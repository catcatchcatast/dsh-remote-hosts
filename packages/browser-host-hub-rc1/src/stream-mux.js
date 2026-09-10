import { WebSocketServer } from 'ws'

export const BROWSER_STREAM_PATH = '/api/browser-host-hub-rc1/streams'

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
const STREAM_ENDPOINTS = new Set(['workspace/follow', 'session/control', 'session/follow', '$events'])

const byteLength = value => Buffer.byteLength(value, 'utf8')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function positiveLimit(value, fallback) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

function protocolError(code, message, details = {}) {
  return { code, message, details }
}

function streamError(error, fallbackCode = 'browser-host-hub-rc1/stream-failure') {
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return protocolError(error.code, error.message, isRecord(error.details) ? error.details : {})
  }
  return protocolError(fallbackCode, error instanceof Error && error.message ? error.message : 'Browser stream failed')
}

class FairSocketSender {
  #socket
  #maxFrameBytes
  #maxStreamQueuedBytes
  #maxSocketQueuedBytes
  #onOverflow
  #onFailure
  #queues = new Map()
  #ready = []
  #queuedBytes = 0
  #sending = false
  #inFlightStream
  #closed = false

  constructor(socket, options, onOverflow, onFailure) {
    this.#socket = socket
    this.#maxFrameBytes = options.maxFrameBytes
    this.#maxStreamQueuedBytes = options.maxStreamQueuedBytes
    this.#maxSocketQueuedBytes = options.maxSocketQueuedBytes
    this.#onOverflow = onOverflow
    this.#onFailure = onFailure
  }

  enqueue(streamId, value, force = false) {
    if (this.#closed || this.#socket.readyState !== 1) return false
    const text = JSON.stringify(value)
    const bytes = byteLength(text)
    if (bytes > this.#maxFrameBytes) {
      if (force) this.#onFailure(new Error('terminal stream frame exceeds the configured frame limit'))
      else this.#onOverflow(streamId, 'frame')
      return false
    }
    const queue = this.#queue(streamId)
    if (force && (queue.bytes + bytes > this.#maxStreamQueuedBytes || this.#queuedBytes + bytes > this.#maxSocketQueuedBytes)) {
      this.#onFailure(new Error('terminal stream frame exceeds the bounded send queue'))
      return false
    }
    if (!force && (queue.bytes + bytes > this.#maxStreamQueuedBytes || this.#queuedBytes + bytes > this.#maxSocketQueuedBytes)) {
      this.#onOverflow(streamId, queue.bytes + bytes > this.#maxStreamQueuedBytes ? 'stream' : 'socket')
      return false
    }
    queue.items.push({ text, bytes })
    queue.bytes += bytes
    this.#queuedBytes += bytes
    if (!queue.ready && this.#inFlightStream !== streamId) {
      queue.ready = true
      this.#ready.push(streamId)
    }
    this.#drain()
    return true
  }

  drop(streamId) {
    const queue = this.#queues.get(streamId)
    if (queue === undefined) return
    const pendingBytes = queue.items.reduce((total, item) => total + item.bytes, 0)
    this.#queuedBytes -= pendingBytes
    queue.bytes -= pendingBytes
    queue.items.length = 0
    queue.ready = false
    this.#ready = this.#ready.filter(candidate => candidate !== streamId)
    if (this.#inFlightStream !== streamId) this.#queues.delete(streamId)
  }

  close() {
    this.#closed = true
    this.#queues.clear()
    this.#ready.length = 0
    this.#queuedBytes = 0
  }

  #queue(streamId) {
    let queue = this.#queues.get(streamId)
    if (queue === undefined) {
      queue = { items: [], bytes: 0, ready: false }
      this.#queues.set(streamId, queue)
    }
    return queue
  }

  #drain() {
    if (this.#closed || this.#sending || this.#socket.readyState !== 1) return
    while (this.#ready.length > 0) {
      const streamId = this.#ready.shift()
      const queue = this.#queues.get(streamId)
      if (queue === undefined) continue
      queue.ready = false
      const item = queue.items.shift()
      if (item === undefined) continue
      this.#sending = true
      this.#inFlightStream = streamId
      try {
        this.#socket.send(item.text, error => {
          this.#sending = false
          this.#inFlightStream = undefined
          // ws 8 reports a successful send as either undefined or null,
          // depending on the concrete socket path.
          if (error != null) {
            this.#onFailure(error)
            return
          }
          const current = this.#queues.get(streamId)
          if (current !== undefined) {
            current.bytes -= item.bytes
            this.#queuedBytes -= item.bytes
          }
          if (current?.items.length) {
            current.ready = true
            this.#ready.push(streamId)
          } else if (current !== undefined) this.#queues.delete(streamId)
          this.#drain()
        })
      } catch (error) {
        this.#sending = false
        this.#inFlightStream = undefined
        this.#onFailure(error)
      }
      return
    }
  }
}

/** Own one accepted WebSocket and multiplex the four browser streaming RPCs. */
export function serveStreamSocket(socket, hub, options = {}) {
  if (!socket || typeof socket.on !== 'function' || typeof socket.send !== 'function') throw new TypeError('socket must expose on/send')
  if (!hub || typeof hub.openStream !== 'function') throw new TypeError('hub.openStream is required')
  const maxFrameBytes = positiveLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES)
  const limits = {
    maxFrameBytes,
    maxStreamQueuedBytes: positiveLimit(options.maxStreamQueuedBytes, maxFrameBytes * 2),
    maxSocketQueuedBytes: positiveLimit(options.maxSocketQueuedBytes, maxFrameBytes * 4),
  }
  const streams = new Map()
  let open = true
  let streamPrefix
  let lastStreamNumber = 0

  const closeIterator = record => {
    if (record.returned) return
    record.returned = true
    record.controller.abort(new Error('browser stream closed'))
    try {
      void Promise.resolve(record.iterator.return?.()).catch(() => {})
    } catch { /* one broken iterator must not block the remaining releases */ }
  }
  const failSocket = () => {
    if (!open) return
    open = false
    sender.close()
    for (const record of streams.values()) closeIterator(record)
    streams.clear()
    if (socket.readyState === 1) {
      try { socket.close?.(1011, 'stream transport failure') } catch { /* socket is already failing */ }
    }
  }
  const terminal = (streamId, type, error) => {
    const record = streams.get(streamId)
    if (record === undefined || record.terminal) return
    record.terminal = true
    if (type === 'error') closeIterator(record)
    sender.enqueue(streamId, type === 'end'
      ? { type: 'end', streamId }
      : { type: 'error', streamId, error: streamError(error) }, true)
    streams.delete(streamId)
  }
  const overflow = (streamId, kind) => {
    if (kind === 'socket') {
      failSocket()
      return
    }
    const record = streams.get(streamId)
    if (record === undefined || record.terminal) return
    sender.drop(streamId)
    terminal(streamId, 'error', protocolError(
      'browser-host-hub-rc1/stream-backpressure',
      'Browser stream exceeded its bounded send queue',
      { limit: kind },
    ))
  }
  const sender = new FairSocketSender(socket, limits, overflow, failSocket)

  const acceptStreamId = streamId => {
    const separator = typeof streamId === 'string' ? streamId.lastIndexOf(':') : -1
    if (separator <= 0) return false
    const prefix = streamId.slice(0, separator)
    const suffix = streamId.slice(separator + 1)
    if (!/^[1-9a-z][0-9a-z]*$/.test(suffix)) return false
    const value = Number.parseInt(suffix, 36)
    if (!Number.isSafeInteger(value) || value <= lastStreamNumber) return false
    if (streamPrefix !== undefined && prefix !== streamPrefix) return false
    streamPrefix = prefix
    lastStreamNumber = value
    return true
  }

  const cancel = streamId => {
    const record = streams.get(streamId)
    if (record === undefined || record.terminal) return
    record.terminal = true
    streams.delete(streamId)
    sender.drop(streamId)
    closeIterator(record)
  }
  const start = message => {
    const { streamId, endpoint, payload } = message
    if (typeof streamId !== 'string' || streamId.length === 0 || typeof endpoint !== 'string' || !STREAM_ENDPOINTS.has(endpoint)) {
      if (typeof streamId === 'string' && streamId.length > 0) {
        sender.enqueue(streamId, { type: 'error', streamId, error: protocolError('browser-host-hub-rc1/invalid-stream-request', 'Invalid stream open request') }, true)
      }
      return
    }
    if (!acceptStreamId(streamId) || streams.has(streamId)) {
      try { socket.close?.(1008, 'non-monotonic stream id') } finally { failSocket() }
      return
    }
    const controller = new AbortController()
    let iterator
    try {
      const stream = hub.openStream(endpoint, payload, controller.signal)
      iterator = stream?.[Symbol.asyncIterator]?.()
      if (iterator === undefined || typeof iterator.next !== 'function') throw new TypeError('hub stream must be async iterable')
    } catch (error) {
      sender.enqueue(streamId, { type: 'error', streamId, error: streamError(error) }, true)
      return
    }
    const record = { controller, iterator, returned: false, terminal: false }
    streams.set(streamId, record)
    void (async () => {
      try {
        for (;;) {
          const item = await iterator.next()
          if (!open || record.terminal) return
          if (item.done) {
            terminal(streamId, 'end')
            return
          }
          if (!sender.enqueue(streamId, { type: 'item', streamId, value: item.value })) return
        }
      } catch (error) {
        if (open && !record.terminal) terminal(streamId, 'error', error)
      }
    })()
  }

  socket.on('message', raw => {
    if (!open) return
    let message
    try { message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) } catch {
      try { socket.close?.(1008, 'invalid stream protocol') } finally { failSocket() }
      return
    }
    if (!isRecord(message)) return
    if (message.type === 'open') start(message)
    else if (message.type === 'cancel' && typeof message.streamId === 'string') cancel(message.streamId)
  })
  socket.once('close', failSocket)
  socket.once('error', failSocket)
  return failSocket
}

function rejectUpgrade(socket, status, message) {
  if (socket?.destroyed) return
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable'
  const bytes = Buffer.byteLength(message)
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${bytes}\r\n\r\n${message}`)
}

function sameOrigin(request) {
  const origin = request?.headers?.origin
  const host = request?.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string' || origin.length === 0 || host.length === 0) return false
  try {
    const expectedProtocol = request?.socket?.encrypted === true ? 'https:' : 'http:'
    const parsed = new URL(origin)
    const expected = new URL(`${expectedProtocol}//${host}`)
    return parsed.origin === expected.origin && parsed.pathname === '/' && !parsed.search && !parsed.hash
  } catch { return false }
}

/** Register the authenticated, same-origin WebSocket upgrade route. */
export function registerStreamMux(ctx, hub, options = {}) {
  if (!ctx?.webServer || typeof ctx.webServer.registerUpgrade !== 'function') throw new TypeError('webServer.registerUpgrade is required')
  if (!ctx?.connection || typeof ctx.connection.requestRejection !== 'function') throw new TypeError('connection.requestRejection is required')
  const maxFrameBytes = positiveLimit(options.maxFrameBytes ?? options.maxResponseBytes, DEFAULT_MAX_FRAME_BYTES)
  const streamOptions = {
    maxFrameBytes,
    maxStreamQueuedBytes: positiveLimit(options.maxStreamQueuedBytes, maxFrameBytes * 2),
    maxSocketQueuedBytes: positiveLimit(options.maxSocketQueuedBytes, maxFrameBytes * 4),
  }
  const webSocketServer = options.webSocketServer ?? new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: maxFrameBytes,
  })
  const disposeRoute = ctx.webServer.registerUpgrade({
    path: options.streamPath ?? BROWSER_STREAM_PATH,
    async handler(request, socket, head) {
      let rejection
      try { rejection = await ctx.connection.requestRejection(request) } catch { rejection = 503 }
      if (rejection !== undefined) {
        rejectUpgrade(socket, rejection === 401 || rejection === 403 ? rejection : 503, rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'service unavailable')
        return
      }
      if (!sameOrigin(request)) {
        rejectUpgrade(socket, 403, 'forbidden')
        return
      }
      webSocketServer.handleUpgrade(request, socket, head, accepted => { serveStreamSocket(accepted, hub, streamOptions) })
    },
  })
  return () => {
    disposeRoute?.()
    if (webSocketServer.clients !== undefined) {
      for (const client of webSocketServer.clients) {
        try { client.close(1001, 'service stopped') } catch { /* best-effort teardown */ }
      }
    }
    try { webSocketServer.close() } catch { /* injected test servers may already be closed */ }
  }
}
