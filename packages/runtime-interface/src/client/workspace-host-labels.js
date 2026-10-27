// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                 
                                                                                                         
function hostRowSelector(kind, hostId) {
  if (hostId !== undefined && (typeof hostId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(hostId))) throw new TypeError('HOST_ID_INVALID')
  const host = hostId === undefined ? '' : btoa(hostId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') + '.'
  return `[role="treeitem"][data-row-key^="${kind}:rh1.${host}"]`
}

export const workspaceHostSelector = hostId => hostRowSelector('workspace', hostId)
export const sessionHostSelector = hostId => hostRowSelector('session', hostId)

/** 官方复合工作区身份只在接口叶解释；原生本地ID和未知形状不触发库存读取。 */
function hasRemoteIdentity(id) {
  const parts = typeof id === 'string' ? id.split('.') : []
  if (parts.length !== 3 || parts[0] !== 'rh1' || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false
  try {
    const hostId = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    return hostId !== 'local' && workspaceHostSelector(hostId).includes('rh1.' + parts[1] + '.')
  } catch { return false }
}
function hasRemoteWorkspace(snapshot) {
  return (Array.isArray(snapshot?.items) ? snapshot.items : []).some(item => hasRemoteIdentity(item?.workspaceId))
}

/** 名称和状态共享一份有界显示投影；只读既有认证库存，不触发业务连接。 */
export function createWorkspaceHostLabels(initialHosts) {
  const listeners = new Set()
  let statusViews = 0
  let pendingStatus = 0
  let inventory
  const normalize = hosts => Object.freeze([...new Map((Array.isArray(hosts) ? hosts : []).flatMap(host => {
    const hostId = host?.hostId ?? host?.id
    try { workspaceHostSelector(hostId) } catch { return [] }
    if (typeof hostId !== 'string') return []
    return [[hostId, Object.freeze({ hostId, label: typeof host.label === 'string' && host.label.trim() ? host.label : hostId,
      state: typeof host.state === 'string' ? host.state : 'unknown' })]]
  })).values()])
  let roster = normalize(initialHosts)
  const observe = hosts => {
    const next = normalize(hosts)
    if (next.length === roster.length && next.every((host, i) => host.hostId === roster[i].hostId && host.label === roster[i].label && host.state === roster[i].state)) return
    roster = next
    for (const listener of [...listeners]) { try { listener() } catch { /* 显示订阅异常不改变原管理响应。 */ } }
  }
  return Object.freeze({ getSnapshot: () => roster, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, workspaceHostSelector, sessionHostSelector,
    managementClient(api) { return Object.freeze({ ...api,
      // 设置面板原status刷新拥有读取时，本标签暂停库存读取并复用原成功响应。
      mountStatusView() {
        statusViews++; inventory?.sync()
        let active = true
        return () => { if (active) { active = false; statusViews--; inventory?.sync() } }
      },
      async call(...args) {
        const status = args[0] === 'status'
        if (status) { pendingStatus++; inventory?.sync() }
        try { const result = await api.call(...args); if (Array.isArray(result.hosts)) observe(result.hosts); return result }
        catch (error) { if (args[0] === 'status') observe(roster.map(host => ({ ...host, state: 'unknown' }))); throw error }
        finally { if (status) { pendingStatus--; inventory?.sync() } }
      },
    }) },
    watchInventory(workspaces, environment = {}) {
      if (inventory) throw new Error('WORKSPACE_HOST_INVENTORY_ALREADY_BOUND')
      const document = environment.document ?? globalThis.document
      const read = environment.fetch ?? globalThis.fetch
      const later = environment.setTimeout ?? globalThis.setTimeout
      const cancel = environment.clearTimeout ?? globalThis.clearTimeout
      let stopped = false, pending, timer, epoch = 0
      const sessions = environment.sessions
      const remoteSession = () => { const ids = sessions?.getSnapshot()?.ids; return Array.isArray(ids) && ids.some(hasRemoteIdentity) }
      const eligible = () => !stopped && document?.visibilityState === 'visible' && statusViews === 0 && pendingStatus === 0 && (hasRemoteWorkspace(workspaces.getSnapshot()) || remoteSession())
      const clearTimer = () => { if (timer !== undefined) { cancel(timer); timer = undefined } }
      async function refresh() {
        if (!eligible() || pending) return
        const request = { controller: new AbortController(), epoch }
        pending = request
        try {
          const response = await read('/api/browser-host-hub-rc1/host-inventory', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: request.controller.signal })
          if (!response.ok) throw new Error('HOST_INVENTORY_UNAVAILABLE')
          const value = await response.json(), seen = new Set()
          if (!Array.isArray(value?.hosts) || value.hosts.some(host => {
            if (!host || typeof host.hostId !== 'string' || typeof host.label !== 'string' || !host.label.trim() || typeof host.state !== 'string' || seen.has(host.hostId)) return true
            try { workspaceHostSelector(host.hostId) } catch { return true }
            seen.add(host.hostId); return false
          })) throw new Error('HOST_INVENTORY_INVALID')
          if (!request.controller.signal.aborted && request.epoch === epoch && eligible()) {
            // 断开的carrier会从perHost库存消失；保留已知显示名称，但不能保留旧在线状态。
            const ids = new Set(value.hosts.map(host => host.hostId))
            observe([...value.hosts, ...roster.filter(host => !ids.has(host.hostId)).map(host => ({ ...host, state: 'unknown' }))])
          }
        } catch {
          if (!request.controller.signal.aborted && request.epoch === epoch && eligible()) observe(roster.map(host => ({ ...host, state: 'unknown' })))
        } finally {
          if (pending === request) pending = undefined
          if (eligible()) {
            if (request.controller.signal.aborted) void refresh()
            else timer = later(() => { timer = undefined; void refresh() }, 4000)
          }
        }
      }
      function sync() {
        if (!eligible()) { epoch++; clearTimer(); pending?.controller.abort(); return }
        if (!pending && timer === undefined) void refresh()
      }
      const owner = { sync }
      inventory = owner
      const stopWorkspaces = workspaces.subscribe(sync)
      const stopSessions = sessions?.subscribe(sync)
      document?.addEventListener('visibilitychange', sync)
      sync()
      return () => {
        if (stopped) return
        stopped = true; epoch++; clearTimer(); pending?.controller.abort()
        stopWorkspaces(); stopSessions?.(); document?.removeEventListener('visibilitychange', sync)
        if (inventory === owner) inventory = undefined
      }
    },
  })
}
