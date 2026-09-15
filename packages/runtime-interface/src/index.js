
/** Official-runtime boundary for every rc1 compatibility package. */
import { createAgentOperations } from './agent-operations.js'
import { mobileSubagentEvent } from './subagent-events.js'
import { createSessionPersistencePort } from './session-persistence.js'
import { MobileAssistantStream } from './mobile-assistant-stream.js'
import { bindManagementConnection } from './management-binding.js'
import { createLocalRuntimeRestart } from './local-runtime-restart.js'
import { normalizeManagedRuntimeDescriptor, readManagedRuntimeDescriptor } from './managed-runtime-launcher.mjs'

export { createLocalRuntimeRestart } from './local-runtime-restart.js'
export {
  BUNDLED_MANAGED_RUNTIME_LAUNCHER,
  descriptorFingerprint,
  forkManagedRuntimeBroker,
  launchManagedRuntime,
  ManagedRuntimeError,
  normalizeManagedRuntimeDescriptor,
  parsePortOwnerPid,
  readProcessBirthStamp,
  readManagedRuntimeDescriptor,
  runManagedRuntimeBroker,
  waitForProcessExit,
  verifyCurrentRuntimeIdentity,
} from './managed-runtime-launcher.mjs'
import {
  createBrowserStreamEncoder,
  createSessionFollowStreamEncoder,
  prepareSessionFollowPayload,
  prepareSessionFollowRequest,
  sessionFollowAssistantStreamRequested,
} from './browser-stream.js'

export {
  BrowserStreamError,
  createBrowserStreamEncoder,
  createSessionFollowStreamEncoder,
  prepareSessionFollowPayload,
  prepareSessionFollowRequest,
  sessionFollowAssistantStreamRequested,
} from './browser-stream.js'
export const name = 'runtime-interface'
// Current connection.rpc.handle binds routes through its calling owner's webServer capability.
export const inject = ['webServer', 'sessionController', 'workspaceController', 'connection', 'subagents', 'commands', 'goals', 'agentPresets', 'sessionPersistence']

export const RUNTIME_INTERFACE_VERSION = 1
export const LEGACY_RUNTIME_VERSION = '0.1.2-rc.1'
export const CURRENT_RUNTIME_VERSION = '0.1.5-rc.2'
export const HISTORY_EPOCH_CAPABILITY = 'history-epoch-v1'
export const HISTORY_EPOCH_HEADER = 'x-dsh-history-epoch'
export const LEGACY_HISTORY_EPOCH = 'legacy'

const SUPPORTED_RUNTIME_VERSIONS = new Set([LEGACY_RUNTIME_VERSION, CURRENT_RUNTIME_VERSION])
const SESSION_METHODS = Object.freeze(['attachment', 'cancel', 'canOpenWorkspacePath', 'control', 'create', 'follow', 'fork', 'list', 'modelCatalog', 'page', 'prompt', 'rename', 'search', 'selectModel', 'updateQueue'])
const WORKSPACE_METHODS = Object.freeze(['archiveSession', 'create', 'delete', 'follow', 'insertBefore', 'insertSessionBefore', 'rename'])
const CONNECTION_METHODS = Object.freeze(['authenticatedUrl', 'requestRejection'])
const SUBAGENT_METHODS = Object.freeze(['remoteExportList', 'prompt', 'interruptByParent'])
const HISTORY_ENDPOINTS = new Set(['session/page', 'session/follow'])
const LEGACY_EVENT_RENAMES = Object.freeze({ 'tool/code-dispatch-start': 'tool/ptc-dispatch-start', 'tool/code-dispatch': 'tool/ptc-dispatch' })
const CURRENT_TO_LEGACY_EVENT_RENAMES = Object.freeze(Object.fromEntries(Object.entries(LEGACY_EVENT_RENAMES).map(([legacy, current]) => [current, legacy])))
const DEFAULT_RUNTIME_CONFIG = Object.freeze({ upstreamVersion: LEGACY_RUNTIME_VERSION })
const LOCAL_BOOTSTRAP_HOST = '127.0.0.1'

export class RuntimeInterfaceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'RuntimeInterfaceError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class HistoryEpochError extends RuntimeInterfaceError {
  constructor(code, historyEpoch) {
    super(code, code === 'history-epoch-required' ? 'A history epoch is required for this continuation' : 'The history baseline has changed', { baselineRequired: true, ...(historyEpoch === undefined ? {} : { historyEpoch }) })
    this.name = 'HistoryEpochError'
    this.historyEpoch = historyEpoch
  }
}

export class HistoryMigrationError extends RuntimeInterfaceError {
  constructor(message, details = {}) {
    super('history-format-incompatible', message, { baselineRequired: true, ...details })
    this.name = 'HistoryMigrationError'
  }
}

/** Public HTTP ingress is decoded here before compatibility routes see it. */
export class MobileIngressError extends RuntimeInterfaceError {
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'MobileIngressError'
  }
}

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function assertBoundedString(value, label, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) throw new RuntimeInterfaceError('runtime-interface/invalid-identity', `${label} must be a bounded non-empty string`)
  return value
}
function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new RuntimeInterfaceError('runtime-interface/invalid-sequence', `${label} must be a non-negative safe integer`)
  return value
}
function sequence(value, label) {
  if (!Number.isSafeInteger(value) || value < -1 || Object.is(value, -0)) throw new RuntimeInterfaceError('runtime-interface/invalid-sequence', `${label} must be a safe integer no smaller than -1`)
  return value
}
function createPort(service, methods, label, invoke, prepare) {
  if (!isRecord(service)) throw new TypeError(`${label} is required`)
  const port = Object.create(null)
  for (const method of methods) Object.defineProperty(port, method, { enumerable: true, value: (...args) => {
    const implementation = service[method]
    if (typeof implementation !== 'function') throw new RuntimeInterfaceError('runtime-interface/capability-unavailable', `${method} is unavailable on the official runtime`, { method })
    const callArgs = prepare === undefined ? args : prepare(method, args)
    const value = implementation.apply(service, callArgs)
    return invoke === undefined ? value : invoke(method, value, callArgs)
  } })
  return Object.freeze(port)
}

function createLocalBootstrapEndpoint({ webServer, connection } = {}) {
  return (...args) => {
    if (args.length !== 0) throw new RuntimeInterfaceError('runtime-interface/bootstrap-params-invalid', 'local bootstrap endpoint does not accept parameters')
    if (!isRecord(webServer) || webServer.host !== LOCAL_BOOTSTRAP_HOST) {
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-loopback-required', 'local bootstrap requires a 127.0.0.1 web server')
    }
    const port = webServer.port
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-port-invalid', 'local bootstrap requires a valid listening port')
    }
    if (typeof connection?.authenticatedUrl !== 'function') {
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-authentication-unavailable', 'authenticated URL capability is unavailable')
    }
    const baseUrl = `http://${LOCAL_BOOTSTRAP_HOST}:${port}/`
    let authenticatedRootUrl
    try {
      authenticatedRootUrl = connection.authenticatedUrl(baseUrl)
    } catch (error) {
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-authentication-failed', 'authenticated URL creation failed', { cause: String(error?.message ?? error) })
    }
    if (typeof authenticatedRootUrl !== 'string' || authenticatedRootUrl.length === 0 || authenticatedRootUrl.length > 4096 || authenticatedRootUrl.includes('\u0000')) {
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-url-invalid', 'authenticated URL is invalid')
    }
    try {
      const url = new URL(authenticatedRootUrl)
      const effectivePort = url.port === '' ? (url.protocol === 'http:' ? 80 : -1) : Number(url.port)
      if (url.protocol !== 'http:' || url.hostname !== LOCAL_BOOTSTRAP_HOST || effectivePort !== port || url.pathname !== '/' || url.username || url.password || url.hash) {
        throw new Error('origin')
      }
    } catch (error) {
      if (error instanceof RuntimeInterfaceError) throw error
      throw new RuntimeInterfaceError('runtime-interface/bootstrap-url-invalid', 'authenticated URL must remain on the local bootstrap origin')
    }
    return Object.freeze({ port, authenticatedRootUrl })
  }
}

function mapReturnedValue(value, mapper) {
  return value?.then instanceof Function ? Promise.resolve(value).then(mapper) : mapper(value)
}

async function * mapReturnedStream(value, mapper) {
  const source = await value
  if (source?.[Symbol.asyncIterator] instanceof Function) {
    const iterator = source[Symbol.asyncIterator]()
    try {
      while (true) {
        const step = await iterator.next()
        if (!isRecord(step)) throw new RuntimeInterfaceError('runtime-interface/invalid-stream', 'Official stream yielded an invalid iterator result')
        if (step.done) return
        yield mapper(step.value)
      }
    } finally {
      // A rejected opening frame must release the original subscription just
      // like an ordinary consumer cancellation. Some official iterators use
      // a void return result, so cleanup intentionally ignores that value.
      try { await iterator.return?.() } catch { /* preserve the stream error */ }
    }
    return
  }
  if (source?.[Symbol.iterator] instanceof Function) {
    const iterator = source[Symbol.iterator]()
    try {
      while (true) {
        const step = iterator.next()
        if (!isRecord(step)) throw new RuntimeInterfaceError('runtime-interface/invalid-stream', 'Official stream yielded an invalid iterator result')
        if (step.done) return
        yield mapper(step.value)
      }
    } finally {
      try { iterator.return?.() } catch { /* preserve the stream error */ }
    }
    return
  }
  yield mapper(source)
}

/** Validate only the two official contracts covered by this adapter. */
export function normalizeRuntimeVersion(value = LEGACY_RUNTIME_VERSION) {
  if (typeof value !== 'string' || !SUPPORTED_RUNTIME_VERSIONS.has(value)) throw new RuntimeInterfaceError('runtime-interface/unsupported-version', 'The upstream runtime version is not supported', { version: value })
  return value
}
export function runtimeCapabilities(version = LEGACY_RUNTIME_VERSION, extra = []) {
  normalizeRuntimeVersion(version)
  return Object.freeze([...new Set(Array.isArray(extra) ? extra.filter(item => typeof item === 'string' && item.length > 0) : [])].sort())
}

/** Stable across restart for the same persisted dataset/format/generation tuple. */
export function createHistoryEpoch({ datasetId, sequenceFormatGeneration, generation } = {}) {
  assertBoundedString(datasetId, 'datasetId', 256)
  nonNegativeInteger(sequenceFormatGeneration, 'sequenceFormatGeneration')
  nonNegativeInteger(generation, 'generation')
  return `dsh-history-v1:${encodeURIComponent(datasetId)}:${sequenceFormatGeneration}:${generation}`
}
function normalizeHistoryEpoch(value) {
  if (typeof value === 'string') return assertBoundedString(value, 'historyEpoch', 512)
  if (isRecord(value)) return createHistoryEpoch(value)
  throw new RuntimeInterfaceError('history-epoch-invalid', 'historyEpoch must be a non-empty opaque string or persisted generation tuple')
}

/** Canonical per-Host identity; no controller/context object can enter it. */
export function normalizeHostIdentity(value, fallbackHostId) {
  const source = isRecord(value) ? value : {}
  const hostId = source.hostId ?? fallbackHostId
  assertBoundedString(hostId, 'hostId', 256)
  const normalized = { hostId }
  for (const key of ['sessionId', 'workspaceId', 'clientId', 'eventId']) if (source[key] !== undefined) normalized[key] = assertBoundedString(source[key], key)
  return Object.freeze(normalized)
}

function normalizeReplace(surfaceOp) {
  if (!isRecord(surfaceOp) || surfaceOp.op !== 'replace') return surfaceOp
  return Object.freeze({ op: 'replace', startSeq: nonNegativeInteger(surfaceOp.startSeq ?? surfaceOp.start, 'replace start'), endSeq: nonNegativeInteger(surfaceOp.endSeq ?? surfaceOp.end, 'replace end') })
}

/** Turn a current or legacy upstream event into the stable canonical vocabulary. */
export function upstreamToCanonicalEvent(event, { hostId } = {}) {
  if (!isRecord(event)) return event
  const normalized = { ...event }
  const sourceSeq = event.sourceSeq ?? event.seq
  if (sourceSeq !== undefined) normalized.sourceSeq = nonNegativeInteger(sourceSeq, 'sourceSeq')
  if (event.seq !== undefined) normalized.seq = nonNegativeInteger(event.seq, 'seq')
  if (event.surfaceOp !== undefined) normalized.surfaceOp = normalizeReplace(event.surfaceOp)
  if (hostId !== undefined) normalized.hostId = assertBoundedString(hostId, 'hostId', 256)
  return Object.freeze(normalized)
}

/** Android history output conversion; legacy representation stays inside the boundary. */
export function canonicalToMobileHistoryEvent(event) {
  if (event?.type === 'subagent/catalog') return mobileSubagentEvent(event)
  if (event?.type === 'legacy/request-header' && event?.data?.legacyType === 'request/header' && isRecord(event.data.data?.header)) {
    const { system: _system, tools: _tools, ...header } = event.data.data.header
    return Object.freeze({ type: 'request/header', seq: event.seq,
      ...(event.time === undefined ? {} : { time: event.time }),
      data: Object.freeze({ ...event.data.data, header: Object.freeze(header) }),
      ...(event.sourceSeq === undefined ? {} : { sourceSeq: event.sourceSeq }) })
  }
  if (event?.type !== 'legacy/assistant-chunk' || event?.data?.legacyType !== 'assistant/chunk') return event
  if (!isRecord(event.data.data)) throw new HistoryMigrationError('Legacy chunk has no valid content')
  return Object.freeze({ type: 'assistant/chunk', seq: event.seq,
    ...(event.time === undefined ? {} : { time: event.time }), data: event.data.data,
    ...(event.sourceSeq === undefined ? {} : { sourceSeq: event.sourceSeq }) })
}

function canonicalHeader(header) {
  if (!isRecord(header)) return header
  const result = { ...header }
  const hasLegacySeedLength = own(result, 'seedLength')
  const inheritedEventCount = hasLegacySeedLength ? nonNegativeInteger(result.seedLength, 'seedLength') : undefined
  const isSeeded = hasLegacySeedLength ? true : result.isSeeded === true
  result.seed = Object.freeze({ isSeeded, ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }) })
  delete result.seedLength
  delete result.isSeeded
  return Object.freeze(result)
}
function legacyOpaqueEvent(event, type) {
  return { type, seq: event.seq, time: event.time, data: { legacyType: event.type, data: event.data, ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }), ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }) }, ignorable: true }
}
function staleLegacyEvent(event) {
  if (event.type === 'request/header' && isRecord(event.data?.header) && own(event.data.header, 'system')) return 'legacy/request-header'
  if (event.type === 'subagent/descriptor' && event.data?.version !== 3) return 'legacy/subagent-descriptor'
  if (event.type.startsWith('team/') && event.data?.version !== 2) return 'legacy/team-event'
  return undefined
}

class LegacyStreamIndex {
  #members = new Map()
  remember(event) {
    if (isRecord(event.data) && isRecord(event.data.chunk)) this.#members.set(event.seq, Object.freeze({ type: 'chunk', time: event.time, chunk: event.data.chunk }))
  }
  take(sourceEventSeqs) {
    if (!Array.isArray(sourceEventSeqs)) return []
    const stream = []
    for (const value of sourceEventSeqs) {
      if (!Number.isSafeInteger(value) || value < 0 || !this.#members.has(value)) return []
      stream.push(this.#members.get(value))
    }
    for (const value of sourceEventSeqs) this.#members.delete(value)
    return stream
  }
}
function canonicalLegacyEvent(event, context) {
  if (!isRecord(event)) throw new HistoryMigrationError('Legacy history event must be an object')
  nonNegativeInteger(event.seq, 'legacy event seq')
  if (event.time !== undefined && !Number.isSafeInteger(event.time)) throw new HistoryMigrationError('Legacy history event time must be an integer', { sourceSeq: event.seq })
  if (event.type === 'assistant/chunk') {
    context.streams.remember(event)
    return upstreamToCanonicalEvent(legacyOpaqueEvent(event, 'legacy/assistant-chunk'), context)
  }
  if (event.type === 'assistant/message') {
    const { sourceEventSeqs: _sourceEventSeqs, ...rest } = event
    const needsEmbeddedStream = Array.isArray(event.sourceEventSeqs) && !Array.isArray(event.data?.stream)
    const data = needsEmbeddedStream && isRecord(event.data) ? { ...event.data, stream: context.streams.take(event.sourceEventSeqs) } : event.data
    return upstreamToCanonicalEvent({ ...rest, data,
      ...(Array.isArray(event.sourceEventSeqs) ? { streamSourceSeqs: [...event.sourceEventSeqs] } : {}),
      ...(needsEmbeddedStream ? { streamDerived: true } : {}),
    }, context)
  }
  const obsolete = staleLegacyEvent(event)
  if (obsolete !== undefined) return upstreamToCanonicalEvent(legacyOpaqueEvent(event, obsolete), context)
  const renamed = LEGACY_EVENT_RENAMES[event.type]
  return upstreamToCanonicalEvent(renamed === undefined ? event : { ...event, type: renamed }, context)
}
function expandLegacyChunkRun(record) {
  const event = record.event
  if (!isRecord(event) || typeof event.type !== 'string' || !event.type.startsWith('chunkrow/')) throw new HistoryMigrationError('Legacy chunk row is malformed')
  const rowType = event.type.slice('chunkrow/'.length)
  const data = event.data
  if (!isRecord(data) || !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time) || !Number.isSafeInteger(data.turn) || data.turn < 0 || !Number.isSafeInteger(data.step) || data.step < 0 || !Number.isSafeInteger(data.index) || data.index < 0 || !Array.isArray(data.dt)) throw new HistoryMigrationError('Legacy chunk row has invalid coordinates', { sourceSeq: event.seq })
  const values = rowType === 'tool-call-chunks' ? data.args : data.texts
  if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string') || data.dt.length !== values.length - 1) throw new HistoryMigrationError('Legacy chunk row has invalid member values', { sourceSeq: event.seq })
  let time = event.time
  return values.map((value, offset) => {
    if (offset > 0) {
      const delta = data.dt[offset - 1]
      if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(time + delta)) throw new HistoryMigrationError('Legacy chunk row has an invalid time gap', { sourceSeq: event.seq + offset })
      time += delta
    }
    const chunk = rowType === 'text-chunks'
      ? { type: 'text-delta', index: data.index, text: value }
      : rowType === 'reasoning-chunks'
        ? { type: 'reasoning-delta', index: data.index, text: value }
        : rowType === 'tool-call-chunks' && typeof data.id === 'string'
          ? { type: 'tool-call-delta', index: data.index, id: data.id, ...(data.name === undefined ? {} : { name: data.name }), argumentsDelta: value }
          : undefined
    if (chunk === undefined) throw new HistoryMigrationError('Legacy chunk row has an unsupported row type', { sourceSeq: event.seq + offset })
    return { type: 'assistant/chunk', seq: event.seq + offset, time, data: { turn: data.turn, step: data.step, chunk } }
  })
}
function canonicalHistoryRecords(records, context) {
  const output = []
  for (const record of records) {
    if (context.version === LEGACY_RUNTIME_VERSION && isRecord(record) && record.type === 'chunks') {
      for (const event of expandLegacyChunkRun(record)) output.push(Object.freeze({ type: 'event', event: canonicalLegacyEvent(event, context) }))
    } else output.push(canonicalWireValue(record, context))
  }
  return Object.freeze(output)
}
function canonicalWireValue(value, context) {
  if (Array.isArray(value)) return Object.freeze(value.map(item => canonicalWireValue(item, context)))
  if (!isRecord(value)) return value
  if (value.ok === true && own(value, 'value')) return Object.freeze({ ...value, value: canonicalWireValue(value.value, context) })
  if (Array.isArray(value.records)) {
    const result = { ...value, records: canonicalHistoryRecords(value.records, context) }
    if (isRecord(value.header)) result.header = canonicalHeader(value.header)
    return Object.freeze(result)
  }
  if (isRecord(value.event)) return Object.freeze({ ...value, event: context.version === LEGACY_RUNTIME_VERSION && context.sessionHistory ? canonicalLegacyEvent(value.event, context) : upstreamToCanonicalEvent(value.event, context) })
  if (value.seq !== undefined && value.type !== 'chunks') {
    const isHistoryEvent = typeof value.type === 'string' && own(value, 'data')
    return context.version === LEGACY_RUNTIME_VERSION && context.sessionHistory && isHistoryEvent ? canonicalLegacyEvent(value, context) : upstreamToCanonicalEvent(value, context)
  }
  if (isRecord(value.header)) return Object.freeze({ ...value, header: canonicalHeader(value.header) })
  return Object.freeze({ ...value })
}

/** Converts old packed history rows to current-valid wire entries while retaining sourceSeq canonically. */
export function upstreamToCanonicalWire(value, { hostId, upstreamVersion = LEGACY_RUNTIME_VERSION, endpoint, adapter } = {}) {
  const version = normalizeRuntimeVersion(upstreamVersion)
  const context = adapter ?? { hostId: hostId === undefined ? undefined : assertBoundedString(hostId, 'hostId', 256), version, sessionHistory: endpoint === undefined || HISTORY_ENDPOINTS.has(endpoint), streams: new LegacyStreamIndex() }
  return canonicalWireValue(value, context)
}
function browserHeader(header, target) {
  if (!isRecord(header)) return header
  const result = { ...header }
  const seed = isRecord(result.seed) ? result.seed : undefined
  delete result.seed
  delete result.seedLength
  delete result.isSeeded
  if (target === CURRENT_RUNTIME_VERSION) result.isSeeded = seed?.isSeeded === true
  else if (seed?.isSeeded === true && Number.isSafeInteger(seed.inheritedEventCount)) result.seedLength = seed.inheritedEventCount
  return Object.freeze(result)
}
function browserEvent(event, target) {
  const opaque = target === LEGACY_RUNTIME_VERSION && isRecord(event.data) && typeof event.data.legacyType === 'string' && event.type.startsWith('legacy/')
    ? { type: event.data.legacyType, seq: event.seq, ...(event.time === undefined ? {} : { time: event.time }), data: event.data.data, ...(event.data.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.data.sourceEventSeqs }), ...(event.data.surfaceOp === undefined ? {} : { surfaceOp: event.data.surfaceOp }) }
    : event
  const { sourceSeq: _sourceSeq, hostId: _hostId, streamSourceSeqs, streamDerived, ...result } = opaque
  if (target === LEGACY_RUNTIME_VERSION && Array.isArray(streamSourceSeqs)) {
    result.sourceEventSeqs = [...streamSourceSeqs]
    if (streamDerived && isRecord(result.data)) {
      const { stream: _stream, ...data } = result.data
      result.data = data
    }
  }
  if (target === LEGACY_RUNTIME_VERSION && CURRENT_TO_LEGACY_EVENT_RENAMES[result.type] !== undefined) result.type = CURRENT_TO_LEGACY_EVENT_RENAMES[result.type]
  if (result.type === 'assistant/message' && own(result, 'sourceEventSeqs') && target === CURRENT_RUNTIME_VERSION) delete result.sourceEventSeqs
  if (result.surfaceOp?.op === 'replace') {
    const { startSeq, endSeq } = normalizeReplace(result.surfaceOp)
    result.surfaceOp = target === LEGACY_RUNTIME_VERSION ? { op: 'replace', start: startSeq, end: endSeq } : { op: 'replace', startSeq, endSeq }
  }
  return Object.freeze(result)
}
/** Maps canonical DTOs to an exact Browser target wire; canonical-only fields never leak. */
export function canonicalToBrowserWire(value, targetVersion = CURRENT_RUNTIME_VERSION) {
  const target = normalizeRuntimeVersion(targetVersion)
  if (Array.isArray(value)) return Object.freeze(value.map(item => canonicalToBrowserWire(item, target)))
  if (!isRecord(value)) return value
  if (value.type === 'assistant-stream') {
    return target === LEGACY_RUNTIME_VERSION ? undefined : Object.freeze({ ...value })
  }
  if (value.ok === true && own(value, 'value')) return Object.freeze({ ...value, value: canonicalToBrowserWire(value.value, target) })
  if (Array.isArray(value.records)) {
    const result = { ...value, records: Object.freeze(value.records.map(record => canonicalToBrowserWire(record, target))) }
    if (isRecord(value.header)) result.header = browserHeader(value.header, target)
    if (target === LEGACY_RUNTIME_VERSION) delete result.assistantStream
    return Object.freeze(result)
  }
  if (isRecord(value.event)) return Object.freeze({ ...value, event: browserEvent(value.event, target) })
  if (value.seq !== undefined && typeof value.type === 'string') return browserEvent(value, target)
  if (isRecord(value.header)) return Object.freeze({ ...value, header: browserHeader(value.header, target) })
  return Object.freeze({ ...value })
}
export function canonicalToUpstreamWire(value, upstreamVersion = LEGACY_RUNTIME_VERSION) { return canonicalToBrowserWire(value, upstreamVersion) }

function readHeader(headers, name) {
  if (headers?.get instanceof Function) return headers.get(name) ?? headers.get(name.toLowerCase())
  if (!isRecord(headers)) return undefined
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  const value = key === undefined ? undefined : headers[key]
  return Array.isArray(value) ? value[0] : value
}
/** First describe/baseline has no expected epoch. Cursor-bound continuations do. */
export function readExpectedHistoryEpoch({ headers, payload, operation, requireExpected = true } = {}) {
  const headerValue = readHeader(headers, HISTORY_EPOCH_HEADER)
  const bodyValue = payload?.historyEpoch
  if (headerValue !== undefined && bodyValue !== undefined && headerValue !== bodyValue) throw new RuntimeInterfaceError('history-epoch-invalid', 'History epoch values disagree')
  const expected = headerValue ?? bodyValue
  if (expected !== undefined) assertBoundedString(expected, 'historyEpoch', 512)
  const continuation = operation === 'delta' || operation === 'history' || operation === 'detail' || operation === 'stream-resume'
  const hasCursor = payload?.afterSeq !== undefined || payload?.beforeSeq !== undefined || payload?.throughSeq !== undefined || payload?.sinceSeq !== undefined || payload?.cursor !== undefined || payload?.detailRef !== undefined || (operation === 'detail' && payload?.seq !== undefined)
  if (requireExpected && continuation && hasCursor && expected === undefined) throw new HistoryEpochError('history-epoch-required')
  return expected
}

function normalizeIngressRoute(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\u0000')) {
    throw new MobileIngressError('runtime-interface/invalid-route', 'Mobile route is invalid')
  }
  return value
}

function parseJsonIngressBody(body, route, allowEmptyObject) {
  if (typeof body !== 'string') throw new MobileIngressError('runtime-interface/invalid-request', `Mobile request body for ${route} must be JSON text`)
  if (allowEmptyObject && body.trim() === '') return {}
  let message
  try { message = JSON.parse(body) } catch { throw new MobileIngressError('runtime-interface/invalid-request', `Mobile request body for ${route} is not valid JSON`) }
  if (!isRecord(message)) throw new MobileIngressError('runtime-interface/invalid-request', `Mobile request body for ${route} must be an object`)
  return message
}

/**
 * Decode a mobile HTTP body into a stable envelope. Limit and policy checks
 * stay with the route, while JSON/envelope/epoch binding never bypasses this
 * boundary.
 */
export function decodeMobileIngress({ route, body, headers, type, method, payloadKey = 'payload', requirePayloadObject = false, allowDirectPayload = false, allowEmptyObject = false, historyOperation, requireHistoryEpoch = true, assertEpoch } = {}) {
  const normalizedRoute = normalizeIngressRoute(route)
  const message = parseJsonIngressBody(body, normalizedRoute, allowEmptyObject)
  if (type !== undefined && message.type !== type) throw new MobileIngressError('runtime-interface/invalid-request', `Invalid ${normalizedRoute} request type`)
  if (method !== undefined && message.method !== method) throw new MobileIngressError('runtime-interface/invalid-method', `Invalid ${normalizedRoute} request method`)
  if (typeof payloadKey !== 'string' || payloadKey.length === 0) throw new MobileIngressError('runtime-interface/invalid-request', 'Mobile payload key is invalid')
  let payload
  if (allowDirectPayload) {
    if (message.type === 'client-request') {
      payload = message[payloadKey]
      if (!isRecord(payload)) throw new MobileIngressError('runtime-interface/invalid-params', `Mobile payload for ${normalizedRoute} must be an object`)
    } else {
      payload = { ...message }
      delete payload.rpcId
    }
  } else {
    payload = message[payloadKey]
  }
  if (requirePayloadObject && !isRecord(payload)) throw new MobileIngressError('runtime-interface/invalid-params', `Mobile payload for ${normalizedRoute} must be an object`)
  if (isRecord(payload)) payload = Object.freeze({ ...payload })
  const rpcId = typeof message.rpcId === 'string' && message.rpcId.length > 0 && message.rpcId.length <= 256 ? message.rpcId : 'invalid'
  let history
  if (historyOperation !== undefined) {
    if (typeof assertEpoch !== 'function') throw new TypeError('assertEpoch is required when binding a history epoch')
    const expectedHistoryEpoch = readExpectedHistoryEpoch({ headers, payload, operation: historyOperation, requireExpected: requireHistoryEpoch })
    history = assertEpoch(expectedHistoryEpoch)
  }
  return Object.freeze({
    route: normalizedRoute,
    rpcId,
    message: Object.freeze({ ...message }),
    payload,
    ...(history === undefined ? {} : { history }),
  })
}
export function assertHistoryEpoch(expectedHistoryEpoch, currentHistoryEpoch, { required = false } = {}) {
  if (currentHistoryEpoch === LEGACY_HISTORY_EPOCH) return Object.freeze({ historyEpoch: LEGACY_HISTORY_EPOCH, historyEpochMode: 'legacy' })
  const current = normalizeHistoryEpoch(currentHistoryEpoch)
  if (required && expectedHistoryEpoch === undefined) throw new HistoryEpochError('history-epoch-required', current)
  if (expectedHistoryEpoch !== undefined && expectedHistoryEpoch !== current) throw new HistoryEpochError('history-epoch-mismatch', current)
  return Object.freeze({ historyEpoch: current, historyEpochMode: 'epoch' })
}
export function historyEpochMetadata({ version = LEGACY_RUNTIME_VERSION, historyEpoch } = {}) {
  const normalizedVersion = normalizeRuntimeVersion(version)
  if (normalizedVersion === LEGACY_RUNTIME_VERSION) return Object.freeze({ historyEpoch: LEGACY_HISTORY_EPOCH, historyEpochMode: 'legacy', capabilities: runtimeCapabilities(normalizedVersion) })
  if (historyEpoch === undefined) throw new RuntimeInterfaceError('history-epoch-unavailable', 'The runtime declares history epochs but did not provide one', { baselineRequired: true })
  const metadata = assertHistoryEpoch(undefined, historyEpoch)
  return Object.freeze({ ...metadata, capabilities: runtimeCapabilities(normalizedVersion, [HISTORY_EPOCH_CAPABILITY]) })
}

/** Returned carrier has no raw bypass and maps every Host upstream into canonical DTOs. */
export function wrapHostCarrier({ hostId, carrier, upstreamVersion = LEGACY_RUNTIME_VERSION, identity } = {}) {
  assertBoundedString(hostId, 'hostId', 256)
  if (!isRecord(carrier) || typeof carrier.call !== 'function' || typeof carrier.open !== 'function') throw new TypeError('carrier must expose call/open')
  const version = normalizeRuntimeVersion(upstreamVersion)
  if (identity !== undefined && !isRecord(identity)) throw new TypeError('identity must be an object')
  const toCanonicalRequest = identity?.toCanonicalRequest ?? ((_endpoint, payload) => payload)
  const toUpstreamRequest = identity?.toUpstreamRequest ?? ((_endpoint, payload) => canonicalToUpstreamWire(payload, version))
  const toCanonicalResult = identity?.toCanonicalResult ?? ((_endpoint, value) => value)
  if (typeof toCanonicalRequest !== 'function' || typeof toUpstreamRequest !== 'function' || typeof toCanonicalResult !== 'function') throw new TypeError('identity mapping hooks must be functions')
  const canonicalRequest = (endpoint, payload) => {
    const mapped = toCanonicalRequest(endpoint, payload, hostId)
    return endpoint === 'session/follow' ? prepareSessionFollowPayload(mapped, version) : mapped
  }
  const mapRequest = (endpoint, payload) => toUpstreamRequest(endpoint, canonicalRequest(endpoint, payload), hostId)
  const makeState = () => ({ hostId, version, sessionHistory: false, streams: new LegacyStreamIndex() })
  const mapResult = (endpoint, value, state) => toCanonicalResult(endpoint, upstreamToCanonicalWire(value, { hostId, upstreamVersion: version, endpoint, adapter: state }), hostId)
  return Object.freeze({
    hostId,
    upstreamVersion: version,
    runtimeInterfaceCarrier: true,
    async call(endpoint, canonicalRequest, signal) {
      const state = makeState(); state.sessionHistory = HISTORY_ENDPOINTS.has(endpoint)
      return mapResult(endpoint, await carrier.call(endpoint, mapRequest(endpoint, canonicalRequest), signal), state)
    },
    async *open(endpoint, canonicalRequest, signal) {
      const state = makeState(); state.sessionHistory = HISTORY_ENDPOINTS.has(endpoint)
      const input = toCanonicalRequest(endpoint, canonicalRequest, hostId)
      const assistantStream = endpoint === 'session/follow' && sessionFollowAssistantStreamRequested(input)
      const prepared = endpoint === 'session/follow' ? prepareSessionFollowPayload(input, version) : input
      const source = await carrier.open(endpoint, toUpstreamRequest(endpoint, prepared, hostId), signal)
      if (!assistantStream) {
        for await (const value of source) yield mapResult(endpoint, value, state)
        return
      }
      const encoder = createSessionFollowStreamEncoder({
        upstreamVersion: version,
        targetVersion: CURRENT_RUNTIME_VERSION,
        request: input,
        mapFrame: value => mapResult(endpoint, value, state),
      })
      try {
        for await (const value of source) {
          for (const frame of encoder.push(value)) yield frame
        }
      } finally {
        encoder.close()
      }
    },
  })
}

/** Management/UI ingress validates public method/params then calls owner-supplied dispatch. */
export function createManagementRpcIngress({ dispatch } = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function')
  return async function managementRpcIngress(request = {}) {
    if (!isRecord(request)) throw new RuntimeInterfaceError('runtime-interface/invalid-request', 'Management request must be an object')
    if (typeof request.method !== 'string' || !/^[a-zA-Z$][a-zA-Z0-9$/.-]*$/.test(request.method)) throw new RuntimeInterfaceError('runtime-interface/invalid-method', 'Management method is invalid')
    const params = request.params === undefined ? {} : request.params
    if (!isRecord(params)) throw new RuntimeInterfaceError('runtime-interface/invalid-params', 'Management params must be an object')
    return dispatch({ method: request.method, params, signal: request.signal, requestMeta: request.requestMeta })
  }
}

function canonicalAdapter(version, endpoint, hostId) {
  return { version, hostId, sessionHistory: HISTORY_ENDPOINTS.has(endpoint), streams: new LegacyStreamIndex() }
}

function followSessionId(request) {
  const address = request?.address
  if (!isRecord(address)) return undefined
  return address.kind === 'subagent' ? address.childSessionId : address.sessionId
}

async function * mapSessionFollowStream(value, mapper, onClose) {
  try {
    const source = await value
    const emit = function * (mapped) {
      if (mapped === undefined) return
      if (Array.isArray(mapped)) {
        for (const item of mapped) if (item !== undefined) yield item
        return
      }
      yield mapped
    }
    if (source?.[Symbol.asyncIterator] instanceof Function) {
      const iterator = source[Symbol.asyncIterator]()
      try {
        while (true) {
          const step = await iterator.next()
          if (!isRecord(step)) throw new RuntimeInterfaceError('runtime-interface/invalid-stream', 'Official stream yielded an invalid iterator result')
          if (step.done) return
          yield * emit(mapper(step.value))
        }
      } finally {
        try { await iterator.return?.() } catch { /* preserve the stream error */ }
      }
      return
    }
    if (source?.[Symbol.iterator] instanceof Function) {
      const iterator = source[Symbol.iterator]()
      try {
        while (true) {
          const step = iterator.next()
          if (!isRecord(step)) throw new RuntimeInterfaceError('runtime-interface/invalid-stream', 'Official stream yielded an invalid iterator result')
          if (step.done) return
          yield * emit(mapper(step.value))
        }
      } finally {
        try { iterator.return?.() } catch { /* preserve the stream error */ }
      }
      return
    }
    yield * emit(mapper(source))
  } finally {
    onClose?.()
  }
}

function canonicalSessionPort(service, version, hostId, mobileAssistant) {
  return createPort(service, SESSION_METHODS, 'sessionController', (method, value, args) => {
    const endpoint = `session/${method}`
    const adapter = canonicalAdapter(version, endpoint, hostId)
    if (method === 'follow') {
      const request = args[0]
      const sessionId = followSessionId(request)
      const assistantStream = version === CURRENT_RUNTIME_VERSION && sessionFollowAssistantStreamRequested(request)
      const streamEncoder = createSessionFollowStreamEncoder({
        upstreamVersion: version,
        targetVersion: CURRENT_RUNTIME_VERSION,
        request,
        enabled: assistantStream,
        mapFrame: frame => upstreamToCanonicalWire(frame, { hostId, upstreamVersion: version, endpoint, adapter }),
      })
      let durableCursor = -1
      const mapFrame = frame => {
        if (frame?.type === 'snapshot') {
          durableCursor = frame.cursor
          if (assistantStream) {
            if (typeof sessionId !== 'string' || sessionId.length === 0) throw new RuntimeInterfaceError('runtime-interface/invalid-identity', 'Session follow address has no session identity')
            const baseline = mobileAssistant?.baseline?.(sessionId, frame.assistantStream)
            if (baseline === undefined) throw new RuntimeInterfaceError('runtime-interface/capability-unavailable', 'Mobile assistant stream baseline mapper is unavailable')
            return Object.freeze({ ...frame, assistantStream: baseline })
          }
          return frame
        }
        if (frame?.type === 'assistant-stream' && assistantStream) {
          if (typeof sessionId !== 'string' || sessionId.length === 0) throw new RuntimeInterfaceError('runtime-interface/invalid-identity', 'Session follow address has no session identity')
          const mapped = mobileAssistant?.ingest?.(sessionId, frame.frame, durableCursor)
          return mapped === undefined ? undefined : Object.freeze({ ...frame, frame: mapped })
        }
        const event = frame?.event ?? (frame?.seq !== undefined && frame?.data !== undefined ? frame : undefined)
        if (event?.seq !== undefined) durableCursor = event.seq
        return frame
      }
      return mapSessionFollowStream(value, frame => {
        const mapped = streamEncoder.push(frame)
        return mapped.map(mapFrame)
      }, () => streamEncoder.close())
    }
    if (method === 'control') {
      return mapReturnedStream(value, frame => upstreamToCanonicalWire(frame, { hostId, upstreamVersion: version, endpoint, adapter }))
    }
    return mapReturnedValue(value, result => upstreamToCanonicalWire(result, { hostId, upstreamVersion: version, endpoint, adapter }))
  }, (method, args) => method === 'follow'
    ? [prepareSessionFollowRequest(args[0], version, { forceAssistantStream: version === CURRENT_RUNTIME_VERSION }), ...args.slice(1)]
    : args)
}

function canonicalWorkspacePort(service, version, hostId) {
  return createPort(service, WORKSPACE_METHODS, 'workspaceController', (method, value) => {
    const endpoint = `workspace/${method}`
    const adapter = canonicalAdapter(version, endpoint, hostId)
    if (method === 'follow') return mapReturnedStream(value, frame => upstreamToCanonicalWire(frame, { hostId, upstreamVersion: version, endpoint, adapter }))
    return mapReturnedValue(value, result => upstreamToCanonicalWire(result, { hostId, upstreamVersion: version, endpoint, adapter }))
  })
}

function managementRpcRegistrar(binding) {
  if (typeof binding?.register !== 'function') return () => {
    throw new RuntimeInterfaceError('runtime-interface/capability-unavailable', 'Management RPC registration is unavailable on the official runtime', { method: 'rpc.handle' })
  }
  return ({ channel, dispatch } = {}) => {
    if (typeof channel !== 'string' || channel.length === 0 || channel.length > 256 || channel.includes('\u0000')) {
      throw new RuntimeInterfaceError('runtime-interface/invalid-channel', 'Management RPC channel is invalid')
  }
  const ingress = createManagementRpcIngress({ dispatch })
    // 官方 client-connection 以 (endpoint, payload, signal) 调用处理器；
    // 在此处重组为稳定 ingress，业务侧不依赖官方 RPC 调用形状。
    return binding.register(channel, (method, params, signal) => ingress({ method, params, signal }))
  }
}

function canonicalEventSource(source, version, hostId, mobileAssistant, historyMetadata) {
  if (!source || typeof source.on !== 'function') {
    throw new RuntimeInterfaceError('runtime-interface/capability-unavailable', 'Global event binding is unavailable', { method: 'on' })
  }
  const identity = session => Object.freeze({ sessionId: assertBoundedString(
    typeof session === 'string' ? session : session?.id ?? session?.sessionId ?? session?.header?.id,
    'sessionId',
  ) })
  return Object.freeze({
    assistantSnapshots() {
      return version === CURRENT_RUNTIME_VERSION
        ? mobileAssistant.snapshots().map(item => Object.freeze({ ...item, ...historyMetadata() })) : []
    },
    discardAssistantSession(sessionId) { mobileAssistant.disposeSession(sessionId) },
    on(eventName, listener, options) {
      if (typeof eventName !== 'string' || eventName.length === 0 || eventName.length > 256 || eventName.includes('\u0000')) {
        throw new RuntimeInterfaceError('runtime-interface/invalid-event', 'Global event name is invalid')
      }
      if (typeof listener !== 'function') throw new TypeError('event listener must be a function')
      if (eventName === 'session/assistant-stream') {
        if (version !== CURRENT_RUNTIME_VERSION) return () => {}
        return source.on('agent/assistant-stream', ({ agent, frame } = {}) => {
          let ref
          try {
            ref = identity(agent?.session)
            const canonical = mobileAssistant.ingest(ref.sessionId, frame, agent.session.seq - 1)
            if (canonical !== undefined) listener(Object.freeze({ ...ref, ...historyMetadata(), frame: canonical }))
          } catch (error) {
            // A malformed/over-limit attempt is local. Never throw into the Agent or request host history.
            if (ref) listener(Object.freeze({ ...ref, ...historyMetadata(), error: Object.freeze({
              code: typeof error?.code === 'string' ? error.code : 'assistant-stream-invalid',
              baselineRequired: error?.baselineRequired === true,
            }) }))
          }
        }, options)
      }
      return source.on(eventName, (...args) => {
        if (eventName === 'session/event') {
          // The live Session instance (with controller/service access) never escapes.
          return listener(identity(args[0]), upstreamToCanonicalWire(args[1], {
            hostId, upstreamVersion: version, endpoint: 'session/follow',
          }))
        }
        if (eventName === 'session/created') {
          const session = args[0], ref = identity(session)
          const firstLiveSeq = session?.firstLiveSeq
          if (!Number.isSafeInteger(firstLiveSeq) || firstLiveSeq < 0 || typeof session?.snapshotEvents !== 'function') {
            return listener(Object.freeze({ ...ref, events: [] }))
          }
          // This is the already-created Session's synchronous live suffix, not a cold restore.
          const events = session.snapshotEvents(firstLiveSeq)
          if (!Array.isArray(events)) throw new RuntimeInterfaceError('runtime-interface/invalid-events', 'Created session suffix must be an array')
          const records = events.map(event => event?.type === 'event' || event?.type === 'chunks' ? event : { type: 'event', event })
          const canonical = upstreamToCanonicalWire({ records }, { hostId, upstreamVersion: version, endpoint: 'session/follow' })
          return listener(Object.freeze({ ...ref, firstLiveSeq, events: Object.freeze(canonical.records.map(record => record.event)) }))
        }
        return listener(...args.map(value => upstreamToCanonicalWire(value, {
          hostId, upstreamVersion: version, endpoint: 'global/event',
        })))
      }, options)
    },
  })
}

function configErrorMessage(error) { return error instanceof Error ? error.message : String(error) }

/** Parse only persisted local configuration; a current runtime never invents an epoch. */
export function normalizeRuntimeInterfaceConfig(value) {
  if (value === undefined || value === null) value = DEFAULT_RUNTIME_CONFIG
  if (!isRecord(value)) throw new TypeError('runtime-interface config must be an object')
  const upstreamVersion = normalizeRuntimeVersion(value.upstreamVersion ?? LEGACY_RUNTIME_VERSION)
  const configuredEpoch = value.historyEpoch
  if (upstreamVersion === CURRENT_RUNTIME_VERSION && (!isRecord(configuredEpoch))) {
    throw new RuntimeInterfaceError('history-epoch-unavailable', 'A current runtime requires persisted historyEpoch dataset and generations', { baselineRequired: true })
  }
  let historyEpoch
  if (configuredEpoch !== undefined) {
    if (!isRecord(configuredEpoch)) throw new RuntimeInterfaceError('history-epoch-invalid', 'historyEpoch config must contain the persisted dataset and generations')
    historyEpoch = Object.freeze({
      datasetId: assertBoundedString(configuredEpoch.datasetId, 'datasetId', 256),
      sequenceFormatGeneration: nonNegativeInteger(configuredEpoch.sequenceFormatGeneration, 'sequenceFormatGeneration'),
      generation: nonNegativeInteger(configuredEpoch.generation, 'generation'),
    })
  }
  const configuredLocalRestart = value.localRestart ?? value.localRuntime
  const localRuntime = configuredLocalRestart === undefined
    ? undefined
    : normalizeLocalRuntimeConfig(configuredLocalRestart)
  return Object.freeze({ upstreamVersion,
    ...(historyEpoch === undefined ? {} : { historyEpoch }),
    ...(localRuntime === undefined ? {} : { localRestart: localRuntime }),
  })
}

function normalizeLocalRuntimeConfig(value) {
  if (isRecord(value) && typeof value.descriptorPath === 'string' && Object.keys(value).every(key => key === 'descriptorPath')) {
    return readManagedRuntimeDescriptor(value.descriptorPath)
  }
  if (isRecord(value) && isRecord(value.descriptor) && Object.keys(value).every(key => key === 'descriptor')) {
    return normalizeManagedRuntimeDescriptor(value.descriptor)
  }
  return normalizeManagedRuntimeDescriptor(value)
}

export const Config = Object.freeze({
  parse(value) { return normalizeRuntimeInterfaceConfig(value) },
  '~standard': {
    version: 1,
    vendor: 'dsh-runtime-interface',
    validate(value) {
      try { return { value: normalizeRuntimeInterfaceConfig(value) } }
      catch (error) { return { issues: [{ message: configErrorMessage(error) }] } }
    },
  },
})

export class RuntimeInterface {
  #version
  #historyEpoch
  #hostId
  #registerManagementRpc
  #localBootstrapEndpoint
  #mobileAssistant = new MobileAssistantStream()
  constructor({ sessionController, workspaceController, connection, managementBinding, subagents, commands, goals, agentPresets, sessionPersistence, upstreamVersion = LEGACY_RUNTIME_VERSION, historyEpoch, hostId = 'local', localRuntime, localRuntimeDescriptor, appExit, webServer } = {}) {
    this.#version = normalizeRuntimeVersion(upstreamVersion)
    this.#historyEpoch = historyEpoch
    this.#hostId = assertBoundedString(hostId, 'hostId', 256)
    // These are canonical business ports. No caller receives an official
    // controller, packed chunk row, or version-specific surface boundary.
    this.session = canonicalSessionPort(sessionController, this.#version, this.#hostId, this.#mobileAssistant)
    this.agentOperations = createAgentOperations({ sessionController, commands, goals, agentPresets, upstreamVersion: this.#version })
    this.workspace = canonicalWorkspacePort(workspaceController, this.#version, this.#hostId)
    this.sessionPersistence = createSessionPersistencePort({ service: sessionPersistence, ErrorType: RuntimeInterfaceError })
    this.connection = createPort(connection, CONNECTION_METHODS, 'connection')
    this.subagents = createPort(subagents, SUBAGENT_METHODS, 'subagents', (_method, value) => mapReturnedValue(value, result => upstreamToCanonicalWire(result, { hostId: this.#hostId, upstreamVersion: this.#version, endpoint: 'subagents/list' })))
    this.#localBootstrapEndpoint = createLocalBootstrapEndpoint({ webServer, connection: this.connection })
    this.localRuntime = localRuntime ?? createLocalRuntimeRestart({ descriptor: localRuntimeDescriptor, appExit, webServer })
    this.#registerManagementRpc = managementRpcRegistrar(managementBinding ?? bindManagementConnection(undefined, connection, this.#version))
    Object.freeze(this)
  }
  get upstreamVersion() { return this.#version }
  get browserVersion() { return this.#version }
  get capabilities() { return historyEpochMetadata({ version: this.#version, historyEpoch: this.#historyEpoch }).capabilities }
  describe() { return Object.freeze({ runtimeInterfaceVersion: RUNTIME_INTERFACE_VERSION, upstreamVersion: this.#version, ...historyEpochMetadata({ version: this.#version, historyEpoch: this.#historyEpoch }) }) }
  localBootstrapEndpoint(...args) { return this.#localBootstrapEndpoint(...args) }
  expectedHistoryEpoch(input) {
    try { return readExpectedHistoryEpoch({ ...input, requireExpected: this.#version === CURRENT_RUNTIME_VERSION }) }
    catch (error) {
      if (error?.code === 'history-epoch-required') throw new HistoryEpochError(error.code, this.describe().historyEpoch)
      throw error
    }
  }
  assertHistoryEpoch(expectedHistoryEpoch, options) { return assertHistoryEpoch(expectedHistoryEpoch, historyEpochMetadata({ version: this.#version, historyEpoch: this.#historyEpoch }).historyEpoch, options) }
  decodeMobileIngress(options) {
    try { return decodeMobileIngress({
      ...options,
      requireHistoryEpoch: this.#version === CURRENT_RUNTIME_VERSION,
      assertEpoch: expectedHistoryEpoch => this.assertHistoryEpoch(expectedHistoryEpoch),
    }) } catch (error) {
      if (error?.code === 'history-epoch-required') throw new HistoryEpochError(error.code, this.describe().historyEpoch)
      throw error
    }
  }
  registerManagementRpc(options) { return this.#registerManagementRpc(options) }
  bindEventSource(source) { return canonicalEventSource(source, this.#version, this.#hostId, this.#mobileAssistant, () => historyEpochMetadata({ version: this.#version, historyEpoch: this.#historyEpoch })) }
  encodeBrowser(value, targetVersion = this.#version) { return canonicalToBrowserWire(value, targetVersion) }
  createBrowserStreamEncoder(options = {}) {
    const targetVersion = options.targetVersion ?? this.#version
    return createBrowserStreamEncoder({
      ...options,
      upstreamVersion: options.upstreamVersion ?? CURRENT_RUNTIME_VERSION,
      targetVersion,
      encodeFrame: options.encodeFrame ?? (value => this.encodeBrowser(value, targetVersion)),
    })
  }
  wrapHostCarrier(options) { return wrapHostCarrier({ ...options, upstreamVersion: options?.upstreamVersion ?? this.#version }) }
}
export function createRuntimeInterface(options) { return new RuntimeInterface(options) }
/** Cordis entry: official controller objects bind only here. */
export function apply(ctx, options = {}) {
  if (!ctx || typeof ctx.provide !== 'function') throw new TypeError('ctx.provide is required')
  const config = normalizeRuntimeInterfaceConfig(options)
  const runtimeInterface = createRuntimeInterface({
    sessionController: ctx.sessionController,
    workspaceController: ctx.workspaceController,
    connection: ctx.connection,
    managementBinding: bindManagementConnection(ctx, ctx.connection, config.upstreamVersion),
    subagents: ctx.subagents,
    commands: ctx.commands,
    goals: ctx.goals,
    agentPresets: ctx.agentPresets,
    sessionPersistence: ctx.sessionPersistence,
    localRuntimeDescriptor: config.localRestart,
    appExit: typeof ctx.appExit === 'function' ? ctx.appExit : undefined,
    webServer: ctx.webServer,
    upstreamVersion: config.upstreamVersion,
    ...(config.historyEpoch === undefined ? {} : { historyEpoch: config.historyEpoch }),
  })
  ctx.provide('runtimeInterface', runtimeInterface)
  return runtimeInterface
}
