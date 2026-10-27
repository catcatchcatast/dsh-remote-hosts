// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                   
                                                                                                                                             
                                                                                                                                                   

/**
 * Stable stream-failure vocabulary owned by the runtime boundary.
 *
 * Host business code must never inspect raw transport text to decide whether a
 * read subscription may be reopened.  This module reduces every stream failure
 * to five allow-listed fields (`source`, `reason`, `recoverable`, `stage` and,
 * for ordering errors, the bounded `expected`/`actual` indices) so that the
 * existing backoff consumers keep working without parsing messages, while the
 * diagnostic journal can persist exactly the same vocabulary.
 *
 * Recoverability is derived from the reason, never from the reported value:
 * authentication refusals, invalid data, version incompatibility, cancellation
 * and resource exhaustion stay terminal.  Only transient transport conditions
 * and ordinary stream completion are reopenable, and only read subscriptions
 * are ever reopened - writes, creations and approvals are never replayed.
 */

/** Where the failure was observed. */
export const STREAM_FAILURE_SOURCES = Object.freeze(['interface', 'carrier', 'hub', 'queue'])

/** Which side of the first snapshot the failure belongs to. */
export const STREAM_FAILURE_STAGES = Object.freeze(['bootstrap', 'live'])

/** Stable reason enumeration. */
export const STREAM_FAILURE_REASONS = Object.freeze([
  'unknown',
  'first-frame-timeout',
  'transport-timeout',
  'transport-disconnected',
  'connect-failed',
  'stream-ended',
  'sequence-gap',
  'attempt-mismatch',
  'invalid-frame',
  'invalid-snapshot',
  'incompatible',
  'unauthorized',
  'aborted',
  'resource-limit',
])

const RECOVERABLE_REASONS = new Set([
  'first-frame-timeout',
  'transport-timeout',
  'transport-disconnected',
  'connect-failed',
  'stream-ended',
])

const REASON_SET = new Set(STREAM_FAILURE_REASONS)
const SOURCE_SET = new Set(STREAM_FAILURE_SOURCES)
const STAGE_SET = new Set(STREAM_FAILURE_STAGES)
const MAX_COUNT = Number.MAX_SAFE_INTEGER

/**
 * Error codes owned by the runtime interface and the Browser transport, mapped
 * to one stable reason and one stable source.  Order matters: the first prefix
 * that matches wins.
 */
const FAILURE_TABLE = Object.freeze([
  ['runtime-interface/stream-closed', 'resource-limit', 'interface'],
  ['runtime-interface/unsupported-version', 'incompatible', 'interface'],
  ['runtime-interface/invalid-stream', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-events', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-event', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-request', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-identity', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-sequence', 'invalid-frame', 'interface'],
  ['runtime-interface/invalid-channel', 'invalid-frame', 'interface'],
  ['runtime-interface/unauthorized', 'unauthorized', 'interface'],
  ['runtime-interface/forbidden', 'unauthorized', 'interface'],
  ['runtime-interface/capability-unavailable', 'incompatible', 'interface'],
  ['runtime-interface/stream-first-frame-timeout', 'first-frame-timeout', 'interface'],
  ['runtime-interface/stream-timeout', 'transport-timeout', 'interface'],
  ['runtime-interface/queue-overflow', 'resource-limit', 'queue'],
  ['runtime-interface/buffer-limit', 'resource-limit', 'queue'],
  ['runtime-interface/aborted', 'aborted', 'interface'],
  ['browser-host-hub-rc1/stream-first-frame-timeout', 'first-frame-timeout', 'hub'],
  ['browser-host-hub-rc1/stream-timeout', 'transport-timeout', 'hub'],
  ['browser-host-hub-rc1/stream-disconnected', 'transport-disconnected', 'hub'],
  ['browser-host-hub-rc1/connect-failed', 'connect-failed', 'hub'],
  ['browser-host-hub-rc1/stream-ended', 'stream-ended', 'hub'],
  ['browser-host-hub-rc1/unauthorized', 'unauthorized', 'hub'],
  ['browser-host-hub-rc1/resource-limit', 'resource-limit', 'hub'],
  ['browser-host-hub-rc1/stream-backpressure', 'resource-limit', 'queue'],
  ['browser-host-hub-rc1/invalid-stream', 'invalid-frame', 'hub'],
])

/** Transport codes raised by Node, WebSocket and AbortSignal. */
const TRANSPORT_REASONS = new Map([
  ['ETIMEDOUT', 'transport-timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'transport-timeout'],
  ['UND_ERR_HEADERS_TIMEOUT', 'transport-timeout'],
  ['UND_ERR_BODY_TIMEOUT', 'transport-timeout'],
  ['ABORT_ERR', 'aborted'],
  ['ERR_CANCELED', 'aborted'],
  ['ECONNRESET', 'transport-disconnected'],
  ['EPIPE', 'transport-disconnected'],
  ['ERR_STREAM_PREMATURE_CLOSE', 'transport-disconnected'],
  ['ECONNREFUSED', 'connect-failed'],
  ['EHOSTUNREACH', 'connect-failed'],
  ['ENETUNREACH', 'connect-failed'],
  ['ENOTFOUND', 'connect-failed'],
  ['EAI_AGAIN', 'connect-failed'],
  ['ENETDOWN', 'connect-failed'],
  ['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', 'resource-limit'],
  ...['WS_ERR_INVALID_UTF8', 'WS_ERR_UNEXPECTED_RSV_1', 'WS_ERR_INVALID_OPCODE', 'WS_ERR_EXPECTED_MASK', 'WS_ERR_UNEXPECTED_MASK', 'WS_ERR_INVALID_CLOSE_CODE', 'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH'].map(code => [code, 'invalid-frame']),
])

// Older carriers expose these fixed identifiers as messages, not typed codes.
// Decode them here once; arbitrary error text is never a retry signal.
const LEGACY_CARRIER_REASONS = new Map([
  ['CARRIER_DISCONNECTED', 'transport-disconnected'],
  ['CARRIER_STREAM_ENDED', 'stream-ended'],
  ['CARRIER_RESULT_HTTP_401', 'unauthorized'],
  ['CARRIER_RESULT_HTTP_403', 'unauthorized'],
  ['HOST_CONNECTION_FAILED_AUTHENTICATION', 'unauthorized'],
  ['HOST_CONNECTION_FAILED_BOOTSTRAP_VALIDATE', 'incompatible'],
  ['HOST_CONNECTION_FAILED_FORWARD', 'connect-failed'],
  ['HOST_CONNECTION_FAILED_BOOTSTRAP_READ', 'connect-failed'],
  ['HOST_CONNECTION_FAILED_CONNECT', 'connect-failed'],
])

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }
function member(set, value) { return typeof value === 'string' && set.has(value) ? value : undefined }
function boundedEnum(list, value) { return typeof value === 'string' && list.includes(value) ? value : undefined }
function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT && !Object.is(value, -0) ? value : undefined
}

function sourceFromCode(code) {
  if (typeof code !== 'string') return undefined
  for (const [prefix, , source] of FAILURE_TABLE) if (code.startsWith(prefix)) return source
  if (TRANSPORT_REASONS.has(code) || /^(?:transport|stream)[/:]/.test(code)) return 'carrier'
  return undefined
}

function reasonFromCode(code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 128) return undefined
  for (const [prefix, reason] of FAILURE_TABLE) if (code.startsWith(prefix)) return reason
  const transport = TRANSPORT_REASONS.get(code)
  if (transport !== undefined) return transport
  // Carrier-local namespaces such as `transport/timeout` or `stream/ended` are
  // normalized onto the same vocabulary instead of being treated as unknown.
  const namespaced = /^(?:transport|stream)[/:](.+)$/.exec(code)?.[1]
  if (namespaced !== undefined) {
    const normalized = namespaced.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const direct = `stream-${normalized}`
    if (REASON_SET.has(direct)) return direct
    if (normalized === 'timeout') return 'transport-timeout'
    if (normalized === 'disconnected' || normalized === 'closed') return 'transport-disconnected'
    if (normalized === 'failed') return 'connect-failed'
    if (REASON_SET.has(normalized)) return normalized
  }
  return undefined
}

function recoverableFor(reason) {
  return RECOVERABLE_REASONS.has(reason)
}

/**
 * Attach the interface-owned classification to a thrown error so that any
 * consumer, including the Browser Host Hub, can read `error.source` and
 * `error.reason` directly without string matching.  Existing `code`/`details`
 * fields are preserved and both views are frozen together.
 */
export function markStreamFailure(error, classification) {
  if (!isRecord(error) && typeof error !== 'function') return error
  const frozen = Object.freeze({ ...classification })
  for (const [key, value] of Object.entries(frozen)) {
    try { error[key] = value } catch { /* frozen or read-only field: skip it */ }
  }
  try { Object.defineProperty(error, 'streamFailure', { value: frozen, configurable: true }) } catch { /* frozen error: leave it unmarked */ }
  return error
}

/**
 * Reduce any thrown value to the stable failure vocabulary.
 *
 * `options.stage` is `bootstrap` before the first snapshot and `live`
 * afterwards.  An aborted signal always wins: cancellation is never a
 * recoverable stream condition.
 */
export function classifyStreamFailure(value, options = {}) {
  if (!isRecord(options)) throw new TypeError('stream failure options must be an object')
  const stage = boundedEnum(STREAM_FAILURE_STAGES, options.stage) ?? 'live'
  const requestedSource = boundedEnum(STREAM_FAILURE_SOURCES, options.source)
  const error = isRecord(value) ? value : undefined
  const marked = isRecord(error?.streamFailure) ? error.streamFailure : error
  const abortSignal = isRecord(options.signal) ? options.signal : undefined
  const aborted = abortSignal?.aborted === true || error?.name === 'AbortError'
  const legacyReason = LEGACY_CARRIER_REASONS.get(error?.message)
  const causeCode = isRecord(error?.cause) ? error.cause.code : undefined

  let reason = boundedEnum(STREAM_FAILURE_REASONS, marked?.reason)
    ?? boundedEnum(STREAM_FAILURE_REASONS, error?.failureReason)
    ?? reasonFromCode(error?.code)
    ?? reasonFromCode(causeCode)
    ?? legacyReason
  if (reason === undefined && aborted) reason = 'aborted'
  if (reason === undefined) reason = 'unknown'

  const source = requestedSource
    ?? boundedEnum(STREAM_FAILURE_SOURCES, marked?.source)
    ?? sourceFromCode(error?.code)
    ?? sourceFromCode(causeCode)
    ?? (legacyReason === undefined ? 'interface' : 'carrier')

  const details = isRecord(error?.details) ? error.details : undefined
  const expected = boundedCount(details?.expected ?? error?.expected)
  const actual = boundedCount(details?.actual ?? error?.actual)
  const classification = {
    source,
    reason: aborted ? 'aborted' : reason,
    recoverable: aborted ? false : recoverableFor(reason),
    stage,
  }
  if (expected !== undefined) classification.expected = expected
  if (actual !== undefined) classification.actual = actual
  return classification
}

/**
 * Project arbitrary input - a journal row being persisted, re-read or exported -
 * onto the same vocabulary.  Anything outside the allow-lists is dropped, and
 * `recoverable` is always recomputed instead of trusted.
 */
export function sanitizeStreamFailure(input) {
  if (!isRecord(input)) return undefined
  const reason = boundedEnum(STREAM_FAILURE_REASONS, input.reason)
    ?? reasonFromCode(isRecord(input.error) ? input.error.code : input.code)
  if (reason === undefined) return undefined
  const row = { source: boundedEnum(STREAM_FAILURE_SOURCES, input.source) ?? 'interface', reason }
  const aborted = reason === 'aborted'
  row.recoverable = aborted ? false : recoverableFor(reason)
  const stage = boundedEnum(STREAM_FAILURE_STAGES, input.stage)
  if (stage !== undefined) row.stage = stage
  const expected = boundedCount(input.expected)
  if (expected !== undefined) row.expected = expected
  const actual = boundedCount(input.actual)
  if (actual !== undefined) row.actual = actual
  return row
}

/** Coarse journal code retained for old diagnostic consumers. */
export function streamFailureDiagnosticCode(reason) {
  if (reason === 'aborted') return 'aborted'
  if (reason === 'unauthorized') return 'unauthorized'
  if (reason === 'resource-limit') return 'overflow'
  if (reason === 'first-frame-timeout' || reason === 'transport-timeout') return 'timeout'
  if (['sequence-gap', 'attempt-mismatch', 'invalid-frame', 'invalid-snapshot', 'incompatible'].includes(reason)) return 'protocol'
  if (['transport-disconnected', 'connect-failed', 'stream-ended'].includes(reason)) return 'transport'
  return 'unknown'
}

export function streamFailureBrowserPolicy() {
  return {
    sources: [...STREAM_FAILURE_SOURCES], reasons: [...STREAM_FAILURE_REASONS], stages: [...STREAM_FAILURE_STAGES],
    recoverable: [...RECOVERABLE_REASONS],
    diagnosticCodes: Object.fromEntries(STREAM_FAILURE_REASONS.map(reason => [reason, streamFailureDiagnosticCode(reason)])),
  }
}

// Fixed transport metadata shared by the journal and browser export.
const TRANSPORT_OPERATIONS = new Set(['ws-error', 'ws-close', 'ws-end', 'ws-cancel', 'lazy-drop', 'ssh-close', 'ssh-exit', 'ssh-error'])
const CANCEL_SOURCES = new Set(['none', 'caller', 'entry'])
const CLOSE_SOURCES = new Set(['socket-error', 'socket-eof', 'protocol-end', 'protocol-error', 'caller-abort', 'entry-abort', 'reader-return', 'auth-refused', 'entry-death', 'host-lifetime', 'caller-close', 'connect-failed', 'child-exit', 'child-error'])
const TRANSPORT_CODES = new Set([...TRANSPORT_REASONS.keys(), 'ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'ENOEXEC', ...LEGACY_CARRIER_REASONS.keys()])
export function sanitizeTransportDiagnostic(input) {
  if (!isRecord(input)) return {}
  const row = {}
  for (const key of ['entry', 'read']) if (/^[a-f0-9]{20}$/.test(input[key] ?? '')) row[key] = input[key]
  for (const [key, allowed] of [['operation', TRANSPORT_OPERATIONS], ['cancelSource', CANCEL_SOURCES], ['closeSource', CLOSE_SOURCES], ['errorCode', TRANSPORT_CODES]]) {
    if (allowed.has(input[key])) row[key] = input[key]
  }
  for (const [key, low, high] of [['httpStatus', 100, 599], ['sshPid', 1, 0xffffffff], ['exitCode', -0x80000000, 0xffffffff]]) {
    if (Number.isSafeInteger(input[key]) && input[key] >= low && input[key] <= high) row[key] = input[key]
  }
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'].includes(input.exitSignal)) row.exitSignal = input.exitSignal
  if (typeof input.killIntent === 'boolean') row.killIntent = input.killIntent
  return row
}
