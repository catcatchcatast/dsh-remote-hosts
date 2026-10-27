// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                                                                     
                                                                                                                                                   
                                                                                                                                         
                                                                                                                                                                       
                                                                                                                                               
                                                                                                                                     

/** One transport generation per Host. A failed request is never replayed. */
export function lazyCarrier(connect, lifetime, { diagnostics, hostId } = {}) {
  let pending
  let current
  let phase = 'offline'
  let disposed = false
  const closedEntries = new WeakSet()
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
  async function get() {
    lifetime.throwIfAborted()
    if (disposed) throw new Error('HOST_CARRIER_CLOSED')
    if (current) return current
    if (!pending) {
      phase = 'connecting'
      pending = Promise.resolve().then(() => connect(lifetime)).then(entry => {
        if (disposed || lifetime.aborted) { entry.close(); throw new Error('HOST_CARRIER_CLOSED') }
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
  async function forCaller(signal) {
    signal?.throwIfAborted()
    const connection = get()
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
  const lostAuthenticationOrConnection = error => ['CARRIER_RESULT_HTTP_401', 'CARRIER_DISCONNECTED', 'CARRIER_STREAM_ENDED'].includes(error?.message)
  lifetime.addEventListener('abort', () => close('host-lifetime'), { once: true })
  return {
    get upstreamVersion() { return current?.carrier.upstreamVersion },
    getState() { return phase },
    async connect(signal) { await forCaller(signal); return phase },
                                                                                          
    async ensureCapability(endpoint, signal) {
      const entry = await forCaller(signal)
      try { await entry.carrier.ensureCapability?.(endpoint, signal ?? lifetime) }
      catch (error) { if (lostAuthenticationOrConnection(error)) drop(entry, error?.message === 'CARRIER_RESULT_HTTP_401' ? 'auth-refused' : 'entry-death', error?.message, endpoint); throw error }
    },
    async raw(path, init = {}) {
      const entry = await forCaller(init.signal)
      init.signal?.throwIfAborted()
      const response = await entry.carrier.raw(path, init)
      if (response.status === 401) drop(entry, 'auth-refused', 'CARRIER_RESULT_HTTP_401', 'other')
      return response
    },
    async call(endpoint, payload, signal) {
      const entry = await forCaller(signal)
      signal?.throwIfAborted()
      // Only a connection death invalidates the carrier. Business/timeout errors do not
      // destroy another browser's active streams, nor replay this side-effectful call.
      try { return await entry.carrier.call(endpoint, payload, signal ?? lifetime) }
      catch (error) { if (lostAuthenticationOrConnection(error)) drop(entry, error?.message === 'CARRIER_RESULT_HTTP_401' ? 'auth-refused' : 'entry-death', error?.message, endpoint); throw error }
    },
    async *open(endpoint, payload, signal, options) {
      const entry = await forCaller(signal)
      // Independent read sockets cannot invalidate their peers. Shared death
      // is driven by entry.closed / Host lifetime, never by one reader's error.
      yield* entry.carrier.open(endpoint, payload, signal ?? lifetime, options)
    },
    close,
  }
}
