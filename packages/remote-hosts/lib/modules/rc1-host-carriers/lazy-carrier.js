// Public change history: docs/PUBLIC-CHANGES.md
import { classifyStreamFailure, markStreamFailure, INTERACTION_READ } from 'dsh-runtime-interface'
// Public change history: docs/PUBLIC-CHANGES.md

/** One transport generation per Host. A failed request is never replayed. */
export function lazyCarrier(connect, lifetime, { diagnostics, hostId } = {}) {
  let pending
  let current
  let phase = 'offline'
  let disposed = false
  let authenticationRefreshed = false
  let authenticationFailure
  const closedEntries = new WeakSet()
  const authRecovery = new WeakMap()
  const endpointChecks = new WeakMap()
  function drop(entry, closeSource = 'entry-death', errorCode, endpoint = 'host/describe') {
    if (current === entry) {
      current = undefined
      phase = 'offline'
    }
    if (entry && !closedEntries.has(entry)) {
      closedEntries.add(entry)
      try { diagnostics?.record({ phase: 'carrier_drop', endpoint, hostId, entryId: entry.entryId, operation: 'lazy-drop', closeSource, errorCode }) } catch { /* diagnostics must not affect lifecycle */ }
      entry.close(closeSource)
    }
  }
  function refreshAuthentication(entry, endpoint) {
    if (!authRecovery.has(entry)) {
      const superseded = current !== undefined && current !== entry
      const refresh = superseded || !authenticationRefreshed
      authRecovery.set(entry, refresh)
      if (!superseded) authenticationRefreshed = true
      if (!refresh) authenticationFailure = new Error('CARRIER_RESULT_HTTP_401')
      drop(entry, 'auth-refused', 'CARRIER_RESULT_HTTP_401', endpoint)
    }
    return authRecovery.get(entry)
      ? markStreamFailure(new Error('CARRIER_DISCONNECTED'), classifyStreamFailure({ reason: 'transport-disconnected' }))
      : undefined
  }
  async function get() {
    lifetime.throwIfAborted()
    if (disposed) throw new Error('HOST_CARRIER_CLOSED')
    if (authenticationFailure) throw authenticationFailure
    if (current) return current
    if (!pending) {
      phase = 'connecting'
      pending = Promise.resolve().then(() => connect(lifetime)).then(entry => {
        if (disposed || lifetime.aborted || authenticationFailure) { entry.close(); throw authenticationFailure ?? new Error('HOST_CARRIER_CLOSED') }
        current = entry
        phase = 'connected'
        const ended = () => { if (current === entry) { current = undefined; phase = 'offline' } }
        entry.closed?.then(ended, ended)
        return entry
      }).catch(error => {
        if (current === undefined) phase = 'offline'
        throw error
      }).finally(() => { pending = undefined })
    }
    return pending
  }
  const close = (closeSource = 'caller-close') => { disposed = true; drop(current, closeSource); phase = 'offline' }
  async function forCaller(signal, work = get) {
    signal?.throwIfAborted()
    const connection = work()
    if (!signal) return connection
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try { return await Promise.race([connection, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  async function refreshEndpoint(entry, error, endpoint, signal) {
    if (current !== entry || signal?.aborted || lifetime.aborted || typeof entry.endpointChanged !== 'function') return
    if (!['connect-failed', 'transport-disconnected', 'stream-ended'].includes(classifyStreamFailure(error).reason)) return
    let checking = endpointChecks.get(entry)
    if (!checking) {
      checking = Promise.resolve().then(() => entry.endpointChanged(entry.signal ?? lifetime))
        .catch(() => false).finally(() => endpointChecks.delete(entry))
      endpointChecks.set(entry, checking)
    }
    if (await forCaller(signal, () => checking) && current === entry && !signal?.aborted && !lifetime.aborted) {
      drop(entry, 'desktop-endpoint-changed', 'CARRIER_DISCONNECTED', endpoint)
    }
  }
  const lostAuthenticationOrConnection = error => ['CARRIER_RESULT_HTTP_401', 'CARRIER_DISCONNECTED', 'CARRIER_STREAM_ENDED'].includes(error?.message)
  lifetime.addEventListener('abort', () => close('host-lifetime'), { once: true })
  return {
    get upstreamVersion() { return current?.carrier.upstreamVersion },
    getState() { return phase },
    async connect(signal) { await forCaller(signal); return phase },
// Public change history: docs/PUBLIC-CHANGES.md
    async ensureCapability(endpoint, signal) {
      const entry = await forCaller(signal)
      try { await entry.carrier.ensureCapability?.(endpoint, signal ?? lifetime) }
      catch (error) { await refreshEndpoint(entry, error, endpoint, signal); if (lostAuthenticationOrConnection(error)) drop(entry, error?.message === 'CARRIER_RESULT_HTTP_401' ? 'auth-refused' : 'entry-death', error?.message, endpoint); throw error }
    },
    async raw(path, init = {}) {
      const entry = await forCaller(init.signal)
      init.signal?.throwIfAborted()
      let response
      try { response = await entry.carrier.raw(path, init) }
      catch (error) { await refreshEndpoint(entry, error, 'other', init.signal); throw error }
      if (response.status === 401) drop(entry, 'auth-refused', 'CARRIER_RESULT_HTTP_401', 'other')
      return response
    },
    async call(endpoint, payload, signal) {
      const entry = await forCaller(signal)
      signal?.throwIfAborted()
      // Only a connection death invalidates the carrier. Business/timeout errors do not
      // destroy another browser's active streams, nor replay this side-effectful call.
      try {
        const result = await entry.carrier.call(endpoint, payload, signal ?? lifetime)
        if (endpoint === INTERACTION_READ && current === entry && result?.ok === true) authenticationRefreshed = false
        return result
      } catch (error) {
        if (!signal?.aborted && !lifetime.aborted && endpoint === INTERACTION_READ && error?.message === 'CARRIER_RESULT_HTTP_401') {
          throw refreshAuthentication(entry, endpoint) ?? error
        }
        await refreshEndpoint(entry, error, endpoint, signal)
        if (lostAuthenticationOrConnection(error)) drop(entry, error?.message === 'CARRIER_RESULT_HTTP_401' ? 'auth-refused' : 'entry-death', error?.message, endpoint)
        throw error
      }
    },
    async *open(endpoint, payload, signal, options) {
      const entry = await forCaller(signal)
      // 普通读流错误保持隔离；握手401说明这代Cookie失效，交回Hub已有退避重开。
      try {
        for await (const item of entry.carrier.open(endpoint, payload, signal ?? lifetime, options)) {
          if (current === entry) authenticationRefreshed = false
          yield item
        }
      } catch (error) {
        if (!signal?.aborted && !lifetime.aborted && error?.message === 'CARRIER_STREAM_UNAUTHORIZED' && error.httpStatus === 401) {
          throw refreshAuthentication(entry, endpoint) ?? error
        }
        await refreshEndpoint(entry, error, endpoint, signal)
        throw error
      }
    },
    close,
  }
}
