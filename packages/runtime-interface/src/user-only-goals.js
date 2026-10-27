// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                             
const CREATE = 'create_goal'
const ORIGINAL = 'create_goal may infer goal intent from a direct human request in any language.'
const USER_ONLY = 'Goals are created only by the user via /goal; do not create goals yourself.'

/** 使用官方Agent作用域restrict与prompt waterfall，不修改官方工具、目标领域或预设。 */
export function installUserOnlyGoals(ctx) {
  let active = true
  const installed = new Map()
  const pending = new Set()
  function install(agent) {
    if (!active || installed.has(agent)) return
    if (agent.ctx.tools.get(CREATE, agent) === undefined) { pending.add(agent); return }
    // restrict自身同步发布tools/change，先退pending并占位避免重复安装。
    pending.delete(agent)
    installed.set(agent, undefined)
    try { installed.set(agent, agent.ctx.tools.restrict({ deny: [CREATE] })) }
    catch (error) { installed.delete(agent); throw error }
  }
  function release(agent) {
    pending.delete(agent)
    const dispose = installed.get(agent)
    installed.delete(agent)
    dispose?.()
  }
  const stops = [
    ctx.on('agent/created', ({ agent }) => install(agent)),
    ctx.on('agent/disposed', ({ agent }) => release(agent)),
    // 只重试尚无该工具的Agent，不在每次工具变化时扫描全部现存Agent。
    ctx.on('tools/change', () => { if (active) for (const agent of [...pending]) install(agent) }),
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      if (!active) return assembly
      return { ...assembly, sections: assembly.sections.map(section => section.name === 'tool:goal' && typeof section.text === 'string' && section.text.startsWith(ORIGINAL)
        ? { ...section, text: USER_ONLY + section.text.slice(ORIGINAL.length) } : section) }
    }),
  ]
  function dispose() {
    if (!active) return
    active = false
    for (const stop of stops) stop()
    for (const agent of [...installed.keys()]) release(agent)
    pending.clear()
  }
  try { for (const agent of ctx.agents.list()) install(agent) }
  catch (error) { dispose(); throw error }
  return dispose
}
