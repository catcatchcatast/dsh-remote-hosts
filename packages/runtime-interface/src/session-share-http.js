// Public change history: docs/PUBLIC-CHANGES.md
import { createServer } from 'node:https'

const MAX_BODY_BYTES = 28 * 1024 * 1024
const KEEPALIVE_MS = 15_000

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

function safeHeaderName(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
}

function safeHeaderValue(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value)
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value))
}

function writeJson(response, status, body) {
  const bytes = jsonBytes(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(bytes)
}

async function readBoundedBody(request) {
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body is too large'), { status: 413 })
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { status: 413 })
    chunks.push(bytes)
  }
  return new Uint8Array(Buffer.concat(chunks, size))
}

function toRequestDto(request, body) {
  const headers = Object.freeze({
    host: firstHeader(request.headers.host),
    origin: firstHeader(request.headers.origin),
    cookie: firstHeader(request.headers.cookie),
    csrf: firstHeader(request.headers['x-dsh-csrf']),
    contentType: firstHeader(request.headers['content-type']),
  })
  return Object.freeze({
    method: typeof request.method === 'string' ? request.method : 'GET',
    url: typeof request.url === 'string' ? request.url : '/',
    remoteAddress: typeof request.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : undefined,
    headers,
    body,
  })
}

function responseHeaders(value) {
  const headers = Object.assign(Object.create(null), {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  })
  for (const [name, header] of Object.entries(value ?? {})) {
    if (!safeHeaderName(name) || !safeHeaderValue(header)) throw new TypeError('invalid public response header')
    headers[name] = header
  }
  return headers
}

function responseStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500
}

async function writeEventStream(response, events, signal, status, headers) {
  response.writeHead(responseStatus(status), {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const iterator = events[Symbol.asyncIterator]()
  const aborted = new Promise(resolve => signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }))
  let pending = iterator.next().then(value => ({ value }))
  try {
    while (!signal.aborted && !response.destroyed && !response.writableEnded) {
      let timer
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve({ keepalive: true }), KEEPALIVE_MS)
        timer.unref?.()
      })
      const result = await Promise.race([pending, timeout, aborted])
      if (timer !== undefined) clearTimeout(timer)
      if (result?.aborted) break
      if (result?.keepalive) {
        response.write(': keepalive\n\n')
        continue
      }
      const next = result?.value
      if (next?.done) break
      pending = iterator.next().then(value => ({ value }))
      const event = next?.value
      if (event === undefined) break
      if (!event || typeof event.event !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(event.event)) continue
      const id = typeof event.id === 'string' || Number.isSafeInteger(event.id) ? String(event.id) : undefined
      if (id !== undefined && (id.length > 128 || /[\r\n]/.test(id))) continue
      const data = JSON.stringify(event.data === undefined ? {} : event.data)
      if (id !== undefined) response.write(`id: ${id}\n`)
      response.write(`event: ${event.event}\ndata: ${data}\n\n`)
      if (event.event === 'revoked') break
    }
  } finally {
    try { await iterator.return?.() } catch {}
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

async function writeResponse(response, value, signal) {
  if (value && value.events && typeof value.events[Symbol.asyncIterator] === 'function') {
    await writeEventStream(response, value.events, signal, value.status, responseHeaders(value.headers))
    return
  }
  const status = responseStatus(value?.status)
  const headers = responseHeaders(value?.headers)
  const body = value?.body instanceof Uint8Array ? Buffer.from(value.body) : Buffer.from(typeof value?.body === 'string' ? value.body : '')
  if (headers['Content-Length'] === undefined) headers['Content-Length'] = String(body.length)
  response.writeHead(status, headers)
  response.end(body)
}

/** Bind one HTTPS listener and expose only request/response DTOs to the caller. */
export async function listenSessionShareHttps({ host, port, tls, handler }) {
  if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535 || !tls || typeof handler !== 'function') {
    throw new TypeError('valid HTTPS listener options are required')
  }
  const server = createServer(tls, async (request, response) => {
    let body
    try {
      body = await readBoundedBody(request)
    } catch (error) {
      if (response.destroyed) return
      const status = Number(error?.status)
      writeJson(response, status >= 400 && status <= 599 ? status : 400, { error: error instanceof Error ? error.message : 'invalid request' })
      return
    }
    const abort = new AbortController()
    const onClose = () => { if (!response.writableFinished) abort.abort() }
    response.once('close', onClose)
    try {
      const result = await handler(toRequestDto(request, body), abort.signal)
      await writeResponse(response, result, abort.signal)
    } catch {
      if (!response.headersSent) writeJson(response, 500, { error: 'request failed' })
      else if (!response.destroyed) response.destroy()
    } finally {
      response.off('close', onClose)
      abort.abort()
    }
  })

  await new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', listening); reject(error) }
    const listening = () => { server.off('error', failed); resolve() }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(port, host)
  })

  let closePromise
  return async function dispose() {
    if (closePromise !== undefined) return await closePromise
    closePromise = new Promise((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections?.()
    })
    return await closePromise
  }
}
