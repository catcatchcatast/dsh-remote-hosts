// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                               

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
export function installParentPause(ctx) {
  const paused = new Map()
  const groups = new Set()
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
      if (!seen.has(agent) && ctx.agents.isOwnedBy(agent.id, parent)) { seen.add(agent); tree.push(agent) }
    }
    // 原投影同步读取；只有accepted parent-delivery external会在这里，未发布启动沿原exec.signal取消。
    const external = tree.flatMap(parent => ctx.sessionProjections.snapshot(parent.session, ['subagentCatalog'])
      .values.subagentCatalog.filter(row => row.mode === 'external').map(row => ({ parent, id: row.id })))
    const group = paused.get(root)?.group ?? new Set()
    groups.add(group)
    for (const agent of tree) guard(group, agent)
    const result = cancel.apply(receiver, args)
    for (const agent of tree.slice(1)) agent.cancel({ kind: 'parent' }, { keepInbox: true })
    for (const row of external) ctx.subagents.interrupt(row.id, { kind: 'ancestor', agent: row.parent })
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
  const stops = [
    // 参数名保持官方SRC反射合同；Gateway也在每次调用时读取当前实例方法。
    wrapMethod(ctx.sessionController, 'cancel', original => function(request) {
      return control(original, this, [request], request?.sessionId)
    }),
    wrapMethod(ctx.subagents, 'interruptByParent', original => function(childSessionId, parentSessionId, mode) {
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
