// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                             
                                                                                                                                                     
                                                                                                                                                                   
                                                                                                                                             
                                                                                                                                             
                                                                                                                                     
                                                                                                                                                     
import { WebSocketServer } from 'ws'
import { classifyStreamFailure, markStreamFailure } from 'dsh-runtime-interface'
import { decodeBrowserStreamFrame, encodeBrowserStreamFailure } from 'dsh-runtime-interface/browser'

export const BROWSER_STREAM_PATH = '/api/browser-host-hub-rc1/streams'

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
const STREAM_ENDPOINTS = new Set(['workspaceFiles/changes', 'workspace/follow', 'session/control', 'session/follow', 'job/list', 'job/follow', '$events'])

const byteLength = value => Buffer.byteLength(value, 'utf8')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function positiveLimit(value, fallback) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

function protocolError(code, message, details = {}) {
  return { code, message, details }
}

function streamError(error, stage = 'live') {
  return encodeBrowserStreamFailure(error, { stage })
}

function backpressureError(limit) {
  return protocolError(
    'browser-host-hub-rc1/stream-backpressure',
    'Browser stream exceeded its bounded send queue',
    { limit },
  )
}

function transportError(value) {
  if (value instanceof Error) {
    const failure = classifyStreamFailure(value, { stage: 'live' })
    if (failure.reason !== 'unknown') return value
    return Object.assign(value, { code: 'browser-host-hub-rc1/stream-disconnected' })
  }
  if (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string') {
    const failure = classifyStreamFailure(value, { stage: 'live' })
    if (failure.reason !== 'unknown') return value
  }
  return Object.assign(new Error('Browser stream WebSocket disconnected'), {
    code: 'browser-host-hub-rc1/stream-disconnected',
  })
}

function abortError(error, stage) {
  const reason = error instanceof Error
    ? error
    : Object.assign(new Error(typeof error?.message === 'string' ? error.message : 'Browser stream failed'), {
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(isRecord(error?.details) ? { details: error.details } : {}),
      })
  return markStreamFailure(reason, classifyStreamFailure(reason, { stage }))
}

class BoundedSocketSender {
  #socket
  #maxFrameBytes
  #maxStreamQueuedBytes
  #maxSocketQueuedBytes
  #onOverflow
  #onFailure
  #streams = new Map()
  #queuedBytes = 0
  #closed = false

  constructor(socket, options, onOverflow, onFailure) {
    this.#socket = socket
    this.#maxFrameBytes = options.maxFrameBytes
    this.#maxStreamQueuedBytes = options.maxStreamQueuedBytes
    this.#maxSocketQueuedBytes = options.maxSocketQueuedBytes
    this.#onOverflow = onOverflow
    this.#onFailure = onFailure
  }

  enqueue(streamId, value, force = false, maxFrameBytes = this.#maxFrameBytes, onSent) {
    if (this.#closed || this.#socket.readyState !== 1) return false
    const text = JSON.stringify(value)
    const bytes = byteLength(text)
    if (bytes > maxFrameBytes) {
      if (force) this.#onFailure(backpressureError('frame'))
      else this.#onOverflow(streamId, 'frame')
      return false
    }
    let stream = this.#streams.get(streamId)
    const streamBytes = (stream?.bytes ?? 0) + bytes
    const terminalAfterItem = force && stream?.items.size === 1
    if ((!terminalAfterItem && streamBytes > this.#maxStreamQueuedBytes) || this.#queuedBytes + bytes > this.#maxSocketQueuedBytes) {
      const limit = streamBytes > this.#maxStreamQueuedBytes ? 'stream' : 'socket'
      if (force) this.#onFailure(backpressureError('socket'))
      else this.#onOverflow(streamId, limit)
      return false
    }
    if (stream === undefined) {
      stream = { bytes: 0, items: new Set() }
      this.#streams.set(streamId, stream)
    }
    const item = { onSent }
    stream.items.add(item)
    stream.bytes += bytes
    this.#queuedBytes += bytes
    const complete = error => {
      if (this.#closed || !stream.items.delete(item)) return
      stream.bytes -= bytes
      this.#queuedBytes -= bytes
      if (stream.items.size === 0) this.#streams.delete(streamId)
      item.onSent?.(error == null)
      if (error != null) this.#onFailure(error)
    }
    try { this.#socket.send(text, complete) } catch (error) { complete(error) }
    return true
  }

  send(streamId, value, maxFrameBytes) {
    let accepted
    const completion = new Promise(resolve => {
      accepted = this.enqueue(streamId, value, false, maxFrameBytes, resolve)
    })
    return accepted ? completion : false
  }

  drop(streamId) {
    // A canceled send remains charged until its actual socket callback.
    for (const item of this.#streams.get(streamId)?.items ?? []) item.onSent?.(false)
  }

  close() {
    this.#closed = true
    for (const stream of this.#streams.values()) for (const item of stream.items) item.onSent?.(false)
    this.#streams.clear()
    this.#queuedBytes = 0
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
  const sessionFollowFrameBytes = positiveLimit(options.maxFrameBytes, 32 * 1024 * 1024)
  const streams = new Map()
  let open = true
  let streamPrefix
  let lastStreamNumber = 0

  const closeIterator = (record, reason) => {
    if (record.returned) return
    record.returned = true
    record.controller.abort(reason === undefined ? new Error('browser stream closed') : abortError(reason, record.stage))
    try {
      void Promise.resolve(record.iterator.return?.()).catch(() => {})
    } catch { /* one broken iterator must not block the remaining releases */ }
  }
  const failSocket = reason => {
    if (!open) return
    open = false
    sender.close()
    const failure = reason === undefined ? transportError() : transportError(reason)
    for (const record of streams.values()) closeIterator(record, failure)
    streams.clear()
    if (socket.readyState === 1) {
      try { socket.close?.(1011, 'stream transport failure') } catch { /* socket is already failing */ }
    }
  }
  const terminal = (streamId, type, error) => {
    const record = streams.get(streamId)
    if (record === undefined || record.terminal) return
    record.terminal = true
    if (type === 'error') closeIterator(record, error)
    sender.enqueue(streamId, type === 'end'
      ? { type: 'end', streamId }
      : { type: 'error', streamId, error: streamError(error, record.stage) }, true)
    streams.delete(streamId)
  }
  const overflow = (streamId, kind) => {
    if (kind === 'socket') {
      failSocket(backpressureError('socket'))
      return
    }
    const record = streams.get(streamId)
    if (record === undefined || record.terminal) return
    sender.drop(streamId)
    terminal(streamId, 'error', backpressureError(kind))
  }
  const sender = new BoundedSocketSender(socket, limits, overflow, failSocket)

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
        sender.enqueue(streamId, { type: 'error', streamId, error: streamError(protocolError('browser-host-hub-rc1/invalid-stream-request', 'Invalid stream open request'), 'bootstrap') }, true)
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
      sender.enqueue(streamId, { type: 'error', streamId, error: streamError(error, 'bootstrap') }, true)
      return
    }
    const record = { controller, iterator, returned: false, terminal: false, stage: 'bootstrap' }
    streams.set(streamId, record)
    void (async () => {
      try {
        for (;;) {
          if (!open || record.terminal) return
          const item = await iterator.next()
          if (!open || record.terminal) return
          if (item.done) {
            terminal(streamId, 'end')
            return
          }
          const sent = sender.send(streamId, { type: 'item', streamId, value: item.value }, endpoint === 'session/follow' ? sessionFollowFrameBytes : maxFrameBytes)
          if (sent === false) return
          record.stage = 'live'
          if (!(await sent)) return
        }
      } catch (error) {
        if (open && !record.terminal) terminal(streamId, 'error', error)
      }
    })()
  }

  socket.on('message', raw => {
    if (!open) return
    let message
    try { message = decodeBrowserStreamFrame(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) } catch {
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
  if (typeof ctx?.authorizeRequest !== 'function') throw new TypeError('interface authorization port is required')
  const maxFrameBytes = positiveLimit(options.maxFrameBytes ?? options.maxResponseBytes, DEFAULT_MAX_FRAME_BYTES)
  const streamOptions = {
    maxFrameBytes: options.maxFrameBytes ?? options.maxResponseBytes,
    maxStreamQueuedBytes: options.maxStreamQueuedBytes,
    maxSocketQueuedBytes: options.maxSocketQueuedBytes,
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
      try { rejection = await ctx.authorizeRequest(request) } catch { rejection = 503 }
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
