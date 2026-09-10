import { randomUUID } from 'node:crypto'

const sidebarFileRoutes = new Set(['session.cwd', 'fs.tree', 'fs.search', 'fs.read', 'fs.write'].map(method => '/sidebar/api/' + method))

/** Official, in-memory authenticated loopback carrier; no token logging or RPC replay. */
export async function createCarrier(origin, authenticatedUrl, WebSocket, signal) {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) throw new Error('CARRIER_ORIGIN_INVALID')
  const entry = new URL(authenticatedUrl)
  if (entry.origin !== base.origin || entry.pathname !== '/' || !entry.searchParams.get('token')) throw new Error('CARRIER_AUTH_INVALID')
  const exchange = await fetch(entry, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  await exchange.body?.cancel()
  if (exchange.status !== 303 || exchange.headers.get('location') !== '/' || !cookie) throw new Error('CARRIER_AUTH_FAILED')
  const carrier = {
    async raw(path, init = {}) {
      const url = new URL(path, base)
      const sidebarJson = sidebarFileRoutes.has(url.pathname)
      const sidebarUpload = url.pathname === '/sidebar/upload'
      const sidebarFile = url.pathname === '/sidebar/file'
      if (url.origin !== base.origin || (!sidebarJson && !sidebarUpload && !sidebarFile && url.pathname !== '/api/upload' && !['/api/upload/v2/', '/api/file-browser/v1/'].some(prefix => url.pathname.startsWith(prefix)))) throw new Error('CARRIER_ROUTE_INVALID')
      const method = init.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('CARRIER_METHOD_INVALID')
      if (((sidebarJson || sidebarUpload) && method !== 'POST') || (sidebarFile && method !== 'GET')) throw new Error('CARRIER_METHOD_INVALID')
      const headers = new Headers()
      for (const [key, value] of new Headers(init.headers)) {
        if (['content-type', 'content-length', 'x-session-id', 'x-file-name', 'x-file-relpath', 'x-file-path', 'range', 'if-range', 'accept', 'upload-offset', 'x-upload-offset', 'upload-length', 'x-upload-length', 'chunk-length', 'x-chunk-length', 'upload-checksum', 'x-chunk-sha256', 'chunk-sha256', 'x-file-sha256', 'file-sha256'].includes(key)) headers.set(key, value)
      }
      headers.set('Cookie', cookie)
      return fetch(url, {
        method, headers, body: init.body, redirect: 'error',
        ...(init.body == null ? {} : { duplex: 'half' }),
        signal: AbortSignal.any([signal, init.signal ?? signal]),
      })
    },
    async call(endpoint, payload, requestSignal = signal) {
      if (!/^[a-zA-Z$][a-zA-Z0-9$/]*$/.test(endpoint)) throw new Error('CARRIER_ROUTE_INVALID')
      const rpcId = randomUUID()
      const response = await fetch(new URL(`/api/${endpoint}`, base), {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        signal: AbortSignal.any([signal, requestSignal, AbortSignal.timeout(endpoint === 'session/list' ? 60000 : 15000)]),
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`CARRIER_RESULT_HTTP_${response.status}`) }
      const reply = await response.json()
      if (reply.type !== 'server-response' || reply.rpcId !== rpcId || typeof reply.result?.ok !== 'boolean') throw new Error('CARRIER_RESULT_INVALID')
      return reply.result
    },
    async result(payload) {
      if ((await carrier.call('$events/result', { args: payload })).ok !== true) throw new Error('CARRIER_RESULT_REJECTED')
    },
    async *open(endpoint, payload, requestSignal = signal) {
      if (!/^[a-zA-Z$][a-zA-Z0-9$/]*$/.test(endpoint)) throw new Error('CARRIER_ROUTE_INVALID')
      const streamSignal = AbortSignal.any([signal, requestSignal])
      streamSignal.throwIfAborted()
      const socket = new WebSocket(new URL('/api/remote.mux', base).href.replace('http:', 'ws:'), { headers: { Cookie: cookie }, maxPayload: 8 * 1024 * 1024 })
      const streamId = randomUUID()
      const queue = []
      let queuedBytes = 0
      let ended = false
      let failure
      let wake
      const notify = () => { wake?.(); wake = undefined }
      const abort = () => { ended = true; socket.terminate(); notify() }
      streamSignal.addEventListener('abort', abort, { once: true })
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })))
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString())
          if (frame.streamId !== streamId) return
          if (frame.type === 'item') {
            queuedBytes += raw.length
            if (queuedBytes > 8 * 1024 * 1024) throw new Error('overflow')
            queue.push({ value: frame.value, bytes: raw.length })
          } else { ended = true; if (frame.type === 'error') failure = new Error('CARRIER_STREAM_ERROR') }
        } catch { failure = new Error('CARRIER_STREAM_INVALID'); ended = true; socket.terminate() }
        notify()
      })
      socket.on('error', () => { failure = new Error('CARRIER_DISCONNECTED'); ended = true; notify() })
      socket.on('close', () => { ended = true; notify() })
      try {
        while (true) {
          streamSignal.throwIfAborted()
          if (failure) throw failure
          if (queue.length) { const item = queue.shift(); queuedBytes -= item.bytes; yield item.value; continue }
          if (ended) throw new Error('CARRIER_STREAM_ENDED')
          await new Promise(resolve => { wake = resolve })
        }
      } finally {
        streamSignal.removeEventListener('abort', abort)
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
        socket.terminate()
      }
    },
  }
  carrier.events = () => carrier.open('$events', { args: {} })
  return carrier
}
