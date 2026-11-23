// Public change history: docs/PUBLIC-CHANGES.md
import { createElement, useSyncExternalStore } from 'react'
import { MenuItemButton, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const NS = 'remote-hosts.file-tab-menu'

export function fileTabSession(tab) {
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\//.exec(tab.contentId)
  if (!match) return
  try { return decodeURIComponent(match[1]) } catch { return }
}

export function installFileTabMenu(ctx) {
  const notice = createSnapshotStore(null), lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(); notice.set(null) })
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { reveal: '打开所在文件夹', open: '用默认方式打开', failed: '文件打开失败' },
    en: { reveal: 'Open containing folder', open: 'Open with default application', failed: 'Could not open file' },
  }))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'file-tab-open-error', locale: NS }, ({ t }) => {
    const value = useSyncExternalStore(notice.subscribe, notice.getSnapshot)
    return value ? createElement(Toast, { key: value, text: t('failed'), onDone: () => notice.set(null) }) : null
  }))
  function FileItem({ tab, dismiss, t, action, sessionId }) {
    const source = ctx.get('resources').source(tab.contentId)
    const resource = useSyncExternalStore(source.subscribe, source.getSnapshot)
    return createElement(MenuItemButton, { disabled: resource.status !== 'live',
      icon: createElement(action === 'reveal' ? IconFolderOpenOutlineRegular : IconRightUpOutlineRegular), onSelect() {
        dismiss()
        void fetch('/api/remote-hosts/file-preview', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, path: resource.value.absolutePath, action }), signal: lifetime.signal,
        }).then(async response => { if (!response.ok || !(await response.json()).opened) throw new Error('File open failed') })
          .catch(() => { if (!lifetime.signal.aborted) notice.set(Date.now()) })
      } }, t(action))
  }
  ctx.slots.inject('sidebar.right.tab.menu.item', () => {
    const stops = ['reveal', 'open'].map((action, index) => ctx.slots.register({
      name: 'sidebar.right.tab.menu.item', id: 'remote-file-' + action, order: 100 + index, locale: NS,
    }, props => {
      const sessionId = fileTabSession(props.tab)
      return sessionId ? createElement(FileItem, { ...props, action, sessionId }) : null
    }))
    return () => { for (const stop of stops) stop() }
  })
}
