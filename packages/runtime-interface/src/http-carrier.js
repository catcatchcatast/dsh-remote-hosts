// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                   
                                                                                                                                                     
                                                                                                                                                                   
                                                                                                                                                 
                                                                                                                                                   
                                                                                                                                               
                                                                                                                                             
                                                                                                                                         
import { randomUUID } from 'node:crypto'
import { classifyStreamFailure, markStreamFailure, sanitizeTransportDiagnostic } from './stream-failure.js'

                                                                                                                                           
const sidebarFileRoutes = new Set(['session.cwd', 'fs.tree', 'fs.search', 'fs.read', 'fs.write'].map(method => '/sidebar/api/' + method))

/** Official, in-memory authenticated loopback carrier; no token logging or RPC replay. */
export async function createCarrier(origin, authenticatedUrl, WebSocket, signal, { diagnostics, hostId, entryId = randomUUID() } = {}) {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) throw new Error('CARRIER_ORIGIN_INVALID')
  const entry = new URL(authenticatedUrl)
  if (entry.origin !== base.origin || entry.pathname !== '/' || !entry.searchParams.get('token')) throw new Error('CARRIER_AUTH_INVALID')
  const exchange = await fetch(entry, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  await exchange.body?.cancel()
  if (exchange.status !== 303 || !['/', './'].includes(exchange.headers.get('location')) || !cookie) throw new Error('CARRIER_AUTH_FAILED')
  const recorded = new Set()
  let firstErrorRead
  const trace = (operation, endpoint, readId, metadata = {}) => {
    // Retain the first error read's terminal close even if a healthy read closed first.
    // An unsolicited EOF may have no error event; preserve its first close separately.
    const unexpectedEof = operation === 'ws-close' && metadata.closeSource === 'socket-eof' && metadata.cancelSource === 'none'
    const key = unexpectedEof ? 'ws-first-eof' : operation === 'ws-close' && readId === firstErrorRead ? 'ws-error-close' : operation
    if (recorded.has(key)) return
    recorded.add(key)
    if (key === 'ws-error-close' || key === 'ws-first-eof') recorded.add('ws-close')
    if (operation === 'ws-error') firstErrorRead = readId
    try { diagnostics?.record({ phase: operation === 'ws-error' ? 'carrier_error' : 'carrier_close',
      endpoint, hostId, entryId, readId, operation, ...metadata }) } catch { /* existing journal is best effort */ }
  }
  const carrier = {
    async raw(path, init = {}) {
      const url = new URL(path, base)
      const sidebarJson = sidebarFileRoutes.has(url.pathname)
      const sidebarUpload = url.pathname === '/sidebar/upload'
      const sidebarFile = url.pathname === '/sidebar/file'
                                                                                                                                                         
      const officialFileUpload = url.pathname === '/api/session/uploadFileBinary'
      const workspaceFileBytes = url.pathname === '/api/workspaceFiles/readBytes' || url.pathname === '/api/officeToPdf/render'
      if (url.origin !== base.origin || (!sidebarJson && !sidebarUpload && !sidebarFile && !officialFileUpload && !workspaceFileBytes && url.pathname !== '/api/upload' && !['/api/upload/v2/', '/api/file-browser/v1/'].some(prefix => url.pathname.startsWith(prefix)))) throw new Error('CARRIER_ROUTE_INVALID')
      const method = init.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('CARRIER_METHOD_INVALID')
      if ((officialFileUpload || workspaceFileBytes) && method !== 'POST') throw new Error('CARRIER_METHOD_INVALID')
      if (workspaceFileBytes && new Headers(init.headers).get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new Error('CARRIER_CONTENT_TYPE_INVALID')
      if (officialFileUpload) {
        const contentType = new Headers(init.headers).get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/octet-stream') throw new Error('CARRIER_CONTENT_TYPE_INVALID')
      }
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
      if (endpoint !== 'host.describe' && !/^[a-zA-Z$][a-zA-Z0-9$/]*$/.test(endpoint)) throw new Error('CARRIER_ROUTE_INVALID')
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
                                                                                                                                                                   
      // A shared connection can die while this reader still wants updates.
      // Preserve caller cancellation; let the interface classify connection loss.
      const throwIfStopped = () => {
        requestSignal.throwIfAborted()
        if (signal.aborted) throw new Error('CARRIER_DISCONNECTED')
      }
      throwIfStopped()
      const streamId = randomUUID()
      const maxReadBytes = endpoint === 'session/follow' ? 32 * 1024 * 1024 : 16 * 1024 * 1024
      const cancellation = () => requestSignal.aborted ? 'caller' : signal.aborted ? 'entry' : 'none'
      const socket = new WebSocket(new URL('/api/remote.mux', base).href.replace('http:', 'ws:'), { headers: { Cookie: cookie }, maxPayload: maxReadBytes })
      const queue = []
      let queuedBytes = 0
      let ended = false
      let normalEnd = false
      let failure
      let endSource
      let receivedItem = false
      let wake
      let transport
      let lastProgressPong = -Infinity
      const stopTransportProgress = () => {
        transport?.removeListener('data', onTransportProgress)
        transport = undefined
      }
      // Control Ping may sit behind an unfinished large frame. Actual incoming
      // bytes permit one standard empty Pong per second; silence never does.
      const onTransportProgress = bytes => {
        if (!bytes.length || ended || streamSignal.aborted || socket.readyState !== WebSocket.OPEN) return
        const now = performance.now()
        if (now - lastProgressPong < 1000) return
        lastProgressPong = now
        socket.pong()
      }
      const watchTransportProgress = response => {
        if (ended || streamSignal.aborted) return
        transport = response.socket
        transport.on('data', onTransportProgress)
      }
      socket.once('upgrade', watchTransportProgress)
      const notify = () => { wake?.(); wake = undefined }
      const abort = () => {
        ended = true
        stopTransportProgress()
        trace('ws-cancel', endpoint, streamId, { cancelSource: cancellation(), closeSource: requestSignal.aborted ? 'caller-abort' : 'entry-abort' })
        socket.terminate(); notify()
      }
      streamSignal.addEventListener('abort', abort, { once: true })
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })))
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString())
          if (frame.streamId !== streamId) return
          if (frame.type === 'item') {
            receivedItem = true
            queuedBytes += raw.length
            if (queuedBytes > maxReadBytes) throw new Error('overflow')
            queue.push({ value: frame.value, bytes: raw.length })
          } else if (frame.type === 'end') {
            ended = true; stopTransportProgress(); normalEnd = true; endSource = 'protocol-end'
            trace('ws-end', endpoint, streamId, { closeSource: endSource, cancelSource: cancellation() })
          }
          else if (frame.type === 'error') { ended = true; stopTransportProgress(); endSource = 'protocol-error'; failure = Object.assign(new Error(frame.error?.message ?? 'CARRIER_STREAM_ERROR'), { code: frame.error?.code, details: frame.error?.details }) }
          else throw new Error('CARRIER_STREAM_INVALID')
        } catch { failure = new Error('CARRIER_STREAM_INVALID'); ended = true; stopTransportProgress(); socket.terminate() }
        notify()
      })
      socket.on('error', error => {
        const status = Number(/^Unexpected server response: (\d{3})$/.exec(error?.message ?? '')?.[1]) || undefined
        const stage = receivedItem ? 'live' : 'bootstrap'
        const transport = classifyStreamFailure(error, { source: 'carrier', stage })
        const reason = status === 401 || status === 403 ? 'unauthorized' : transport.reason === 'unknown' ? 'transport-disconnected' : transport.reason
        const classification = classifyStreamFailure({ source: 'carrier', reason }, { stage })
        const code = { unauthorized: 'runtime-interface/unauthorized', 'resource-limit': 'runtime-interface/buffer-limit', 'invalid-frame': 'runtime-interface/invalid-frame' }[reason] ?? 'transport/disconnected'
        failure = markStreamFailure(Object.assign(new Error(reason === 'unauthorized' ? 'CARRIER_STREAM_UNAUTHORIZED' : 'CARRIER_STREAM_DISCONNECTED'), { code }), classification)
        ended = true; stopTransportProgress(); endSource = 'socket-error'
        trace('ws-error', endpoint, streamId, { ...sanitizeTransportDiagnostic({ errorCode: error?.code, httpStatus: status }),
          source: 'carrier', reason, stage: receivedItem ? 'live' : 'bootstrap', cancelSource: cancellation() })
        notify()
      })
      socket.on('close', closeCode => {
        ended = true
        stopTransportProgress()
        trace('ws-close', endpoint, streamId, { closeCode, cancelSource: cancellation(), closeSource: endSource ?? (requestSignal.aborted ? 'caller-abort' : signal.aborted ? 'entry-abort' : 'socket-eof') })
        notify()
      })
      try {
        while (true) {
          throwIfStopped()
          if (failure) throw failure
          if (queue.length) { const item = queue.shift(); queuedBytes -= item.bytes; yield item.value; continue }
                                                                                                                                                           
          if (ended) { if (normalEnd && (endpoint === 'job/follow' || endpoint === 'userQuestions/attachWait')) return; throw new Error('CARRIER_STREAM_ENDED') }
          await new Promise(resolve => { wake = resolve })
        }
      } finally {
        streamSignal.removeEventListener('abort', abort)
        socket.removeListener('upgrade', watchTransportProgress)
        stopTransportProgress()
        if (!ended) {
          endSource = 'reader-return'
          trace('ws-cancel', endpoint, streamId, { closeSource: endSource, cancelSource: cancellation() })
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
        socket.terminate()
      }
    },
  }
  carrier.events = () => carrier.open('$events', { args: {} })
  return carrier
}
