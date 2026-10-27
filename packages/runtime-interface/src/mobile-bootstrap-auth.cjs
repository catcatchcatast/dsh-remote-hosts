// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                 
'use strict'
const http = require('node:http')
const LIMIT = 4096
const RETRYABLE = Object.freeze({ INVALID_REQUEST: false, UNAVAILABLE: true, UNSAFE_MATERIAL: false, STALE_INSTANCE: true, AUTHENTICATION_FAILED: false, TIMEOUT: true, CANCELLED: false, OUTPUT_TOO_LARGE: false })
function fail(code) { const error = new Error(code); error.code = code; return error }
function failure(code) { if (!Object.hasOwn(RETRYABLE, code)) code = 'UNSAFE_MATERIAL'; return { version: 2, ok: false, error: { code, retryable: RETRYABLE[code] } } }
function bounded(value) {
  let text
  try { text = JSON.stringify(value) } catch { throw fail('INVALID_REQUEST') }
  if (!text || Buffer.byteLength(text) > LIMIT) throw fail('OUTPUT_TOO_LARGE')
  return value
}
function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'forwardPort,generation,port,version' ||
      value.version !== 2 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !Number.isSafeInteger(value.forwardPort) || value.forwardPort < 1024 || value.forwardPort > 65535 ||
      typeof value.generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.generation)) throw fail('INVALID_REQUEST')
  bounded(value)
  return Object.freeze({ version: 2, port: value.port, forwardPort: value.forwardPort, generation: value.generation })
}
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'cookie2', 'set-cookie', 'origin', 'referer', 'user-agent', 'accept', 'range', 'date', 'pragma', 'expires', 'etag', 'last-modified', 'vary', 'forwarded', 'via', 'dnt'])
const FORBIDDEN_PREFIXES = ['content-', 'accept-', 'cache-', 'if-', 'sec-', 'proxy-', 'access-control-', 'x-forwarded-']
function validateRequestHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw fail('UNSAFE_MATERIAL')
  const entries = Object.entries(headers), names = new Set()
  if (entries.length < 1 || entries.length > 8) throw fail('UNSAFE_MATERIAL')
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (name.length < 1 || name.length > 64 || !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(name) || names.has(lower) ||
        FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_PREFIXES.some(prefix => lower.startsWith(prefix)) ||
        typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[\x20-\x7E]+$/.test(value) || value.trim() !== value) throw fail('UNSAFE_MATERIAL')
    names.add(lower)
  }
  bounded(headers)
  return Object.freeze({ ...headers })
}
function credentialHeaders(status, headers, root) {
  if (status !== 303 || typeof headers.location !== 'string' || !Array.isArray(headers['set-cookie']) || headers['set-cookie'].length !== 1) throw fail('AUTHENTICATION_FAILED')
  let target
  try { target = new URL(headers.location, root) } catch { throw fail('AUTHENTICATION_FAILED') }
  if (target.origin !== root.origin || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw fail('AUTHENTICATION_FAILED')
  const raw = headers['set-cookie'][0]
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMIT) throw fail('OUTPUT_TOO_LARGE')
  const pair = raw.split(';', 1)[0]
  const separator = pair.indexOf('=')
  if (separator <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair.slice(0, separator)) ||
      !/^[\x21-\x7E]+$/.test(pair.slice(separator + 1)) || /[;,\\"]/.test(pair.slice(separator + 1))) throw fail('AUTHENTICATION_FAILED')
  return validateRequestHeaders({ Cookie: pair })
}
/** The official response is interpreted only here; the helper receives stable headers. */
async function exchangeCredential(material, request, { signal, requestFactory = http.request, timeoutMs = 10000 } = {}) {
  request = validateRequest(request)
  let root
  try { root = new URL(material.authenticatedRootUrl) } catch { throw fail('UNSAFE_MATERIAL') }
  if (root.protocol !== 'http:' || root.hostname !== '127.0.0.1' || Number(root.port) !== request.port || root.pathname !== '/' ||
      root.username || root.password || root.hash || [...root.searchParams.keys()].join(',') !== 'token' || !root.searchParams.get('token')) throw fail('UNSAFE_MATERIAL')
  if (signal?.aborted) throw fail('CANCELLED')
  return new Promise((resolve, reject) => {
    let client, timer, done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) { client?.destroy(); reject(error) } else resolve(value)
    }
    const abort = () => finish(fail('CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(fail('TIMEOUT')), timeoutMs)
    try {
      client = requestFactory({
        hostname: '127.0.0.1', port: request.port, path: root.pathname + root.search, method: 'GET',
        headers: { Host: '127.0.0.1:' + request.forwardPort, Connection: 'close' },
        agent: false, maxHeaderSize: LIMIT,
      }, response => {
        try {
          // No redirect following and no body accumulation; discard official response data.
          const value = credentialHeaders(response.statusCode, response.headers, root)
          response.destroy()
          finish(undefined, value)
        } catch (error) { response.destroy(); finish(error) }
      })
      client.on('error', error => finish(fail(error?.code === 'HPE_HEADER_OVERFLOW' ? 'OUTPUT_TOO_LARGE' : 'UNAVAILABLE')))
      if (done) client.destroy()
      else client.end()
    } catch { finish(fail('UNAVAILABLE')) }
    if (signal?.aborted) abort()
  })
}
function success(material, request, requestHeaders) {
  return bounded({ version: 2, ok: true, port: request.port, pid: material.pid, instanceId: material.instanceId,
    forwardPort: request.forwardPort, generation: request.generation, requestHeaders: validateRequestHeaders(requestHeaders) })
}
module.exports = { LIMIT, validateRequest, validateRequestHeaders, failure, exchangeCredential, success }
