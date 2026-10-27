// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                             
                                                                                                                                               
// Official rc2 resolver binding lives here; callers never receive a resolver or raw RPC.
                                                                                                                                                                 
const fail = code => new Error(code)

export function sessionModelHost(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 4096) throw fail('MODEL_SESSION_ID_INVALID')
  if (!sessionId.startsWith('rh1.')) return 'local'
  const parts = /^rh1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(sessionId)
  if (!parts) throw fail('MODEL_SESSION_ID_INVALID')
  try {
    const decode = value => {
      const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)))
      const bytes = new TextEncoder().encode(decoded)
      const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      if (!decoded || canonical !== value) throw fail('MODEL_SESSION_ID_INVALID')
      return decoded
    }
    const host = decode(parts[1])
    decode(parts[2])
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(host)) throw fail('MODEL_SESSION_ID_INVALID')
    return host
  } catch { throw fail('MODEL_SESSION_ID_INVALID') }
}

function catalogStore() {
  let state = { value: null, status: 'idle', error: null }
  const listeners = new Set()
  return { getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(value) { state = value; for (const listener of [...listeners]) listener() },
  }
}

function hostCatalog(rpc, hostId) {
  const store = catalogStore()
  const reasoning = new Map()
  let generation = 0, inflight, aborter, disposed = false
  const reset = () => {
    generation++
    aborter?.abort()
    inflight = undefined
    store.set({ value: null, status: 'idle', error: null })
  }
  const catalog = { store,
    reasoningFor(selection) { return reasoning.get(JSON.stringify([selection.provider, selection.model])) },
    load() {
      if (disposed) return Promise.reject(fail('MODEL_CATALOG_DISPOSED'))
      const state = store.getSnapshot()
      if (state.status === 'ready') return Promise.resolve(state.value)
      if (inflight) return inflight
      const ticket = generation
      const controller = aborter = new AbortController()
      store.set({ ...state, status: 'loading', error: null })
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return rpc.call('/api', 'session/modelCatalog', { args: {}, __hostId: hostId }, controller.signal)
      })
        .then(response => {
          const value = response?.value
          if (response?.ok !== true || !value || !Array.isArray(value.groups) || !Array.isArray(value.failures) || !Array.isArray(value.routableProviders) || typeof value.default?.provider !== 'string' || typeof value.default?.model !== 'string') throw fail('MODEL_CATALOG_UNAVAILABLE')
          if (ticket === generation && !disposed) {
            for (const group of value.groups) for (const model of group.models) reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning)
            store.set({ value, status: 'ready', error: null })
          }
          return value
        }).catch(() => {
          if (ticket === generation && !disposed) store.set({ value: null, status: 'error', error: 'MODEL_CATALOG_UNAVAILABLE' })
          throw fail('MODEL_CATALOG_UNAVAILABLE')
        }).finally(() => { if (ticket === generation && inflight === operation) inflight = undefined })
      inflight = operation
      return operation
    },
    refresh() { reset(); catalog.load().catch(() => {}) },
    resetGeneration() { reasoning.clear(); catalog.refresh() },
    dispose() { disposed = true; reasoning.clear(); reset() },
  }
  return catalog
}

/** Own the native catalog seam, including resident directory subscriptions.
 * Keep native directory identity, projection, selection and scope teardown.
 * Never hold the factory catalog substitution across await.
 */
export function bindHostModelCatalogs(ctx, resolver, rpc) {
  if (typeof resolver?.directoryFor !== 'function' || typeof resolver.catalog?.load !== 'function' || typeof resolver.catalog?.store?.subscribe !== 'function' || typeof rpc?.call !== 'function' || typeof ctx?.on !== 'function' || typeof ctx?.remote?.$on !== 'function') throw fail('MODEL_INTERFACE_INCOMPATIBLE')
  const resident = resolver.live?.directories?.values
  if (!resident || typeof resident[Symbol.iterator] !== 'function' || typeof resolver.ctx?.sessions?.scope !== 'function') throw fail('MODEL_INTERFACE_INCOMPATIBLE')
  const compatible = directory => typeof directory?.syncInputs === 'function'
    && typeof directory.unsubscribeCatalog === 'function' && typeof directory.projected?.getSnapshot === 'function'
    && typeof directory.store?.getSnapshot === 'function' && typeof directory.store?.set === 'function'
    && typeof directory.catalog?.store?.subscribe === 'function'
  for (const directory of resident) {
    if (!compatible(directory)) throw fail('MODEL_INTERFACE_INCOMPATIBLE')
    sessionModelHost(directory.sessionId)
  }
  const catalogs = new Map(), bindings = new Map(), original = resolver.directoryFor
  const catalogFor = sessionId => {
    const hostId = sessionModelHost(sessionId)
    if (!catalogs.has(hostId)) catalogs.set(hostId, hostCatalog(rpc, hostId))
    return catalogs.get(hostId)
  }
  const detach = (directory, binding) => {
    binding.unsubscribe()
    if (directory.syncInputs === binding.syncInputs) {
      if (binding.descriptor) Object.defineProperty(directory, 'syncInputs', binding.descriptor)
      else delete directory.syncInputs
    }
    if (directory.catalog === binding.catalog) {
      directory.catalog = binding.nativeCatalog
      if (!directory.disposed) directory.unsubscribeCatalog = binding.nativeCatalog.store.subscribe(() => directory.syncInputs())
      directory.syncInputs()
    }
    bindings.delete(directory)
  }
  const attach = (directory, catalog, nativeCatalog) => {
    if (bindings.has(directory)) {
      if (directory.catalog !== catalog) throw fail('MODEL_INTERFACE_INCOMPATIBLE')
      return
    }
    if (!compatible(directory)) throw fail('MODEL_INTERFACE_INCOMPATIBLE')
    const scope = resolver.ctx.sessions.scope(directory.sessionId)
    if (typeof scope?.effect !== 'function') throw fail('MODEL_INTERFACE_INCOMPATIBLE')
    const descriptor = Object.getOwnPropertyDescriptor(directory, 'syncInputs'), originalSync = directory.syncInputs
    const syncInputs = function () {
      if (this.disposed) return originalSync.call(this)
      const before = this.store.getSnapshot()
      originalSync.call(this)
      const after = this.store.getSnapshot(), selected = this.projected.getSnapshot()?.next
      const retained = selected !== undefined && after.current === null && this.catalog.store.getSnapshot().value === null
      const selecting = before.status === 'selecting' && after.pending !== null
      if (retained || selecting) this.store.set({ ...after,
        ...(retained ? { current: selected } : {}), ...(selecting ? { status: 'selecting' } : {}) })
    }
    directory.unsubscribeCatalog()
    directory.catalog = catalog
    Object.defineProperty(directory, 'syncInputs', { configurable: true, writable: true, value: syncInputs })
    const unsubscribe = directory.unsubscribeCatalog = catalog.store.subscribe(() => directory.syncInputs())
    const binding = { catalog, nativeCatalog, descriptor, syncInputs, unsubscribe }
    bindings.set(directory, binding)
    try {
      binding.release = scope.effect(() => () => { if (bindings.get(directory) === binding) detach(directory, binding) }, 'runtime-interface: directory catalog binding')
      if (typeof binding.release !== 'function') throw fail('MODEL_INTERFACE_INCOMPATIBLE')
    } catch (error) {
      detach(directory, binding)
      throw error
    }
    directory.syncInputs()
    catalog.load().catch(() => {})
  }
  const descriptor = Object.getOwnPropertyDescriptor(resolver, 'directoryFor')
  const directoryFor = function (sessionId) {
    const catalog = catalogFor(sessionId)
    const previous = this.catalog
    try {
      this.catalog = catalog
      const directory = original.call(this, sessionId)
      attach(directory, catalog, directory.catalog === catalog ? previous : directory.catalog)
      return directory
    } finally { this.catalog = previous }
  }
  const restoreFactory = () => {
    if (Object.getOwnPropertyDescriptor(resolver, 'directoryFor')?.value === directoryFor) {
      if (descriptor) Object.defineProperty(resolver, 'directoryFor', descriptor)
      else delete resolver.directoryFor
    }
  }
  Object.defineProperty(resolver, 'directoryFor', { configurable: true, writable: true, value: directoryFor })
  try {
    for (const directory of resident) attach(directory, catalogFor(directory.sessionId), directory.catalog)
  } catch (error) {
    for (const binding of bindings.values()) binding.release()
    for (const catalog of catalogs.values()) catalog.dispose()
    restoreFactory()
    throw error
  }
  const refresh = () => { for (const catalog of catalogs.values()) catalog.refresh() }
  const stops = [ctx.on('connection/reset', () => { for (const catalog of catalogs.values()) catalog.resetGeneration() })]
  for (const event of ['llm/adapters-updated', 'settings/document-updated', 'credentials/reference-updated']) stops.push(ctx.remote.$on(event, refresh))
  return () => {
    for (const stop of stops) if (typeof stop === 'function') stop()
    for (const binding of bindings.values()) binding.release()
    for (const catalog of catalogs.values()) catalog.dispose()
    catalogs.clear()
    restoreFactory()
  }
}
