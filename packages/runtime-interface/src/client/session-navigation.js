// Public change history: docs/PUBLIC-CHANGES.md
const unavailable = () => Object.assign(new Error('SESSION_NAVIGATION_UNAVAILABLE'), { code: 'SESSION_NAVIGATION_UNAVAILABLE' })

/** Own official navigation and selection semantics; session identities remain opaque. */
export function createSessionNavigationClient({ uiWorkspace, sessions }) {
  return Object.freeze({
    async open(id) {
      if (typeof id !== 'string' || id === '' || id.includes('\0')) throw unavailable()
      try {
        // Both supported official UI generations expose this policy entry point.
        await uiWorkspace.openSession(id)
      } catch { throw unavailable() }
    },
    getCurrentId() {
      const list = sessions.list.getSnapshot()
      // Older official controllers carry selection directly in the catalog.
      if (Object.hasOwn(list, 'current')) return list.current
      const selected = uiWorkspace.selection.getSnapshot().sessionId
      const retained = id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0
      // During replacement both references can briefly exist; selection picks the new one.
      if (typeof selected === 'string' && retained(selected)) return selected
      return Object.values(list.byId).find(row => retained(row.id))?.id
    },
    subscribe(listener) {
      const stops = [sessions.list.subscribe(listener)]
      if (uiWorkspace.selection) stops.push(uiWorkspace.selection.subscribe(listener))
      return () => { for (const stop of stops) stop() }
    },
  })
}
