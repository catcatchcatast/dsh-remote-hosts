// Public change history: docs/PUBLIC-CHANGES.md
import { WEB_021_RUNTIME_VERSION, isWeb022RuntimeVersion } from './web-020.js'
// Public change history: docs/PUBLIC-CHANGES.md
import { randomUUID } from 'node:crypto'

/** 在实际服务实例上安装方法，卸载时只撤回本次原件。 */
function wrapMethod(object, key, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  const original = object[key]
  const wrapped = wrap(original)
  Object.defineProperty(object, key, { configurable: true, writable: true, value: wrapped })
  return () => {
    if (Object.getOwnPropertyDescriptor(object, key)?.value !== wrapped) return
    if (descriptor) Object.defineProperty(object, key, descriptor)
    else delete object[key]
  }
}

/** 公开人类控制入口的差额；不改Agent原型、子代理领域或正常消息。 */
export function installParentPause(ctx, { upstreamVersion = WEB_021_RUNTIME_VERSION } = {}) {
  const modern = isWeb022RuntimeVersion(upstreamVersion)
  const paused = new Map()
  const groups = new Set()
  const reported = 'RESULT_ALREADY_REPORTED'
  const adjacentTool = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')
  const reportRoute = 'Your closing reply is automatically delivered to your parent. Give the full final result there. Only for a new finding or blocker that the parent must act on before you finish, send_message with "[UPDATE] " followed by the update.'
  const manager = ctx.subagents.requireManager()
  const parentOf = task => modern ? ctx.agents.get(task?.ancestors.at(-1)) : task?.parent
  const owns = (agent, parent) => {
    if (!modern) return ctx.agents.isOwnedBy(agent.id, parent)
    const task = manager.resident.get(agent.id)
    return task?.handle?.agent === agent && task.ancestors.includes(parent.id) && task.root === manager.rootOf(parent)
  }
  const reports = new WeakMap()
  const assignments = new WeakMap()
  const cancelled = new WeakMap()
  const turnOf = agent => ctx.sessionProjections.stateOf(agent.session, 'turnBoundary').lastTurn
  function release(group) {
    if (!groups.delete(group)) return
    for (const agent of group) {
      const state = paused.get(agent)
      if (state?.group !== group) continue
      state.restore()
      paused.delete(agent)
    }
    group.clear()
  }
  function guard(group, agent) {
    const prior = paused.get(agent)
    if (prior) {
      if (prior.group !== group) {
        const old = prior.group
        for (const member of old) { paused.get(member).group = group; group.add(member) }
        groups.delete(old)
        old.clear()
      }
      return
    }
    const state = { group, restore: undefined }
    state.restore = wrapMethod(agent, 'send', original => function(message, target, wakeup) {
      if (wakeup === true && message.source.kind === 'user') release(state.group)
      return original.call(this, message, target,
        paused.has(agent) && message.source.kind === 'subagent-settled' ? false : wakeup)
    })
    paused.set(agent, state)
    group.add(agent)
  }
  function pause(root, cancel, receiver, args) {
    const live = ctx.agents.list()
    const tree = [root]
    const seen = new Set(tree)
    for (const parent of tree) for (const agent of live) {
      if (!seen.has(agent) && owns(agent, parent)) { seen.add(agent); tree.push(agent) }
    }
    // 原投影同步读取；只有accepted parent-delivery external会在这里，未发布启动沿原exec.signal取消。
    const external = tree.flatMap(parent => ctx.sessionProjections.snapshot(parent.session, ['subagentCatalog'])
      .values.subagentCatalog.filter(row => row.mode === 'external').map(row => ({ parent, id: row.id })))
    const group = paused.get(root)?.group ?? new Set()
    groups.add(group)
    for (const agent of tree) guard(group, agent)
    const result = cancel.apply(receiver, args)
    for (const agent of tree.slice(1)) {
      const signal = agent.phase?.abort?.signal
      const cause = { kind: 'parent' }
      agent.cancel(cause, { keepInbox: true })
      if (signal?.reason === cause) cancelled.set(agent, turnOf(agent))
    }
    for (const row of external) {
      const activation = manager.resident.get(row.id)
      const signal = activation?.controller?.signal
      const pending = signal && !signal.aborted
      ctx.subagents.interrupt(row.id, { kind: 'ancestor', agent: row.parent })
      if (pending && signal.reason?.kind === 'parent') cancelled.set(activation, true)
    }
    return result
  }
  function control(original, receiver, args, targetId) {
    const agent = ctx.agents.get(targetId)
    if (!agent) return original.apply(receiver, args)
    // 原公开方法先完成身份/授权校验，真正调用目标cancel的同步瞬间才联动。
    // 所有send守卫先于任何cancel；finally精确还原这个短生命周期实例方法。
    const restore = wrapMethod(agent, 'cancel', cancel => function(...cancelArgs) {
      return pause(agent, cancel, this, cancelArgs)
    })
    try { return original.apply(receiver, args) } finally { restore() }
  }
  const routing = ctx.inject(['tools', 'agents', 'subagents'], scope => {
    scope.tools.guard(exec => {
      if (exec.name !== 'send_message' || !exec.agent || exec.signal.aborted) return
      const task = manager.resident.get(exec.agent.id)
      const args = exec.arguments, parent = parentOf(task)
      const tool = scope.tools.get(exec.name, exec.agent, exec.toolSet)
      const nativeTool = modern && tool === scope.tools.get(exec.name) &&
        tool?.parameters?.properties?.agent?.type === 'string' && tool?.parameters?.properties?.message?.type === 'string'
      const target = modern ? args?.agent : args?.agent_id
      const parentTarget = modern && parent ? scope.subagents.namesOf(exec.agent).parent : parent?.id
      if (task?.delivery !== 'parent' || task.handle?.agent !== exec.agent || !parent || parentTarget !== target ||
          task.closing || scope.agents.get(parent.id) !== parent ||
          typeof args.message !== 'string' || Object.keys(args).length !== 2 ||
          !(nativeTool || (!modern && tool?.[adjacentTool]))) return
      if (!/^\[UPDATE\]\s+\S/u.test(args.message)) return 'Not delivered. ' + reportRoute
    })
  })
  const closureContext = ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: 'runtime-interface:child-delivery', order: scope.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
      required: true,
      text({agent}) {
        if (!agent) return ''
        const task = manager.resident.get(agent.id)
        const work = assignments.get(task)
        const parent = parentOf(task)
        if (!work || task.handle?.agent !== agent || !parent) return ''
        const childTurn = turnOf(agent)
        const parentState = ctx.sessionProjections.stateOf(parent.session, 'turnBoundary')
        const parentFinished = work.parentTurn > 0 && parentState.lastTurn === work.parentTurn && parentState.openTurnStartSeq === null
        if (!work.followup && !parentFinished && reports.get(task)?.turn !== childTurn) return ''
        work.childTurn = childTurn
        return 'Finish your assigned work. If actual prior messages confirm your parent already has every substantive result and only routine bookkeeping or a restatement remains, your entire closing text should be the receipt below. If there is any new result, failed operation the parent has not heard about, blocker, or uncertainty, give your normal full closing report instead. A parent ending its turn is not acceptance.\n' + work.receipt
      },
    })
  })
  const stops = [
    () => closureContext.dispose(),
    wrapMethod(manager, 'submitAdmitted', original => function(task, content, options, parent) {
      const id = original.call(this, task, content, options, parent)
      const noticeParent = modern ? parentOf(task) : parent
      if (task.delivery === 'parent' && task.handle?.agent && !task.structured && noticeParent) {
        assignments.set(task, { parentTurn: turnOf(noticeParent), followup: (modern ? task.accepted : task.announced) && !options.source,
          receipt: 'NO_NEW_RESULT_' + randomUUID() })
      }
      return id
    }),
    () => routing.dispose(),
    // 仅替换官方为新后台子会话追加的指引。用户的原任务和后续来信逐块保留。
    wrapMethod(manager, 'submitMaterialized', original => function(activation, content, options, parent, commit) {
      const senderTool = commit && activation.delivery === 'parent' &&
        ctx.get('tools')?.get('send_message', activation.handle.agent)
      const nativeGuidance = modern && senderTool === ctx.get('tools')?.get('send_message') && senderTool?.parameters?.properties?.agent?.type === 'string'
      if ((nativeGuidance && content.at(-1)?.text?.startsWith('Your final answer is delivered automatically if your parent is still online.')) || (senderTool?.[adjacentTool] &&
          content.at(-1)?.text?.startsWith('Your parent agent id is ' + JSON.stringify(parent.id) + '. Before you finish, send your result'))) {
        content = [...content.slice(0, -1), { type: 'text', text:
          (modern ? 'Your parent agent is ' + JSON.stringify(ctx.subagents.namesOf(activation.handle.agent).parent) : 'Your parent agent id is ' + JSON.stringify(parent.id)) +
          '. ' + reportRoute + ' If an earlier update already contained the entire result and nothing has changed, close with just ' + reported + '.' }]
      }
      return original.call(this, activation, content, options, parent, commit)
    }),
    modern ? wrapMethod(manager, 'sendMessage', original => async function(sender, targetId, content, options) {
      const id = await original.call(this, sender, targetId, content, options)
      const task = manager.resident.get(sender.id)
      if (parentOf(task)?.id === targetId) reports.set(task, { turn: turnOf(sender), content })
      return id
    }) : wrapMethod(manager, 'sendToParent', original => function(activation, sender, content) {
      const id = original.call(this, activation, sender, content)
      reports.set(activation, { turn: turnOf(sender), content })
      return id
    }),
    wrapMethod(manager, 'notifySettlement', original => function(activation, terminal) {
      const child = activation.handle?.agent
      if (terminal.stopReason === 'aborted' && (child
        ? cancelled.has(child) && cancelled.get(child) === turnOf(child)
        : cancelled.has(activation))) return
      const report = reports.get(activation)
      const work = assignments.get(activation)
      const visible = terminal.output.filter(block => block.type !== 'reasoning')
      if (work?.childTurn !== undefined && work.childTurn === turnOf(child) &&
          terminal.stopReason === 'completed' && terminal.structured === undefined && terminal.diagnostic === undefined &&
          visible.length === 1 && visible[0].type === 'text' && visible[0].text.trim() === work.receipt) return
      if (terminal.stopReason === 'completed' && report && report.turn === turnOf(child) &&
          terminal.structured === undefined && terminal.diagnostic === undefined &&
          report.content.length === 1 && visible.length === 1 &&
          report.content[0].type === 'text' && visible[0].type === 'text' &&
          (visible[0].text === reported || report.content[0].text === visible[0].text)) return
      // 新版原生按最后一次工具投递省略结语；存在真正新结果时仍交原结算器携带完整结果。
      if (modern && child && report && report.turn === turnOf(child)) activation.omitClosingText = false
      return original.call(this, activation, terminal)
    }),
    // 参数名保持官方SRC反射合同；Gateway也在每次调用时读取当前实例方法。
    wrapMethod(ctx.sessionController, 'cancel', original => function(request) {
      return control(original, this, [request], request?.sessionId)
    }),
    modern ? wrapMethod(ctx.subagents, 'interrupt', original => function(childSessionId, authority) {
      return control(original, this, [childSessionId, authority], childSessionId)
    }) : wrapMethod(ctx.subagents, 'interruptByParent', original => function(childSessionId, parentSessionId, mode) {
      return control(original, this, [childSessionId, parentSessionId, mode], childSessionId)
    }),
    ctx.on('agent/disposed', ({ agent }) => {
      const state = paused.get(agent)
      if (!state) return
      state.restore(); paused.delete(agent); state.group.delete(agent)
      if (state.group.size === 0) groups.delete(state.group)
    }),
  ]
  return () => { for (const stop of stops) stop(); for (const group of [...groups]) release(group) }
}
