// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                    
import { createElement, useSyncExternalStore } from 'react'
import { MenuItemButton, IconCopyOutlineRegular, IconFolderOpenRegular, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sessionModelHost } from './model-catalog.js'

const NS = 'remote-hosts.workspace-path-menu'
const installed = new WeakMap()
const emptySubscribe = () => () => {}
const emptySnapshot = () => undefined
const nativeApps = ['explorer', 'finder', 'filemanager']

/** ID和路径来自本条权威列表；保留POSIX/Windows原字符串，不引用当前选中会话。 */
export function createWorkspacePathActions({ sessions, workspaces, slots }) {
  const face = () => slots.entries('conversation.session.header.utilities').find(entry => entry.options.id === 'open-in-app')?.inject?.()
  function resolve(kind, id) {
    const row = kind === 'workspace' ? workspaces.list.getSnapshot()?.items?.find(item => item.workspaceId === id) : sessions.list.getSnapshot()?.byId?.[id]
    if (!row || (kind === 'session' && row.id !== id)) return
    const path = kind === 'workspace' ? row.path : row.cwd
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return
    let host
    try { host = sessionModelHost(id) } catch { return }
    return { path, host }
  }
  function nativeOpener(target) {
    if (target?.host !== 'local') return
    const value = face(), apps = value?.hooks?.openInAppApps?.getSnapshot()
    const app = nativeApps.find(app => Array.isArray(apps) && apps.includes(app))
    if (app && typeof value.launch === 'function' && ['idle', 'error'].includes(value.hooks.openInAppLaunch?.getSnapshot()?.phase)) return { value, app }
  }
  return {
    resolve, face,
    canOpen(kind, id) { return !!nativeOpener(resolve(kind, id)) },
    async run(action, kind, id) {
      const target = resolve(kind, id)
      if (!target) throw new Error('WORKSPACE_PATH_UNAVAILABLE')
      if (action === 'copy') { if (!await writeClipboard(target.path)) throw new Error('WORKSPACE_PATH_COPY_FAILED') }
      else if (action === 'open') {
        const opener = nativeOpener(target)
        if (!opener) throw new Error('WORKSPACE_FOLDER_OPENER_UNAVAILABLE')
        await opener.value.launch(opener.app, target.path)
      }
    },
  }
}

/** Root批准的021局部DOM接缝：只在准确原工作区三点打开期间补普通button，原Menu继续处理键盘/焦点/关闭。 */
function installWorkspaceGroupMenu({ document, actions, workspaces, slots, locale, t, reportFailure }) {
  installed.get(document)?.()
  let current, disposed = false
  function clear() { const old = current; current = undefined; old?.stop() }
  function onClick(event) {
    const trigger = event.target?.closest?.('button')
    const row = trigger?.closest('[role="treeitem"][data-row-key^="workspace:"]')
    const lane = row?.querySelector('span[class$="_rowActions"]')
    // 021原Menu wrapper为rowActions的首span；第二个Tooltip按钮是新建，不接管。
    if (!row || trigger !== lane?.firstElementChild?.querySelector('button')) return
    if (current?.trigger === trigger) { clear(); return }
    clear()
    const id = row.getAttribute('data-row-key').slice('workspace:'.length)
    if (!actions.resolve('workspace', id)) return
    const entry = slots.entries('sidebar.workspaces').find(entry => entry.children?.['sidebar.workspaces.directoryFlow'])
    if (!entry?.locale) return
    const nativeT = locale.bind(entry.locale)
    const existing = new Set(document.querySelectorAll('[role="menu"]'))
    const added = new Map(), stops = []
    let menu, expiry, stopped = false
    const stop = () => { if (stopped) return; stopped = true; clearTimeout(expiry); observer.disconnect(); for (const stop of stops) stop(); for (const node of added.values()) node.remove(); added.clear() }
    const finish = () => { if (current?.stop === stop) clear(); else stop() }
    function sync() {
      if (!menu || stopped) return
      const target = actions.resolve('workspace', id)
      const available = target ? ['copy', ...(actions.canOpen('workspace', id) ? ['open'] : [])] : []
      for (const [key, node] of added) if (!available.includes(key)) { node.remove(); added.delete(key) }
      const template = menu.querySelector('button[role="menuitem"]')?.parentElement
      if (!template) return
      for (const action of available) {
        if (added.has(action)) continue
        const wrap = template.cloneNode(true), button = wrap.querySelector('button')
        // 复用原MenuItemButton的无图标形状，移除rename图标而不伪造原动作。
        button.querySelector('svg')?.parentElement.remove()
        button.lastElementChild.textContent = t(action)
        button.removeAttribute('aria-keyshortcuts')
        button.dataset.dshWorkspacePathAction = action
        button.addEventListener('click', () => {
          if (stopped || disposed) return
          trigger.click() // 原三点toggle关闭；自有节点同步移除后显式交回原trigger。
          if (trigger.isConnected) trigger.focus({ preventScroll: true })
          void actions.run(action, 'workspace', id).catch(() => reportFailure(action))
        })
        template.parentElement.appendChild(wrap)
        added.set(action, wrap)
      }
    }
    const observer = new MutationObserver(records => {
      if (menu && !menu.isConnected) { finish(); return }
      if (menu) return
      const candidates = records.flatMap(record => [...record.addedNodes]).filter(node => node.nodeType === 1 && node.getAttribute('role') === 'menu' && !existing.has(node))
      for (const candidate of candidates) {
        const buttons = [...candidate.querySelectorAll('button[role="menuitem"]')]
        if (buttons.length !== 2 || buttons[0].textContent !== nativeT('rename') || buttons[1].textContent !== nativeT('delete.workspace')) continue
        if (!trigger.isConnected || !row.isConnected) { finish(); return }
        menu = candidate
        clearTimeout(expiry)
        sync()
        stops.push(workspaces.list.subscribe(sync))
        const hooks = actions.face()?.hooks
        if (hooks?.openInAppApps) stops.push(hooks.openInAppApps.subscribe(sync))
        if (hooks?.openInAppLaunch) stops.push(hooks.openInAppLaunch.subscribe(sync))
        return
      }
    })
    current = { trigger, stop }
    observer.observe(document.body, { childList: true })
    // 一次打开若未产生原portal，不把后来的其它菜单误认成本次工作区菜单。
    expiry = setTimeout(() => { if (!menu) finish() }, 0)
  }
  document.addEventListener('click', onClick, true)
  const dispose = () => { if (disposed) return; disposed = true; clear(); document.removeEventListener('click', onClick, true); if (installed.get(document) === dispose) installed.delete(document) }
  installed.set(document, dispose)
  return dispose
}

export function installWorkspacePathMenus(ctx) {
  const notices = createSnapshotStore(null)
  let alive = true, sequence = 0
  const reportFailure = action => { if (alive) notices.set({ action, sequence: ++sequence }) }
  ctx.effect(() => () => { alive = false; notices.set(null) }, 'workspace path menu: release notice')
  const actions = createWorkspacePathActions({ sessions: ctx.get('sessions'), workspaces: ctx.get('workspaces'), slots: ctx.slots })
  ctx.effect(() => ctx.locale.register(NS, { zh: { copy: '复制工作区路径', open: '打开工作区文件夹', copyFailed: '工作区路径复制失败', openFailed: '工作区文件夹打开失败' }, en: { copy: 'Copy workspace path', open: 'Open workspace folder', copyFailed: 'Could not copy workspace path', openFailed: 'Could not open workspace folder' } }), 'workspace path menu: locale')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace-path-failure', locale: NS }, ({ t }) => {
    const notice = useSyncExternalStore(notices.subscribe, notices.getSnapshot)
    return notice ? createElement(Toast, { key: notice.sequence, text: t(notice.action + 'Failed'), onDone() { if (notices.getSnapshot() === notice) notices.set(null) } }) : null
  }))
  function PathItem({ sessionId, useMenuOpenState, t, action }) {
    useSyncExternalStore(ctx.get('sessions').list.subscribe, ctx.get('sessions').list.getSnapshot)
    const hooks = actions.face()?.hooks
    for (const key of ['openInAppApps', 'openInAppLaunch']) useSyncExternalStore(hooks?.[key]?.subscribe ?? emptySubscribe, hooks?.[key]?.getSnapshot ?? emptySnapshot)
    const [, setOpen] = useMenuOpenState()
    if (!actions.resolve('session', sessionId) || (action === 'open' && !actions.canOpen('session', sessionId))) return null
    return createElement(MenuItemButton, { icon: createElement(action === 'copy' ? IconCopyOutlineRegular : IconFolderOpenRegular), onSelect() {
      setOpen(false)
      void actions.run(action, 'session', sessionId).catch(() => reportFailure(action))
    } }, t(action))
  }
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => {
    const stops = ['copy', 'open'].map((action, i) => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'workspace-path-' + action, order: 460 + i, locale: NS }, props => createElement(PathItem, { ...props, action })))
    return () => { for (const stop of stops) stop() }
  })
  ctx.effect(() => installWorkspaceGroupMenu({ document: globalThis.document, actions, workspaces: ctx.get('workspaces'), slots: ctx.slots, locale: ctx.locale, t: ctx.locale.bind(NS), reportFailure }), 'workspace path menu: original group portal')
}
