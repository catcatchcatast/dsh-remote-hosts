// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                         
import { createElement, useMemo, useState, useEffect } from 'react'

const RECENCY = Symbol.for('dsh.runtime-interface.workspace-recency')
const identity = value => value
const adapters = new WeakMap()

/** 只派生展示items：成员最新数字时间降序，同值及空组保原相对顺序。 */
export function workspaceRecencySnapshot(snapshot, sessions) {
  if (!Array.isArray(snapshot?.items) || snapshot.items.length < 2) return snapshot
  const ranked = snapshot.items.map((workspace, index) => ({ workspace, index,
    time: (workspace.sessionIds ?? []).reduce((latest, id) => {
      const value = sessions?.byId?.[id]?.updatedAt
      return Number.isFinite(value) ? Math.max(latest, value) : latest
    }, -Infinity),
  })).sort((a, b) => b.time - a.time || a.index - b.index)
  if (ranked.every((row, index) => row.index === index)) return snapshot
  return { ...snapshot, items: ranked.map(row => row.workspace) }
}

/** 保原entry/children/store授权。只恢复仍由本次拥有的component，不覆盖其它后装所有者。 */
export function installWorkspaceRecency(entry) {
  const original = entry?.component
  if (typeof original !== 'function' || original[RECENCY]) return () => {}
  const previous = adapters.get(entry)
  if (previous?.original === original) return previous.mount()
  const mounted = new Set()
  let active = true
  function RecencyProjection(props) {
    const groupBy = props.useStore(state => state.groupBy)
    const orderBy = props.useStore(state => state.orderBy)
    const sessions = props.useSessions(identity)
    const enabled = groupBy === 'workspace' && orderBy === 'updated'
    const project = useMemo(() => {
      const cache = new WeakMap()
      return snapshot => {
        if (!snapshot || typeof snapshot !== 'object') return snapshot
        if (!cache.has(snapshot)) cache.set(snapshot, workspaceRecencySnapshot(snapshot, sessions))
        return cache.get(snapshot)
      }
    }, [sessions])
    const useWorkspaces = useMemo(() => function useRecencyWorkspaces(selector = identity, ...args) {
      return props.useWorkspaces(snapshot => selector(project(snapshot)), ...args)
    }, [props.useWorkspaces, project])
    return createElement(original, enabled ? { ...props, useWorkspaces } : props)
  }
  function WorkspaceRecency(props) {
    const [enabled, setEnabled] = useState(active)
    useEffect(() => {
      mounted.add(setEnabled)
      setEnabled(active)
      return () => mounted.delete(setEnabled)
    }, [])
    return createElement(enabled ? RecencyProjection : original, props)
  }
  Object.defineProperty(WorkspaceRecency, RECENCY, { value: true })
  // 本entry的React局部生存期：卸载立即撤掉投影订阅，复挂复用同一wrapper，既不层叠也不改Slot版本/队列。
  function mount() {
    active = true
    entry.component = WorkspaceRecency
    for (const update of mounted) update(true)
    return () => {
      active = false
      for (const update of mounted) update(false)
      if (entry.component === WorkspaceRecency) entry.component = original
    }
  }
  adapters.set(entry, { original, mount })
  return mount()
}
