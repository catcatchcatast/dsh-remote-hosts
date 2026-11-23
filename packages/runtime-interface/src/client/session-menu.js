// Public change history: docs/PUBLIC-CHANGES.md
const MENU = 'sidebar.workspaces.session.menu.item'
// Public change history: docs/PUBLIC-CHANGES.md
import { sessionModelHost } from './model-catalog.js'
const ROW = 'sidebar.workspaces.session.row.action'
const fail = () => new Error('SESSION_MENU_UNAVAILABLE')

/** Reuse the registered public root action faces, including native rename/active-archive dialogs.
 * No private module exports, source rewriting, or independent mutation policy. */
export function createSessionMenuClient({ slots, sessions, workspaces, locale }) {
  const t = locale.bind('workspace')
  const methods = {
    rename: [MENU, 'rename', 'requestSessionRename'], fork: [MENU, 'fork', 'forkSession'],
    archive: [ROW, 'archive', 'archiveSession'], unarchive: [ROW, 'archive', 'unarchiveSession'],
    pin: [MENU, 'pin', 'pinSession'], unpin: [MENU, 'pin', 'unpinSession'],
  }
  const faceFor = (slot, entryId) => {
    const entry = slots.entriesOfSlot(slot).find(entry => entry.options.id === entryId)
    return entry?.inject?.()
  }
  const workspaceFor = id => {
    const summary = sessions.list.getSnapshot().byId[id]
    if (!summary) return
    try { if (sessionModelHost(id) !== 'local') return } catch { return }
    if ((summary.id !== undefined && summary.id !== id) || (summary.sessionId !== undefined && summary.sessionId !== id)) return
    const path = summary.cwd
    if (typeof path !== 'string' || !path || path.includes('\0') || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path))) return
    // The directory header face uses serving-Host HTTP, unlike page-Host-selected path RPC.
    const face = faceFor('conversation.session.header.utilities', 'open-in-app')
    const apps = face?.hooks?.openInAppApps?.getSnapshot?.()
    const choice = face?.hooks?.openInAppChoice?.getSnapshot?.()
    const appId = Array.isArray(apps) ? (apps.includes(choice) ? choice : apps[0]) : undefined
    const operation = face?.hooks?.openInAppLaunch?.getSnapshot?.()
    if (typeof appId !== 'string' || !appId || typeof face?.launch !== 'function' || !['idle', 'error'].includes(operation?.phase)) return
    return { face, appId, path }
  }
  // Official archive/pin membership is interpreted here; callers see only stable action kinds.
  const items = (id, localPinned = false) => {
    const summary = sessions.list.getSnapshot().byId[id]
    if (!summary) return Object.freeze([])
    const state = workspaces.list.getSnapshot()
    const archived = (state.archivedSessionIds ?? []).includes(id)
    const pinned = (state.pinnedSessionIds ?? []).includes(id) || localPinned
    const kinds = ['rename', 'fork', archived ? 'unarchive' : 'archive']
    if (!archived) kinds.push(pinned ? 'unpin' : 'pin')
    return Object.freeze([...kinds.filter(kind => {
      const [slot, entryId, method] = methods[kind]
      return typeof faceFor(slot, entryId)?.[method] === 'function'
    }), ...(workspaceFor(id) ? ['openWorkspace'] : []), 'copy'])
  }
  return Object.freeze({
    items,
    pinned() {
      const list = sessions.list.getSnapshot()
      return (workspaces.list.getSnapshot().pinnedSessionIds ?? []).map(id => ({ id, title: list.byId[id]?.displayTitle ?? list.byId[id]?.title ?? id }))
    },
    run(kind, id, title, localPinned = false) {
      if (typeof id !== 'string' || !id || id.includes('\0')) throw fail()
      if (kind === 'openWorkspace') {
        const workspace = workspaceFor(id)
        if (!workspace) throw fail()
        return workspace.face.launch(workspace.appId, workspace.path)
      }
      // Re-read at selection time: a menu can outlive archive/pin changes or slot removal.
      if (!Object.hasOwn(methods, kind) || !items(id, localPinned).includes(kind)) throw fail()
      const summary = sessions.list.getSnapshot().byId[id]
      const [slot, entryId, method] = methods[kind]
      const face = faceFor(slot, entryId)
      if (typeof face?.[method] !== 'function') throw fail()
      return face[method](id, summary.blank ? '' : summary.title?.trim() ?? '')
    },
    installProjectMenus(onOpen, document = globalThis.document) {
      const handle = event => {
        const row = event.target?.closest?.('[data-row-key^="session:"]')
        if (!row) return
        const id = row.getAttribute('data-row-key').slice('session:'.length)
        const summary = sessions.list.getSnapshot().byId[id]
        if (!summary || summary.blank) return
        const title = summary.title?.trim() || t('session.untitled')
        const button = event.target.closest?.('button')
        if (event.type === 'click' && (!button || button.getAttribute('aria-label') !== t('actions.session.aria', { name: title }))) return
        event.preventDefault(); event.stopPropagation()
        const rect = (button ?? row).getBoundingClientRect()
        onOpen(event.type === 'contextmenu' ? event.clientX : rect.left,
          event.type === 'contextmenu' ? event.clientY : rect.bottom + 4, id, title)
      }
      document.addEventListener('click', handle, true)
      document.addEventListener('contextmenu', handle, true)
      return () => {
        document.removeEventListener('click', handle, true)
        document.removeEventListener('contextmenu', handle, true)
      }
    },
  })
}
