// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
                                                                                                                                               

/** Official lifecycle and inbox objects remain inside this installation port. */
export function createForkInboxIsolationPort(ctx, { upstreamVersion, persistence }) {
  return Object.freeze({ install(selectInheritedMessages) {
    if (typeof selectInheritedMessages !== 'function') throw new TypeError('fork inbox policy is required')
    let disposed = false
    const handled = new WeakSet()
    const fiber = ctx.inject(['agents', 'sessions'], scope => scope.on('agent/created', async ({ agent, signal }) => {
      if (disposed) return
      const session = agent.session
      const cut = session.inheritedEventCount
      const lifecycleStart = (upstreamVersion === '0.2.0-rc.2' || upstreamVersion === '0.2.1-rc.2') ? session.firstLifecycleSeq : session.firstLiveSeq
      if (!session.header.isSeeded || !session.header.parentSession || lifecycleStart !== cut || handled.has(session)) return
      signal?.throwIfAborted()
      // Read the durability boundary, not deprecated synchronous log snapshots.
      await scope.sessions.flush(session)
      const { events } = await persistence.readFrom(session.id)
      signal?.throwIfAborted()
      if (disposed) return
      const own = events.slice(cut)
      if (own[0]?.seq !== cut || own[0]?.type !== 'session/end-seed' || own[0]?.data?.inherited !== true) {
        throw new Error('fork isolation: invalid inherited seed boundary')
      }
      if (own.some(event => event.type === 'turn/start')) throw new Error('fork isolation: agent published after first child turn')
      const inserted = rows => rows.flatMap(event => event.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? []).map(message => message.id) : [])
      const inherited = new Set(inserted(events.slice(0, cut)))
      for (const id of inserted(own)) inherited.delete(id)
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id)
      const eligible = new Set(pending.filter(id => inherited.has(id)))
      const facts = Object.freeze({ inheritedMessageIds: Object.freeze([...eligible]) })
      const selected = await selectInheritedMessages(facts)
      if (!Array.isArray(selected) || selected.some(id => !eligible.has(id))) throw new TypeError('fork isolation policy selected an unrelated message')
      signal?.throwIfAborted()
      if (disposed) return
      handled.add(session)
      for (const id of new Set(selected)) {
        if (!agent.inbox.remove(id)) throw new Error('fork isolation: inherited pending message removal failed')
      }
    }))
    return () => { disposed = true; return fiber.dispose() }
  } })
}
