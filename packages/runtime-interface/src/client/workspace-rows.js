// Public change history: docs/PUBLIC-CHANGES.md
/** Official workspace snapshots and row keys stay inside this boundary. */
export function createWorkspaceRowsClient(workspaces) {
  return Object.freeze({
    decorate(root, render) {
      let snapshot
      try { snapshot = workspaces.list.getSnapshot() } catch { return }
      const byId = new Map((snapshot?.items ?? []).map(item => [item.workspaceId, item]))
      for (const row of root.querySelectorAll('[role="treeitem"]')) {
        const key = row.getAttribute('data-row-key')
        if (!key?.startsWith('workspace:')) continue
        const item = byId.get(key.slice('workspace:'.length))
        if (!item) continue
        const suffix = render(Object.freeze({ workspaceId: item.workspaceId, title: String(item.title ?? '') }))
        if (suffix && (suffix.parentNode !== row || row.lastChild !== suffix)) row.appendChild(suffix)
      }
    },
  })
}
