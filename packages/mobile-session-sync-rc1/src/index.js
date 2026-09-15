/**
 * Loopback-only v2 mobile Session sync for the official DSH 0.1.2-rc.1
 * controller faces. This adapter deliberately does not depend on the removed
 * rc.8 proxy layer or on an implicit/current Host selection.
 *
 */

import { randomUUID } from 'node:crypto'

export const name = 'mobile-session-sync-rc1'
export const inject = [
  'webServer',
  'runtimeInterface',
]

export const MOBILE_SESSION_DELTA_PATH = '/api/mobile.sessionDelta'
export const MOBILE_SESSION_SYNC_DESCRIBE_PATH = '/api/mobile.sessionSyncDescribe'
export const MOBILE_SESSION_SYNC_SNAPSHOT_PATH = '/api/mobile.sessionSyncSnapshot'

export const MOBILE_SESSION_SYNC_PROTOCOL_VERSION = 2
export const MOBILE_SESSION_SYNC_CAPABILITY = 'mobile-session-sync-v2'

export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_EVENTS = 512
export const DEFAULT_SCAN_PAGE_MESSAGES = 24
export const DEFAULT_MAX_SCAN_PAGES = 32
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

const DEFAULT_OPTIONS = Object.freeze({
  maxEvents: DEFAULT_MAX_EVENTS,
  scanPageMessages: DEFAULT_SCAN_PAGE_MESSAGES,
  maxScanPages: DEFAULT_MAX_SCAN_PAGES,
})

/**
 * A small schema-compatible facade keeps this source build-free. Cordis
 * callers may pass the raw object; `apply` performs the same bounded checks.
 */
export const Config = Object.freeze({
  parse(value) {
    return normalizeConfig(value)
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-mobile-session-sync-rc1',
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: errorMessage(error) }] }
      }
    },
  },
})

function runtimeOf(ctx) {
  const runtime = ctx?.runtimeInterface
  if (!runtime || typeof runtime !== 'object'
      || typeof runtime.decodeMobileIngress !== 'function'
      || !runtime.session || !runtime.workspace || !runtime.connection) {
    throw new TypeError('runtimeInterface is required')
  }
  return runtime
}

/** Read later events from one fixed rc1 follow snapshot and bounded pages. */
export async function readSessionDelta(sessionPort, request, options, signal) {
  const controller = sessionPort
  if (!controller || typeof controller.follow !== 'function' || typeof controller.page !== 'function') {
    throw new TypeError('runtimeInterface.session with follow and page is required')
  }

  const effectiveSignal = signal ?? (isAbortSignal(options) ? options : undefined) ?? new AbortController().signal
  const normalizedOptions = normalizeDeltaOptions(isAbortSignal(options) ? undefined : options)
  validateDeltaRequest(request, normalizedOptions.maxEvents)
  throwIfAborted(effectiveSignal)

  const address = { kind: 'session', sessionId: request.sessionId }
  let opening
  try {
    opening = await openSessionSnapshot(
      controller,
      address,
      normalizedOptions.scanPageMessages,
      effectiveSignal,
    )
  } catch (error) {
    throwOrReturnCancellation(error, effectiveSignal)
    if (error instanceof BaselineRecoveryError) {
      return successResult(baselineRecovery(
        request.afterSeq,
        request.afterSeq,
        undefined,
        error.reason,
        false,
      ))
    }
    return failureResult(error)
  }

  const fixedCursor = opening.cursor
  const lastSeq = fixedCursor
  if (request.afterSeq > fixedCursor) {
    return successResult(baselineRecovery(
      request.afterSeq,
      fixedCursor,
      undefined,
      'cursor-regressed',
      false,
    ))
  }
  const projections = opening.projections
  const records = []
  let cursorReached = request.afterSeq >= fixedCursor
  let pageHasMore = opening.hasMore
  let scanLimitReached = false
  let baselineReason

  try {
    const openingEntries = decodeHistoryRecords(opening.records, fixedCursor)
    records.push(...openingEntries)
    if (openingEntries.length > 0) {
      cursorReached ||= minSeq(openingEntries) <= request.afterSeq
      if (request.afterSeq < fixedCursor && maxSeq(openingEntries) !== fixedCursor) {
        baselineReason = 'truncated-snapshot-page'
      }
    } else if (opening.hasMore || (fixedCursor >= 0 && request.afterSeq < fixedCursor)) {
      baselineReason = 'truncated-snapshot-page'
    }

    let beforeSeq = openingEntries.length > 0 ? minSeq(openingEntries) : undefined
    for (let pageIndex = 0; !cursorReached && pageHasMore && !baselineReason; pageIndex += 1) {
      if (pageIndex >= normalizedOptions.maxScanPages) {
        scanLimitReached = true
        baselineReason = 'scan-limit'
        break
      }
      if (beforeSeq === undefined) {
        baselineReason = 'unusable-page-cursor'
        break
      }

      throwIfAborted(effectiveSignal)
      const rawPage = await raceAbort(
        Promise.resolve(controller.page({
          address,
          throughSeq: fixedCursor,
          beforeSeq,
          maxMessages: normalizedOptions.scanPageMessages,
        }, effectiveSignal)),
        effectiveSignal,
      )
      const page = unwrapControllerValue(rawPage)
      if (!page || typeof page !== 'object' || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        baselineReason = 'invalid-history-page'
        break
      }
      const entries = decodeHistoryRecords(page.records, fixedCursor, beforeSeq)
      if (entries.length === 0 && page.hasMore) {
        baselineReason = 'truncated-history-page'
        break
      }
      if (entries.length > 0) {
        const nextBeforeSeq = minSeq(entries)
        if (nextBeforeSeq >= beforeSeq) {
          baselineReason = 'stalled-page-cursor'
          break
        }
        beforeSeq = nextBeforeSeq
        records.push(...entries)
        cursorReached ||= nextBeforeSeq <= request.afterSeq
      } else if (!page.hasMore && request.afterSeq < beforeSeq) {
        // `hasMore=false` is the official proof that this sparse page reaches
        // the log origin; numeric seq values do not imply a missing prefix.
      }
      pageHasMore = page.hasMore
      if (!pageHasMore && !baselineReason) cursorReached = true
    }
    if (!cursorReached && pageHasMore && !baselineReason) {
      scanLimitReached = true
      baselineReason = 'scan-limit'
    }
  } catch (error) {
    throwOrReturnCancellation(error, effectiveSignal)
    if (error instanceof BaselineRecoveryError) {
      baselineReason = error.reason
    } else {
      return failureResult(error)
    }
  }

  if (baselineReason !== undefined) {
    return successResult(baselineRecovery(
      request.afterSeq,
      lastSeq,
      projections,
      baselineReason,
      scanLimitReached,
    ))
  }

  let events
  try {
    events = dedupeAndSort(records, request.afterSeq, fixedCursor)
  } catch (error) {
    return successResult(baselineRecovery(
      request.afterSeq,
      lastSeq,
      projections,
      error instanceof BaselineRecoveryError ? error.reason : 'duplicate-sequence-conflict',
      false,
    ))
  }
  const requestedLimit = request.maxEvents ?? normalizedOptions.maxEvents
  const delivered = events.slice(0, requestedLimit)
  const throughSeq = delivered.at(-1)?.event?.seq ?? request.afterSeq
  return successResult({
    acknowledgedSeq: request.afterSeq,
    ...(delivered[0] === undefined ? {} : { firstSeq: delivered[0].event.seq }),
    throughSeq,
    lastSeq,
    caughtUp: throughSeq >= lastSeq,
    scanLimitReached: false,
    events: delivered,
    ...(projections === undefined ? {} : { projections }),
  })
}

/**
 * Capture one server-owned baseline. The workspace stream is consumed only
 * through its first baseline frame; each Session fallback uses one follow
 * opening cursor, so no phone clock or moving tail is trusted.
 */
export async function readSessionSyncSnapshot(first, second, third) {
  const { session, workspace, signal } = normalizeSnapshotArgs(first, second, third)
  if (!session || typeof session.list !== 'function') {
    throw new TypeError('runtimeInterface.session with list is required')
  }
  if (!workspace || typeof workspace.follow !== 'function') {
    throw new TypeError('runtimeInterface.workspace with follow is required')
  }
  const effectiveSignal = signal ?? new AbortController().signal
  throwIfAborted(effectiveSignal)

  const snapshotId = randomUUID()
  let listed
  let workspaceBaseline
  try {
    ;[listed, workspaceBaseline] = await Promise.all([
      raceAbort(Promise.resolve(session.list({}, effectiveSignal)), effectiveSignal),
      readWorkspaceBaseline(workspace, effectiveSignal),
    ])
  } catch (error) {
    throwOrReturnCancellation(error, effectiveSignal)
    return failureResult(error)
  }

  let listValue
  try {
    listValue = unwrapControllerValue(listed)
  } catch (error) {
    throwOrReturnCancellation(error, effectiveSignal)
    return failureResult(error)
  }
  if (!listValue || !Array.isArray(listValue.items)) {
    return failureResult(new Error('runtimeInterface.session.list returned an invalid value'))
  }
  const archived = new Set(Array.isArray(workspaceBaseline.archivedSessionIds) ? workspaceBaseline.archivedSessionIds : [])
  const sessions = []
  for (const summary of listValue.items) {
    if (!summary || typeof summary !== 'object' || typeof summary.sessionId !== 'string') continue
    validateLocalSessionId(summary.sessionId)
    if (archived.has(summary.sessionId)) continue
    const projected = summary.projections?.asOfSeq
    if (isSafeSequence(projected)) {
      sessions.push({ sessionId: summary.sessionId, lastSeq: projected })
      continue
    }
    try {
      const opening = await openSessionSnapshot(
        session,
        { kind: 'session', sessionId: summary.sessionId },
        1,
        effectiveSignal,
      )
      sessions.push({ sessionId: summary.sessionId, lastSeq: opening.cursor })
    } catch (error) {
      throwOrReturnCancellation(error, effectiveSignal)
      // A single unreadable/corrupt Session gets a conservative cursor. The
      // mobile side must baseline it instead of treating an error as empty.
      sessions.push({ sessionId: summary.sessionId, lastSeq: -1 })
    }
  }

  return successResult({
    protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
    snapshotId,
    observedAt: Date.now(),
    sessions,
  })
}

/** Register the exact v2 routes with rc1 authentication and loopback fences. */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('webServer is required')
  }
  const runtime = runtimeOf(ctx)
  const register = () => {
    const disposers = []
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_DELTA_PATH,
        handler: (req, res) => handleDeltaRequest(runtime, req, res, resolved),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_SYNC_DESCRIBE_PATH,
        handler: (req, res) => handleDescribeRequest(runtime, req, res, resolved),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_SYNC_SNAPSHOT_PATH,
        handler: (req, res) => handleSnapshotRequest(runtime, req, res, resolved),
      }))
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try { dispose?.() } catch { /* preserve the registration failure */ }
      }
      throw error
    }
    return () => disposers.reverse().forEach(dispose => dispose())
  }
  return typeof ctx.effect === 'function'
    ? ctx.effect(register, 'mobile-session-sync-rc1: v2 routes')
    : register()
}

function handleDescribeRequest(runtime, req, res, config) {
  if (!authorizeHttpRequest(runtime, req, res, config.maxResponseBytes)) return
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  sendJson(res, 200, {
    protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
    capability: MOBILE_SESSION_SYNC_CAPABILITY,
    limits: {
      maxRequestBytes: config.maxRequestBytes,
      maxResponseBytes: config.maxResponseBytes,
      maxEvents: config.maxEvents,
      scanPageMessages: config.scanPageMessages,
      maxScanPages: config.maxScanPages,
      requestTimeoutMs: config.requestTimeoutMs,
    },
  }, config.maxResponseBytes)
}

async function handleDeltaRequest(runtime, req, res, config) {
  if (!authorizeHttpRequest(runtime, req, res, config.maxResponseBytes)) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content type must be application/json' }, config.maxResponseBytes)
    return
  }
  await handleJsonRequest(runtime, req, res, config, 'mobile.sessionDelta', async (ingress, signal) => {
    return readSessionDelta(runtime.session, ingress.payload, config, signal)
  })
}

async function handleSnapshotRequest(runtime, req, res, config) {
  if (!authorizeHttpRequest(runtime, req, res, config.maxResponseBytes)) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content type must be application/json' }, config.maxResponseBytes)
    return
  }
  await handleJsonRequest(runtime, req, res, config, 'mobile.sessionSyncSnapshot', async (_ingress, signal) => {
    return readSessionSyncSnapshot(runtime.session, runtime.workspace, signal)
  })
}

async function handleJsonRequest(runtime, req, res, config, method, operation) {
  const lifetime = createRequestLifetime(req, res, config.requestTimeoutMs)
  let rpcId = 'invalid'
  try {
    const body = await raceAbort(readBody(req, config.maxRequestBytes, lifetime.signal), lifetime.signal)
    const ingress = runtime.decodeMobileIngress({
      route: method,
      body,
      headers: req.headers,
      type: 'client-request',
      method,
    })
    rpcId = ingress.rpcId
    const result = await operation(ingress, lifetime.signal)
    if (lifetime.timedOut) {
      sendJson(res, 408, { error: 'request timeout' }, config.maxResponseBytes)
      return
    }
    if (lifetime.clientClosed) return
    sendJson(res, 200, { type: 'server-response', rpcId, result }, config.maxResponseBytes)
  } catch (error) {
    if (lifetime.clientClosed) return
    if (lifetime.timedOut) {
      sendJson(res, 408, { error: 'request timeout' }, config.maxResponseBytes)
      return
    }
    if (error instanceof RequestTooLargeError) {
      sendJson(res, 413, { error: 'request body too large' }, config.maxResponseBytes)
      return
    }
    if (isAbortError(error)) return
    sendJson(res, 400, serverFailure(rpcId, error), config.maxResponseBytes)
  } finally {
    lifetime.dispose()
  }
}

function authorizeHttpRequest(runtime, req, res, maxResponseBytes) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: 'forbidden' }, maxResponseBytes)
    return false
  }
  const connection = runtime?.connection
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 503, { error: 'authentication unavailable' }, maxResponseBytes)
    return false
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    sendJson(res, 503, { error: 'authentication unavailable' }, maxResponseBytes)
    return false
  }
  if (rejection !== undefined) {
    const status = rejection === 401 || rejection === 403 ? rejection : 503
    sendJson(res, status, { error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication unavailable' }, maxResponseBytes)
    return false
  }
  return true
}

function normalizeConfig(value) {
  if (value === undefined || value === null) value = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('config must be an object')
  const maxRequestBytes = boundedInteger(value.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES, 'maxRequestBytes', 1024, 64 * 1024 * 1024)
  const maxResponseBytes = boundedInteger(value.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes', 1024, 64 * 1024 * 1024)
  const maxEvents = boundedInteger(value.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents', 1, 4096)
  const scanPageMessages = boundedInteger(value.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES, 'scanPageMessages', 1, 256)
  const maxScanPages = boundedInteger(value.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES, 'maxScanPages', 1, 256)
  const requestTimeoutMs = boundedInteger(value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs', 1, 10 * 60 * 1000)
  return Object.freeze({
    maxRequestBytes,
    maxResponseBytes,
    maxEvents,
    scanPageMessages,
    maxScanPages,
    requestTimeoutMs,
  })
}

function normalizeDeltaOptions(value) {
  if (value === undefined || value === null || isAbortSignal(value)) return DEFAULT_OPTIONS
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('delta options must be an object')
  return Object.freeze({
    maxEvents: boundedInteger(value.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents', 1, 4096),
    scanPageMessages: boundedInteger(value.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES, 'scanPageMessages', 1, 256),
    maxScanPages: boundedInteger(value.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES, 'maxScanPages', 1, 256),
  })
}

function validateDeltaRequest(request, configuredMaxEvents) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('payload must be an object')
  validateLocalSessionId(request.sessionId)
  if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < -1 || Object.is(request.afterSeq, -0)) {
    throw new TypeError('afterSeq must be a safe integer greater than or equal to -1')
  }
  if (request.maxEvents !== undefined && (!Number.isSafeInteger(request.maxEvents)
      || request.maxEvents < 1 || request.maxEvents > configuredMaxEvents)) {
    throw new TypeError(`maxEvents must be between 1 and ${String(configuredMaxEvents)}`)
  }
}

function validateLocalSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\u0000')) {
    throw new TypeError('sessionId must be a bounded non-empty local Session id')
  }
  if (value.startsWith('rh1.')) throw new TypeError('sessionId must not be an rh1 remote composite id')
}

async function openSessionSnapshot(controller, address, maxMessages, signal) {
  validateLocalSessionId(address.sessionId)
  const source = controller.follow({ address, maxMessages }, signal)
  const iterator = await toAsyncIterator(source)
  try {
    const first = await raceAbort(Promise.resolve(iterator.next()), signal)
    if (first?.done || !first?.value || first.value.type !== 'snapshot') {
      throw new BaselineRecoveryError('missing-follow-snapshot')
    }
    if (!isSafeSequence(first.value.cursor) && first.value.cursor !== -1) {
      throw new BaselineRecoveryError('invalid-follow-cursor')
    }
    if (!Array.isArray(first.value.records) || typeof first.value.hasMore !== 'boolean') {
      throw new BaselineRecoveryError('invalid-follow-snapshot')
    }
    return first.value
  } finally {
    await closeIterator(iterator, signal)
  }
}

async function readWorkspaceBaseline(controller, signal) {
  const iterator = await toAsyncIterator(controller.follow(signal))
  try {
    const first = await raceAbort(Promise.resolve(iterator.next()), signal)
    if (first?.done) throw new Error('workspace follow ended before baseline')
    const frame = first.value
    const value = frame?.type === 'baseline' ? frame.value : frame
    if (value && typeof value === 'object'
        && Array.isArray(value.items) && Array.isArray(value.archivedSessionIds)) return value
    throw new Error('workspace follow returned an invalid baseline')
  } finally {
    await closeIterator(iterator, signal)
  }
}

/** Do not let a cancelled remote generator keep an HTTP request alive. */
async function closeIterator(iterator, signal) {
  let closing
  try {
    closing = iterator.return?.()
  } catch {
    return
  }
  const ignored = Promise.resolve(closing).catch(() => {})
  if (signal?.aborted) return
  await ignored
}

function decodeHistoryRecords(records, throughSeq, beforeSeq) {
  const entries = []
  for (const record of records) {
    const decoded = decodeHistoryRecord(record)
    for (const entry of decoded) {
      const seq = entry.event?.seq
      if (!isSafeSequence(seq) || seq > throughSeq) throw new BaselineRecoveryError('unsupported-record')
      if (beforeSeq !== undefined && seq >= beforeSeq) throw new BaselineRecoveryError('unusable-page-cursor')
      entries.push(entry)
    }
  }
  return entries
}

function decodeHistoryRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new BaselineRecoveryError('unsupported-record')
  }
  if (record.type === 'event') {
    const event = canonicalEventForV2(record.event)
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new BaselineRecoveryError('unsupported-record')
    }
    if (!isSafeSequence(event.seq)) throw new BaselineRecoveryError('unsupported-record')
    return [{ event }]
  }
  throw new BaselineRecoveryError('unsupported-record')
}

/** Canonical legacy chunk DTOs are restored only for the stable v2 wire. */
function canonicalEventForV2(event) {
  if (event?.type !== 'legacy/assistant-chunk' || event?.data?.legacyType !== 'assistant/chunk') return event
  const data = event.data.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BaselineRecoveryError('unsupported-record')
  return {
    type: 'assistant/chunk',
    seq: event.seq,
    ...(event.time === undefined ? {} : { time: event.time }),
    data,
  }
}

function dedupeAndSort(entries, afterSeq, throughSeq) {
  const bySeq = new Map()
  for (const entry of entries) {
    const seq = entry.event.seq
    if (seq <= afterSeq || seq > throughSeq) continue
    const previous = bySeq.get(seq)
    if (previous !== undefined && stableJson(previous) !== stableJson(entry)) {
      throw new BaselineRecoveryError('duplicate-sequence-conflict')
    }
    bySeq.set(seq, entry)
  }
  return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
}

function baselineRecovery(acknowledgedSeq, lastSeq, projections, reason, scanLimitReached) {
  return {
    acknowledgedSeq,
    throughSeq: acknowledgedSeq,
    lastSeq,
    caughtUp: false,
    scanLimitReached,
    events: [],
    baselineRequired: true,
    baselineReason: reason,
    ...(projections === undefined ? {} : { projections }),
  }
}

function failureResult(error) {
  const safe = safePublicError(error)
  return {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details }),
    },
  }
}

function successResult(value) {
  return { ok: true, value }
}

function unwrapControllerValue(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean' && Object.hasOwn(value, 'value')) {
    if (!value.ok) throw value.error ?? new Error('controller returned a failed result')
    return value.value
  }
  if (value && typeof value === 'object' && value.result && typeof value.result.ok === 'boolean') {
    if (!value.result.ok) throw value.result.error ?? new Error('controller returned a failed result')
    return value.result.value
  }
  return value
}

function normalizeSnapshotArgs(first, second, third) {
  if (first?.session && first?.workspace) {
    return { session: first.session, workspace: first.workspace, signal: second ?? third }
  }
  return { session: first, workspace: second, signal: third }
}

async function toAsyncIterator(value) {
  const resolved = await value
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') return resolved[Symbol.asyncIterator]()
  if (resolved && typeof resolved[Symbol.iterator] === 'function') return resolved[Symbol.iterator]()
  return (async function * one() { yield resolved })()
}

function createRequestLifetime(req, res, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  let clientClosed = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('request timed out'))
  }, timeoutMs)
  const onAborted = () => {
    clientClosed = true
    controller.abort(new Error('request aborted'))
  }
  const onClose = () => {
    if (!req.complete && !res.writableEnded) onAborted()
  }
  req.once?.('aborted', onAborted)
  req.once?.('close', onClose)
  res.once?.('close', () => {
    if (!res.writableEnded) onAborted()
  })
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    get clientClosed() { return clientClosed },
    dispose() {
      clearTimeout(timeout)
      req.off?.('aborted', onAborted)
      req.off?.('close', onClose)
    },
  }
}

async function readBody(req, maxBytes, signal) {
  const contentLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume?.()
    throw new RequestTooLargeError()
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    throwIfAborted(signal)
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new RequestTooLargeError()
    chunks.push(buffer)
  }
  throwIfAborted(signal)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value, maxBytes) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    status = 500
    body = JSON.stringify({ error: 'response unavailable' })
  }
  if (body === undefined) body = JSON.stringify({ error: 'response unavailable' })
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    status = 413
    body = JSON.stringify({ error: 'response too large' })
    if (Buffer.byteLength(body, 'utf8') > maxBytes) body = ''
  }
  if (res.headersSent) return false
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  })
  res.end(body)
  return true
}

function serverFailure(rpcId, message) {
  const safe = safePublicError(message)
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: safe.code, message: safe.message, details: safe.details ?? { issues: [] } } },
  }
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  'gateway/bad-request': 'request rejected',
  'gateway/cancelled': 'request cancelled',
  'gateway/internal': 'session sync unavailable',
  'session/not-found': 'session unavailable',
  'session/agent-busy': 'session unavailable',
  'subagent/not-found': 'session unavailable',
  'subagent/unauthorized': 'session unavailable',
  'subagent/catalog-diagnostic': 'session unavailable',
})

const SAFE_ERROR_REASONS = new Set([
  'corrupt',
  'unsupported',
  'use subagent delivery for this child session',
])

function safePublicError(error) {
  const isInputError = typeof error === 'string'
    || error instanceof TypeError
    || error instanceof SyntaxError
  const candidate = typeof error?.code === 'string' ? error.code : undefined
  const code = isInputError
    ? 'gateway/bad-request'
    : Object.hasOwn(PUBLIC_ERROR_MESSAGES, candidate) ? candidate : 'gateway/internal'
  const details = safeErrorDetails(error?.details)
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
    ...(details === undefined ? {} : { details }),
  }
}

function safeErrorDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const reason = details.reason
  if (typeof reason === 'string' && SAFE_ERROR_REASONS.has(reason)) return { reason }
  // Keep the Standard Schema error shape stable without copying issue text or paths.
  if (Array.isArray(details.issues)) return { issues: [] }
  return undefined
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? req.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isJsonContentType(req) {
  const contentType = req.headers?.['content-type']
  if (Array.isArray(contentType)) return isJsonContentType({ headers: { 'content-type': contentType[0] } })
  return typeof contentType === 'string'
    && contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max || Object.is(value, -0)) {
    throw new TypeError(`${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return value
}

function isSafeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function minSeq(entries) {
  return entries.reduce((min, entry) => Math.min(min, entry.event.seq), Infinity)
}

function maxSeq(entries) {
  return entries.reduce((max, entry) => Math.max(max, entry.event.seq), -Infinity)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'request failed')
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function'
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
}

function throwOrReturnCancellation(error, signal) {
  if (signal?.aborted || isAbortError(error)) throw error
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function raceAbort(promise, signal) {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(signal.reason ?? new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(value => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

class BaselineRecoveryError extends Error {
  constructor(reason) {
    super(`baseline recovery required: ${reason}`)
    this.name = 'BaselineRecoveryError'
    this.reason = reason
  }
}

class RequestTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'RequestTooLargeError'
    this.code = 'gateway/request-too-large'
  }
}
