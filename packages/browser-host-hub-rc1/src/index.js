// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                   
                                                                                                                                               
                                                                                                                                                     
                                                                                                                                           
                                                                                                                                                 
                                                                                                                                           
                                                                                                                                             
                                                                                                                                                                   
                                                                                                                                                       
                                                                                                                                               
                                                                                                                                                             
                                                                                                                                               
                                                                                                                                             
                                                                                                                                             
                                                                                                                                               
import { once } from 'node:events'
import { InteractionView } from './interaction-view.js'
                                                                                                                                                     
                                                                                                                                                 
                                                                                                                                                       
import { isCoreInteractionFrame, decodeBrowserInteractionResult, ADMIN_CATALOG_ENDPOINTS } from 'dsh-runtime-interface'
                                                                                                                                                       
                                                                                                                                     
                                                                                                                                           
                                                                                                                                         
                                                                                                                                                                 
                                                                                                                                                         
                                                                                                                                                                     
                                                                                                                                                       
                                                                                                                                                     
                                                                                                                                               
                                                                                                                           
                                                                                                                                                   
                                                                                                                                                 
                                                                                                                                                   
import { createFileProxyHandler, relayWorkspaceFileBytes, fileProxyBootstrap, FILE_PROXY_PREFIX } from './file-proxy.js'
import { readBootstrapHostInventory, registerHostInventory } from './host-selector.js'
import { BROWSER_STREAM_PATH, registerStreamMux, serveStreamSocket } from './stream-mux.js'
                                                                                                                                             
import { CURRENT_RUNTIME_VERSION, LEGACY_RUNTIME_VERSION, canonicalToBrowserWire, createBrowserStreamEncoder, normalizeRuntimeVersion, upstreamToCanonicalWire, wrapHostCarrier, classifyStreamFailure, markStreamFailure, sanitizeStreamFailure, streamFailureDiagnosticCode } from 'dsh-runtime-interface'
import { WORKSPACE_FILE_ENDPOINTS, OFFICE_TO_PDF_ENDPOINTS, WORKSPACE_BINARY_ENDPOINTS, workspaceFileBytesRequest, workspaceIdentityReferences, mapWorkspaceRequest, scopeWorkspaceValue, scopeWorkspaceFrame } from 'dsh-runtime-interface'
import { scopeProjection, scopeJobFrame, createJobStreamEncoder, applyControlQueue } from 'dsh-runtime-interface'
import { decodeBrowserRequest, encodeBrowserResponse, browserStreamFailureCodecSource, browserColdRestoreReaderSource } from 'dsh-runtime-interface/browser'

export { BROWSER_STREAM_PATH, registerStreamMux, serveStreamSocket } from './stream-mux.js'

const COLD_DIRECTORY_PHASE = Symbol('cold directory response phase')
const coldDirectoryHeaders = result => result?.[COLD_DIRECTORY_PHASE] ? { 'X-DSH-Cold-Directory': result[COLD_DIRECTORY_PHASE] } : {}
const DEFAULT_BASE_URL = 'http://dsh.invalid/'
const DEFAULT_API_PREFIX = '/api'
const DEFAULT_BFF_API_PREFIX = '/api/browser-host-hub-rc1'
const DEFAULT_RETRY_DELAY_MS = 25
const DEFAULT_MAX_RETRY_DELAY_MS = 1000
const DEFAULT_INITIAL_BASELINE_TIMEOUT_MS = 100
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024

export const BROWSER_BOOTSTRAP_PATH = '/__dsh/browser-host-hub-rc1-bootstrap.js'
/** Independent server-side BFF prefix; the browser still addresses official `/api`. */
export const BROWSER_BFF_API_PREFIX = DEFAULT_BFF_API_PREFIX
/** Reserved browser-page selection hint; it is stripped before carrier calls. */
export const HOST_SELECTOR = '__hostId'

export const name = 'browser-host-hub-rc1'
// `perHost` is supplied by the server-side carrier package.  The other two
// services are intentionally injected instead of discovered from the global
// object so the BFF keeps the official auth and web-server ownership.
export const inject = ['perHost', 'webServer', 'runtimeInterface']

/**
 * Deliberately finite: this is the only RPC surface the browser hook may proxy.
 * Do not replace this set with a path prefix check.
 */
export const HOST_RPC_ALLOWLIST = Object.freeze([
  ...ADMIN_CATALOG_ENDPOINTS,
  ...WORKSPACE_FILE_ENDPOINTS,
  ...OFFICE_TO_PDF_ENDPOINTS,
  'host/describe',
  'host.describe',
  'workspace/initializeDefault',
  'workspace/create',
  'workspace/rename',
  'workspace/delete',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'workspace/pinSession',
  'workspace/unpinSession',
  'workspace/follow',
  'session/create',
  'session/rename',
  'session/fork',
  'session/page',
  'session/follow',
  'session/control',
  'session/projections',
  'job/list',
  'job/follow',
  'job/kill',
  'session/list',
  'session/search',
  'session/prompt',
  'session/cancel',
  'session/modelCatalog',
  'session/selectModel',
  'session/updateQueue',
  'session/attachment',
  'userQuestions/answer',
  'userQuestions/attachWait',
  'agentPresets/list',
  'agentPresets/select',
  'agentPreset.list',
  'agentPreset.select',
  'subagents/interruptByParent',
  'subagents/list',
  'subagents/prompt',
  'goals/clear',
  'goals/complete',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'messageFeedback/delete',
  'messageFeedback/list',
  'messageFeedback/put',
  'commands/execute',
  'commands/list',
  'fileReferences/list',
  'skills/list',
  'settings/canOpenAgentPresetDirectory',
  'settings/describe',
  'settings/mutate',
  'settings/openAgentPresetDirectory',
  'settings/openSettingsDocument',
  'settings/replace',
  'settings/update',
  'llm/discoverModels',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'pluginInventory/list',
  'dynamicCordisRunner/inventory',
  'dynamicCordisRunner/syncInspectManifest',
  'directoryPicker/pick',
  'directoryPicker/list',
  'directoryPicker/createDirectory',
  '$events',
  '$events/result'
])

const ALLOWLIST = new Set(HOST_RPC_ALLOWLIST)
const AGGREGATE_UNARY = new Set(['session/list', 'session/search'])
const MAX_SESSION_LIST_SNAPSHOTS = 64
const DEFAULT_AGGREGATE_HOST_TIMEOUT_MS = 2_500
const DEFAULT_SESSION_LIST_REFRESH_TIMEOUT_MS = 60_000
const STREAM_ENDPOINTS = new Set(['workspaceFiles/changes', 'workspace/follow', 'session/control', 'session/follow', 'job/list', 'job/follow', 'userQuestions/attachWait', '$events'])
const EVENT_RESULT_ENDPOINT = '$events/result'
const DIAGNOSTIC_ENDPOINTS = new Set([
  '$events/result',
  'session/follow',
  'session/control',
  'workspace/follow',
  '$events',
  'session/list',
  'workspace/archiveSession',
  'host/describe'
])
const DIAGNOSTIC_PHASES = new Set([
  'request_start',
  'request_success',
  'request_error',
  'stream_open',
  'stream_snapshot',
  'stream_end',
  'stream_error',
  'stream_cancel',
  'interaction_delivery', 'interaction_deferred', 'interaction_retry_limit',
  'interaction_answer', 'interaction_rejected'
])
const DIAGNOSTIC_CODES = new Set(['unknown', 'timeout', 'aborted', 'transport', 'protocol', 'unauthorized', 'forbidden', 'overflow'])
const SESSION_ENDPOINTS = new Set([
  'session/create',
  'session/rename',
  'session/fork',
  'session/page',
  'session/follow',
  'session/prompt',
  'session/cancel',
  'session/selectModel',
  'session/updateQueue',
  'session/attachment',
  'agentPresets/select',
  'agentPreset.select'
])
const DIRECT_AGENT_ENDPOINTS = new Set([
  'userQuestions/answer',
  'userQuestions/attachWait',
  'agentPresets/select',
  'agentPreset.select',
  'commands/execute',
  'commands/list',
  'fileReferences/list',
  'goals/clear',
  'goals/complete',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
])
const DIRECT_SUBAGENT_ENDPOINTS = new Set([
  'subagents/interruptByParent',
  'subagents/list',
])
const SUBAGENT_REQUEST_ENDPOINTS = new Set(['subagents/prompt'])
const SESSION_REQUEST_ID_ENDPOINTS = new Set([
  'session/projections', 'job/list', 'job/follow', 'job/kill',
  ...SESSION_ENDPOINTS,
  'messageFeedback/delete',
  'messageFeedback/list',
  'messageFeedback/put',
  'skills/list',
])


const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key)

function diagnosticEndpoint(endpoint) {
  return DIAGNOSTIC_ENDPOINTS.has(endpoint) ? endpoint : 'other'
}

function diagnosticCode(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return 'aborted'
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : ''
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  const value = `${code} ${message}`
  if (value.includes('timeout') || value.includes('timed out')) return 'timeout'
  if (value.includes('unauthorized') || code === '401') return 'unauthorized'
  if (value.includes('forbidden') || code === '403') return 'forbidden'
  if (value.includes('overflow') || value.includes('too-large') || value.includes('too large')) return 'overflow'
  if (value.includes('protocol') || value.includes('invalid')) return 'protocol'
  if (value.includes('transport') || value.includes('disconnect') || value.includes('network')) return 'transport'
  return 'unknown'
}

function diagnosticSequence(value) {
  const candidates = [value?.cursor, value?.seq, value?.event?.seq, value?.value?.cursor]
  return candidates.find(candidate => Number.isSafeInteger(candidate))
}

function defaultBaseUrl() {
  return typeof location !== 'undefined' && typeof location.origin === 'string' ? `${location.origin}/` : DEFAULT_BASE_URL
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function jsonSafeError(error, fallbackCode = 'browser-host-hub-rc1/host-unavailable') {
  if (error instanceof BrowserHostHubError) return { code: error.code, message: error.message, details: error.details }
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string' && isRecord(error.details)) return { code: error.code, message: error.message, details: error.details }
  return {
    code: fallbackCode,
    message: error instanceof Error && error.message ? error.message : 'Host carrier unavailable',
    details: {}
  }
}

function failure(error, fallbackCode) {
  return { ok: false, error: jsonSafeError(error, fallbackCode) }
}

function success(value) {
  return { ok: true, value }
}

export class BrowserHostHubError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BrowserHostHubError'
    this.code = code
    this.details = isRecord(details) ? details : {}
  }
}

export class HostRpcNotAllowedError extends BrowserHostHubError {
  constructor(endpoint) {
    super('browser-host-hub-rc1/endpoint-not-allowed', `RPC endpoint is not allowlisted: ${endpoint}`, { endpoint })
  }
}

export class SelectedHostRequiredError extends BrowserHostHubError {
  constructor(endpoint) {
    super('browser-host-hub-rc1/selected-host-required', `RPC endpoint requires an explicitly selected Host: ${endpoint}`, { endpoint })
  }
}

export class CrossHostIdentityError extends BrowserHostHubError {
  constructor(endpoint, hostIds) {
    super('browser-host-hub-rc1/cross-host-identity', `RPC payload contains identities from multiple Hosts: ${endpoint}`, { endpoint, hostIds: [...hostIds] })
  }
}

export class HostUnavailableError extends BrowserHostHubError {
  constructor(hostId) {
    super('browser-host-hub-rc1/host-unavailable', `Host is not available: ${hostId}`, { hostId })
  }
}

export class SessionFollowBootstrapError extends BrowserHostHubError {
  constructor(hostId, reason, failure) {
    super('browser-host-hub-rc1/session-follow-bootstrap-failed', 'Session follow failed before the initial snapshot', { hostId, reason })
    markStreamFailure(this, failure ?? classifyStreamFailure({ reason: 'invalid-snapshot' }, { source: 'hub', stage: 'bootstrap' }))
  }
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('invalid rh1 base64url segment')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

/** Built-in copy of the strict rh1 codec; runtime-host-hub-rc1 may be injected instead. */
export function encodeCompositeId(hostId, rawId) {
  assertString(hostId, 'hostId')
  assertString(rawId, 'rawId')
  return `rh1.${bytesToBase64Url(new TextEncoder().encode(hostId))}.${bytesToBase64Url(new TextEncoder().encode(rawId))}`
}

export function decodeCompositeId(value) {
  assertString(value, 'compositeId')
  const match = /^rh1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) throw new TypeError('invalid rh1 composite id')
  const hostId = new TextDecoder().decode(base64UrlToBytes(match[1]))
  const rawId = new TextDecoder().decode(base64UrlToBytes(match[2]))
  if (!hostId || !rawId || encodeCompositeId(hostId, rawId) !== value) throw new TypeError('non-canonical rh1 composite id')
  return { hostId, rawId }
}

export function isCompositeId(value) {
  if (typeof value !== 'string' || !value.startsWith('rh1.')) return false
  try {
    decodeCompositeId(value)
    return true
  } catch {
    return false
  }
}

function normalizeCodec(codec) {
  if (codec === undefined) return { encodeCompositeId, decodeCompositeId, isCompositeId }
  if (!isRecord(codec) || typeof codec.encodeCompositeId !== 'function' || typeof codec.decodeCompositeId !== 'function') throw new TypeError('codec must expose encodeCompositeId/decodeCompositeId')
  return {
    encodeCompositeId: codec.encodeCompositeId.bind(codec),
    decodeCompositeId: codec.decodeCompositeId.bind(codec),
    isCompositeId: typeof codec.isCompositeId === 'function' ? codec.isCompositeId.bind(codec) : value => {
      try { codec.decodeCompositeId(value); return true } catch { return false }
    }
  }
}

export function encodeSyntheticEventId(hostId, clientId, eventId, codec) {
  const normalized = normalizeCodec(codec)
  assertString(clientId, 'clientId')
  assertString(eventId, 'eventId')
  return normalized.encodeCompositeId(hostId, JSON.stringify([clientId, eventId]))
}

export function decodeSyntheticEventId(value, codec) {
  const normalized = normalizeCodec(codec)
  const decoded = normalized.decodeCompositeId(value)
  let pair
  try { pair = JSON.parse(decoded.rawId) } catch { throw new TypeError('invalid synthetic event id payload') }
  if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || typeof pair[1] !== 'string' || !pair[1]) throw new TypeError('invalid synthetic event id payload')
  return { hostId: decoded.hostId, clientId: pair[0], eventId: pair[1] }
}

function makeId(prefix) {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `${prefix}-${random}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function abortSignalOf(signal) {
  if (signal === undefined) return new AbortController().signal
  if (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') throw new TypeError('signal must be an AbortSignal')
  return signal
}

function wait(ms, signal) {
  if (signal.aborted || ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    let timer
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

class AsyncQueue {
  #items = []
  #waiters = []
  #closed = false

  push(value) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#items.push(value)
    else {
      clearTimeout(waiter.timer)
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve({ done: false, value })
    }
  }

  close() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve({ done: true, value: undefined })
    }
  }

  next(signal, timeoutMs) {
    if (this.#items.length > 0) return Promise.resolve({ done: false, value: this.#items.shift() })
    if (this.#closed || signal?.aborted) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => {
      const waiter = { resolve, signal, onAbort: undefined, timer: undefined }
      const finish = result => {
        const index = this.#waiters.indexOf(waiter)
        if (index !== -1) this.#waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        signal?.removeEventListener('abort', waiter.onAbort)
        resolve(result)
      }
      waiter.onAbort = () => finish({ done: true, value: undefined })
      if (timeoutMs !== undefined) waiter.timer = setTimeout(() => finish({ done: true, timeout: true, value: undefined }), Math.max(0, timeoutMs))
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }
}

function cloneArgsPayload(payload, updateArgs) {
  if (!isRecord(payload) || !isRecord(payload.args)) return payload
  return { ...payload, args: updateArgs({ ...payload.args }) }
}

function cloneRequestPayload(payload, updateRequest) {
  return cloneArgsPayload(payload, args => {
    const key = isRecord(args.request) ? 'request' : isRecord(args._request) ? '_request' : undefined
    if (key === undefined) return args
    return { ...args, [key]: updateRequest({ ...args[key] }) }
  })
}

function requestOf(payload) {
  if (isRecord(payload?.args?.request)) return payload.args.request
  // session/list is the one generated remote whose parameter is named
  // `_request` on the wire.  Keep that spelling when forwarding it.
  if (isRecord(payload?.args?._request)) return payload.args._request
  return undefined
}

function addReference(references, value, path) {
  if (typeof value === 'string' && value.length > 0) references.push({ value, path })
}

function compositeValue(value, codec) {
  if (typeof value !== 'string' || !value.startsWith('rh1.')) return false
  if (!codec.isCompositeId(value)) throw new TypeError('invalid rh1 composite id')
  return true
}

function identityReferences(endpoint, payload) {
  const references = []
  const args = isRecord(payload?.args) ? payload.args : undefined
  const request = requestOf(payload)
  if (DIRECT_AGENT_ENDPOINTS.has(endpoint)) addReference(references, args?.agentId, 'args.agentId')
  if (DIRECT_SUBAGENT_ENDPOINTS.has(endpoint)) {
    addReference(references, args?.parentSessionId, 'args.parentSessionId')
    addReference(references, args?.childSessionId, 'args.childSessionId')
  }
  if (SUBAGENT_REQUEST_ENDPOINTS.has(endpoint) && request !== undefined) {
    addReference(references, request.parentSessionId, 'args.request.parentSessionId')
    addReference(references, request.childSessionId, 'args.request.childSessionId')
  }
  if (SESSION_REQUEST_ID_ENDPOINTS.has(endpoint) && request !== undefined) {
    addReference(references, request.sessionId, 'args.request.sessionId')
    addReference(references, request.parentSessionId, 'args.request.parentSessionId')
    addReference(references, request.beforeSessionId, 'args.request.beforeSessionId')
    addReference(references, request.workspaceId, 'args.request.workspaceId')
    addReference(references, request.itemId, 'args.request.itemId')
    if (endpoint.startsWith('job/')) addReference(references, request.jobId, 'args.request.jobId')
    if (isRecord(request.address)) {
      addReference(references, request.address.parentSessionId, 'args.request.address.parentSessionId')
      addReference(references, request.address.sessionId, 'args.request.address.sessionId')
      addReference(references, request.address.childSessionId, 'args.request.address.childSessionId')
    }
  }
  references.push(...workspaceIdentityReferences(endpoint, (WORKSPACE_FILE_ENDPOINTS.includes(endpoint) || OFFICE_TO_PDF_ENDPOINTS.includes(endpoint)) ? args : request))
  return references
}

function identityHostIds(endpoint, payload, codec) {
  const hosts = new Set()
  for (const reference of identityReferences(endpoint, payload)) {
    if (!compositeValue(reference.value, codec)) continue
    const decoded = codec.decodeCompositeId(reference.value)
    hosts.add(decoded.hostId)
  }
  return hosts
}

function rawIdentity(codec, hostId, value) {
  if (typeof value !== 'string') return value
  if (!compositeValue(value, codec)) return value
  const decoded = codec.decodeCompositeId(value)
  if (decoded.hostId !== hostId) throw new CrossHostIdentityError('payload', [hostId, decoded.hostId])
  return decoded.rawId
}

function updateAddress(address, hostId, codec) {
  if (!isRecord(address)) return address
  const result = { ...address }
  if (typeof result.parentSessionId === 'string') result.parentSessionId = rawIdentity(codec, hostId, result.parentSessionId)
  if (typeof result.sessionId === 'string') result.sessionId = rawIdentity(codec, hostId, result.sessionId)
  if (typeof result.childSessionId === 'string') result.childSessionId = rawIdentity(codec, hostId, result.childSessionId)
  return result
}

function mapPayloadForHost(endpoint, payload, hostId, codec) {
  if (!isRecord(payload)) return payload
  // `__hostId` is a browser-page selection hint, never an official wire
  // parameter.  Strip it before invoking a Host carrier.
  let result = { ...payload }
  delete result.__hostId
  delete result.__pageId
  delete result.__coldRestore
  if (!isRecord(result.args)) return result
  if (DIRECT_AGENT_ENDPOINTS.has(endpoint)) result = cloneArgsPayload(result, args => ({ ...args, ...typeof args.agentId === 'string' ? { agentId: rawIdentity(codec, hostId, args.agentId) } : {} }))
  if (DIRECT_SUBAGENT_ENDPOINTS.has(endpoint)) result = cloneArgsPayload(result, args => ({
    ...args,
    ...typeof args.parentSessionId === 'string' ? { parentSessionId: rawIdentity(codec, hostId, args.parentSessionId) } : {},
    ...typeof args.childSessionId === 'string' ? { childSessionId: rawIdentity(codec, hostId, args.childSessionId) } : {},
  }))
  if (WORKSPACE_FILE_ENDPOINTS.includes(endpoint) || OFFICE_TO_PDF_ENDPOINTS.includes(endpoint)) result = cloneArgsPayload(result, args => mapWorkspaceRequest(endpoint, args, hostId, codec))
  const request = requestOf(result)
  if (request === undefined) return result
  if (SESSION_REQUEST_ID_ENDPOINTS.has(endpoint) || SUBAGENT_REQUEST_ENDPOINTS.has(endpoint)) {
    result = cloneRequestPayload(result, next => {
      if (typeof next.sessionId === 'string') next.sessionId = rawIdentity(codec, hostId, next.sessionId)
      if (typeof next.parentSessionId === 'string') next.parentSessionId = rawIdentity(codec, hostId, next.parentSessionId)
      if (typeof next.childSessionId === 'string') next.childSessionId = rawIdentity(codec, hostId, next.childSessionId)
      if (typeof next.beforeSessionId === 'string') next.beforeSessionId = rawIdentity(codec, hostId, next.beforeSessionId)
      if (typeof next.workspaceId === 'string') next.workspaceId = rawIdentity(codec, hostId, next.workspaceId)
      if (typeof next.itemId === 'string') next.itemId = rawIdentity(codec, hostId, next.itemId)
      if (endpoint.startsWith('job/') && typeof next.jobId === 'string') next.jobId = rawIdentity(codec, hostId, next.jobId)
      if (isRecord(next.address)) next.address = updateAddress(next.address, hostId, codec)
      return next
    })
  }
  if (endpoint.startsWith('workspace/')) result = cloneRequestPayload(result, next => mapWorkspaceRequest(endpoint, next, hostId, codec))
  return result
}

export function mapWorkspaceFrame(frame, hostId, codec = undefined) {
  return scopeWorkspaceFrame(frame, hostId, normalizeCodec(codec))
}

function mapQueueItem(item, hostId, codec) {
  if (!isRecord(item)) return item
  const result = { ...item }
  if (typeof result.id === 'string') result.id = codec.encodeCompositeId(hostId, result.id)
  if (isRecord(result.message)) {
    result.message = { ...result.message }
    if (typeof result.message.id === 'string') result.message.id = codec.encodeCompositeId(hostId, result.message.id)
    // message.content is deliberately opaque and is not traversed.
  }
  return result
}

function mapJob(job, hostId, codec) {
  if (!isRecord(job)) return job
  return typeof job.id === 'string' ? { ...job, id: codec.encodeCompositeId(hostId, job.id) } : job
}

function mapSessionRecordById(value, hostId, codec, mapper) {
  if (!isRecord(value)) return value
  const result = {}
  for (const [rawSessionId, rows] of Object.entries(value)) Object.defineProperty(result, codec.encodeCompositeId(hostId, rawSessionId), { value: mapper(rows), enumerable: true, configurable: true, writable: true })
  return result
}

export function mapControlFrame(frame, hostId, codec = undefined) {
  if (!isRecord(frame)) return frame
  const normalized = normalizeCodec(codec)
  if (frame.type === 'baseline' && isRecord(frame.value)) {
    const value = { ...frame.value }
    if (isRecord(value.queues)) value.queues = mapSessionRecordById(value.queues, hostId, normalized, rows => Array.isArray(rows) ? rows.map(item => mapQueueItem(item, hostId, normalized)) : rows)
    if (isRecord(value.jobs)) value.jobs = mapSessionRecordById(value.jobs, hostId, normalized, rows => Array.isArray(rows) ? rows.map(job => mapJob(job, hostId, normalized)) : rows)
    if (isRecord(value.projections)) value.projections = mapSessionRecordById(value.projections, hostId, normalized, projection => scopeProjection(projection, hostId, normalized))
    return { ...frame, value }
  }
  if (typeof frame.sessionId === 'string') {
    const result = { ...frame, sessionId: normalized.encodeCompositeId(hostId, frame.sessionId) }
    if (frame.type === 'queue' && Array.isArray(frame.items)) result.items = frame.items.map(item => mapQueueItem(item, hostId, normalized))
    if (frame.type === 'jobs' && Array.isArray(frame.jobs)) result.jobs = frame.jobs.map(job => mapJob(job, hostId, normalized))
    return result
  }
  return frame
}

export function mapSessionFollowFrame(frame, hostId, codec = undefined) {
  if (!isRecord(frame) || frame.type !== 'snapshot' || !isRecord(frame.header)) return frame
  const normalized = normalizeCodec(codec)
  const header = { ...frame.header }
  if (typeof header.id === 'string') header.id = normalized.encodeCompositeId(hostId, header.id)
  if (typeof header.parentSession === 'string') header.parentSession = normalized.encodeCompositeId(hostId, header.parentSession)
  // The carrier has already converted its upstream records through the
  // runtime interface.  This mapping only scopes Host identities.
  return { ...frame, header, ...(frame.projections === undefined ? {} : { projections: scopeProjection(frame.projections, hostId, normalized) }) }
}

/**
 * Carriers are converted before this Hub maps Host IDs. Direct helper callers
 * may explicitly supply a source version, but the normal Hub path preserves
 * the already-targeted record objects and their opaque data references.
 */
export function mapHistoryRecords(records, { upstreamVersion, hostId, browserVersion = LEGACY_RUNTIME_VERSION } = {}) {
  if (!Array.isArray(records) || upstreamVersion === undefined) return records
  return canonicalToBrowserWire(upstreamToCanonicalWire({ records }, {
    upstreamVersion,
    hostId,
    endpoint: 'session/page',
  }), browserVersion).records
}
export const decodeHistoryRecords = mapHistoryRecords

function mapSessionListItem(item, hostId, codec) {
  if (!isRecord(item)) return item
  const result = { ...item }
  if (typeof result.sessionId === 'string') result.sessionId = codec.encodeCompositeId(hostId, result.sessionId)
  if (typeof result.parentSessionId === 'string') result.parentSessionId = codec.encodeCompositeId(hostId, result.parentSessionId)
  if (result.projections !== undefined) result.projections = scopeProjection(result.projections, hostId, codec)
  return result
}

function mapSessionListValue(value, hostId, codec) {
  if (!isRecord(value) || !Array.isArray(value.items)) return value
  return {
    ...value,
    items: value.items.map(item => mapSessionListItem(item, hostId, codec))
  }
}

function mapSessionEvent(raw, hostId, codec) {
  if (raw.type !== 'emit' || !Array.isArray(raw.args)) return raw
  if (raw.event === 'api-session/added') {
    if (!isRecord(raw.args[0])) return raw
    const args = [...raw.args]
    args[0] = mapSessionListItem(raw.args[0], hostId, codec)
    return { ...raw, args }
  }
  if (raw.event === 'api-session/status' || raw.event === 'api-session/removed' || raw.event === 'api-session/error' || raw.event === 'api-session/activity') {
    if (typeof raw.args[0] !== 'string') return raw
    const args = [...raw.args]
    args[0] = codec.encodeCompositeId(hostId, raw.args[0])
    return { ...raw, args }
  }
  return raw
}

function rawSessionIdentity(value, hostId, codec) {
  if (typeof value !== 'string') return undefined
  try {
    if (!codec.isCompositeId(value)) return value
    const decoded = codec.decodeCompositeId(value)
    return decoded.hostId === hostId ? decoded.rawId : undefined
  } catch {
    return value
  }
}

function sessionIdFromEvent(raw) {
  if (!isRecord(raw) || raw.type !== 'emit' || !Array.isArray(raw.args)) return undefined
  if (raw.event === 'api-session/added') return raw.args[0]?.sessionId
  if (raw.event === 'api-session/status' || raw.event === 'api-session/removed' || raw.event === 'api-session/error' || raw.event === 'api-session/activity') return raw.args[0]
  return undefined
}

function mapSessionSearchValue(value, hostId, codec) {
  if (!isRecord(value) || !Array.isArray(value.items)) return value
  return { ...value, items: value.items.map(item => isRecord(item) && typeof item.sessionId === 'string' ? { ...item, sessionId: codec.encodeCompositeId(hostId, item.sessionId) } : item) }
}

function mapSubagentValue(value, hostId, codec) {
  if (!isRecord(value) || !Array.isArray(value.entries)) return value
  return {
    ...value,
    entries: value.entries.map(entry => isRecord(entry) && typeof entry.id === 'string'
      ? { ...entry, id: codec.encodeCompositeId(hostId, entry.id) }
      : entry)
  }
}

function mapDynamicCordisInventoryValue(value, hostId, codec) {
  if (!Array.isArray(value)) return value
  return value.map(row => isRecord(row) && typeof row.agentId === 'string'
    ? { ...row, agentId: codec.encodeCompositeId(hostId, row.agentId) }
    : row)
}

function mapUnaryValue(endpoint, value, hostId, codec) {
  if (endpoint === 'session/projections') return scopeProjection(value, hostId, codec)
  if (value === undefined) return value
  if (endpoint === 'session/list') return mapSessionListValue(value, hostId, codec)
  if (endpoint === 'session/search') return mapSessionSearchValue(value, hostId, codec)
  if (endpoint.startsWith('workspace/')) return scopeWorkspaceValue(value, hostId, codec)
  if (endpoint === 'session/create' || endpoint === 'session/fork') {
    if (!isRecord(value)) return value
    return typeof value.sessionId === 'string' ? { ...value, sessionId: codec.encodeCompositeId(hostId, value.sessionId) } : value
  }
  if (endpoint === 'subagents/list') return mapSubagentValue(value, hostId, codec)
  if (endpoint === 'dynamicCordisRunner/inventory') return mapDynamicCordisInventoryValue(value, hostId, codec)
  return value
}

function mergeWorkspaceBaselines(values) {
  const items = []
  const archivedSessionIds = []
  const pins = []
  const seenPins = new Set()
  const seenItems = new Set()
  const seenArchived = new Set()
  for (const value of values) {
    if (!isRecord(value)) continue
    for (const item of value.items ?? []) {
      const key = isRecord(item) && typeof item.workspaceId === 'string' ? item.workspaceId : `${items.length}`
      if (seenItems.has(key)) continue
      seenItems.add(key)
      items.push(item)
    }
    for (const id of value.pins ?? []) if (!seenPins.has(id)) { seenPins.add(id); pins.push(id) }
    for (const id of value.archivedSessionIds ?? []) if (!seenArchived.has(id)) {
      seenArchived.add(id)
      archivedSessionIds.push(id)
    }
  }
  return { items, archivedSessionIds, pins, workspaceState: true }
}

function mergeControlBaselines(values) {
  const queues = {}
  const jobs = {}
  const projections = {}
  const copyOwn = (target, source) => {
    for (const [key, value] of Object.entries(source)) Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
  }
  for (const value of values) {
    if (!isRecord(value)) continue
    if (isRecord(value.queues)) copyOwn(queues, value.queues)
    if (isRecord(value.jobs)) copyOwn(jobs, value.jobs)
    if (isRecord(value.projections)) copyOwn(projections, value.projections)
  }
  return { queues, jobs, projections }
}

// The official RemoteSnapshotStream accepts one baseline per browser generation.
// Keep per-Host state current so a late/reconnected Host can join using legal deltas.
function applyAggregateIncrement(endpoint, state, frame) {
  if (endpoint === 'workspace/follow') {
    const items = [...state.items]
    if (frame.type === 'upsert') {
      const index = items.findIndex(item => item.workspaceId === frame.workspace.workspaceId)
      if (index < 0) items.push(frame.workspace)
      else items[index] = frame.workspace
    }
    if (frame.type === 'remove') return { ...state, items: items.filter(item => item.workspaceId !== frame.workspaceId) }
    if (frame.type === 'order') {
      const byId = new Map(items.map(item => [item.workspaceId, item]))
      const ordered = frame.workspaceIds.flatMap(id => byId.has(id) ? [byId.get(id)] : [])
      const included = new Set(frame.workspaceIds)
      return { ...state, items: [...ordered, ...items.filter(item => !included.has(item.workspaceId))] }
    }
    return { ...state, items, archivedSessionIds: frame.type === 'archived' ? frame.archivedSessionIds : state.archivedSessionIds,
      pins: frame.type === 'pins' ? frame.pins : state.pins }
  }
  if (frame.type === 'queue') return applyControlQueue(state, frame)
  if (frame.type === 'jobs') return { ...state, jobs: { ...state.jobs, [frame.sessionId]: frame.jobs } }
  if (frame.type === 'projection') {
    const previous = state.projections[frame.sessionId] ?? { asOfSeq: -1, values: {} }
    return { ...state, projections: { ...state.projections, [frame.sessionId]: {
      asOfSeq: Math.max(previous.asOfSeq, frame.seq), values: { ...previous.values, [frame.key]: frame.value }
    } } }
  }
  return state
}

function replacementIncrements(endpoint, previous, next, combined) {
  const updates = []
  if (endpoint === 'workspace/follow') {
    const nextIds = new Set(next.items.map(item => item.workspaceId))
    for (const item of previous.items) if (!nextIds.has(item.workspaceId)) updates.push({ type: 'remove', workspaceId: item.workspaceId })
    for (const workspace of next.items) updates.push({ type: 'upsert', workspace })
    updates.push({ type: 'order', workspaceIds: combined.items.map(item => item.workspaceId) })
    updates.push({ type: 'archived', archivedSessionIds: combined.archivedSessionIds })
    updates.push({ type: 'pins', pins: combined.pins })
    return updates
  }
  // The rc1 control protocol has no projection-clear delta. In that rare case
  // end only this browser generation; its official reader obtains a fresh baseline.
  // Do not invent a null value or a seq to clear a projection.
  for (const [sessionId, projection] of Object.entries(previous.projections)) {
    const values = next.projections[sessionId]?.values ?? {}
    if (Object.keys(projection.values).some(key => !own(values, key))) return undefined
  }
  for (const sessionId of new Set([...Object.keys(previous.queues), ...Object.keys(next.queues)])) {
    const seq = next.projections[sessionId]?.asOfSeq
    updates.push({ type: 'queue', sessionId, items: next.queues[sessionId] ?? [],
      ...(Number.isSafeInteger(seq) && seq >= 0 ? { seq } : {}) })
  }
  for (const sessionId of new Set([...Object.keys(previous.jobs), ...Object.keys(next.jobs)])) {
    updates.push({ type: 'jobs', sessionId, jobs: next.jobs[sessionId] ?? [] })
  }
  for (const [sessionId, projection] of Object.entries(next.projections)) {
    for (const [key, value] of Object.entries(projection.values)) updates.push({ type: 'projection', sessionId, key, value, seq: projection.asOfSeq })
  }
  return updates
}

function mergeListValues(endpoint, values) {
  const items = []
  let hasMore = false
  for (const value of values) {
    if (Array.isArray(value)) items.push(...value)
    else if (isRecord(value)) {
      if (Array.isArray(value.items)) items.push(...value.items)
      if (value.hasMore === true) hasMore = true
    }
  }
  if (values.some(value => Array.isArray(value))) return items
  return endpoint === 'session/search' ? { items, hasMore } : { items }
}

function resultOfCarrier(result) {
  if (isRecord(result) && result.ok === true) return result
  if (isRecord(result) && result.ok === false && isRecord(result.error)) return result
  throw new TypeError('Host carrier returned an invalid RPC result')
}

function mergeError(results) {
  const firstFailure = results.find(result => result.ok === false)
  return firstFailure ?? failure(new BrowserHostHubError('browser-host-hub-rc1/host-unavailable', 'No Host returned a result'))
}

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error: jsonSafeError(error) }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })
}

function normalizePathPrefix(value, label) {
  assertString(value, label)
  if (!value.startsWith('/') || value.includes('?') || value.includes('#') || value.includes('..')) throw new TypeError(`${label} must be an absolute path without query or traversal`)
  const normalized = value.replace(/\/+$/g, '')
  return normalized || '/'
}

function routePath(prefix, endpoint) {
  return prefix === '/' ? `/${endpoint}` : `${prefix}/${endpoint}`
}

function requestHeader(request, name) {
  const headers = request?.headers
  if (headers && typeof headers.get === 'function') return headers.get(name)
  if (!headers || typeof headers !== 'object') return undefined
  if (headers[name] !== undefined) return headers[name]
  if (headers[name.toLowerCase()] !== undefined) return headers[name.toLowerCase()]
  if (headers[name.toUpperCase()] !== undefined) return headers[name.toUpperCase()]
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

function isByteChunk(value) {
  return typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer
}

function asBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('request body must contain text or bytes')
}

async function readBffBody(request, maxBytes, signal) {
  const contentLength = Number(requestHeader(request, 'content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new BrowserHostHubError('browser-host-hub-rc1/request-too-large', 'Request body exceeds the configured limit', { maxBytes })
  const chunks = []
  let bytes = 0
  const append = chunk => {
    if (!isByteChunk(chunk)) throw new TypeError('request body must contain text or bytes')
    const encoded = asBytes(chunk)
    bytes += encoded.byteLength
    if (bytes > maxBytes) throw new BrowserHostHubError('browser-host-hub-rc1/request-too-large', 'Request body exceeds the configured limit', { maxBytes })
    chunks.push(encoded)
  }
  if (signal.aborted) throw signal.reason ?? new Error('request aborted')
  if (isByteChunk(request)) append(request)
  else if (request && typeof request[Symbol.asyncIterator] === 'function') {
    for await (const chunk of request) {
      if (signal.aborted) throw signal.reason ?? new Error('request aborted')
      append(chunk)
    }
  } else if (isByteChunk(request?.body)) append(request.body)
  else if (request?.body && typeof request.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of request.body) {
      if (signal.aborted) throw signal.reason ?? new Error('request aborted')
      append(chunk)
    }
  } else if (request && typeof request.text === 'function') append(await request.text())
  else throw new TypeError('request body is unavailable')
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(result)
}

function bffLifetime(request, response) {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('browser RPC request closed'))
  const requestClosed = () => { if (request?.complete === false) abort() }
  const responseClosed = () => { if (response?.writableEnded !== true) abort() }
  request?.once?.('aborted', abort)
  request?.once?.('close', requestClosed)
  response?.once?.('close', responseClosed)
  return {
    signal: controller.signal,
    dispose() {
      request?.off?.('aborted', abort)
      request?.off?.('close', requestClosed)
      response?.off?.('close', responseClosed)
    }
  }
}

function responseHeadersSent(response) {
  return response?.headersSent === true
}

function startResponse(response, status, headers) {
  if (!responseHeadersSent(response)) response.writeHead(status, headers)
}

function writeResponse(response, status, headers, body = '') {
  startResponse(response, status, headers)
  response.end(body)
}

function errorStatus(error) {
  if (error instanceof HostRpcNotAllowedError) return 404
  if (error instanceof SelectedHostRequiredError || error instanceof CrossHostIdentityError) return 400
  if (error instanceof SyntaxError || error instanceof TypeError || error?.code === 'browser-host-hub-rc1/invalid-request') return 400
  if (error?.code === 'browser-host-hub-rc1/request-too-large') return 413
  if (error?.code === 'browser-host-hub-rc1/method-not-allowed') return 405
  if (error?.code === 'browser-host-hub-rc1/invalid-content-type') return 415
  return 502
}

function jsonBytes(value) {
  const text = JSON.stringify(value)
  const bytes = new TextEncoder().encode(text)
  return { text, bytes }
}

function rejectionResponse(response, rejection) {
  if (rejection === 401 || rejection === 403) {
    writeResponse(response, rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, rejection === 401 ? 'unauthorized' : 'forbidden')
  } else writeResponse(response, 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'service unavailable')
}

/** Handle one authenticated official `/api/<endpoint>` BFF request. */
export async function handleBffRequest(ctx, hub, endpoint, request, response, options = {}) {
  if (typeof ctx?.authorizeRequest !== 'function') throw new TypeError('interface authorization port is required')
  let rejection
  try { rejection = await ctx.authorizeRequest(request) } catch { rejection = 503 }
  if (rejection !== undefined) { rejectionResponse(response, rejection); return }
  if (!ALLOWLIST.has(endpoint)) { writeResponse(response, 404, { 'Cache-Control': 'no-store' }); return }
  const method = String(request?.method ?? '').toUpperCase()
  if (method !== 'POST') {
    writeResponse(response, 405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'POST' }, 'method not allowed')
    return
  }
  const contentType = requestHeader(request, 'content-type')
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    writeResponse(response, 415, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'content type must be application/json')
    return
  }
  const maxRequestBytes = Number.isFinite(options.maxRequestBytes) ? Math.max(1, options.maxRequestBytes) : DEFAULT_MAX_REQUEST_BYTES
  const maxResponseBytes = Number.isFinite(options.maxResponseBytes) ? Math.max(1, options.maxResponseBytes) : undefined
  const lifetime = bffLifetime(request, response)
  let headersWritten = false
  try {
    const body = await readBffBody(request, maxRequestBytes, lifetime.signal)
    const message = decodeBrowserRequest(JSON.parse(body), endpoint)
    if (WORKSPACE_BINARY_ENDPOINTS.includes(endpoint)) {
      await hub.relayWorkspaceFileBytes(message, response, lifetime.signal)
      return
    }
    if (STREAM_ENDPOINTS.has(endpoint)) {
      const stream = hub.openStream(endpoint, message.payload, lifetime.signal)
      startResponse(response, 200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      headersWritten = true
      for await (const frame of stream) {
        if (lifetime.signal.aborted) break
        const line = `data: ${JSON.stringify(frame)}\n\n`
        if (maxResponseBytes !== undefined && Buffer.byteLength(line, 'utf8') > maxResponseBytes) throw new BrowserHostHubError('browser-host-hub-rc1/response-too-large', 'Stream frame exceeds the configured limit', { maxResponseBytes })
        if (response.write(line) === false) await once(response, 'drain', { signal: lifetime.signal })
      }
      if (!response.writableEnded) response.end()
      return
    }
    const result = await hub.call(endpoint, message.payload, lifetime.signal)
    if (!isRecord(result) || typeof result.ok !== 'boolean') throw new TypeError('Hub returned an invalid RPC result')
    const envelope = encodeBrowserResponse(message.rpcId, result)
    const text = JSON.stringify(envelope)
    if (Number.isFinite(options.maxResponseBytes) && Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw new BrowserHostHubError('browser-host-hub-rc1/response-too-large', 'RPC response exceeds the configured limit', { maxResponseBytes })
    writeResponse(response, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...coldDirectoryHeaders(result) }, text)
    headersWritten = true
  } catch (error) {
    if (headersWritten || responseHeadersSent(response)) {
      if (!response.writableEnded) response.destroy?.()
      return
    }
    const status = errorStatus(error)
    const payload = { error: jsonSafeError(error, status >= 500 ? 'browser-host-hub-rc1/bff-failure' : 'browser-host-hub-rc1/invalid-request') }
    let encoded
    try { encoded = jsonBytes(payload) } catch { encoded = { text: '{"error":{"code":"browser-host-hub-rc1/bff-failure","message":"BFF failure","details":{}}}' } }
    writeResponse(response, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, encoded.text)
  } finally {
    lifetime.dispose()
  }
}

function bootstrapScriptResponse(ctx, request, response, createScript) {
  return (async () => {
    if (typeof ctx?.authorizeRequest !== 'function') throw new TypeError('interface authorization port is required')
    let rejection
    try { rejection = await ctx.authorizeRequest(request) } catch { rejection = 503 }
    if (rejection !== undefined) { rejectionResponse(response, rejection); return }
    if (String(request?.method ?? '').toUpperCase() !== 'GET') {
      writeResponse(response, 405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Allow: 'GET' }, 'method not allowed')
      return
    }
    const script = createScript()
    writeResponse(response, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    }, script)
  })().catch(() => {
    if (!responseHeadersSent(response)) writeResponse(response, 503, { 'Cache-Control': 'no-store' }, 'service unavailable')
  })
}

/** Register the exact BFF routes. No arbitrary endpoint or proxy URL is exposed. */
export function registerBff(ctx, hub, options = {}) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') throw new TypeError('webServer.register is required')
  if (typeof ctx?.authorizeRequest !== 'function') throw new TypeError('interface authorization port is required')
  // `apiPrefix` remains the legacy one-prefix override.  With no override the
  // browser accepts the official `/api` input, while this BFF owns an
  // independent prefix so its Host carriers can still call official `/api`
  // without recursing into these routes.
  const legacyApiPrefix = options.apiPrefix
  const browserApiPrefix = normalizePathPrefix(options.browserApiPrefix ?? legacyApiPrefix ?? DEFAULT_API_PREFIX, 'browserApiPrefix')
  const bffApiPrefix = normalizePathPrefix(options.bffApiPrefix ?? options.bffPrefix ?? legacyApiPrefix ?? DEFAULT_BFF_API_PREFIX, 'bffApiPrefix')
  const bootstrapPath = normalizePathPrefix(options.bootstrapPath ?? BROWSER_BOOTSTRAP_PATH, 'bootstrapPath')
  const createScript = () => createBrowserBootstrapScript({
    browserApiPrefix,
    bffApiPrefix,
    streamPath: options.streamPath,
    hosts: options.perHost === undefined ? [] : readBootstrapHostInventory(options.perHost),
  })
  const disposers = []
  try {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: bootstrapPath, handler: (request, response) => bootstrapScriptResponse(ctx, request, response, createScript) }))
    disposers.push(registerStreamMux(ctx, hub, options))
    for (const endpoint of HOST_RPC_ALLOWLIST) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: routePath(bffApiPrefix, endpoint),
        handler: (request, response) => handleBffRequest(ctx, hub, endpoint, request, response, options)
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch { /* preserve registration failure */ } }
    throw error
  }
  return () => disposers.reverse().forEach(dispose => { try { dispose?.() } catch { /* preserve teardown */ } })
}

function scriptLiteral(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

/**
 * Self-contained browser bootstrap. It is served as a script-src before the
 * official boot-ready tail, and only adds a page-local Host selector to RPC
 * envelopes. The server remains the authority for allowlisting and mapping.
 */
export function createBrowserBootstrapScript(options = {}) {
  // Keep direct callers of the old `apiPrefix` option compatible, but make the
  // default browser-facing and server-facing prefixes distinct.
  const legacyApiPrefix = options.apiPrefix
  const browserApiPrefix = normalizePathPrefix(options.browserApiPrefix ?? legacyApiPrefix ?? DEFAULT_API_PREFIX, 'browserApiPrefix')
  const bffApiPrefix = normalizePathPrefix(options.bffApiPrefix ?? options.bffPrefix ?? (legacyApiPrefix ?? DEFAULT_BFF_API_PREFIX), 'bffApiPrefix')
  const streamPath = normalizePathPrefix(options.streamPath ?? BROWSER_STREAM_PATH, 'streamPath')
  const hosts = []
  const hostIds = new Set()
  for (const item of Array.isArray(options.hosts) ? options.hosts : []) {
    if (!isRecord(item) || typeof item.hostId !== 'string' || !item.hostId || typeof item.label !== 'string' || !item.label.trim() || hostIds.has(item.hostId)) continue
    hostIds.add(item.hostId)
    hosts.push({ hostId: item.hostId, label: item.label })
  }
  return `(function(){
  'use strict';
  const API_PREFIX=${scriptLiteral(browserApiPrefix)};
  const BFF_PREFIX=${scriptLiteral(bffApiPrefix)};
  const STREAM_PATH=${scriptLiteral(streamPath)};
  const DIRECT_CHANNELS=Object.freeze([
    {prefix:'/codex-subscription/',kind:'subscription'},
    {prefix:'/subscriptions-auth/',kind:'subscription'},
    {prefix:'/api/subscriptions-auth.',kind:'subscription',methodPrefix:'subscriptions-auth.'},
    {prefix:'/remote-hosts/',kind:'management'}
  ]);
  const SELECTOR=${scriptLiteral(HOST_SELECTOR)};
  const ALLOWLIST=new Set(${scriptLiteral(HOST_RPC_ALLOWLIST)});
  const STREAM_ENDPOINTS=new Set(${scriptLiteral([...STREAM_ENDPOINTS])});
  const DIAGNOSTIC_ENDPOINTS=new Set(${scriptLiteral([...STREAM_ENDPOINTS])});
  const DIAGNOSTIC_CODES=new Set(['unknown','timeout','aborted','transport','protocol','unauthorized','forbidden','overflow']);
  const HOSTS=Object.freeze(${scriptLiteral(hosts)}.map(item=>Object.freeze(item)));
  const stateKey='__DSH_BROWSER_HOST_HUB__';
  const previousState=globalThis[stateKey];
  let selectedHost=previousState && typeof previousState.getSelectedHost==='function' ? previousState.getSelectedHost() : 'local';
  const listeners=new Set();
  let coldRestoreReader;
  let coldRestoreConsumed;
  let coldDirectoryPending=false;
  let coldDirectoryRead;
  const coldRequest=Symbol();
  const state={
    bindColdRestoreReader(reader,consumed){
      if(typeof reader!=='function') throw new TypeError('cold restore reader must be a function');
      coldRestoreReader=reader;
      coldRestoreConsumed=consumed;
      return ()=>{if(coldRestoreReader===reader){coldRestoreReader=undefined;coldRestoreConsumed=undefined;coldDirectoryPending=false;coldDirectoryRead=undefined;}};
    },
    getSelectedHost(){return selectedHost;},
    setSelectedHost(value){
      if(value!==undefined && value!==null && (typeof value!=='string' || value.length===0)) throw new TypeError('selectedHost must be a non-empty string');
      selectedHost=value===null ? undefined : value;
      for(const listener of [...listeners]){try{listener(selectedHost);}catch(error){console.error('[browser-host-hub-rc1] selected Host listener failed',error);}}
      return selectedHost;
    },
    onSelectedHost(listener){
      if(typeof listener!=='function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return function(){return listeners.delete(listener);};
    },
    getHosts(){return HOSTS.map(item=>({hostId:item.hostId,label:item.label}));}
  };
  Object.defineProperty(state,'selectedHost',{enumerable:true,get(){return selectedHost;}});
  globalThis[stateKey]=state;
  const nativeFetch=globalThis.fetch.bind(globalThis);
  const previousTransport=globalThis.__DSH_TRANSPORT__;
  const randomId=()=>globalThis.crypto && typeof globalThis.crypto.randomUUID==='function' ? globalThis.crypto.randomUUID() : 'bff-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const own=(value,key)=>value!==null && typeof value==='object' && Object.prototype.hasOwnProperty.call(value,key);
  const targetUrl=input=>{
    const raw=typeof input==='string' ? input : input && (typeof input.href==='string' ? input.href : input.url);
    const url=new URL(raw, globalThis.location && globalThis.location.href || 'http://dsh.invalid/');
    if(globalThis.location && url.origin!==globalThis.location.origin) throw new TypeError('transport URL origin is not allowed');
    for(const channel of DIRECT_CHANNELS){
      if(url.pathname.startsWith(channel.prefix)){
        const endpoint=decodeURIComponent(url.pathname.slice(channel.prefix.length));
        if(endpoint.length===0 || url.pathname!==channel.prefix+endpoint) throw new TypeError(channel.kind+' transport path is not allowed');
        return {url,endpoint,direct:true,kind:channel.kind,envelopeMethod:channel.methodPrefix ? channel.methodPrefix+endpoint : endpoint};
      }
    }
    if(!url.pathname.startsWith(API_PREFIX+'/')) throw new TypeError('transport path is not allowed');
    const endpoint=decodeURIComponent(url.pathname.slice(API_PREFIX.length+1));
    if(!ALLOWLIST.has(endpoint) || url.pathname!==API_PREFIX+'/'+endpoint) throw new TypeError('RPC endpoint is not allowlisted: '+endpoint);
    return {url,endpoint};
  };
  const validateDirectRequest=(target,init)=>{
    const label=target.kind;
    const body=init && own(init,'body') ? init.body : undefined;
    if(typeof body!=='string') throw new TypeError(label+' transport request body must be JSON');
    let message;
    try{message=JSON.parse(body);}catch{throw new TypeError(label+' transport request body must be JSON');}
    const method=String(init && own(init,'method') ? init.method : 'GET').toUpperCase();
    if(method!=='POST') throw new TypeError(label+' transport requires POST');
    if(!message || message.type!=='client-request' || typeof message.rpcId!=='string' || message.rpcId.length===0 || message.method!==target.envelopeMethod) throw new TypeError('invalid '+label+' client-request envelope');
  };
  const readColdRestoreSession=${browserColdRestoreReaderSource()};
  let firstSessionList=true;
  const decorate=(target,init)=>{
    const body=init && own(init,'body') ? init.body : undefined;
    if(typeof body!=='string') throw new TypeError('transport request body must be JSON');
    let message;
    try{message=JSON.parse(body);}catch{throw new TypeError('transport request body must be JSON');}
    if(!message || message.type!=='client-request' || typeof message.rpcId!=='string' || message.method!==target.endpoint) throw new TypeError('invalid client-request envelope');
    if(message.payload && typeof message.payload==='object' && !Array.isArray(message.payload)){
      const payload={...message.payload};
      let read;
      if(selectedHost!==undefined && !own(payload,SELECTOR)) payload[SELECTOR]=selectedHost;
      if(target.endpoint==='$events' || target.endpoint==='session/list') payload.__pageId=pageId;
      if(target.endpoint==='session/list' && firstSessionList){
        firstSessionList=false;
        let id,value; try{value=coldRestoreReader?.();id=readColdRestoreSession(()=>value);}catch{}
        if(id!==undefined){
          payload.__coldRestore={sessionId:id};
          if(typeof coldRestoreConsumed==='function' && value?.signal){
            coldDirectoryPending=true;payload.__coldRestore.orderedRefresh='target';
            read={consume:coldRestoreConsumed,signal:value.signal};coldDirectoryRead=read;
          }
        }
      }
      if(target.endpoint==='session/list' && coldDirectoryPending && !payload.__coldRestore){payload.__coldRestore={orderedRefresh:'complete'};read=coldDirectoryRead&&!coldDirectoryRead.signal.aborted?{...coldDirectoryRead,completion:true}:undefined;}
      const decorated={...init,body:JSON.stringify({...message,payload})};
      if(read){decorated[coldRequest]=read;if(!read.completion)decorated.signal=init.signal?AbortSignal.any([init.signal,read.signal]):read.signal;}
      return decorated;
    }
    return init;
  };
  let socket;
  let socketPromise;
  let socketEpoch=0;
  let streamCounter=0;
  const pageId=randomId();
  const streams=new Map();
  const diagnosticEntries=[];
  const streamFailureCodec=${browserStreamFailureCodecSource()};
  const diagnosticCode=value=>streamFailureCodec.diagnosticCode(value);
  const diagnosticRecord=event=>{
    if(!event || (event.type!=='socket' && event.type!=='logical')) return;
    const endpoint=DIAGNOSTIC_ENDPOINTS.has(event.endpoint) ? event.endpoint : '$events';
    const phases=event.type==='socket' ? new Set(['open','close','error']) : new Set(['open','end','error','abort']);
    if(!phases.has(event.phase)) return;
    const item={type:event.type,phase:event.phase,endpoint,time:Date.now()};
    if(event.type==='logical' && typeof event.streamId==='string' && event.streamId.startsWith(pageId+':')) item.streamId=event.streamId;
    if(event.phase==='error') item.code=DIAGNOSTIC_CODES.has(event.code) ? event.code : diagnosticCode(event.error);
    if(Number.isFinite(event.closeCode)) item.closeCode=Math.max(0,Math.floor(event.closeCode));
    if(Number.isFinite(event.count)) item.count=Math.max(0,Math.floor(event.count));
    if(Number.isFinite(event.durationMs)) item.durationMs=Math.max(0,Math.floor(event.durationMs));
    if(event.error) Object.assign(item,streamFailureCodec.metadata(event.error));
    diagnosticEntries.push(Object.freeze(item));
    if(diagnosticEntries.length>200) diagnosticEntries.splice(0,diagnosticEntries.length-200);
  };
  const diagnostics=Object.freeze({snapshot:()=>Object.freeze(diagnosticEntries.map(item=>Object.freeze({...item})))});
  try{Object.defineProperty(globalThis,'__DSH_REMOTE_DIAGNOSTICS__',{value:diagnostics,configurable:true});}catch{}
  const streamCarrierFailure=(value,reason='transport-disconnected',stage='live')=>streamFailureCodec.fromWire({
    message:value instanceof Error ? value.message : 'browser stream carrier failed',
    streamFailure:{source:'carrier',reason,stage}
  });
  const recoverableStreamCloseCode=code=>code===1001 || code===1006;
  const streamFailure=value=>streamFailureCodec.fromWire(value);
  const removeAbort=record=>{if(record.signal && record.onAbort) record.signal.removeEventListener('abort',record.onAbort);};
  const finishRecord=(record,error)=>{
    if(record.terminal) return;
    record.terminal=true;
    record.error=error;
    streams.delete(record.streamId);
    removeAbort(record);
    diagnosticRecord({type:'logical',phase:record.aborted?'abort':error?'error':'end',endpoint:record.endpoint,streamId:record.streamId,error,count:record.count,durationMs:Date.now()-record.startedAt});
    for(const waiter of record.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({done:true,value:undefined});
  };
  const deliver=(record,frame)=>{
    if(record.terminal) return;
    if(frame.type==='item'){
      const waiter=record.waiters.shift();
      record.count++;
      if(waiter) waiter.resolve({done:false,value:frame.value});
      else record.items.push(frame.value);
      return;
    }
    if(frame.type==='end') finishRecord(record);
    else if(frame.type==='error') finishRecord(record,streamFailure(frame.error));
  };
  const failEpoch=(epoch,error)=>{
    for(const record of [...streams.values()]) if(record.epoch===epoch) {
      const failure=streamFailureCodec.metadata(error);
      finishRecord(record,failure ? streamFailureCodec.fromWire({code:error.code,message:error.message,streamFailure:{...failure,stage:record.count?'live':'bootstrap'}}) : error);
    }
  };
  const socketUrl=()=>{
    const url=new URL(STREAM_PATH,globalThis.location && globalThis.location.href || 'http://dsh.invalid/');
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    return url.href;
  };
  const ensureSocket=()=>{
    if(socket && socket.readyState===globalThis.WebSocket.OPEN) return Promise.resolve({socket,epoch:socketEpoch});
    if(socketPromise) return socketPromise;
    const epoch=++socketEpoch;
    const candidate=new globalThis.WebSocket(socketUrl());
    socket=candidate;
    socketPromise=new Promise((resolve,reject)=>{
      let opened=false;
      candidate.addEventListener('open',()=>{
        if(epoch!==socketEpoch || socket!==candidate) return;
        opened=true;
        diagnosticRecord({type:'socket',phase:'open',endpoint:'$events'});
        socketPromise=undefined;
        resolve({socket:candidate,epoch});
      });
      candidate.addEventListener('message',event=>{
        if(epoch!==socketEpoch || socket!==candidate || typeof event.data!=='string') return;
        let frame;
        try{frame=JSON.parse(event.data);}catch{return;}
        if(!frame || typeof frame.streamId!=='string') return;
        const record=streams.get(frame.streamId);
        if(record && record.epoch===epoch) deliver(record,frame);
      });
      candidate.addEventListener('close',event=>{
        if(epoch!==socketEpoch || socket!==candidate) return;
        diagnosticRecord({type:'socket',phase:'close',endpoint:'$events',closeCode:event?.code});
        socket=undefined;
        socketPromise=undefined;
        const disconnected=new Error('browser stream WebSocket disconnected');
        const error=recoverableStreamCloseCode(event?.code) ? streamCarrierFailure(disconnected,'transport-disconnected',opened?'live':'bootstrap') : disconnected;
        failEpoch(epoch,error);
        if(!opened) reject(error);
      });
      candidate.addEventListener('error',event=>{
        diagnosticRecord({type:'socket',phase:'error',endpoint:'$events',code:'transport',error:event});
        if(epoch!==socketEpoch || socket!==candidate || opened) return;
        const error=streamCarrierFailure(new Error('browser stream WebSocket connection failed'),'connect-failed','bootstrap');
        socket=undefined;
        socketPromise=undefined;
        failEpoch(epoch,error);
        reject(error);
      });
    });
    return socketPromise;
  };
  const cancelRecord=record=>{
    if(record.terminal) return;
    record.aborted=true;
    if(record.opened && socket && record.epoch===socketEpoch && socket.readyState===globalThis.WebSocket.OPEN){
      try{socket.send(JSON.stringify({type:'cancel',streamId:record.streamId}));}catch{}
    }
    finishRecord(record);
  };
  const protocolStream=(endpoint,payload,signal)=>{
    const streamId=pageId+':'+(++streamCounter).toString(36);
    const record={streamId,endpoint,epoch:undefined,opened:false,terminal:false,aborted:false,error:undefined,items:[],waiters:[],signal,onAbort:undefined,count:0,startedAt:Date.now()};
    streams.set(streamId,record);
    if(signal){
      if(signal.aborted) cancelRecord(record);
      else{record.onAbort=()=>cancelRecord(record);signal.addEventListener('abort',record.onAbort,{once:true});}
    }
    record.ready=ensureSocket().then(current=>{
      if(record.terminal) return;
      record.epoch=current.epoch;
      record.opened=true;
      diagnosticRecord({type:'logical',phase:'open',endpoint,streamId});
      current.socket.send(JSON.stringify({type:'open',streamId,endpoint,payload}));
    });
    void record.ready.catch(error=>finishRecord(record,error));
    return {
      ready:record.ready,
      next(){
        if(record.items.length) return Promise.resolve({done:false,value:record.items.shift()});
        if(record.terminal) return record.error ? Promise.reject(record.error) : Promise.resolve({done:true,value:undefined});
        return new Promise((resolve,reject)=>record.waiters.push({resolve,reject}));
      },
      return(){cancelRecord(record);return Promise.resolve({done:true,value:undefined});},
      [Symbol.asyncIterator](){return this;}
    };
  };
  const selectedPayload=(endpoint,payload)=>{
    const decorated=decorate({endpoint},{body:JSON.stringify({type:'client-request',rpcId:randomId(),method:endpoint,payload})});
    return JSON.parse(decorated.body).payload;
  };
  const streamResponse=async(message,signal)=>{
    const stream=protocolStream(message.method,message.payload,signal);
    await stream.ready;
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({
      async pull(controller){
        try{
          const item=await stream.next();
          if(item.done){controller.close();return;}
          controller.enqueue(encoder.encode('data: '+JSON.stringify(item.value)+'\\n\\n'));
        }catch(error){controller.error(error);}
      },
      cancel(){return stream.return();}
    }),{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','X-Accel-Buffering':'no'}});
  };
  const fetchHook=(input,init={})=>{
    const target=targetUrl(input);
    if(target.direct){
      validateDirectRequest(target,init);
      return nativeFetch(input,init);
    }
    const decorated=decorate(target,init);
    if(STREAM_ENDPOINTS.has(target.endpoint)) return streamResponse(JSON.parse(decorated.body),decorated.signal);
    const path=BFF_PREFIX==='/' ? '/'+target.endpoint : BFF_PREFIX+'/'+target.endpoint;
    const read=decorated[coldRequest];
    const request=nativeFetch(new URL(path,target.url.origin).href,decorated);
    if(target.endpoint!=='session/list') return request;
    return request.then(response=>{
      const phase=response.headers.get('X-DSH-Cold-Directory');
      const json=response.json;let consumed=false;
      if(!read && phase!=='complete') return response;
      response.json=function(...args){
        return json.apply(this,args).then(value=>{
          if(this===response && !consumed){
            consumed=true;
            if(read?.signal.aborted && !read.completion){if(coldRestoreConsumed===read.consume) read.consume(undefined,'failed');throw read.signal.reason;}
            if((phase==='complete' && value?.result?.ok===true && !decorated.signal?.aborted) || (read && !read.completion && phase!=='target')) coldDirectoryPending=false;
            if(read && (!read.completion || !decorated.signal?.aborted) && coldRestoreConsumed===read.consume) read.consume(value,phase);
          }
          return value;
        },error=>{if(this===response && !consumed){consumed=true;if(read && coldRestoreConsumed===read.consume) read.consume(undefined,'failed');}throw error;});
      };
      return response;
    },error=>{if(read && coldRestoreConsumed===read.consume) read.consume(undefined,'failed');throw error;});
  };
  async function* openStream(endpoint,payload,signal){
    if(!ALLOWLIST.has(endpoint)) throw new TypeError('RPC endpoint is not allowlisted: '+endpoint);
    if(!STREAM_ENDPOINTS.has(endpoint)) throw new TypeError('RPC endpoint is not streaming: '+endpoint);
    const stream=protocolStream(endpoint,selectedPayload(endpoint,payload),signal);
    try{for await(const item of stream) yield item;}
    finally{await stream.return();}
  }
  const transport={...(previousTransport && typeof previousTransport==='object' ? previousTransport : {}),fetch:fetchHook,openStream};
  globalThis.__DSH_TRANSPORT__=transport;
  state.transport=transport;
  state.shutdown=()=>{
    for(const record of [...streams.values()]) cancelRecord(record);
    try{socket && socket.close();}catch{}
    socket=undefined;
    socketPromise=undefined;
  };
  state.restore=()=>{state.shutdown();if(globalThis.__DSH_TRANSPORT__===transport) globalThis.__DSH_TRANSPORT__=previousTransport;};
})();\n` + fileProxyBootstrap()
}

export function registerBrowserBootstrap(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') throw new TypeError('ctx.on is required for browser bootstrap injection')
  const bootstrapPath = normalizePathPrefix(options.bootstrapPath ?? BROWSER_BOOTSTRAP_PATH, 'bootstrapPath')
  const listener = table => { if (Array.isArray(table)) table.unshift({ kind: 'script-src', placement: 'head', src: bootstrapPath }) }
  const dispose = ctx.on('webserver/index-inject', listener, { prepend: true })
  return typeof dispose === 'function' ? dispose : () => {}
}

export class BrowserHostHub {
  #perHost
  #runtimeInterface
  #browserVersion
  #codec
  #selectedHost
  #officeGeneration = makeId('dsh-hub-office-generation')
  #listeners = new Set()
  #events = new Map()
  #baseUrl
  #baseOrigin
  #homeValue
  #retryDelayMs
  #maxRetryDelayMs
  #initialBaselineTimeoutMs
  #sessionListSnapshots = new Map()
  #sessionListRefreshes = new Map()
  #sessionListSessionVersions = new Map()
  #archivedSessionIds = new Map()
  #archiveReplyOrder = new WeakMap()
  #archiveRequestOrder = 0
  #workspacePins = new Map()
  #aggregateHostTimeoutMs
  #sessionListRefreshTimeoutMs

  constructor(options = {}) {
    if (!isRecord(options) || options.perHost === undefined) throw new TypeError('perHost carrier map is required')
    this.#perHost = options.perHost
    if (options.runtimeInterface !== undefined && (typeof options.runtimeInterface?.wrapHostCarrier !== 'function' || typeof options.runtimeInterface?.encodeBrowser !== 'function')) throw new TypeError('runtimeInterface.wrapHostCarrier/encodeBrowser must be functions')
    this.#runtimeInterface = options.runtimeInterface
    this.#browserVersion = normalizeRuntimeVersion(options.browserVersion ?? options.runtimeInterface?.browserVersion ?? LEGACY_RUNTIME_VERSION)
    this.#codec = normalizeCodec(options.codec)
    this.#selectedHost = options.selectedHost
    if (this.#selectedHost !== undefined && (typeof this.#selectedHost !== 'string' || this.#selectedHost.length === 0)) throw new TypeError('selectedHost must be a non-empty string')
    this.#baseUrl = new URL(options.baseUrl ?? defaultBaseUrl()).toString()
    this.#baseOrigin = new URL(this.#baseUrl).origin
    if (options.home !== undefined && typeof options.home !== 'string') throw new TypeError('home must be a string')
    this.#homeValue = options.home
    this.#retryDelayMs = Math.max(0, Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS)
    this.#maxRetryDelayMs = Math.max(this.#retryDelayMs, Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : DEFAULT_MAX_RETRY_DELAY_MS)
    this.#initialBaselineTimeoutMs = Math.max(0, Number.isFinite(options.initialBaselineTimeoutMs) ? options.initialBaselineTimeoutMs : DEFAULT_INITIAL_BASELINE_TIMEOUT_MS)
    this.#aggregateHostTimeoutMs = Math.max(1, Number.isFinite(options.aggregateHostTimeoutMs) ? options.aggregateHostTimeoutMs : DEFAULT_AGGREGATE_HOST_TIMEOUT_MS)
    this.#sessionListRefreshTimeoutMs = Math.max(this.#aggregateHostTimeoutMs, Number.isFinite(options.sessionListRefreshTimeoutMs) ? options.sessionListRefreshTimeoutMs : DEFAULT_SESSION_LIST_REFRESH_TIMEOUT_MS)
    this.transport = Object.freeze({ fetch: this.fetch.bind(this), openStream: this.openStream.bind(this) })
  }

  hostIds() { return this.#entries().map(entry => entry.hostId) }

  getSelectedHost() { return this.#selectedHost }

  get selectedHost() { return this.#selectedHost }

  setSelectedHost(hostId) {
    if (hostId !== undefined && hostId !== null) assertString(hostId, 'selectedHost')
    const next = hostId === null ? undefined : hostId
    if (next !== undefined && !this.hostIds().includes(next)) throw new HostUnavailableError(next)
    this.#selectedHost = next
    for (const listener of this.#listeners) listener(next)
    return next
  }

  onSelectedHost(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #entries() {
    const source = typeof this.#perHost === 'function' ? this.#perHost() : this.#perHost
    const entries = source instanceof Map ? [...source.entries()] : isRecord(source) ? Object.entries(source) : []
    return entries.map(([hostId, value]) => {
      assertString(hostId, 'hostId')
      const carrier = isRecord(value) && own(value, 'carrier') && isRecord(value.carrier) ? value.carrier : value
      if (!isRecord(carrier) || typeof carrier.call !== 'function' || typeof carrier.open !== 'function') throw new TypeError(`perHost[${hostId}] must expose call/open`)
      if (carrier.runtimeInterfaceCarrier === true) return { hostId, carrier }
      const upstreamVersion = typeof value?.upstreamVersion === 'string'
        ? value.upstreamVersion
        : typeof carrier.upstreamVersion === 'string'
          ? carrier.upstreamVersion
          : this.#runtimeInterface?.upstreamVersion ?? this.#browserVersion
      const factory = this.#runtimeInterface?.wrapHostCarrier?.bind(this.#runtimeInterface) ?? wrapHostCarrier
      return { hostId, carrier: factory({ hostId, carrier, upstreamVersion }) }
    })
  }

  #entry(hostId) {
    const entry = this.#entries().find(candidate => candidate.hostId === hostId)
    if (entry === undefined) throw new HostUnavailableError(hostId)
    return entry
  }

  #encodeBrowser(value) {
    return this.#runtimeInterface?.encodeBrowser?.(value, this.#browserVersion)
      ?? canonicalToBrowserWire(value, this.#browserVersion)
  }

  #recordDiagnostic(event) {
    const record = this.#runtimeInterface?.diagnostics?.record
    if (typeof record !== 'function' || !isRecord(event) || !DIAGNOSTIC_PHASES.has(event.phase)) return
    const output = { phase: event.phase, endpoint: diagnosticEndpoint(event.endpoint) }
    for (const key of ['hostId', 'sessionId']) if (typeof event[key] === 'string' && event[key]) output[key] = event[key]
    if (DIAGNOSTIC_CODES.has(event.code)) output.code = event.code
    if (Number.isFinite(event.closeCode)) output.closeCode = event.closeCode
    if (Number.isFinite(event.count)) output.count = Math.max(0, Math.floor(event.count))
    if (Number.isFinite(event.durationMs)) output.durationMs = Math.max(0, Math.floor(event.durationMs))
    if (Number.isSafeInteger(event.lastSeq)) output.lastSeq = event.lastSeq
    Object.assign(output, sanitizeStreamFailure(event))
    try { record.call(this.#runtimeInterface.diagnostics, output) } catch { /* diagnostics must never affect transport */ }
  }

  #recordAggregateTerminal(endpoint, outerSignal, error, stage, completed, startedAt) {
    const failure = outerSignal.reason?.streamFailure
      ? classifyStreamFailure(outerSignal.reason, { stage })
      : error ? classifyStreamFailure(error, { stage, signal: outerSignal })
        : !completed ? classifyStreamFailure({ reason: 'aborted' }, { source: 'hub', stage }) : undefined
    this.#recordDiagnostic({ endpoint, durationMs: Date.now() - startedAt,
      phase: failure ? failure.reason === 'aborted' ? 'stream_cancel' : 'stream_error' : 'stream_end',
      ...(failure ? { ...failure, code: streamFailureDiagnosticCode(failure.reason) } : {}),
    })
  }

  #diagnosticSessionId(endpoint, payload) {
    const request = requestOf(payload)
    const value = request?.sessionId ?? request?.address?.sessionId
    if (typeof value !== 'string' || !value) return undefined
    try {
      if (isCompositeId(value)) return this.#codec.decodeCompositeId(value).rawId
    } catch { /* preserve an opaque identifier for the runtime diagnostic sanitizer */ }
    return value
  }

  #selectHost(endpoint, payload) {
    const hostIds = identityHostIds(endpoint, payload, this.#codec)
    if (hostIds.size > 1) throw new CrossHostIdentityError(endpoint, hostIds)
    // A browser-page selector is only a fallback for requests without a
    // resource identity. A single composite resource must route to its Host,
    // even when the bootstrap supplied the default local selector.
    if (hostIds.size === 1) return [...hostIds][0]
    if (own(payload, HOST_SELECTOR)) {
      const selected = payload[HOST_SELECTOR]
      assertString(selected, `${HOST_SELECTOR}`)
      this.#entry(selected)
      return selected
    }
    if (this.#selectedHost === undefined) throw new SelectedHostRequiredError(endpoint)
    return this.#selectedHost
  }

  async #callHost(endpoint, payload, signal, hostId) {
    const startedAt = Date.now()
    const sessionId = this.#diagnosticSessionId(endpoint, payload)
    const archiveOperation = endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession'
    const archiveSet = this.#archivedSessionIds.get(hostId)
    const archiveStamp = this.#archiveReplyOrder.get(archiveSet)
    const archiveRequest = archiveOperation ? { generation: archiveStamp ? archiveStamp.generation : archiveSet, order: ++this.#archiveRequestOrder } : undefined
    let carrierStarted = false
    this.#recordDiagnostic({ phase: 'request_start', endpoint, hostId, sessionId })
    try {
      const entry = this.#entry(hostId)
      const request = mapPayloadForHost(endpoint, payload, hostId, this.#codec)
      carrierStarted = true
      const result = resultOfCarrier(await entry.carrier.call(endpoint, request, signal))
      if (result.ok !== true) {
        // An acknowledged refusal is not a newer write. Explicit transport
        // uncertainty still fences older replies, using the interface vocabulary.
        // Cancellation cannot change an already acknowledged refusal's outcome.
        const fault = sanitizeStreamFailure(result.error?.streamFailure ?? result.error)
        if (archiveRequest && fault && ['unknown', 'first-frame-timeout', 'transport-timeout', 'transport-disconnected', 'connect-failed', 'stream-ended', 'aborted'].includes(fault.reason)) this.#fenceArchiveReply(hostId, archiveRequest)
        this.#recordDiagnostic({ phase: 'request_error', endpoint, hostId, sessionId, code: diagnosticCode(result.error, signal), durationMs: Date.now() - startedAt })
        return result
      }
      let mapped = mapUnaryValue(endpoint, result.value, hostId, this.#codec)
      if (endpoint.startsWith('workspace/') && Array.isArray(mapped?.pins)) {
        this.#workspacePins.set(hostId, mapped.pins)
        mapped = { ...mapped, pins: this.#combinedWorkspacePins() }
      }
      if (archiveOperation && Array.isArray(mapped?.archivedSessionIds)) {
        if (this.#acceptArchiveReply(hostId, archiveRequest)) {
          this.#recordArchivedSessionIds(hostId, mapped.archivedSessionIds, archiveRequest)
          const archived = new Set(mapped.archivedSessionIds)
          this.#workspacePins.set(hostId, (this.#workspacePins.get(hostId) ?? []).filter(id => !archived.has(id)))
        }
        mapped = { ...mapped, archivedSessionIds: this.#combinedArchivedSessionIds() }
      }
      const value = this.#encodeBrowser(mapped)
      this.#recordDiagnostic({ phase: 'request_success', endpoint, hostId, sessionId, durationMs: Date.now() - startedAt })
      return { ok: true, value }
    } catch (error) {
      // Preserve the error's write outcome; a cancelled read lifetime cannot
      // turn an interface capability refusal into an uncertain write.
      if (archiveRequest && carrierStarted && !['unauthorized', 'incompatible'].includes(classifyStreamFailure(error).reason)) this.#fenceArchiveReply(hostId, archiveRequest)
      this.#recordDiagnostic({ phase: 'request_error', endpoint, hostId, sessionId, code: diagnosticCode(error, signal), durationMs: Date.now() - startedAt })
      return failure(error)
    }
  }

  async #aggregateCall(endpoint, payload, signal) {
    const entries = this.#entries()
    if (entries.length === 0) return failure(new BrowserHostHubError('browser-host-hub-rc1/host-unavailable', 'No Host carrier is configured'))
                                                                                                                                             
    const pageId = typeof payload?.__pageId === 'string' && payload.__pageId.length <= 128 && payload.__pageId.length > 0 ? payload.__pageId : undefined
    let preferred
    const orderedTarget = pageId && payload?.__coldRestore?.orderedRefresh === 'target'
    const orderedComplete = pageId && payload?.__coldRestore?.orderedRefresh === 'complete'
    let targetOnly = false
    if (endpoint === 'session/list' && pageId && typeof payload?.__coldRestore?.sessionId === 'string') {
      try {
        preferred = this.#codec.decodeCompositeId(payload.__coldRestore.sessionId)
        if (!entries.some(entry => entry.hostId === preferred.hostId)) preferred = undefined
      } catch { /* unknown identities keep the complete aggregate policy */ }
    }
    payload = { ...payload }
    delete payload.__pageId
    delete payload.__coldRestore
    // Aggregate lists visit every Host; the page selector is not a Host argument
    // and must not split identical per-Host in-flight directory work.
    delete payload[HOST_SELECTOR]
    const requestKey = endpoint === 'session/list' ? JSON.stringify(payload) : undefined
    const results = new Array(entries.length)
    const calls = entries.map((entry, index) => (requestKey === undefined
      ? this.#boundedAggregateHostCall(endpoint, payload, signal, entry.hostId)
      : this.#boundedSessionListHostCall(payload, signal, entry.hostId, requestKey, pageId, orderedComplete))
      .then(result => { results[index] = result; return result }))
    const all = Promise.all(calls)
    // The remaining read lifetimes continue after an early reply; observe refusals.
    void all.catch(() => {})
    try {
      if (preferred) {
        const index = entries.findIndex(entry => entry.hostId === preferred.hostId)
        const result = await calls[index]
        const refresh = this.#sessionListRefreshes.get(`${preferred.hostId}\u0000${requestKey}`)
        const item = result.ok === true ? result.value?.items?.find(item => item.sessionId === this.#codec.encodeCompositeId(preferred.hostId, preferred.rawId)) : undefined
        const archived = this.#archivedSessionIds.get(preferred.hostId)
        const unchanged = (this.#sessionListSessionVersions.get(preferred.hostId)?.get(preferred.rawId) ?? 0) === (refresh?.startVersions.get(preferred.rawId) ?? 0)
        if (item?.blank !== false || item.origin === 'subagent' || orderedTarget && item.parentSessionId !== undefined || !archived || archived.has(preferred.rawId) || !unchanged || signal.aborted) await all
        else targetOnly = orderedTarget
      } else await all
    } finally {
      if (requestKey !== undefined && pageId) entries.forEach((entry, index) => {
        const key = `${entry.hostId}\u0000${requestKey}`
        const refresh = this.#sessionListRefreshes.get(key)
        if (!refresh) return
        for (const target of refresh.targets) if (target.pageId === pageId) {
          target.waiting = false
          if (targetOnly || results[index]?.ok === true) target.delivered = true
          else { target.deferred = true; refresh.deferred = true }
        }
        this.#publishSessionListRefresh(key, refresh)
      })
    }
    let unsafeFallback
    const usable = results.flatMap((result, index) => {
      if (requestKey === undefined) return result?.ok === true ? [result] : []
      const cacheKey = `${entries[index].hostId}\u0000${requestKey}`
      if (result?.ok === true) return [result]
      const snapshot = this.#sessionListSnapshots.get(cacheKey)
      if (snapshot === undefined) return []
      const hostId = entries[index].hostId
      const versions = this.#sessionListSessionVersions.get(hostId)
      const items = snapshot.value.items.filter(item => {
        const rawId = rawSessionIdentity(item.sessionId, hostId, this.#codec)
        if (this.#archivedSessionIds.get(hostId)?.has(rawId)) return false
        if ((versions?.get(rawId) ?? 0) !== (snapshot.versions.get(rawId) ?? 0)) {
          unsafeFallback ??= result?.ok === false ? result : failure(new HostUnavailableError(hostId))
          return false
        }
        return true
      })
      return [{ ok: true, value: { ...snapshot.value, items } }]
    })
    const successful = usable.filter(result => result.ok === true)
    if (successful.length === 0) return mergeError(results)
    const value = mergeListValues(endpoint, successful.map(result => result.value))
                                                                                                                                                           
    // Check entries, not the sparse result array: pending hosts must never count as complete.
                                                                                                                                                         
    // Early target eligibility does not restrict an all-success full fallback.
    const complete = (orderedComplete || (orderedTarget && preferred)) && entries.every((_, index) => results[index]?.ok === true) && !signal.aborted
    if (targetOnly && !complete) {
      value.items = value.items.filter(item => item.sessionId === this.#codec.encodeCompositeId(preferred.hostId, preferred.rawId))
      return Object.assign(success(value), { [COLD_DIRECTORY_PHASE]: 'target' })
    }
    // The public list consumer treats success as a complete replacement, so a
    // version-fenced cache omission must preserve its current summaries via failure.
    if (unsafeFallback) return unsafeFallback
    const result = success(value)
    if (complete) result[COLD_DIRECTORY_PHASE] = 'complete'
    return result
  }

  #rememberSessionListSnapshot(cacheKey, value, hostId, startVersions) {
    // Keep the existing bounded cache, with the same mutation fence as delivery.
    const versions = new Map((value.items ?? []).map(item => {
      const rawId = rawSessionIdentity(item.sessionId, hostId, this.#codec)
      return [rawId, startVersions.get(rawId) ?? 0]
    }))
    this.#sessionListSnapshots.delete(cacheKey)
    this.#sessionListSnapshots.set(cacheKey, { value, versions })
    while (this.#sessionListSnapshots.size > MAX_SESSION_LIST_SNAPSHOTS) {
      this.#sessionListSnapshots.delete(this.#sessionListSnapshots.keys().next().value)
    }
  }

  #bumpSessionListSessionVersion(hostId, sessionId) {
    if (typeof sessionId !== 'string') return
    let versions = this.#sessionListSessionVersions.get(hostId)
    if (versions === undefined) {
      versions = new Map()
      this.#sessionListSessionVersions.set(hostId, versions)
    }
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1)
  }

  #recordSessionEvent(hostId, raw) {
    const sessionId = rawSessionIdentity(sessionIdFromEvent(raw), hostId, this.#codec)
    if (sessionId !== undefined) this.#bumpSessionListSessionVersion(hostId, sessionId)
  }

  #recordControlFrame(hostId, frame) {
    // A complete baseline seeds the consumer; only a later delta is newer than
    // the list request and can invalidate its summary for this session.
    if (frame?.type !== 'projection') return
    const rawId = rawSessionIdentity(frame.sessionId, hostId, this.#codec)
    if (rawId !== undefined) this.#bumpSessionListSessionVersion(hostId, rawId)
  }

  #acceptArchiveReply(hostId, request) {
    const current = this.#archivedSessionIds.get(hostId)
    const stamp = this.#archiveReplyOrder.get(current)
    return request.generation === (stamp ? stamp.generation : current) && request.order > (stamp?.order ?? 0)
  }

  #fenceArchiveReply(hostId, request) {
    if (!this.#acceptArchiveReply(hostId, request)) return
    const current = new Set(this.#archivedSessionIds.get(hostId))
    this.#archiveReplyOrder.set(current, request)
    this.#archivedSessionIds.set(hostId, current)
  }

  #recordArchivedSessionIds(hostId, sessionIds, request) {
    if (!Array.isArray(sessionIds)) return
    const next = new Set()
    for (const sessionId of sessionIds) {
      const rawId = rawSessionIdentity(sessionId, hostId, this.#codec)
      if (rawId === undefined) continue
      next.add(rawId)
    }
    // Stream replacements have a fresh Set identity; control acknowledgements
    // carry only ordering metadata, never another copy of archive business state.
    if (request) this.#archiveReplyOrder.set(next, request)
    const previous = this.#archivedSessionIds.get(hostId) ?? new Set()
    for (const rawId of new Set([...previous, ...next])) {
      if (previous.has(rawId) !== next.has(rawId)) this.#bumpSessionListSessionVersion(hostId, rawId)
    }
    this.#archivedSessionIds.set(hostId, next)
  }

  #combinedArchivedSessionIds() {
    return this.#entries().flatMap(entry => [...this.#archivedSessionIds.get(entry.hostId) ?? []].map(rawId => this.#codec.encodeCompositeId(entry.hostId, rawId)))
  }

  #combinedWorkspacePins() {
    return this.#entries().flatMap(entry => this.#workspacePins.get(entry.hostId) ?? [])
  }

  #recordWorkspaceFrame(hostId, frame) {
    if (frame?.type === 'baseline') this.#workspacePins.set(hostId, frame.value?.pins ?? [])
    else if (frame?.type === 'pins') this.#workspacePins.set(hostId, frame.pins)
    if (frame?.type === 'baseline') this.#recordArchivedSessionIds(hostId, frame.value?.archivedSessionIds)
    else if (frame?.type === 'archived') this.#recordArchivedSessionIds(hostId, frame.archivedSessionIds)
  }

  #captureSessionListTargets(hostId, startVersions) {
    const targets = []
    for (const state of this.#events.values()) {
      const hostState = state.hostStates?.get(hostId)
      if (state.queue === undefined || hostState?.ready !== true || hostState.generation === undefined) continue
      targets.push({ state, hostState, generation: hostState.generation, versions: new Map(startVersions) })
    }
    return targets
  }

  #registerSessionListTargets(hostId, state, hostState, generation) {
    if (generation === undefined) return
    for (const [key, refresh] of this.#sessionListRefreshes) {
      if (refresh.hostId !== hostId) continue
      const cold = refresh.targets.filter(target => target.pageId && target.pageId === state.pageId)
      for (const target of cold) if (!target.delivered && target.state === undefined) Object.assign(target, { state, hostState, generation })
      if (cold.length === 0 && !refresh.completed && hostState.ready === true && !refresh.targets.some(target => target.state === state && target.hostState === hostState && target.generation === generation)) {
        refresh.targets.push({ state, hostState, generation, versions: new Map(refresh.startVersions) })
      }
      this.#publishSessionListRefresh(key, refresh)
    }
  }

  #publishSessionListRefresh(key, refresh) {
    if (!refresh.completed || refresh.expired) return
    for (const target of refresh.targets) {
      if (target.delivered || target.waiting) continue
      if (target.pageId && target.deferred && (target.state === undefined || target.hostState?.ready !== true)) continue
      if (refresh.deferred && (!target.pageId || target.deferred) && refresh.result?.ok === true) {
        for (const item of refresh.result.value?.items ?? []) {
          if (!this.#canPublishLateSessionItem(target, refresh.hostId, item)) continue
          const rawId = rawSessionIdentity(item.sessionId, refresh.hostId, this.#codec)
          const version = this.#sessionListSessionVersions.get(refresh.hostId)?.get(rawId) ?? 0
          let serialized
          try { serialized = JSON.stringify(item) } catch {}
          const pending = target.hostState.pendingLateItems.get(rawId)
          if (serialized !== undefined && pending?.version === version && pending.serialized === serialized) continue
          const packet = { hostId: refresh.hostId, generation: target.generation, frame: { type: 'emit', event: 'api-session/added', args: [serialized === undefined ? item : JSON.parse(serialized)] } }
          target.state.queue.push(packet)
          if (serialized === undefined) target.hostState.pendingLateItems.delete(rawId)
          else target.hostState.pendingLateItems.set(rawId, { packet, version, serialized })
        }
      }
      target.delivered = true
    }
    if (refresh.targets.every(target => target.delivered)) {
      clearTimeout(refresh.timer)
      if (this.#sessionListRefreshes.get(key) === refresh) this.#sessionListRefreshes.delete(key)
    }
  }

  #retireSessionListPage(state, hostState, generation) {
    if (!state.pageId) return
    for (const [key, refresh] of this.#sessionListRefreshes) {
      for (const target of refresh.targets) if (target.pageId === state.pageId && (target.state === state || target.state === undefined) && (!hostState || target.hostState === hostState && target.generation === generation)) {
        target.delivered = true
        if (hostState) refresh.invalidated = true
      }
      this.#publishSessionListRefresh(key, refresh)
    }
  }

  #canPublishLateSessionItem(target, hostId, item) {
    if (this.#events.get(target.state.clientId) !== target.state) return false
    const hostState = target.state.hostStates?.get(hostId)
    if (hostState !== target.hostState || hostState?.ready !== true || hostState.generation !== target.generation) return false
    const rawId = rawSessionIdentity(item?.sessionId, hostId, this.#codec)
    if (rawId === undefined) return false
    const versions = this.#sessionListSessionVersions.get(hostId)
    if ((versions?.get(rawId) ?? 0) !== (target.versions.get(rawId) ?? 0)) return false
    return this.#archivedSessionIds.get(hostId)?.has(rawId) !== true
  }

  async #boundedSessionListHostCall(payload, outerSignal, hostId, requestKey, pageId, orderedComplete = false) {
    const cacheKey = `${hostId}\u0000${requestKey}`
    let refresh = this.#sessionListRefreshes.get(cacheKey)
    if (refresh === undefined) {
      const controller = new AbortController()
      let promise
      const versions = this.#sessionListSessionVersions.get(hostId)
      const startVersions = versions === undefined ? new Map() : new Map(versions)
      const targets = this.#captureSessionListTargets(hostId, startVersions)
      refresh = { hostId, promise: undefined, deferred: false, completed: false, startVersions, targets, expired: false, result: undefined, timer: undefined }
      this.#sessionListRefreshes.set(cacheKey, refresh)
      promise = this.#callHost('session/list', payload, controller.signal, hostId)
        .then(result => {
          refresh.completed = true
          refresh.result = result
          if (!refresh.expired && !refresh.invalidated && result.ok === true) this.#rememberSessionListSnapshot(cacheKey, result.value, hostId, startVersions)
          this.#publishSessionListRefresh(cacheKey, refresh)
          return result
        })
      refresh.promise = promise
      refresh.timer = setTimeout(() => {
        refresh.expired = true
        refresh.targets.length = 0
        controller.abort()
        if (this.#sessionListRefreshes.get(cacheKey) === refresh) this.#sessionListRefreshes.delete(cacheKey)
      }, this.#sessionListRefreshTimeoutMs)
      refresh.timer.unref?.()
    }
    if (pageId) {
      let target = refresh.targets.find(target => target.pageId === pageId && !target.delivered)
      if (!target) {
        const state = [...this.#events.values()].find(state => state.pageId === pageId)
        const hostState = state?.hostStates?.get(hostId)
        target = refresh.targets.find(target => state && target.state === state)
        if (!target) { target = { versions: new Map(refresh.startVersions) }; refresh.targets.push(target) }
        Object.assign(target, { pageId, state, hostState, generation: hostState?.generation, waiting: true, delivered: false })
      } else target.waiting = true
    }

    let timer
    let stop
    const boundary = new Promise(resolve => {
      stop = () => resolve(failure(new BrowserHostHubError('browser-host-hub-rc1/host-unavailable', `Host unavailable: ${hostId}`, { hostId })))
      if (outerSignal.aborted) return stop()
      outerSignal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(() => {
        refresh.deferred = true
        resolve(failure(new BrowserHostHubError('browser-host-hub-rc1/host-timeout', `Host timed out: ${hostId}`, { hostId })))
      }, orderedComplete ? this.#sessionListRefreshTimeoutMs : this.#aggregateHostTimeoutMs)
      timer.unref?.()
    })
    try {
      const result = await Promise.race([refresh.promise, boundary])
      if (orderedComplete && (refresh.expired || refresh.invalidated || outerSignal.aborted)) return failure(new BrowserHostHubError('browser-host-hub-rc1/host-unavailable', 'Directory read was retired'))
      return result
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (stop !== undefined) outerSignal.removeEventListener('abort', stop)
    }
  }

  async #boundedAggregateHostCall(endpoint, payload, outerSignal, hostId) {
    const controller = new AbortController()
    let timer
    let stop
    const boundary = new Promise(resolve => {
      stop = () => {
        controller.abort(outerSignal.reason)
        resolve(failure(new BrowserHostHubError('browser-host-hub-rc1/host-unavailable', `Host unavailable: ${hostId}`, { hostId })))
      }
      if (outerSignal.aborted) return stop()
      outerSignal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(() => {
        controller.abort()
        resolve(failure(new BrowserHostHubError('browser-host-hub-rc1/host-timeout', `Host timed out: ${hostId}`, { hostId })))
      }, this.#aggregateHostTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([this.#callHost(endpoint, payload, controller.signal, hostId), boundary])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (stop !== undefined) outerSignal.removeEventListener('abort', stop)
    }
  }

  async relayWorkspaceFileBytes(message, response, signal) {
    const hostId = this.#selectHost(message.method, message.payload)
    const entry = this.#entry(hostId)
    const callSignal = abortSignalOf(signal)
    if (typeof entry.carrier.connect === 'function') await entry.carrier.connect(callSignal)
                                                                                        
    if (typeof entry.carrier.ensureCapability === 'function') await entry.carrier.ensureCapability(message.method, callSignal)
    callSignal.throwIfAborted()
    const request = workspaceFileBytesRequest(message, hostId, this.#codec, entry.carrier.upstreamVersion)
    return relayWorkspaceFileBytes(this.#perHost, hostId, request, response, callSignal)
  }

  async call(endpoint, payload, signal) {
    if (endpoint === EVENT_RESULT_ENDPOINT) return this.#eventResult(payload, signal)
    if (WORKSPACE_BINARY_ENDPOINTS.includes(endpoint)) throw new BrowserHostHubError('browser-host-hub-rc1/binary-http-only', 'Workspace bytes require their original HTTP response')
    if (!ALLOWLIST.has(endpoint) || STREAM_ENDPOINTS.has(endpoint)) {
      if (STREAM_ENDPOINTS.has(endpoint)) throw new BrowserHostHubError('browser-host-hub-rc1/stream-only', `Endpoint is stream-only: ${endpoint}`, { endpoint })
      throw new HostRpcNotAllowedError(endpoint)
    }
    const callSignal = abortSignalOf(signal)
    if (endpoint === 'officeToPdf/generation') {
      try {
        callSignal.throwIfAborted()
        workspaceIdentityReferences(endpoint, payload?.args)
        // 原生查询无file上下文：Hub独立代次不匹配Host UUID，保原pending合并但不retain完成PDF。
        return success(this.#officeGeneration)
      } catch (error) { return failure(error) }
    }
    if (AGGREGATE_UNARY.has(endpoint)) return this.#aggregateCall(endpoint, payload, callSignal)
    let hostId
    try { hostId = this.#selectHost(endpoint, payload) } catch (error) { return failure(error) }
    return this.#callHost(endpoint, payload, callSignal, hostId)
  }

  async #eventResult(payload, signal) {
    let args
    try { args = decodeBrowserInteractionResult(payload) }
    catch { return failure(new BrowserHostHubError('browser-host-hub-rc1/invalid-event-result', 'Invalid $events/result payload')) }
    const state = this.#events.get(args.clientId)
    if (state === undefined) return failure(new BrowserHostHubError('gateway/invocation-unavailable', 'Synthetic event clientId is not active'))
    const interaction = state.mappings.get(args.eventId)
    if (interaction?.interaction === true) {
      // A browser without a matching UI listener may decline this delivery.
      // That is not a decision on the peer-owned business interaction.
      if (args.decision === 'defer') {
        const diagnostic = interaction.defer()
        if (diagnostic) this.#recordDiagnostic({ ...diagnostic, endpoint: EVENT_RESULT_ENDPOINT })
        return { ok: true, value: undefined }
      }
      if (!interaction.confirmed) return failure(new BrowserHostHubError('INTERACTION_UNCONFIRMED', 'Interaction is awaiting confirmation after reconnect'))
      if (args.decision === 'reject') this.#recordDiagnostic({ phase: 'interaction_rejected', endpoint: EVENT_RESULT_ENDPOINT, hostId: interaction.hostId, sessionId: interaction.sessionId, count: interaction.count })
      try {
        await this.#entry(interaction.hostId).carrier.interactions.respond({ runtimeEpoch: interaction.runtimeEpoch,
          ownerInstanceId: interaction.ownerInstanceId, interactionId: interaction.interactionId, outcome: args.outcome }, abortSignalOf(signal))
        interaction.retryAt = Infinity // An accepted answer must not be presented again before owner reconciliation.
        this.#recordDiagnostic({ phase: 'interaction_answer', endpoint: EVENT_RESULT_ENDPOINT, hostId: interaction.hostId, sessionId: interaction.sessionId, count: interaction.count })
        return { ok: true, value: undefined }
      } catch (error) { return failure(error) }
    }
    let decoded
    try { decoded = decodeSyntheticEventId(args.eventId, this.#codec) } catch (error) { return failure(error, 'browser-host-hub-rc1/invalid-event-id') }
    const mapping = state.mappings.get(args.eventId)
    if (mapping === undefined || decoded.hostId !== mapping.hostId || decoded.clientId !== mapping.remoteClientId || decoded.eventId !== mapping.remoteEventId) return failure(new BrowserHostHubError('gateway/invocation-unavailable', 'Synthetic eventId does not belong to this event stream'))
    try {
      const entry = this.#entry(mapping.hostId)
      // The browser uses the official Typert payload envelope (`args`), while
      // the injected Host carrier already targets the endpoint's decoded
      // method and therefore receives the named parameters directly.
      const result = resultOfCarrier(await entry.carrier.call(EVENT_RESULT_ENDPOINT, { args: { clientId: mapping.remoteClientId, eventId: mapping.remoteEventId, outcome: args.outcome } }, abortSignalOf(signal)))
      return result.ok === true ? { ok: true, value: this.#encodeBrowser(result.value) } : result
    } catch (error) {
      return failure(error)
    }
  }

  async #pumpHost(hostId, endpoint, payload, signal, queue, mapper) {
    let retry = this.#retryDelayMs
    while (!signal.aborted) {
      const startedAt = Date.now()
      let count = 0
      let lastSeq
      let generationBaseline = false
      this.#recordDiagnostic({ phase: 'stream_open', endpoint, hostId, sessionId: this.#diagnosticSessionId(endpoint, payload) })
      try {
        const entry = this.#entry(hostId)
        const source = await entry.carrier.open(endpoint, mapPayloadForHost(endpoint, payload, hostId, this.#codec), signal, { diagnosticOwner: 'consumer' })
        for await (const raw of source) {
          const sequence = diagnosticSequence(raw)
          if (sequence !== undefined) lastSeq = sequence
          const mapped = mapper(raw, hostId)
          const frame = endpoint === 'session/control' || endpoint === 'workspace/follow' ? mapped : this.#encodeBrowser(mapped)
          count++
          if (!generationBaseline) {
            if (frame?.type !== 'baseline') throw markStreamFailure(new TypeError(`${endpoint} generation must begin with baseline`), classifyStreamFailure({ reason: 'invalid-snapshot' }, { source: 'hub', stage: 'bootstrap' }))
            generationBaseline = true
            retry = this.#retryDelayMs
            this.#recordDiagnostic({ phase: 'stream_snapshot', endpoint, hostId, sessionId: this.#diagnosticSessionId(endpoint, payload), count, lastSeq, durationMs: Date.now() - startedAt })
          }
          queue.push({ hostId, frame })
        }
        if (!signal.aborted) this.#recordDiagnostic({ phase: 'stream_end', endpoint, hostId, sessionId: this.#diagnosticSessionId(endpoint, payload), count, lastSeq, durationMs: Date.now() - startedAt })
        retry = this.#retryDelayMs
      } catch (error) {
        if (signal.aborted) break
        const failure = classifyStreamFailure(signal.reason?.streamFailure ? signal.reason : error, { stage: generationBaseline ? 'live' : 'bootstrap', ...signal.reason?.streamFailure ? {} : { signal } })
        this.#recordDiagnostic({ phase: failure.reason === 'aborted' ? 'stream_cancel' : 'stream_error', endpoint, hostId, sessionId: this.#diagnosticSessionId(endpoint, payload), ...failure, code: streamFailureDiagnosticCode(failure.reason), count, lastSeq, durationMs: Date.now() - startedAt })
        // Only this Host stops on a terminal protocol/auth/resource error.
        if (!failure.recoverable) break
      }
      if (signal.aborted) break
      await wait(retry, signal)
      retry = retry === 0 ? 0 : Math.min(this.#maxRetryDelayMs, Math.max(this.#retryDelayMs, retry * 2))
    }
  }

  async *#aggregateBaselineStream(endpoint, payload, signal, mapper, emptyValue, merge) {
    const outerSignal = abortSignalOf(signal)
    const entries = this.#entries()
    if (entries.length === 0) {
      yield this.#encodeBrowser({ type: 'baseline', value: emptyValue() })
      return
    }
    const startedAt = Date.now()
    const mergeCurrent = values => {
      const value = merge(values)
      return endpoint === 'workspace/follow' ? { ...value, pins: this.#combinedWorkspacePins(), archivedSessionIds: this.#combinedArchivedSessionIds() } : value
    }
    let terminalError
    let completed = false
    const lifetime = new AbortController()
    const stop = () => lifetime.abort(outerSignal.reason)
    outerSignal.addEventListener('abort', stop, { once: true })
    const queue = new AsyncQueue()
                                                                                                                                                   
    if (endpoint === 'workspace/follow') {
      const currentHosts = new Set(entries.map(entry => entry.hostId))
      for (const hostId of this.#workspacePins.keys()) if (!currentHosts.has(hostId)) this.#workspacePins.delete(hostId)
      for (const hostId of this.#archivedSessionIds.keys()) if (!currentHosts.has(hostId)) this.#archivedSessionIds.delete(hostId)
    }
    const baselineByHost = new Map()
    const baselineHosts = new Set()
    if (endpoint === 'workspace/follow') for (const entry of entries) {
      baselineByHost.set(entry.hostId, {
        items: [],
        workspaceState: true,
        pins: this.#workspacePins.get(entry.hostId) ?? [],
        archivedSessionIds: [...this.#archivedSessionIds.get(entry.hostId) ?? []].map(rawId => this.#codec.encodeCompositeId(entry.hostId, rawId)),
      })
    }
    const running = entries.map(entry => this.#pumpHost(entry.hostId, endpoint, payload, lifetime.signal, queue, mapper))
    let initial = false
    let deadline = Date.now() + this.#initialBaselineTimeoutMs
    try {
      while (!outerSignal.aborted) {
        let item
        if (!initial && baselineHosts.size < entries.length && baselineHosts.size > 0 && this.#initialBaselineTimeoutMs === 0) {
          initial = true
          yield this.#encodeBrowser({ type: 'baseline', value: mergeCurrent([...baselineByHost.values()]) })
          continue
        }
        if (!initial && baselineHosts.size < entries.length && baselineHosts.size > 0 && this.#initialBaselineTimeoutMs > 0) {
          const remaining = Math.max(0, deadline - Date.now())
          item = await queue.next(outerSignal, remaining)
          if (item?.timeout) {
            initial = true
            yield this.#encodeBrowser({ type: 'baseline', value: mergeCurrent([...baselineByHost.values()]) })
            continue
          }
        } else item = await queue.next(outerSignal)
        if (outerSignal.aborted || item?.done) break
        const packet = item.value
        const frame = packet.frame
        if (endpoint === 'workspace/follow') this.#recordWorkspaceFrame(packet.hostId, frame)
        if (endpoint === 'session/control') this.#recordControlFrame(packet.hostId, frame)
        if (frame?.type === 'baseline') {
          const previous = baselineByHost.get(packet.hostId) ?? emptyValue()
          baselineByHost.set(packet.hostId, frame.value)
          baselineHosts.add(packet.hostId)
          if (!initial && baselineHosts.size === entries.length) {
            initial = true
            yield this.#encodeBrowser({ type: 'baseline', value: mergeCurrent([...baselineByHost.values()]) })
          } else if (initial) {
            const updates = replacementIncrements(endpoint, previous, frame.value, mergeCurrent([...baselineByHost.values()]))
            if (updates === undefined) { completed = true; return }
            for (const update of updates) {
              const encoded = this.#encodeBrowser(update)
              if (encoded !== undefined) yield encoded
            }
          }
        } else {
          baselineByHost.set(packet.hostId, applyAggregateIncrement(endpoint, baselineByHost.get(packet.hostId), frame))
          if (initial) {
            if (endpoint === 'workspace/follow' && frame.type === 'order') {
              yield { type: 'order', workspaceIds: merge([...baselineByHost.values()]).items.map(item => item.workspaceId) }
            } else if (endpoint === 'workspace/follow' && frame.type === 'archived') {
              yield { type: 'archived', archivedSessionIds: this.#combinedArchivedSessionIds() }
            } else if (endpoint === 'workspace/follow' && frame.type === 'pins') {
              const encoded = this.#encodeBrowser({ type: 'pins', pins: this.#combinedWorkspacePins() })
              if (encoded !== undefined) yield encoded
            } else {
              const encoded = this.#encodeBrowser(frame)
              if (encoded !== undefined) yield encoded
            }
          }
        }
      }
    } catch (error) {
      terminalError = error
      throw error
    } finally {
      this.#recordAggregateTerminal(endpoint, outerSignal, terminalError, initial ? 'live' : 'bootstrap', completed, startedAt)
      outerSignal.removeEventListener('abort', stop)
      lifetime.abort()
      queue.close()
      await Promise.allSettled(running)
    }
  }

  async *#singleHostStream(endpoint, payload, signal, hostId, mapper) {
    const outerSignal = abortSignalOf(signal)
    const lifetime = new AbortController()
    const stop = () => lifetime.abort(outerSignal.reason)
    outerSignal.addEventListener('abort', stop, { once: true })
    if (outerSignal.aborted) stop()
    let hasSnapshot = false
    let completedNormally = false
    let terminalError
    let streamEncoder
    const startedAt = Date.now()
    let count = 0
    let lastSeq
    const sessionId = this.#diagnosticSessionId(endpoint, payload)
    const makeStreamEncoder = this.#runtimeInterface?.createBrowserStreamEncoder?.bind(this.#runtimeInterface) ?? createBrowserStreamEncoder
    this.#recordDiagnostic({ phase: 'stream_open', endpoint, hostId, sessionId })
    try {
      // One upstream generation per consumer subscription. Official consumers
      // own recovery and cancellation; transport progress has no first-frame budget.
      streamEncoder = endpoint.startsWith('job/') ? createJobStreamEncoder(endpoint, value => this.#encodeBrowser(value)) : makeStreamEncoder({
        upstreamVersion: CURRENT_RUNTIME_VERSION,
        targetVersion: this.#browserVersion,
        request: payload,
        encodeFrame: value => this.#encodeBrowser(value),
      })
      const entry = this.#entry(hostId)
      const source = await entry.carrier.open(endpoint, mapPayloadForHost(endpoint, payload, hostId, this.#codec), lifetime.signal, { diagnosticOwner: 'consumer' })
      for await (const raw of source) {
        if (outerSignal.aborted) break
        const sequence = diagnosticSequence(raw)
        if (sequence !== undefined) lastSeq = sequence
        for (const frame of streamEncoder.push(mapper(raw, hostId))) {
          if (outerSignal.aborted) break
          count++
          if (!hasSnapshot) {
            if (streamEncoder.isOpening ? !streamEncoder.isOpening(frame) : frame?.type !== 'snapshot') throw new SessionFollowBootstrapError(hostId, 'invalid-first-frame')
            hasSnapshot = true
            this.#recordDiagnostic({ phase: 'stream_snapshot', endpoint, hostId, sessionId, count, lastSeq, durationMs: Date.now() - startedAt })
          }
          yield frame
        }
      }
      if (!outerSignal.aborted) {
        if (!hasSnapshot) throw new SessionFollowBootstrapError(hostId, 'stream-ended-before-snapshot')
        streamEncoder.end?.()
        completedNormally = true
      }
    } catch (error) {
      if (!outerSignal.aborted) {
        terminalError = markStreamFailure(error, classifyStreamFailure(error, { stage: hasSnapshot ? 'live' : 'bootstrap' }))
        throw terminalError
      }
    } finally {
      outerSignal.removeEventListener('abort', stop)
      lifetime.abort()
      streamEncoder?.close?.()
      // The Hub owns one terminal per logical subscription. The interface only
      // attaches metadata here; it must not journal this same subscription again.
      const failure = outerSignal.reason?.streamFailure
        ? classifyStreamFailure(outerSignal.reason, { stage: hasSnapshot ? 'live' : 'bootstrap' })
        : terminalError ? classifyStreamFailure(terminalError, { stage: hasSnapshot ? 'live' : 'bootstrap', signal: outerSignal })
          : !completedNormally ? classifyStreamFailure({ reason: 'aborted' }, { source: 'hub', stage: hasSnapshot ? 'live' : 'bootstrap' }) : undefined
      this.#recordDiagnostic({
        phase: failure ? failure.reason === 'aborted' ? 'stream_cancel' : 'stream_error' : 'stream_end',
        endpoint, hostId, sessionId, count, lastSeq, durationMs: Date.now() - startedAt,
        ...(failure ? { ...failure, code: streamFailureDiagnosticCode(failure.reason) } : {}),
      })
    }
  }

  async *#eventsStream(payload, signal) {
    const outerSignal = abortSignalOf(signal)
    const clientId = makeId('bff-client')
    const state = { clientId, mappings: new Map(), pageId: typeof payload?.__pageId === 'string' && payload.__pageId.length > 0 && payload.__pageId.length <= 128 ? payload.__pageId : undefined }
    this.#events.set(clientId, state)
    const entries = this.#entries()
    if (entries.length === 0) {
      try { yield { type: 'ready', clientId, host: { home: this.#home() } } } finally { this.#events.delete(clientId) }
      return
    }
    const startedAt = Date.now()
    let terminalError
    let completed = false
    const lifetime = new AbortController()
    const stop = () => lifetime.abort(outerSignal.reason)
    outerSignal.addEventListener('abort', stop, { once: true })
    const queue = new AsyncQueue()
    state.queue = queue
    const hostStates = new Map(entries.map(entry => [entry.hostId, { remoteClientId: undefined, byRawEventId: new Map(), pendingLateItems: new Map(), ready: false, generation: undefined }]))
    state.hostStates = hostStates
    const running = entries.flatMap(entry => [
      this.#pumpEventsHost(entry.hostId, payload, lifetime.signal, queue, hostStates.get(entry.hostId), state),
      this.#pumpInteractions(entry.hostId, lifetime.signal, queue, state),
    ])
    let ready = false
    try {
      while (!outerSignal.aborted) {
        const item = await queue.next(outerSignal)
        if (item.done) break
        const packet = item.value
        if (packet?.generation !== undefined) {
          const hostState = state.hostStates?.get(packet.hostId)
          const rawId = rawSessionIdentity(sessionIdFromEvent(packet.frame), packet.hostId, this.#codec)
          if (hostState?.pendingLateItems.get(rawId)?.packet === packet) hostState.pendingLateItems.delete(rawId)
          if (hostState?.ready !== true || hostState.generation !== packet.generation) continue
        }
        if (packet?.frame === undefined) continue
        if (packet.frame.type === 'ready') {
          const hostHome = packet.frame.host.home
          if (!ready) {
            ready = true
            yield { type: 'ready', clientId, host: { home: this.#home(hostHome) } }
          }
          continue
        }
        if (!ready) {
          ready = true
          yield { type: 'ready', clientId, host: { home: this.#home() } }
        }
        yield packet.frame
      }
    } catch (error) {
      terminalError = error
      throw error
    } finally {
      this.#recordAggregateTerminal('$events', outerSignal, terminalError, ready ? 'live' : 'bootstrap', completed, startedAt)
      outerSignal.removeEventListener('abort', stop)
      lifetime.abort()
      queue.close()
      await Promise.allSettled(running)
      this.#retireSessionListPage(state)
      this.#events.delete(clientId)
    }
  }

  #home(fallback = '') {
    return this.#homeValue === undefined ? fallback : this.#homeValue
  }

  async #pumpInteractions(hostId, signal, queue, state) {
    const view = new InteractionView({ hostId, codec: this.#codec, mappings: state.mappings })
    let query = { waitMs: 10000 }
    let retry = this.#retryDelayMs
    let failed = false
    while (!signal.aborted) {
      try {
        const snapshot = await this.#entry(hostId).carrier.interactions.read(query, signal)
        if (signal.aborted) break
        for (const frame of view.accept(snapshot)) {
          const delivery = state.mappings.get(frame.eventId)
          if (delivery) this.#recordDiagnostic({ phase: 'interaction_delivery', endpoint: '$events', hostId, sessionId: delivery.sessionId, count: delivery.count })
          queue.push({ hostId, frame })
        }
        query = { ownerInstanceId: snapshot.ownerInstanceId, afterRevision: snapshot.revision, waitMs: 10000 }
        if (failed) this.#recordDiagnostic({ phase: 'stream_snapshot', endpoint: 'hostInteractions/v1/read', hostId })
        failed = false
        retry = this.#retryDelayMs
      } catch (error) {
        if (signal.aborted) break
        view.unavailable()
        if (!failed) this.#recordDiagnostic({ phase: 'stream_error', endpoint: 'hostInteractions/v1/read', hostId,
          ...classifyStreamFailure(error, { source: 'interface', stage: 'live' }), code: /^INTERACTION_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'INTERACTION_PEER_UNAVAILABLE' })
        failed = true
        if (error?.recoverable !== true) break
        await wait(Math.max(25, retry), signal)
        retry = Math.min(Math.max(25, this.#maxRetryDelayMs), Math.max(25, retry * 2))
      }
    }
  }

  async #pumpEventsHost(hostId, payload, signal, queue, hostState, aggregateState) {
                                                                                                                                                                 
    let retry = this.#retryDelayMs
    while (!signal.aborted) {
      const generation = {}
      hostState.remoteClientId = undefined
      hostState.byRawEventId.clear()
      hostState.pendingLateItems.clear()
      hostState.ready = false
      hostState.generation = generation
      this.#registerSessionListTargets(hostId, aggregateState, hostState, generation)
      const startedAt = Date.now()
      let count = 0
      let lastSeq
      let generationReady = false
      let recover = true
      try {
        const entry = this.#entry(hostId)
        let snapshot = false
        this.#recordDiagnostic({ phase: 'stream_open', endpoint: '$events', hostId })
        const source = await entry.carrier.open('$events', mapPayloadForHost('$events', payload, hostId, this.#codec), signal, { diagnosticOwner: 'consumer' })
        for await (const raw of source) {
          if (!isRecord(raw)) continue
          count++
          const sequence = diagnosticSequence(raw)
          if (sequence !== undefined) lastSeq = sequence
          if (raw.type === 'ready') {
            if (typeof raw.clientId !== 'string' || raw.clientId.length === 0 || !isRecord(raw.host) || typeof raw.host.home !== 'string') throw markStreamFailure(new TypeError('invalid Host $events ready frame'), classifyStreamFailure({ reason: 'invalid-snapshot' }, { source: 'hub', stage: 'bootstrap' }))
            hostState.remoteClientId = raw.clientId
            hostState.byRawEventId.clear()
            generationReady = true
            retry = this.#retryDelayMs
            hostState.ready = true
            if (!snapshot) {
              snapshot = true
              this.#recordDiagnostic({ phase: 'stream_snapshot', endpoint: '$events', hostId, count, lastSeq, durationMs: Date.now() - startedAt })
            }
            this.#registerSessionListTargets(hostId, aggregateState, hostState, generation)
            queue.push({ hostId, frame: { type: 'ready', clientId: raw.clientId, host: { home: raw.host.home } } })
            continue
          }
          if (!generationReady || typeof hostState.remoteClientId !== 'string') throw markStreamFailure(new TypeError('Host $events frame arrived before ready'), classifyStreamFailure({ reason: 'invalid-snapshot' }, { source: 'hub', stage: 'bootstrap' }))
          if (isCoreInteractionFrame(raw)) continue
          if (raw.type === 'waterfall') {
            if (typeof raw.eventId !== 'string' || typeof raw.event !== 'string') throw markStreamFailure(new TypeError('invalid Host waterfall frame'), classifyStreamFailure({ reason: 'invalid-frame' }, { source: 'hub', stage: 'live' }))
            const synthetic = encodeSyntheticEventId(hostId, hostState.remoteClientId, raw.eventId, this.#codec)
            const mapping = { hostId, remoteClientId: hostState.remoteClientId, remoteEventId: raw.eventId }
            hostState.byRawEventId.set(raw.eventId, synthetic)
            aggregateState.mappings.set(synthetic, mapping)
            queue.push({ hostId, generation, frame: { ...raw, eventId: synthetic, ...typeof raw.agentId === 'string' ? { agentId: this.#codec.encodeCompositeId(hostId, raw.agentId) } : {} } })
          } else if (raw.type === 'cancel') {
            const synthetic = hostState.byRawEventId.get(raw.eventId)
            if (synthetic !== undefined) {
              hostState.byRawEventId.delete(raw.eventId)
              aggregateState.mappings.delete(synthetic)
              queue.push({ hostId, frame: { ...raw, eventId: synthetic } })
            }
          } else {
            this.#recordSessionEvent(hostId, raw)
            queue.push({ hostId, frame: mapSessionEvent(raw, hostId, this.#codec) })
          }
        }
        if (!signal.aborted) this.#recordDiagnostic({ phase: 'stream_end', endpoint: '$events', hostId, count, lastSeq, durationMs: Date.now() - startedAt })
        retry = this.#retryDelayMs
      } catch (error) {
        if (signal.aborted) break
        const failure = classifyStreamFailure(signal.reason?.streamFailure ? signal.reason : error, { stage: generationReady ? 'live' : 'bootstrap', ...signal.reason?.streamFailure ? {} : { signal } })
        recover = failure.recoverable
        this.#recordDiagnostic({ phase: failure.reason === 'aborted' ? 'stream_cancel' : 'stream_error', endpoint: '$events', hostId, ...failure, code: streamFailureDiagnosticCode(failure.reason), count, lastSeq, durationMs: Date.now() - startedAt })
        // Do not retry terminal errors or close another Host's global queue.
      } finally {
        if (hostState.generation === generation) {
          this.#retireSessionListPage(aggregateState, hostState, generation)
          hostState.generation = undefined
          hostState.ready = false
          hostState.remoteClientId = undefined
          // Retire interactions before backoff, even when the error is terminal.
          // Cancels intentionally outlive the retired generation's queued frames.
          for (const synthetic of hostState.byRawEventId.values()) {
            aggregateState.mappings.delete(synthetic)
            if (!signal.aborted) queue.push({ hostId, frame: { type: 'cancel', eventId: synthetic } })
          }
          hostState.byRawEventId.clear()
          hostState.pendingLateItems.clear()
        }
      }
      if (signal.aborted || !recover) break
      await wait(retry, signal)
      retry = retry === 0 ? 0 : Math.min(this.#maxRetryDelayMs, Math.max(this.#retryDelayMs, retry * 2))
    }
  }

  #validateOpenPayload(endpoint, payload) {
    if (endpoint === '$events' || endpoint === 'workspace/follow' || endpoint === 'session/control' || endpoint === 'session/follow') {
      if (!isRecord(payload) || !isRecord(payload.args)) throw new TypeError(`invalid ${endpoint} payload`)
    }
  }

  openStream(endpoint, payload, signal) {
    if (!ALLOWLIST.has(endpoint)) throw new HostRpcNotAllowedError(endpoint)
    if (!STREAM_ENDPOINTS.has(endpoint)) throw new BrowserHostHubError('browser-host-hub-rc1/not-a-stream', `Endpoint is not a stream: ${endpoint}`, { endpoint })
    this.#validateOpenPayload(endpoint, payload)
    const streamSignal = abortSignalOf(signal)
    if (endpoint === 'userQuestions/attachWait' || endpoint === 'workspaceFiles/changes') {
      const hostId = this.#selectHost(endpoint, payload)
      const lifetime = new AbortController()
      const ownedSignal = AbortSignal.any([streamSignal, lifetime.signal])
      const hub = this
      const iterator = (async function* () {
        try {
          ownedSignal.throwIfAborted()
          const source = await hub.#entry(hostId).carrier.open(endpoint, mapPayloadForHost(endpoint, payload, hostId, hub.#codec), ownedSignal, { diagnosticOwner: 'consumer' })
          for await (const frame of source) {
            if (ownedSignal.aborted) return
            yield hub.#encodeBrowser(frame)
          }
        } finally { lifetime.abort() }
      })()
      // Release the finite wait before AsyncIteratorClose waits for a pending read.
      return {
        next: (...args) => iterator.next(...args),
        return(value) { lifetime.abort(); return iterator.return(value) },
        throw(error) { lifetime.abort(error); return iterator.throw(error) },
        [Symbol.asyncIterator]() { return this },
      }
    }
    if (endpoint === 'workspace/follow') return this.#aggregateBaselineStream(endpoint, payload, streamSignal, (frame, hostId) => mapWorkspaceFrame(frame, hostId, this.#codec), () => ({ items: [], archivedSessionIds: [], pins: [], workspaceState: true }), mergeWorkspaceBaselines)
    if (endpoint === 'session/control') return this.#aggregateBaselineStream(endpoint, payload, streamSignal, (frame, hostId) => mapControlFrame(frame, hostId, this.#codec), () => ({ queues: {}, jobs: {}, projections: {} }), mergeControlBaselines)
    if (endpoint === 'job/list' || endpoint === 'job/follow') {
      const hostId = this.#selectHost(endpoint, payload)
      return this.#singleHostStream(endpoint, payload, streamSignal, hostId, (frame, id) => scopeJobFrame(frame, id, this.#codec))
    }
    if (endpoint === 'session/follow') {
      let hostId
      try { hostId = this.#selectHost(endpoint, payload) } catch (error) { throw error }
      return this.#singleHostStream(endpoint, payload, streamSignal, hostId, (frame, id) => mapSessionFollowFrame(frame, id, this.#codec))
    }
    return this.#eventsStream(payload, streamSignal)
  }

  open(endpoint, payload, signal) { return this.openStream(endpoint, payload, signal) }

  async fetch(input, init = {}) {
    let endpoint
    try {
      const rawUrl = typeof input === 'string' ? input : typeof input?.href === 'string' ? input.href : input?.url
      const url = new URL(rawUrl, this.#baseUrl)
      if (url.origin !== this.#baseOrigin) return errorResponse(403, new BrowserHostHubError('browser-host-hub-rc1/origin-not-allowed', 'Transport URL origin is not configured', { origin: url.origin }))
      if (!url.pathname.startsWith('/api/') || url.pathname.endsWith('/')) return errorResponse(404, new HostRpcNotAllowedError(url.pathname))
      endpoint = decodeURIComponent(url.pathname.slice('/api/'.length))
      if (!ALLOWLIST.has(endpoint) || url.pathname !== `/api/${endpoint}`) return errorResponse(404, new HostRpcNotAllowedError(endpoint))
      const requestMethod = String(init.method ?? input?.method ?? 'GET').toUpperCase()
      if (requestMethod !== 'POST') return errorResponse(405, new BrowserHostHubError('browser-host-hub-rc1/method-not-allowed', 'RPC transport requires POST', { method: requestMethod }))
      const body = init.body ?? (typeof input === 'object' && typeof input.clone === 'function' ? await input.clone().text() : undefined)
      if (typeof body !== 'string') return errorResponse(400, new BrowserHostHubError('browser-host-hub-rc1/invalid-request', 'Transport request body must be JSON'))
      let message
      try { message = JSON.parse(body) } catch { return errorResponse(400, new BrowserHostHubError('browser-host-hub-rc1/invalid-request', 'Request body must be valid JSON')) }
      message = decodeBrowserRequest(message, endpoint)
      const result = await this.call(endpoint, message.payload, init.signal)
      return new Response(JSON.stringify(encodeBrowserResponse(message.rpcId, result)), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...coldDirectoryHeaders(result) } })
    } catch (error) {
      return errorResponse(error instanceof HostRpcNotAllowedError ? 404 : 400, error)
    }
  }
}

export function createBrowserHostHub(options) { return new BrowserHostHub(options) }

export function installTransportHook(hub, target = globalThis) {
  if (!(hub instanceof BrowserHostHub) && (!hub || typeof hub.fetch !== 'function' || typeof hub.openStream !== 'function')) throw new TypeError('hub must expose fetch/openStream')
  const previous = target.__DSH_TRANSPORT__
  const transport = {
    ...(isRecord(previous) ? previous : {}),
    fetch: hub.fetch.bind(hub),
    openStream: hub.openStream.bind(hub)
  }
  target.__DSH_TRANSPORT__ = transport
  return () => {
    if (target.__DSH_TRANSPORT__ === transport) target.__DSH_TRANSPORT__ = previous
  }
}

export function createTransportHook(hub) {
  if (!hub || typeof hub.fetch !== 'function' || typeof hub.openStream !== 'function') throw new TypeError('hub must expose fetch/openStream')
  return Object.freeze({ fetch: hub.fetch.bind(hub), openStream: hub.openStream.bind(hub) })
}

/** Cordis entry point; Root supplies the authenticated server-side perHost map. */
export function apply(ctx, options = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') throw new TypeError('webServer.register is required')
  const runtimeInterface = options.runtimeInterface ?? ctx.runtimeInterface
  if (!runtimeInterface || typeof runtimeInterface.wrapHostCarrier !== 'function' || typeof runtimeInterface.encodeBrowser !== 'function' || !runtimeInterface.connection || typeof runtimeInterface.connection.requestRejection !== 'function') throw new TypeError('runtimeInterface with connection/wrapHostCarrier/encodeBrowser is required')
  const perHost = options.perHost === undefined ? ctx.perHost : options.perHost
  const webRuntime = { webServer: ctx.webServer, authorizeRequest: request => runtimeInterface.connection.requestRejection(request) }
  const hub = new BrowserHostHub({ ...options, perHost, runtimeInterface })
  const register = () => {
    const disposers = []
    try {
      if (options.registerBff !== false) disposers.push(registerBff(webRuntime, hub, { ...options, perHost }))
      disposers.push(registerHostInventory(webRuntime, perHost))
      // 存量例外：file-proxy.js 的 raw file carrier 调用受其专属安全边界保护；会话、历史和控制流不走该路径。
      disposers.push(ctx.webServer.register({ kind: 'prefix', path: FILE_PROXY_PREFIX, handler: createFileProxyHandler(runtimeInterface.connection, perHost, decodeCompositeId) }))
      if (options.injectBootstrap !== false) disposers.push(registerBrowserBootstrap({ on: ctx.on?.bind(ctx) }, options))
      // This opt-in is only for a Node-side harness. In production the actual
      // browser gets the hook from the protected script-src route above; do
      // not mutate the server's global object by default.
      if (options.installNodeTransport === true) disposers.push(installTransportHook(hub, options.target ?? globalThis))
    } catch (error) {
      for (const dispose of disposers.reverse()) { try { dispose?.() } catch { /* preserve registration failure */ } }
      throw error
    }
    return () => disposers.reverse().forEach(dispose => { try { dispose?.() } catch { /* preserve teardown */ } })
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'browser-host-hub-rc1: authenticated browser BFF')
  } else register()
  return hub
}
