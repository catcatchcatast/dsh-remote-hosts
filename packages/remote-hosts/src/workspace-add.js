// Public change history: docs/PUBLIC-CHANGES.md
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'remote-hosts.workspace-add'
const holes = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
const adapters = new WeakMap()
const dictionaries = {
  zh: { title: '选择电脑', host: '电脑', next: '浏览目录', cancel: '取消', unavailable: '所选电脑不可用，请重新选择。' },
  en: { title: 'Select computer', host: 'Computer', next: 'Browse directories', cancel: 'Cancel', unavailable: 'The selected computer is unavailable. Please choose again.' },
}

function hostRows(bridge) {
  const rows = bridge?.getHosts?.()
  return Array.isArray(rows) ? rows.filter(row => typeof row.hostId === 'string' && row.hostId && typeof row.label === 'string') : []
}

/** Host路由跟随原owner的open/busy；onPicked是void，不能用其返回值作为释放时点。 */
function hostFlow(original, t, getBridge) {
  return function HostDirectoryFlow(props) {
    const bridge = getBridge()
    const available = bridge && ['getHosts', 'getSelectedHost', 'setSelectedHost'].every(key => typeof bridge[key] === 'function') && typeof props.listDirectory === 'function' && typeof props.createDirectory === 'function'
    const [host, setHost] = useState(() => bridge?.getSelectedHost?.() ?? 'local')
    const [browsing, setBrowsing] = useState(false)
    const [error, setError] = useState('')
    const lease = useRef(null)
    const pending = useRef(false)
    const owner = useRef(props)
    owner.current = props
    const release = () => {
      const current = lease.current
      lease.current = null
      pending.current = false
      if (current && bridge.getSelectedHost() === current.hostId) bridge.setSelectedHost(current.before)
    }
    useEffect(() => {
      if (!props.open && !props.busy) { release(); setBrowsing(false); setError('') }
    }, [props.open, props.busy])
    useEffect(() => () => release(), [])
    useEffect(() => {
      if (!props.open && !props.busy) return
      return bridge?.onSelectedHost?.(value => {
      if (!lease.current || value === lease.current.hostId || owner.current.busy || pending.current) return
      // 外部显式换Host撤掉原浏览器；原组件卸载负责abort旧扫描，不让旧路径留在新主机下。
      lease.current = null
      setBrowsing(false)
      setHost(value ?? 'local')
      })
    }, [bridge, props.open, props.busy])
    const callbacks = useMemo(() => {
      const requireRoute = () => {
        if (!lease.current || bridge.getSelectedHost() !== lease.current.hostId || !hostRows(bridge).some(row => row.hostId === lease.current.hostId)) throw new Error(t('unavailable'))
      }
      return {
        listDirectory(path, signal) { requireRoute(); return owner.current.listDirectory(path, signal) },
        createDirectory(path, name) { requireRoute(); return owner.current.createDirectory(path, name) },
        onPicked(path) {
          if (pending.current || owner.current.busy) return
          try { requireRoute() }
          catch (reason) { owner.current.onError?.(reason.message); return }
          pending.current = true
          owner.current.onPicked(path)
        },
      }
    }, [bridge])
    useEffect(() => {
      if (!available && props.open) {
        if (owner.current.onError) owner.current.onError(t('unavailable'))
        else owner.current.onCancel()
      }
    }, [available, props.open])
    if (!available) return null
    const browse = () => {
      try {
        if (!hostRows(bridge).some(row => row.hostId === host)) throw new Error(t('unavailable'))
        lease.current = { hostId: host, before: bridge.getSelectedHost() }
        bridge.setSelectedHost(host)
        setError(''); setBrowsing(true)
      } catch { release(); setError(t('unavailable')) }
    }
    if (!props.open && !props.busy) return null
    if (browsing) return createElement(original, { ...props, ...callbacks })
    return createElement(Modal, { open: props.open, title: t('title'), onClose: props.busy ? () => {} : props.onCancel,
      footer: createElement('div', { style: { display: 'flex', gap: 8 } },
        createElement(Button, { variant: 'outline', disabled: props.busy, onClick: props.onCancel }, t('cancel')),
        createElement(Button, { variant: 'primary', disabled: props.busy, onClick: browse }, t('next'))) },
      createElement('label', null, t('host'), createElement('select', { 'aria-label': t('host'), value: host, disabled: props.busy, onChange: event => setHost(event.target.value), style: { width: '100%' } },
        hostRows(bridge).map(row => createElement('option', { key: row.hostId, value: row.hostId }, row.label)))),
      error ? createElement('p', { role: 'alert' }, error) : null)
  }
}

function wrap(entry, t, getBridge) {
  const existing = adapters.get(entry)
  if (existing && entry.component === existing.original) return existing.mount()
  if (existing && entry.component === existing.wrapper) return () => {}
  const original = entry.component
  const mounted = new Set()
  let active = true
  const Flow = hostFlow(original, t, getBridge)
  function Wrapper(props) {
    const [enabled, setEnabled] = useState(active)
    useEffect(() => { mounted.add(setEnabled); setEnabled(active); return () => mounted.delete(setEnabled) }, [])
    return createElement(enabled ? Flow : original, props)
  }
  const mount = () => {
    active = true; entry.component = Wrapper
    for (const update of mounted) update(true)
    return () => {
      active = false
      for (const update of mounted) update(false)
      if (entry.component === Wrapper) entry.component = original
    }
  }
  adapters.set(entry, { original, wrapper: Wrapper, mount })
  return mount()
}

export function installWorkspaceAdd(ctx, getBridge = () => globalThis.__DSH_BROWSER_HOST_HUB__) {
  ctx.effect(() => {
    const stopLocale = ctx.locale.register(NS, dictionaries)
    const t = ctx.locale.bind(NS), installed = new Map()
    const reconcile = () => {
      const live = new Set(holes.flatMap(key => [...ctx.slots.entries(key)]))
      for (const [entry, dispose] of installed) if (!live.has(entry)) { dispose(); installed.delete(entry) }
      for (const entry of live) if (typeof entry.component === 'function' && !installed.has(entry)) installed.set(entry, wrap(entry, t, getBridge))
    }
    const stop = ctx.on('slots/changed', key => { if (holes.includes(key)) reconcile() })
    reconcile()
    return () => { stop(); for (const dispose of installed.values()) dispose(); installed.clear(); stopLocale() }
  }, 'remote-hosts: official workspace add Host selection')
}
