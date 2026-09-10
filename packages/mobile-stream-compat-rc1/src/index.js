/**
 * Loopback-only RC1 mobile Session sync compatibility for the official DSH
 * 0.1.2-rc.1 controller faces. The sibling mobile-session-sync-rc1 package
 * owns the v2 HTTP routes; this adapter registers additive v3 and legacy SSE
 * routes while reusing the bounded v2 projection/paging semantics. It
 * deliberately does not depend on the removed legacy proxy layer or on an
 * implicit/current Host selection.
 *
 */

import { randomUUID } from 'node:crypto'

const name = 'mobile-stream-compat-rc1'
const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  'subagents',
  'mobileInteractions',
]

const MOBILE_SESSION_DELTA_PATH = '/api/mobile.sessionDelta'
const MOBILE_SESSION_SYNC_DESCRIBE_PATH = '/api/mobile.sessionSyncDescribe'
const MOBILE_SESSION_SYNC_SNAPSHOT_PATH = '/api/mobile.sessionSyncSnapshot'

const MOBILE_SESSION_SYNC_PROTOCOL_VERSION = 2
const MOBILE_SESSION_SYNC_CAPABILITY = 'mobile-session-sync-v2'

/** RC1 v3 transport remains additive to the accepted v2 controller bridge. */
const MOBILE_SESSION_V3_BASE_PATH = '/api/mobile/v3'
const MOBILE_SESSION_V3_DESCRIBE_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/describe`
const MOBILE_SESSION_V3_SNAPSHOT_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/snapshot`
const MOBILE_SESSION_V3_DELTA_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/delta`
const MOBILE_SESSION_V3_HISTORY_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/history`
const MOBILE_SESSION_V3_EVENTS_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/events`
const MOBILE_SESSION_V3_DETAILS_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/details`
const MOBILE_EVENTS_MUX_PATH = '/api/events.mux'
const MOBILE_EVENTS_HOST_PATH = '/api/events.host'
const MOBILE_SESSION_V3_PROTOCOL_VERSION = 3
const MOBILE_SESSION_V3_CAPABILITY = 'mobile-session-sync-v3'

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_EVENTS = 512
const DEFAULT_SCAN_PAGE_MESSAGES = 24
const DEFAULT_MAX_SCAN_PAGES = 32
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_V3_MAX_EVENTS = 128
const DEFAULT_V3_MAX_BYTES = 512 * 1024
const DEFAULT_V3_MAX_INLINE_BYTES = 16 * 1024
const DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES = 64 * 1024
const DEFAULT_V3_MAX_HISTORY_PAGES = 64
const DEFAULT_V3_MAX_CACHED_EVENTS = 2048
const DEFAULT_V3_MAX_DETAIL_CACHE_BYTES = 8 * 1024 * 1024
const DEFAULT_V3_MAX_SUBSCRIBER_QUEUE = 512
const DEFAULT_V3_MAX_SUBSCRIBER_BYTES = DEFAULT_V3_MAX_BYTES
const DEFAULT_V3_MAX_SUBSCRIBER_SEEN = 4096
const DEFAULT_BACKGROUND_BOOTSTRAP_LIMIT = 2
const DEFAULT_BACKGROUND_CATALOG_INTERVAL_MS = 5e3
const DEFAULT_MAX_PENDING_GLOBAL_EVENTS = DEFAULT_V3_MAX_CACHED_EVENTS
const DEFAULT_MAX_DIAGNOSTIC_CATEGORIES = 64
const DEFAULT_SUBAGENT_CATALOG_TTL_MS = 1000
const DEFAULT_SUBAGENT_CATALOG_FAILURE_TTL_MS = 250

const DEFAULT_OPTIONS = Object.freeze({
  maxEvents: DEFAULT_MAX_EVENTS,
  scanPageMessages: DEFAULT_SCAN_PAGE_MESSAGES,
  maxScanPages: DEFAULT_MAX_SCAN_PAGES,
})

/**
 * A small schema-compatible facade keeps this source build-free. Cordis
 * callers may pass the raw object; `apply` performs the same bounded checks.
 */
const Config = Object.freeze({
  parse(value) {
    return normalizeConfig(value)
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-mobile-stream-compat-rc1',
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: errorMessage(error) }] }
      }
    },
  },
})

/** Read later events from one fixed rc1 follow snapshot and bounded pages. */
async function readSessionDelta(controllerOrContext, request, options, signal, state) {
  const effectiveSignal = signal ?? (isAbortSignal(options) ? options : undefined) ?? new AbortController().signal
  const releaseBootstrap = state?.acquireBootstrap === undefined
    ? undefined
    : await state.acquireBootstrap(effectiveSignal, request?.sessionId)
  try {
    return await readSessionDeltaCore(controllerOrContext, request, options, effectiveSignal, state)
  } finally {
    releaseBootstrap?.()
  }
}

async function readSessionDeltaCore(controllerOrContext, request, options, signal, state) {
  const controller = controllerOrContext?.sessionController ?? controllerOrContext
  if (!controller || typeof controller.follow !== 'function' || typeof controller.page !== 'function') {
    throw new TypeError('sessionController with follow and page is required')
  }

  const effectiveSignal = signal ?? (isAbortSignal(options) ? options : undefined) ?? new AbortController().signal
  const normalizedOptions = normalizeDeltaOptions(isAbortSignal(options) ? undefined : options)
  validateDeltaRequest(request, normalizedOptions.maxEvents)
  throwIfAborted(effectiveSignal)

  let address
  let opening
  try {
    address = await resolveSessionAddress(controllerOrContext, request.sessionId, state, effectiveSignal)
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
async function readSessionSyncSnapshot(first, second, third) {
  const { sessionController, workspaceController, subagents, signal, readOptions } = normalizeSnapshotArgs(first, second, third)
  if (!sessionController || typeof sessionController.list !== 'function') {
    throw new TypeError('sessionController with list is required')
  }
  if (!workspaceController || typeof workspaceController.follow !== 'function') {
    throw new TypeError('workspaceController with follow is required')
  }
  const effectiveSignal = signal ?? new AbortController().signal
  throwIfAborted(effectiveSignal)

  const snapshotId = randomUUID()
  let listed
  let workspace
  try {
    ;[listed, workspace] = await Promise.all([
      raceAbort(Promise.resolve(sessionController.list({}, effectiveSignal)), effectiveSignal),
      readWorkspaceBaseline(workspaceController, effectiveSignal),
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
    return failureResult(new Error('sessionController.list returned an invalid value'))
  }
  const watermarkIndex = readOptions?.watermarkIndex ?? (readOptions && typeof readOptions.getWatermark === 'function' ? readOptions : undefined)
  const addressSource = {
    sessionController,
    ...(subagents === undefined ? {} : { subagents }),
    ...(readOptions?.addressBook === undefined ? {} : { addressBook: readOptions.addressBook }),
  }
  const addressBook = addressBookFor(addressSource, watermarkIndex)
  addressBook?.registerSummaries(listValue.items)
  const archived = new Set(Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds : [])
  const sessions = []
  for (const summary of listValue.items) {
    if (!summary || typeof summary !== 'object' || typeof summary.sessionId !== 'string') continue
    validateLocalSessionId(summary.sessionId)
    if (archived.has(summary.sessionId)) continue
    if (watermarkIndex !== undefined || readOptions?.scheduleColdTail !== undefined) {
      const indexed = watermarkIndex?.getWatermark(summary.sessionId)
      if (indexed !== undefined && (isSafeSequence(indexed.lastSeq) || (indexed.lastSeq === -1 && indexed.confirmedEmpty === true))) {
        sessions.push({ sessionId: summary.sessionId, lastSeq: indexed.lastSeq, authoritative: true })
      } else {
        sessions.push({ sessionId: summary.sessionId, unknown: true, pending: true, authoritative: false })
        if (typeof readOptions?.scheduleColdTail === 'function') readOptions.scheduleColdTail(summary.sessionId)
        else watermarkIndex?.scheduleColdTail?.(sessionController, summary.sessionId)
      }
      continue
    }
    try {
      const address = await resolveSessionAddress(addressSource, summary.sessionId, watermarkIndex, effectiveSignal)
      const opening = await openSessionSnapshot(
        sessionController,
        address,
        1,
        effectiveSignal,
      )
      sessions.push({ sessionId: summary.sessionId, lastSeq: opening.cursor })
    } catch (error) {
      throwOrReturnCancellation(error, effectiveSignal)
      // An unreadable Session is explicitly pending.  Never publish -1 for an
      // unknown tail: -1 is reserved for an authoritative confirmed-empty log.
      sessions.push({ sessionId: summary.sessionId, unknown: true, pending: true, authoritative: false })
    }
  }

  return successResult({
    protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
    snapshotId,
    observedAt: Date.now(),
    sessions,
  })
}

/**
 * Register the RC1 v3 transport and the two legacy SSE compatibility routes.
 * No route depends on the removed apiProxy service; all reads go through the
 * injected official controllers and all HTTP calls pass the RC1 auth hook.
 */
function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('webServer is required')
  }
  const state = new MobileSessionSyncState({
    maxInlineBytes: resolved.v3MaxInlineBytes,
    maxDetailChunkBytes: resolved.v3MaxDetailChunkBytes,
    maxCachedEvents: resolved.v3MaxCachedEvents,
    maxDetailCacheBytes: resolved.v3MaxDetailCacheBytes,
    maxSubscriberQueue: resolved.v3MaxSubscriberQueue,
    maxSubscriberBytes: resolved.v3MaxSubscriberBytes,
    diagnostics: resolved.diagnostics,
  })
  state.setAddressSource({ sessionController: ctx.sessionController, subagents: ctx.subagents })
  const options = {
    ...resolved,
    // The public config keeps the v3 prefix to avoid colliding with the
    // accepted v2 limits; the shared v3 reader/converter uses these aliases.
    maxEvents: resolved.v3MaxEvents,
    maxBytes: resolved.v3MaxBytes,
    maxInlineBytes: resolved.v3MaxInlineBytes,
    maxDetailChunkBytes: resolved.v3MaxDetailChunkBytes,
    maxHistoryPages: resolved.v3MaxHistoryPages,
    maxDetailCacheBytes: resolved.v3MaxDetailCacheBytes,
    maxSubscriberQueue: resolved.v3MaxSubscriberQueue,
    maxSubscriberBytes: resolved.v3MaxSubscriberBytes,
    watermarkIndex: state,
  }
  const register = () => {
    const disposers = []
    let statusDispose = () => {}
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_DESCRIBE_PATH,
        handler: (req, res) => handleV3DescribeRequest(ctx, req, res, resolved.maxRequestBytes, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_SNAPSHOT_PATH,
        handler: (req, res) => handleV3SnapshotRequest(ctx, req, res, resolved.maxRequestBytes, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_DELTA_PATH,
        handler: (req, res) => handleV3DeltaRequest(ctx, req, res, resolved.maxRequestBytes, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_HISTORY_PATH,
        handler: (req, res) => handleV3HistoryRequest(ctx, req, res, resolved.maxRequestBytes, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_EVENTS_PATH,
        handler: (req, res) => handleV3EventsRequest(ctx, req, res, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_SESSION_V3_DETAILS_PATH,
        handler: (req, res) => handleV3DetailsRequest(ctx, req, res, resolved.maxRequestBytes, state, options),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_EVENTS_MUX_PATH,
        handler: (req, res) => handleCompatEventsRequest(ctx, req, res, state, options, 'mux'),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: MOBILE_EVENTS_HOST_PATH,
        handler: (req, res) => handleCompatEventsRequest(ctx, req, res, state, options, 'host'),
      }))
      statusDispose = installSessionStatusBridge(ctx, state)
    } catch (error) {
      try { statusDispose?.() } catch { /* preserve the registration failure */ }
      for (const dispose of disposers.reverse()) {
        try { dispose?.() } catch { /* preserve the registration failure */ }
      }
      state.dispose()
      throw error
    }
    ctx.provide('mobileSessionEvents', createMobileSessionEvents(state))
    ctx.provide('mobileSessionDiagnostics', () => state.getDiagnostics())
    const interactionSource = resolveInteractionSource(ctx, resolved)
    if (interactionSource) state.attachInteractions(interactionSource)
    state.startBackground({
      sessionController: ctx.sessionController,
      workspaceController: ctx.workspaceController,
      subagents: ctx.subagents,
      eventSource: ctx,
    }, options)
    return () => {
      try { statusDispose?.() } catch { /* preserve the first teardown */ }
      state.dispose()
      disposers.reverse().forEach(dispose => {
        try { dispose?.() } catch { /* preserve the first teardown */ }
      })
    }
  }
  return typeof ctx.effect === 'function'
    ? ctx.effect(register, 'mobile-stream-compat-rc1: v3 routes')
    : register()
}

function handleDescribeRequest(ctx, req, res, config) {
  if (!authorizeHttpRequest(ctx, req, res, config.maxResponseBytes)) return
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

async function handleDeltaRequest(ctx, req, res, config) {
  if (!authorizeHttpRequest(ctx, req, res, config.maxResponseBytes)) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content type must be application/json' }, config.maxResponseBytes)
    return
  }
  await handleJsonRequest(ctx, req, res, config, 'mobile.sessionDelta', async (message, signal) => {
    return readSessionDelta(ctx, message.payload, config, signal)
  })
}

async function handleSnapshotRequest(ctx, req, res, config) {
  if (!authorizeHttpRequest(ctx, req, res, config.maxResponseBytes)) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content type must be application/json' }, config.maxResponseBytes)
    return
  }
  await handleJsonRequest(ctx, req, res, config, 'mobile.sessionSyncSnapshot', async (_message, signal) => {
    return readSessionSyncSnapshot(ctx, signal)
  })
}

async function handleJsonRequest(ctx, req, res, config, method, operation) {
  const lifetime = createRequestLifetime(req, res, config.requestTimeoutMs)
  let rpcId = 'invalid'
  try {
    const body = await raceAbort(readBody(req, config.maxRequestBytes, lifetime.signal), lifetime.signal)
    const message = JSON.parse(body)
    rpcId = typeof message?.rpcId === 'string' && message.rpcId.length > 0 ? message.rpcId : 'invalid'
    if (message?.type !== 'client-request' || message?.method !== method) {
      sendJson(res, 400, serverFailure(rpcId, `invalid ${method} request`), config.maxResponseBytes)
      return
    }
    const result = await operation(message, lifetime.signal)
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

function authorizeHttpRequest(ctx, req, res, maxResponseBytes) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: 'forbidden' }, maxResponseBytes)
    return false
  }
  const connection = ctx.connection
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
  const v3MaxEvents = boundedInteger(value.v3MaxEvents ?? DEFAULT_V3_MAX_EVENTS, 'v3MaxEvents', 1, 4096)
  const v3MaxBytes = boundedInteger(value.v3MaxBytes ?? DEFAULT_V3_MAX_BYTES, 'v3MaxBytes', 1024, 64 * 1024 * 1024)
  const v3MaxInlineBytes = boundedInteger(value.v3MaxInlineBytes ?? DEFAULT_V3_MAX_INLINE_BYTES, 'v3MaxInlineBytes', 1, 16 * 1024 * 1024)
  const v3MaxDetailChunkBytes = boundedInteger(value.v3MaxDetailChunkBytes ?? DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES, 'v3MaxDetailChunkBytes', 1, 16 * 1024 * 1024)
  const v3MaxHistoryPages = boundedInteger(value.v3MaxHistoryPages ?? DEFAULT_V3_MAX_HISTORY_PAGES, 'v3MaxHistoryPages', 1, 4096)
  const v3MaxCachedEvents = boundedInteger(value.v3MaxCachedEvents ?? DEFAULT_V3_MAX_CACHED_EVENTS, 'v3MaxCachedEvents', 1, 1_000_000)
  const v3MaxDetailCacheBytes = boundedInteger(value.v3MaxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES, 'v3MaxDetailCacheBytes', 1024, 512 * 1024 * 1024)
  const v3MaxSubscriberQueue = boundedInteger(value.v3MaxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE, 'v3MaxSubscriberQueue', 1, 16_384)
  const v3MaxSubscriberBytes = boundedInteger(value.v3MaxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES, 'v3MaxSubscriberBytes', 1024, 64 * 1024 * 1024)
  return Object.freeze({
    maxRequestBytes,
    maxResponseBytes,
    maxEvents,
    scanPageMessages,
    maxScanPages,
    requestTimeoutMs,
    v3MaxEvents,
    v3MaxBytes,
    v3MaxInlineBytes,
    v3MaxDetailChunkBytes,
    v3MaxHistoryPages,
    v3MaxCachedEvents,
    v3MaxDetailCacheBytes,
    v3MaxSubscriberQueue,
    v3MaxSubscriberBytes,
    diagnostics: value.diagnostics === true,
    interactions: value.interactions,
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
	validateSessionAddress(address)
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
    const event = record.event
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new BaselineRecoveryError('unsupported-record')
    }
    if (!isSafeSequence(event.seq)) throw new BaselineRecoveryError('unsupported-record')
    return [{ event }]
  }
  if (record.type !== 'chunks') throw new BaselineRecoveryError('unsupported-record')
  return expandChunkRun(record.event)
}

/** Expand the exact rc1 SessionHistoryRecord chunk-row wire form. */
function expandChunkRun(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.type !== 'string' || typeof event.seq !== 'number'
      || typeof event.time !== 'number' || !event.data || typeof event.data !== 'object') {
    throw new BaselineRecoveryError('unsupported-record')
  }
  const rowType = event.type
  if (!['chunkrow/text-chunks', 'chunkrow/reasoning-chunks', 'chunkrow/tool-call-chunks'].includes(rowType)) {
    throw new BaselineRecoveryError('unsupported-record')
  }
  if (!isSafeSequence(event.seq) || !Number.isSafeInteger(event.time)) {
    throw new BaselineRecoveryError('unsupported-record')
  }
  const data = event.data
  const isTool = rowType === 'chunkrow/tool-call-chunks'
  const payload = isTool ? data.args : data.texts
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(item => typeof item !== 'string')) {
    throw new BaselineRecoveryError('unsupported-record')
  }
  if (!Array.isArray(data.dt) || data.dt.length !== payload.length - 1
      || data.dt.some(item => !Number.isSafeInteger(item))) {
    throw new BaselineRecoveryError('unsupported-record')
  }
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    throw new BaselineRecoveryError('unsupported-record')
  }
  if (isTool && typeof data.id !== 'string') throw new BaselineRecoveryError('unsupported-record')
  if (isTool && data.name !== undefined && typeof data.name !== 'string') {
    throw new BaselineRecoveryError('unsupported-record')
  }
  const entries = []
  let time = event.time
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += data.dt[index - 1]
    const seq = event.seq + index
    if (!isSafeSequence(seq) || !Number.isSafeInteger(time)) {
      throw new BaselineRecoveryError('unsupported-record')
    }
    let chunk
    if (rowType === 'chunkrow/text-chunks') {
      chunk = { type: 'text-delta', index: data.index, text: payload[index] }
    } else if (rowType === 'chunkrow/reasoning-chunks') {
      chunk = { type: 'reasoning-delta', index: data.index, text: payload[index] }
    } else {
      chunk = {
        type: 'tool-call-delta',
        index: data.index,
        id: data.id,
        ...(data.name === undefined ? {} : { name: data.name }),
        argumentsDelta: payload[index],
      }
    }
    entries.push({
      event: {
        type: 'assistant/chunk',
        seq,
        time,
        data: { turn: data.turn, step: data.step, chunk },
      },
    })
  }
  return entries
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
	if (first?.sessionController && first?.workspaceController) {
		if (isAbortSignal(second)) return { sessionController: first.sessionController, workspaceController: first.workspaceController, subagents: first.subagents, signal: second, readOptions: undefined }
		return { sessionController: first.sessionController, workspaceController: first.workspaceController, subagents: first.subagents, signal: third, readOptions: second }
	}
	if (second?.watermarkIndex || second?.scheduleColdTail) return { sessionController: first?.sessionController ?? first, workspaceController: first?.workspaceController, subagents: first?.subagents, signal: third, readOptions: second }
	return { sessionController: first, workspaceController: second, subagents: undefined, signal: third, readOptions: undefined }
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
	'unavailable',
	'use subagent delivery for this child session',
])
const SAFE_CATALOG_DIAGNOSTIC_REASONS = new Set(['corrupt', 'unsupported', 'unavailable'])

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
  const address = typeof req === 'string'
    ? req
    : req?.socket?.remoteAddress ?? req?.remoteAddress
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
  const input = Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    input.then(value => {
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
    if (signal.aborted) onAbort()
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

function validateSessionAddress(address) {
	if (!address || typeof address !== 'object' || Array.isArray(address)) throw new TypeError('address must be an object')
	if (address.kind === 'session') {
		validateLocalSessionId(address.sessionId)
		return
	}
	if (address.kind === 'subagent') {
		validateLocalSessionId(address.parentSessionId)
		validateLocalSessionId(address.childSessionId)
		if (address.mode !== 'one-shot' && address.mode !== 'continuable') throw new TypeError('subagent mode is invalid')
		return
	}
	throw new TypeError('address kind is invalid')
}

/**
 * Resolve a listed Session to the address accepted by the official RC1
 * Session Controller. Child Sessions require their durable parent and the
 * mode published by the official subagent catalog.
 */
class SessionAddressBook {
	constructor(source = {}) {
		this.sessionController = source.sessionController
		this.subagents = source.subagents
		this.summaries = new Map()
		this.catalogs = new Map()
		this.catalogExpiresAt = new Map()
		this.catalogFailures = new Map()
		this.catalogLoads = new Map()
		this.listLoad = undefined
	}

	invalidateCatalog(parentSessionId) {
		this.catalogs.delete(parentSessionId)
		this.catalogExpiresAt.delete(parentSessionId)
		this.catalogFailures.delete(parentSessionId)
	}

	registerSummaries(items) {
		if (!Array.isArray(items)) return
		for (const summary of items) {
			const sessionId = boundedString(summary?.sessionId, 4096)
			if (sessionId === undefined || sessionId.length === 0 || sessionId.startsWith('rh1.')) continue
			const origin = summary?.origin === 'subagent' ? 'subagent' : 'session'
			const parentSessionId = origin === 'subagent' ? boundedString(summary?.parentSessionId, 4096) : undefined
			const previous = this.summaries.get(sessionId)
			if (previous?.origin !== origin || previous?.parentSessionId !== parentSessionId) {
				if (previous?.parentSessionId !== undefined) this.invalidateCatalog(previous.parentSessionId)
				if (parentSessionId !== undefined) this.invalidateCatalog(parentSessionId)
			}
			this.summaries.set(sessionId, { sessionId, origin, ...(parentSessionId === undefined ? {} : { parentSessionId }) })
		}
	}

	async refresh(signal) {
		if (typeof this.sessionController?.list !== 'function') return
		if (this.listLoad === undefined) {
			const sharedSignal = new AbortController().signal
			this.listLoad = Promise.resolve(this.sessionController.list({}, sharedSignal))
				.then((raw) => unwrapControllerValue(raw))
				.then((value) => {
					if (!value || !Array.isArray(value.items)) throw new SubagentAddressError('corrupt')
					this.registerSummaries(value.items)
					return value
				})
				.finally(() => { this.listLoad = undefined })
		}
		await raceAbort(this.listLoad, signal)
	}

	async catalog(parentSessionId, signal) {
		if (this.catalogs.has(parentSessionId) && (this.catalogExpiresAt.get(parentSessionId) ?? 0) > Date.now()) {
			return this.catalogs.get(parentSessionId)
		}
		if (typeof this.subagents?.remoteExportList !== 'function') throw new SubagentAddressError('unavailable')
		const cachedFailure = this.catalogFailures.get(parentSessionId)
		if (cachedFailure !== undefined) {
			if (cachedFailure.expiresAt > Date.now()) throw cachedFailure.error
			this.catalogFailures.delete(parentSessionId)
		}
		let load = this.catalogLoads.get(parentSessionId)
		if (load === undefined) {
			const sharedSignal = new AbortController().signal
			load = Promise.resolve(this.subagents.remoteExportList(parentSessionId, sharedSignal))
				.then((raw) => unwrapControllerValue(raw))
				.then((value) => {
					if (!value || !Array.isArray(value.entries) || typeof value.parentAvailable !== 'boolean') {
						throw new SubagentAddressError('corrupt')
					}
					this.catalogs.set(parentSessionId, value)
					this.catalogFailures.delete(parentSessionId)
					this.catalogExpiresAt.set(parentSessionId, Date.now() + DEFAULT_SUBAGENT_CATALOG_TTL_MS)
					return value
				})
				.catch((error) => {
					if (error?.code === 'subagent/catalog-diagnostic' && error?.details?.reason === 'corrupt') {
						this.catalogFailures.set(parentSessionId, {
							error,
							expiresAt: Date.now() + DEFAULT_SUBAGENT_CATALOG_FAILURE_TTL_MS,
						})
					}
					throw error
				})
				.finally(() => {
					if (this.catalogLoads.get(parentSessionId) === load) this.catalogLoads.delete(parentSessionId)
				})
			this.catalogLoads.set(parentSessionId, load)
		}
		return raceAbort(load, signal)
	}

	async resolve(sessionId, signal) {
		validateLocalSessionId(sessionId)
		let summary = this.summaries.get(sessionId)
		if (summary === undefined) {
			await this.refresh(signal)
			summary = this.summaries.get(sessionId)
		}
		if (summary?.origin !== 'subagent') return { kind: 'session', sessionId }
		const parentSessionId = summary.parentSessionId
		if (parentSessionId === undefined || parentSessionId.length === 0 || parentSessionId.startsWith('rh1.')) {
			throw new SubagentAddressError('corrupt')
		}
		const catalog = await this.catalog(parentSessionId, signal)
		const entry = catalog.entries.find((candidate) => candidate?.id === sessionId)
		if (entry?.kind === 'diagnostic') {
			const reason = SAFE_CATALOG_DIAGNOSTIC_REASONS.has(entry.reason) ? entry.reason : 'unavailable'
			throw new SubagentAddressError(reason)
		}
		if (entry?.kind !== 'child' || (entry.mode !== 'one-shot' && entry.mode !== 'continuable')) {
			// Keep a valid negative catalog for its short TTL. The next request
			// then reuses the bounded diagnostic instead of refetching per child;
			// expiry or a changed session summary invalidates it naturally.
			throw new SubagentAddressError('unavailable')
		}
		return { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: entry.mode }
	}
}

class SubagentAddressError extends Error {
	constructor(reason) {
		super(`subagent address unavailable: ${reason}`)
		this.name = 'SubagentAddressError'
		this.code = 'subagent/catalog-diagnostic'
		this.details = { reason }
	}
}

function addressBookFor(controllerOrContext, state) {
	const context = controllerOrContext && typeof controllerOrContext === 'object' ? controllerOrContext : {}
	if (state?.addressBook !== undefined) return state.addressBook
	const addressBook = ownDataProperty(context, 'addressBook')
	if (addressBook !== undefined && typeof addressBook.resolve === 'function') return addressBook
	const hasContext = context.sessionController !== undefined || context.subagents !== undefined
	if (!hasContext) return undefined
	const controller = context.sessionController ?? controllerOrContext
	const subagents = context.subagents
	if (controller === undefined && subagents === undefined) return undefined
	return new SessionAddressBook({ sessionController: controller, subagents })
}

function ownDataProperty(source, key) {
	if (source === null || (typeof source !== 'object' && typeof source !== 'function')) return undefined
	const descriptor = Object.getOwnPropertyDescriptor(source, key)
	return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

async function resolveSessionAddress(controllerOrContext, sessionId, state, signal) {
	const book = addressBookFor(controllerOrContext, state)
	if (book === undefined) return { kind: 'session', sessionId }
	return book.resolve(sessionId, signal)
}

/**
* Process-local authority/cache for the plugin. It intentionally observes the
* existing mux instead of adding a core API. `session/subscribed.lastSeq` and
* `session/event.seq` are the only live-tail sources; projection frames never
* advance this index.
*/
var MobileSessionSyncState = class {
	watermarks = /* @__PURE__ */ new Map();
	events = /* @__PURE__ */ new Map();
	details = /* @__PURE__ */ new Map();
	detailOrder = [];
	detailBytes = 0;
	interactionOrigins = /* @__PURE__ */ new Map();
	pendingControls = /* @__PURE__ */ new Map();
	subscribers = /* @__PURE__ */ new Set();
	coldPending = /* @__PURE__ */ new Set();
	coldQueue = [];
	options;
	muxAbort;
	detailLoader;
	coldRunning = false;
	muxRunning = false;
	backgroundAbort;
	backgroundRunning = false;
	backgroundTasks = /* @__PURE__ */ new Set();
	bootstrapQueue = [];
	bootstrapSessions = new Map();
	activeBootstrap = 0;
	maxBootstrap = 0;
	bootstrapTotal = 0;
	catalogCalls = 0;
	catalogLoad;
	diagnosticsEnabled = false;
	backgroundBootstrapLimit = DEFAULT_BACKGROUND_BOOTSTRAP_LIMIT;
	globalEventUnsubscribers = [];
	globalEventsRunning = false;
	workspaceBaselineKnown = true;
	pendingGlobalEvents = [];
	globalBaselineRequired;
	errorCounts = new Map();
	interactionSource;
	interactionUnsubscribe;
	interactionFrames = /* @__PURE__ */ new Map();
	archivedSessions = /* @__PURE__ */ new Set();
	addressBook;
	workspaceBaselineReady;
	workspaceBaselineResolve;
	constructor(options = {}) {
		this.options = {
			maxInlineBytes: options.maxInlineBytes ?? DEFAULT_V3_MAX_INLINE_BYTES,
			maxDetailChunkBytes: options.maxDetailChunkBytes ?? DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES,
			maxCachedEvents: options.maxCachedEvents ?? DEFAULT_V3_MAX_CACHED_EVENTS,
			maxDetailCacheBytes: options.maxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES,
			maxSubscriberQueue: options.maxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE,
			maxSubscriberBytes: options.maxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES,
			maxSubscriberSeen: options.maxSubscriberSeen ?? DEFAULT_V3_MAX_SUBSCRIBER_SEEN,
			maxPendingGlobalEvents: Number.isSafeInteger(options.maxPendingGlobalEvents) && options.maxPendingGlobalEvents > 0
				? options.maxPendingGlobalEvents
				: DEFAULT_MAX_PENDING_GLOBAL_EVENTS,
		};
		this.diagnosticsEnabled = options.diagnostics === true;
	}
	getDiagnostics() {
		if (!this.diagnosticsEnabled) return undefined;
		const errorCounts = {};
		for (const [category, count] of this.errorCounts) errorCounts[category] = count;
		return {
			clientCount: this.subscribers.size,
			activeBootstrap: this.activeBootstrap,
			maxBootstrap: this.maxBootstrap,
			bootstrapTotal: this.bootstrapTotal,
			catalogCalls: this.catalogCalls,
			errorCounts,
		};
	}
	recordError(kind) {
		const candidate = boundedString(kind, 96) ?? "stream-error";
		const category = /^[A-Za-z0-9._:/-]+$/.test(candidate) ? candidate : "other";
		if (this.errorCounts.has(category) || this.errorCounts.size < DEFAULT_MAX_DIAGNOSTIC_CATEGORIES) {
			this.errorCounts.set(category, (this.errorCounts.get(category) ?? 0) + 1);
			return;
		}
		this.errorCounts.set("other", (this.errorCounts.get("other") ?? 0) + 1);
	}
	recordCatalogCall() {
		this.catalogCalls += 1;
	}
	loadSessionCatalog(sessionController, signal) {
		if (this.catalogLoad === undefined) {
			this.recordCatalogCall();
			const sharedSignal = AbortSignal.any([this.backgroundAbort?.signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
			this.catalogLoad = raceAbort(Promise.resolve().then(() => sessionController.list({}, sharedSignal)), sharedSignal)
				.then((raw) => unwrapControllerValue(raw))
				.finally(() => { this.catalogLoad = undefined; });
		}
		return raceAbort(this.catalogLoad, signal);
	}
	acquireBootstrap(signal, sessionId) {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('operation aborted'));
		const key = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
		const sessionState = key === undefined ? undefined : this.bootstrapSessions.get(key) ?? { active: false };
		if (key !== undefined && this.bootstrapSessions.get(key) === undefined) this.bootstrapSessions.set(key, sessionState);
		if (this.activeBootstrap < this.backgroundBootstrapLimit && (sessionState === undefined || !sessionState.active)) return Promise.resolve(this.grantBootstrap(key, sessionState));
		return new Promise((resolve, reject) => {
			const waiter = { signal, sessionId: key, resolve, reject };
			const onAbort = () => {
				const index = this.bootstrapQueue.indexOf(waiter);
				if (index >= 0) this.bootstrapQueue.splice(index, 1);
				signal?.removeEventListener('abort', onAbort);
				reject(signal.reason ?? new Error('operation aborted'));
			};
			waiter.onAbort = onAbort;
			this.bootstrapQueue.push(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}
	grantBootstrap(sessionId, sessionState) {
		if (sessionState !== undefined) sessionState.active = true;
		this.activeBootstrap += 1;
		this.maxBootstrap = Math.max(this.maxBootstrap, this.activeBootstrap);
		this.bootstrapTotal += 1;
		return this.createBootstrapRelease(sessionId, sessionState);
	}
	createBootstrapRelease(sessionId, sessionState) {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (sessionState !== undefined) sessionState.active = false;
			this.activeBootstrap = Math.max(0, this.activeBootstrap - 1);
			this.drainBootstrapQueue();
			if (sessionId !== undefined && sessionState !== undefined && !sessionState.active
				&& !this.bootstrapQueue.some((waiter) => waiter.sessionId === sessionId)) this.bootstrapSessions.delete(sessionId);
		};
	}
	drainBootstrapQueue() {
		while (this.activeBootstrap < this.backgroundBootstrapLimit && this.bootstrapQueue.length > 0) {
			let index = -1;
			for (let candidate = 0; candidate < this.bootstrapQueue.length; candidate += 1) {
				const waiter = this.bootstrapQueue[candidate];
				const sessionState = waiter.sessionId === undefined ? undefined : this.bootstrapSessions.get(waiter.sessionId);
				if (sessionState === undefined || !sessionState.active) { index = candidate; break; }
			}
			if (index < 0) break;
			const waiter = this.bootstrapQueue.splice(index, 1)[0];
			waiter.signal?.removeEventListener('abort', waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(waiter.signal.reason ?? new Error('operation aborted'));
				continue;
			}
			const sessionState = waiter.sessionId === undefined ? undefined : this.bootstrapSessions.get(waiter.sessionId) ?? { active: false };
			if (waiter.sessionId !== undefined && this.bootstrapSessions.get(waiter.sessionId) === undefined) this.bootstrapSessions.set(waiter.sessionId, sessionState);
			waiter.resolve(this.grantBootstrap(waiter.sessionId, sessionState));
		}
	}
	installGlobalSessionBridge(source, options) {
		const on = source && typeof source.on === "function" ? source.on.bind(source) : undefined;
		if (on === undefined) return false;
		const disposers = [];
		// No failure here may fall back to full-history follows for every Session.
		try {
			const eventDispose = on("session/event", (session, event) => {
				try {
					this.ingestGlobalSessionEvent(session, event, options);
				} catch (error) {
					if (!this.backgroundAbort?.signal.aborted) this.emitStreamError("session-event", error, this.globalSessionId(session, event));
				}
			}, { global: true });
			if (typeof eventDispose === "function") disposers.push(eventDispose);
			const createdDispose = on("session/created", (session) => {
				try {
					this.ingestGlobalSessionCreated(session, options);
				} catch (error) {
					if (!this.backgroundAbort?.signal.aborted) this.emitStreamError("session-created", error, this.globalSessionId(session));
				}
			}, { global: true });
			if (typeof createdDispose === "function") disposers.push(createdDispose);
			this.globalEventUnsubscribers = disposers;
			this.globalEventsRunning = true;
			return true;
		} catch (error) {
			for (const dispose of disposers.reverse()) {
				try { dispose(); } catch { /* preserve the bridge installation failure */ }
			}
			this.globalEventUnsubscribers = [];
			this.globalEventsRunning = false;
			this.emitStreamError("session-events", error);
			return false;
		}
	}
	globalSessionId(session, event) {
		const sessionValue = asRecord(session);
		const eventValue = asRecord(event);
		const header = asRecord(sessionValue?.header);
		return boundedString(
			eventValue?.sessionId
				?? sessionValue?.sessionId
				?? sessionValue?.id
				?? header?.sessionId
				?? header?.id
				?? (typeof session === "string" ? session : undefined),
			4096,
		);
	}
	globalEventValue(event) {
		const value = asRecord(event);
		if (value?.type === "event" && asRecord(value.event) !== undefined) return value.event;
		return value;
	}
	ingestGlobalSessionEvent(session, event, options) {
		const sessionId = this.globalSessionId(session, event);
		const value = this.globalEventValue(event);
		if (sessionId === undefined || sessionId.startsWith("rh1.") || value === undefined) return;
		if (this.archivedSessions.has(sessionId)) return;
		const seq = value.seq;
		if (!isSafeSequence(seq)) {
			this.emitStreamError("unknown-sequence", new Error("global session event sequence is unknown"), sessionId);
			return;
		}
		const item = { sessionId, event: value, options };
		if (!this.workspaceBaselineKnown) {
			this.queuePendingGlobalEvent(item);
			return;
		}
		this.applyGlobalSessionEvent(item);
	}
	applyGlobalSessionEvent(item) {
		const { sessionId, event, options } = item;
		if (this.archivedSessions.has(sessionId)) return;
		if (this.events.get(sessionId)?.has(event.seq)) return;
		let converted;
		try {
			converted = convertMobileHistoryEntry({ event }, sessionId, this, options);
		} catch (error) {
			this.emitStreamError("session-event", error, sessionId);
			return;
		}
		this.rememberEvent(converted);
		this.emit(converted);
		this.updateWatermark(sessionId, event.seq, "mux");
	}
	ingestGlobalSessionCreated(session, options) {
		const sessionId = this.globalSessionId(session);
		if (sessionId === undefined || sessionId.startsWith("rh1.")) return;
		if (this.archivedSessions.has(sessionId)) return;
		const sessionValue = asRecord(session);
		if (typeof session?.snapshotEvents !== "function") return;
		const knownCursor = this.getWatermark(sessionId)?.lastSeq;
		const firstLiveSeq = [sessionValue?.firstLiveSeq]
			.find((candidate) => isSafeSequence(candidate));
		const startSeq = knownCursor === undefined ? firstLiveSeq : knownCursor + 1;
		if (!Number.isSafeInteger(startSeq) || startSeq < 0) return;
		const snapshotEvents = session.snapshotEvents(startSeq);
		if (!Array.isArray(snapshotEvents)) throw new TypeError("session.snapshotEvents must return an array");
		for (const candidate of snapshotEvents) this.ingestGlobalSnapshotCandidate(sessionId, candidate, options, startSeq);
	}
	ingestGlobalSnapshotCandidate(sessionId, candidate, options, startSeq) {
		const record = asRecord(candidate);
		if (record === undefined) return;
		if (record.type === "chunks") {
			try {
				for (const entry of decodeHistoryRecords([record], Number.MAX_SAFE_INTEGER)) {
					if (entry.event.seq >= startSeq) this.ingestGlobalSessionEvent(sessionId, entry.event, options);
				}
			} catch (error) {
				this.emitStreamError(error instanceof BaselineRecoveryError ? error.reason : "session-created", error, sessionId);
			}
			return;
		}
		const event = this.globalEventValue(record);
		if (!isSafeSequence(event?.seq) || event.seq < startSeq) return;
		this.ingestGlobalSessionEvent(sessionId, event, options);
	}
	queuePendingGlobalEvent(item) {
		if (this.pendingGlobalEvents.length >= this.options.maxPendingGlobalEvents) {
			this.pendingGlobalEvents.shift();
			if (this.globalBaselineRequired === undefined) {
				this.globalBaselineRequired = "global-event-buffer-overflow";
				this.recordError("global-event-buffer-overflow");
				this.emit({ sessionId: "", time: Date.now(), type: "control/baseline-required", body: { reason: this.globalBaselineRequired } });
			}
		}
		this.pendingGlobalEvents.push(item);
	}
	flushPendingGlobalEvents() {
		const pending = this.pendingGlobalEvents;
		this.pendingGlobalEvents = [];
		for (const item of pending) {
			if (item.cursorOnly) this.updateWatermark(item.sessionId, item.event.seq, "mux");
			else this.applyGlobalSessionEvent(item);
		}
	}
	setAddressSource(source) {
		const addressBook = ownDataProperty(source, 'addressBook')
		if (addressBook !== undefined && typeof addressBook.resolve === "function") {
			this.addressBook = addressBook;
			return this.addressBook;
		}
		if (source !== undefined) this.addressBook = new SessionAddressBook(source);
		return this.addressBook;
	}
	registerSessionSummaries(items) {
		this.addressBook?.registerSummaries(items);
	}
	async resolveSessionAddress(sessionId, signal) {
		return resolveSessionAddress({ addressBook: this.addressBook }, sessionId, this, signal);
	}
	getWatermark(sessionId) {
		return this.watermarks.get(sessionId);
	}
	replaceArchivedSessions(value) {
		this.archivedSessions = new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
	}
	/** The conversion layer uses this bound to keep normal event bodies small. */
	get maxInlineBytes() {
		return this.options.maxInlineBytes;
	}
	get maxDetailChunkBytes() {
		return this.options.maxDetailChunkBytes;
	}
	get maxDetailCacheBytes() {
		return this.options.maxDetailCacheBytes;
	}
	/** Install the bounded history reloader used when an oversized detail was evicted. */
	setDetailLoader(loader) {
		this.detailLoader = loader;
	}
	updateWatermark(sessionId, lastSeq, source) {
		if ((!Number.isSafeInteger(lastSeq) && lastSeq !== -1) || lastSeq < -1 || Object.is(lastSeq, -0)) return;
		const previous = this.watermarks.get(sessionId);
		if (previous !== void 0 && lastSeq < previous.lastSeq) return;
		if (previous?.source === "mux" && source === "history" && lastSeq === previous.lastSeq) return;
		this.watermarks.set(sessionId, {
			lastSeq,
			source,
			confirmedEmpty: lastSeq === -1
		});
	}
	putDetail(sessionId, seq, field, text, contentType = "text/plain") {
		const ref = {
			seq,
			version: 1,
			field
		};
		const key = detailKey(sessionId, ref);
		const totalBytes = Buffer.byteLength(text, "utf8");
		const previous = this.details.get(key);
		if (previous?.text !== void 0) this.detailBytes -= previous.totalBytes;
		if (!this.details.has(key)) this.detailOrder.push(key);
		this.details.set(key, {
			...totalBytes <= this.options.maxDetailCacheBytes ? { text } : {},
			contentType,
			totalBytes
		});
		if (totalBytes <= this.options.maxDetailCacheBytes) this.detailBytes += totalBytes;
		const maximumEntries = this.options.maxCachedEvents * 4;
		while (this.detailOrder.length > maximumEntries || this.detailBytes > this.options.maxDetailCacheBytes) {
			const oldest = this.detailOrder.shift();
			if (oldest !== void 0) {
				const evicted = this.details.get(oldest);
				if (evicted?.text !== void 0) this.detailBytes -= evicted.totalBytes;
				this.details.delete(oldest);
			}
		}
		return ref;
	}
	readDetail(sessionId, ref) {
		return this.details.get(detailKey(sessionId, ref));
	}
	async resolveDetail(sessionId, ref, signal) {
		const cached = this.readDetail(sessionId, ref);
		if (cached?.text !== void 0) return cached;
		if (this.detailLoader === void 0) return cached;
		return this.detailLoader(sessionId, ref, signal);
	}
	/** Index a durable approval ask; question requests have no durable core event. */
	noteInteractionOrigin(sessionId, kind, interactionId, seq) {
		if (!Number.isInteger(seq) || seq < 0 || interactionId.length === 0) return;
		let byId = this.interactionOrigins.get(sessionId);
		if (byId === void 0) this.interactionOrigins.set(sessionId, byId = /* @__PURE__ */ new Map());
		const key = `${kind}:${interactionId}`;
		if (!byId.has(key)) byId.set(key, seq);
	}
	getInteractionOrigin(sessionId, kind, interactionId) {
		return this.interactionOrigins.get(sessionId)?.get(`${kind}:${interactionId}`);
	}
	/** Cache a converted history event for replay to a newly opened v3 stream. */
	rememberConvertedEvent(event) {
		this.rememberEvent(event);
	}
	cachedEvents(sessionId) {
		const entries = [];
		const maps = sessionId === void 0 ? [...this.events.entries()] : [[sessionId, this.events.get(sessionId)]];
		for (const [id, map] of maps) {
			if (map === void 0) continue;
			for (const event of map.values()) entries.push({
				...event,
				...event.sessionId === void 0 ? { sessionId: id } : {}
			});
		}
		return entries.sort((left, right) => {
			const sessionOrder = (left.sessionId ?? "").localeCompare(right.sessionId ?? "");
			if (sessionOrder !== 0) return sessionOrder;
			return (left.seq ?? -1) - (right.seq ?? -1) || left.time - right.time;
		});
	}
	/**
	 * Start the controller-backed background synchronizer.  The process-wide
	 * event seam carries live Session events; the catalog only maintains
	 * summaries and never opens a full-history follow per Session.
	 * `startMux` remains an alias for callers compiled against the v3 preview.
	 */
	startBackground(source, options = {}) {
		if (this.backgroundRunning) return;
		const hasControllers = source !== null && typeof source === "object" && source.sessionController !== void 0;
		const sessionController = hasControllers ? source.sessionController : source;
		const workspaceController = hasControllers ? source.workspaceController : void 0;
		const eventSource = hasControllers ? source.eventSource : undefined;
		if (!sessionController && !(eventSource && typeof eventSource.on === "function")) return;
		this.setAddressSource(hasControllers ? source : { sessionController });
		const controller = new AbortController();
		this.backgroundAbort = controller;
		this.muxAbort = controller;
		this.backgroundRunning = true;
		this.muxRunning = true;
		this.workspaceBaselineReady = workspaceController && typeof workspaceController.follow === "function"
			? new Promise((resolve) => { this.workspaceBaselineResolve = resolve; })
			: Promise.resolve();
		this.workspaceBaselineKnown = !(workspaceController && typeof workspaceController.follow === "function");
		const mergedOptions = {
			...defaultV3Options(this),
			...options,
			scanPageMessages: options.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES,
			maxHistoryPages: options.maxHistoryPages ?? DEFAULT_V3_MAX_HISTORY_PAGES
		};
		this.installGlobalSessionBridge(eventSource, mergedOptions);
		installDetailLoader({ sessionController, addressBook: this.addressBook }, this, mergedOptions);
		const jobs = [
			this.runSessionCatalog(sessionController, workspaceController, controller, mergedOptions),
			this.runSessionControl(sessionController, controller, mergedOptions)
		];
		if (workspaceController && typeof workspaceController.follow === "function") {
			jobs.push(this.runWorkspaceCatalog(sessionController, workspaceController, controller, mergedOptions));
		}
		for (const job of jobs) {
			this.backgroundTasks.add(job);
			Promise.resolve(job).catch(() => {}).finally(() => this.backgroundTasks.delete(job));
		}
	}
	startMux(source, options = {}) {
		this.startBackground(source, options);
	}
	async runSessionCatalog(sessionController, workspaceController, controller, options) {
		let backoff = DEFAULT_BACKGROUND_CATALOG_INTERVAL_MS;
		if (workspaceController && this.workspaceBaselineReady) {
			await Promise.race([this.workspaceBaselineReady, waitWithAbort(2e3, controller.signal)]);
		}
		while (!controller.signal.aborted) {
			try {
				if (typeof sessionController?.list === "function") {
					const raw = await this.loadSessionCatalog(sessionController, controller.signal);
					const listed = unwrapControllerValue(raw);
					if (Array.isArray(listed?.items)) {
						this.registerSessionSummaries(listed.items);
					}
				}
				backoff = DEFAULT_BACKGROUND_CATALOG_INTERVAL_MS;
			} catch (error) {
				if (controller.signal.aborted) return;
				this.emitStreamError("session-catalog", error);
			}
			if (!await waitWithAbort(Math.min(backoff, 5e3), controller.signal)) return;
			backoff = Math.min(backoff * 2, 5e3);
		}
	}
	runWorkspaceCatalog(sessionController, workspaceController, controller, options) {
		return this.consumeWorkspaceCatalog(sessionController, workspaceController, controller, options);
	}
	async consumeWorkspaceCatalog(sessionController, workspaceController, controller, options) {
		let backoff = 100;
		while (!controller.signal.aborted) {
			try {
				const iterator = await toAsyncIterator(workspaceController.follow(controller.signal));
				try {
					for await (const frame of { [Symbol.asyncIterator]: () => iterator }) {
						if (controller.signal.aborted) return;
						const value = frame?.type === "baseline" ? frame.value : frame;
						if (value?.archivedSessionIds && Array.isArray(value.archivedSessionIds)) {
							this.replaceArchivedSessions(value.archivedSessionIds);
							this.workspaceBaselineKnown = true;
							this.flushPendingGlobalEvents();
							this.workspaceBaselineResolve?.();
							this.workspaceBaselineResolve = void 0;
							this.emit({ sessionId: "", time: Date.now(), type: "control/workspace-baseline", body: { archivedSessionIds: [...this.archivedSessions] }, hostFrame: frame });
							this.refreshSessionSummariesFromList(sessionController, controller);
						} else if (frame?.type === "archived" && Array.isArray(frame.archivedSessionIds)) {
							this.replaceArchivedSessions(frame.archivedSessionIds);
							this.emit({ sessionId: "", time: Date.now(), type: "control/workspace-archived", body: { archivedSessionIds: [...this.archivedSessions] }, hostFrame: frame });
							this.refreshSessionSummariesFromList(sessionController, controller);
						} else if (frame?.type === "upsert" || frame?.type === "remove" || frame?.type === "order") {
							this.emit({ sessionId: "", time: Date.now(), type: "control/workspace-update", body: { type: frame.type }, hostFrame: frame });
						}
					}
				} finally { await closeIterator(iterator, controller.signal); }
				if (controller.signal.aborted) return;
				this.workspaceBaselineResolve?.();
				this.workspaceBaselineResolve = void 0;
				this.emitStreamError("workspace-ended");
			} catch (error) {
				if (controller.signal.aborted) return;
				this.emitStreamError("workspace-follow", error);
			}
			if (!await waitWithAbort(backoff, controller.signal)) return;
			backoff = Math.min(backoff * 2, 5e3);
		}
	}
	refreshSessionSummariesFromList(sessionController, controller) {
		if (typeof sessionController?.list !== "function") return;
		this.loadSessionCatalog(sessionController, controller.signal).then((raw) => {
			const listed = unwrapControllerValue(raw);
			this.registerSessionSummaries(listed?.items);
		}).catch((error) => { if (!controller.signal.aborted) this.emitStreamError("session-catalog", error); });
	}
	ingestHistoryEntry(entry, sessionId, options) {
		const event = convertMobileHistoryEntry(entry, sessionId, this, options);
		this.rememberEvent(event);
		this.emit(event);
	}
	ingestSessionStatus(sessionId, running) {
		const id = boundedString(sessionId, 4096);
		if (id === void 0 || id.length === 0 || id !== sessionId || id.startsWith("rh1.") || typeof running !== "boolean") {
			this.emitStreamError("invalid-session-status");
			return;
		}
		this.emit({
			sessionId: id,
			time: Date.now(),
			type: "control/session-status",
			body: { running },
			hostFrame: { type: "api-session/status", sessionId: id, running }
		});
	}
	async runSessionControl(sessionController, controller, options) {
		if (typeof sessionController.control !== "function") return;
		let backoff = 100;
		while (!controller.signal.aborted) {
			try {
				const iterator = await toAsyncIterator(sessionController.control(controller.signal));
				try {
					for await (const frame of { [Symbol.asyncIterator]: () => iterator }) {
						if (controller.signal.aborted) return;
						this.ingestControlFrame(frame, options);
					}
				} finally { await closeIterator(iterator, controller.signal); }
				if (controller.signal.aborted) return;
				this.emitStreamError("session-control-ended");
				backoff = 100;
			} catch (error) {
				if (controller.signal.aborted) return;
				this.emitStreamError("session-control", error);
			}
			if (!await waitWithAbort(backoff, controller.signal)) return;
			backoff = Math.min(backoff * 2, 5e3);
		}
	}
	ingestControlFrame(frame, options) {
		const value = frame?.value ?? frame;
		const type = stringValue(frame?.type);
		if (type === "baseline") {
			const queues = asRecord(value?.queues);
			for (const [sessionId, items] of Object.entries(queues ?? {})) this.emit(convertMobileMuxFrame({ type: "session/queue", sessionId, items }, this, options));
			const jobs = asRecord(value?.jobs);
			for (const [sessionId, entries] of Object.entries(jobs ?? {})) this.emit(convertMobileMuxFrame({ type: "session/jobs", sessionId, jobs: entries }, this, options));
			const projections = asRecord(value?.projections);
			for (const [sessionId, block] of Object.entries(projections ?? {})) {
				const normalized = normalizeMobileProjectionBlock(block);
				if (normalized === void 0) {
					this.emitStreamError("invalid-control-projection", void 0, sessionId);
					continue;
				}
				for (const [key, item] of Object.entries(normalized.values)) {
					this.emit(convertMobileMuxFrame({ type: "session/projection", sessionId, key, value: item, seq: normalized.asOfSeq }, this, options));
				}
			}
			return;
		}
		if (type === "queue" || type === "jobs") {
			const sessionId = boundedString(frame.sessionId, 4096);
			if (sessionId) this.emit(convertMobileMuxFrame({ type: `session/${type}`, sessionId, items: frame.items ?? frame.jobs, jobs: frame.jobs }, this, options));
			return;
		}
		if (type === "projection") {
			const sessionId = boundedString(frame.sessionId, 4096);
			if (sessionId) {
				const converted = convertMobileMuxFrame({
					type: "session/projection",
					sessionId,
					key: frame.key,
					value: frame.value,
					seq: frame.seq
				}, this, options);
				if (converted === void 0) this.emitStreamError("invalid-control-projection", void 0, sessionId);
				else this.emit(converted);
			}
			return;
		}
		if (type !== void 0) this.emitStreamError("unknown-control-frame");
	}
	emitStreamError(kind, error, sessionId = "") {
		const failureKind = boundedString(kind, 96) ?? "stream-error";
		this.recordError(failureKind);
		this.emit({ sessionId, time: Date.now(), type: "control/stream-error", body: { failureKind, action: sessionId === "" ? "reconnect" : "retry-session", ...failureCategory(error) === void 0 ? {} : { source: failureCategory(error) } } });
	}
	/** Attach Root's interaction bridge; only its explicit current snapshot is used. */
	attachInteractions(source) {
		if (!source || (typeof source.subscribe !== "function" && typeof source.snapshot !== "function")) return () => {};
		if (this.interactionSource === source) return this.interactionUnsubscribe ?? (() => {});
		this.interactionUnsubscribe?.();
		this.interactionSource = source;
		const applySnapshot = (frames) => {
			if (!Array.isArray(frames)) return;
			for (const frame of frames) this.ingestInteractionFrame(frame, false);
		};
		try {
			const snapshot = typeof source.snapshot === "function" ? source.snapshot() : [];
			if (snapshot && typeof snapshot.then === "function") snapshot.then(applySnapshot).catch(() => {});
			else applySnapshot(snapshot);
		} catch {
			this.emitStreamError("interaction-snapshot");
		}
		if (typeof source.subscribe === "function") {
			try {
				const unsubscribe = source.subscribe((frame) => this.ingestInteractionFrame(frame, true));
				this.interactionUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : undefined;
			} catch {
				this.emitStreamError("interaction-subscribe");
			}
		}
		return this.interactionUnsubscribe ?? (() => {});
	}
	bindInteractions(source) { return this.attachInteractions(source); }
	/** Return only explicitly pending bridge requests, never historical asks. */
	pendingServerRequests() { return [...this.interactionFrames.values()].map((frame) => cloneJson(frame)).filter(Boolean); }
	snapshot() { return this.pendingServerRequests(); }
	interactionSnapshot() { return this.pendingServerRequests(); }
	ingestInteractionFrame(frame, broadcast = true) {
		const normalized = normalizeInteractionServerRequest(frame);
		if (!normalized) {
			if (asRecord(frame)?.type === "server-request") this.emitStreamError("unknown-interaction");
			return;
		}
		const id = normalized.rpcId;
		const key = `${normalized.payload?.sessionId ?? ""}:${normalized.method}:${id}`;
		if (normalized.method.endsWith("/requested")) {
			if (id !== void 0) this.interactionFrames.set(key, normalized);
		} else if (normalized.method.endsWith("/resolved")) {
			if (id !== void 0) {
				for (const pendingKey of this.interactionFrames.keys()) {
					if (pendingKey.endsWith(`:${id}`)) this.interactionFrames.delete(pendingKey);
				}
			}
		}
		if (broadcast) this.emit(interactionControlEvent(normalized));
	}
	subscribe(options = {}) {
		const subscriber = {
			queue: [],
			seen: /* @__PURE__ */ new Set(),
			seenOrder: [],
			lastSeqBySession: /* @__PURE__ */ new Map(),
			queuedBytes: 0,
			done: false,
			...options
		};
		for (const event of this.pendingControls.values()) {
			if (!eventBelongsToChannel(event, options.channel)) continue;
			if (event.sessionId !== void 0 && event.sessionId !== "" && options.sessionId !== void 0 && event.sessionId !== options.sessionId) continue;
			this.enqueue(subscriber, event);
		}
		for (const frame of this.interactionFrames.values()) {
			const event = interactionControlEvent(frame);
			if (!eventBelongsToChannel(event, options.channel)) continue;
			if (frame.payload?.sessionId !== void 0 && options.sessionId !== void 0 && frame.payload.sessionId !== options.sessionId) continue;
			this.enqueue(subscriber, event);
		}
		if (this.globalBaselineRequired !== undefined) this.enqueue(subscriber, {
			sessionId: "",
			time: Date.now(),
			type: "control/baseline-required",
			body: { reason: this.globalBaselineRequired },
		});
		if (options.sessionId !== void 0 && !this.archivedSessions.has(options.sessionId)) for (const event of this.cachedEvents(options.sessionId)) {
			if (!eventBelongsToChannel(event, options.channel)) continue;
			if (event.seq !== void 0 && options.sinceSeq !== void 0 && event.seq <= options.sinceSeq) continue;
			this.enqueue(subscriber, event);
		}
		if (!subscriber.done) this.subscribers.add(subscriber);
		const state = this;
		return { [Symbol.asyncIterator]() {
			return {
				next() {
					if (subscriber.queue.length > 0) return Promise.resolve({
						done: false,
						value: state.takeQueued(subscriber)
					});
					if (subscriber.done) return Promise.resolve({
						done: true,
						value: void 0
					});
					return new Promise((resolve) => {
						subscriber.waiter = () => {
							subscriber.waiter = void 0;
							if (subscriber.queue.length > 0) resolve({
								done: false,
								value: state.takeQueued(subscriber)
							});
							else resolve({
								done: true,
								value: void 0
							});
						};
					});
				},
				return() {
					state.closeSubscriber(subscriber);
					return Promise.resolve({
						done: true,
						value: void 0
					});
				}
			};
		} };
	}
	emit(event) {
		if (!eventBelongsToChannel(event, void 0)) return;
		this.updatePendingControl(event);
		for (const subscriber of this.subscribers) {
			if (subscriber.done) continue;
			if (!eventBelongsToChannel(event, subscriber.channel)) continue;
			if (subscriber.sessionId !== void 0 && event.sessionId !== void 0 && event.sessionId !== "" && event.sessionId !== subscriber.sessionId) continue;
			if (event.seq !== void 0 && subscriber.sinceSeq !== void 0 && event.seq <= subscriber.sinceSeq) continue;
			this.enqueue(subscriber, event);
		}
	}
	scheduleColdTail(api, sessionId) {
		if (this.getWatermark(sessionId)?.source === "mux" || this.coldPending.has(sessionId)) return;
		this.coldPending.add(sessionId);
		this.coldQueue.push(sessionId);
		if (!this.coldRunning) this.drainColdTails(api);
	}
	dispose() {
		this.muxAbort?.abort();
		this.backgroundAbort?.abort();
		this.muxAbort = void 0;
		this.backgroundAbort = void 0;
		this.backgroundRunning = false;
		this.muxRunning = false;
		this.interactionUnsubscribe?.();
		this.interactionUnsubscribe = void 0;
		this.interactionSource = void 0;
		for (const waiter of this.bootstrapQueue.splice(0)) {
			waiter.signal?.removeEventListener('abort', waiter.onAbort);
			waiter.reject(new Error('operation aborted'));
		}
		this.globalEventUnsubscribers.splice(0).reverse().forEach((dispose) => {
			try { dispose?.(); } catch { /* preserve teardown */ }
		});
		this.globalEventsRunning = false;
		this.pendingGlobalEvents.length = 0;
		this.backgroundTasks.clear();
		for (const subscriber of this.subscribers) {
			subscriber.done = true;
			subscriber.waiter?.();
		}
		this.subscribers.clear();
		this.coldQueue.length = 0;
		this.coldPending.clear();
		this.events.clear();
		this.details.clear();
		this.detailOrder.length = 0;
		this.detailBytes = 0;
		this.pendingControls.clear();
		this.interactionFrames.clear();
		this.archivedSessions.clear();
		this.interactionOrigins.clear();
		this.watermarks.clear();
		this.addressBook = undefined;
	}
	rememberEvent(event) {
		if (event.sessionId === void 0 || event.seq === void 0) return;
		let map = this.events.get(event.sessionId);
		if (map === void 0) this.events.set(event.sessionId, map = /* @__PURE__ */ new Map());
		if (map.has(event.seq)) return;
		map.set(event.seq, event);
		while (map.size > this.options.maxCachedEvents) {
			const oldest = map.keys().next().value;
			if (oldest === void 0) break;
			map.delete(oldest);
		}
	}
	enqueue(subscriber, event) {
		if (subscriber.done) return;
		if (event.sessionId !== void 0 && event.seq !== void 0) {
			const last = subscriber.lastSeqBySession.get(event.sessionId);
			if (last !== void 0 && event.seq <= last) return;
			if (subscriber.sinceSeq !== void 0 && event.seq <= subscriber.sinceSeq) return;
			subscriber.lastSeqBySession.set(event.sessionId, event.seq);
		}
		const key = subscriberEventKey(event);
		if (key !== void 0) {
			if (subscriber.seen.has(key)) return;
			this.rememberSubscriberKey(subscriber, key);
		}
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		if (subscriber.queue.length >= this.options.maxSubscriberQueue || subscriber.queuedBytes + eventBytes > this.options.maxSubscriberBytes) {
			this.failSubscriber(subscriber);
			return;
		}
		subscriber.queue.push(event);
		subscriber.queuedBytes += eventBytes;
		subscriber.waiter?.();
	}
	takeQueued(subscriber) {
		const event = subscriber.queue.shift();
		subscriber.queuedBytes = Math.max(0, subscriber.queuedBytes - Buffer.byteLength(JSON.stringify(event), "utf8"));
		return event;
	}
	rememberSubscriberKey(subscriber, key) {
		subscriber.seen.add(key);
		subscriber.seenOrder.push(key);
		while (subscriber.seenOrder.length > this.options.maxSubscriberSeen) {
			const oldest = subscriber.seenOrder.shift();
			if (oldest !== void 0) subscriber.seen.delete(oldest);
		}
	}
	failSubscriber(subscriber) {
		if (subscriber.done) return;
		subscriber.queue.length = 0;
		subscriber.queuedBytes = 0;
		subscriber.seen.clear();
		subscriber.seenOrder.length = 0;
		subscriber.lastSeqBySession.clear();
		subscriber.done = true;
		const overflow = {
			sessionId: subscriber.sessionId ?? "",
			time: Date.now(),
			type: "control/stream-overflow",
			body: {
				failureKind: "subscriber-overflow",
				action: "resync-delta"
			}
		};
		subscriber.queue.push(overflow);
		subscriber.queuedBytes = Buffer.byteLength(JSON.stringify(overflow), "utf8");
		this.subscribers.delete(subscriber);
		subscriber.waiter?.();
	}
	updatePendingControl(event) {
		const key = pendingControlKey(event);
		if (key === void 0) return;
		if (event.type.endsWith("/requested")) this.pendingControls.set(key, event);
		else if (event.type.endsWith("/resolved")) this.pendingControls.delete(key);
	}
	closeSubscriber(subscriber) {
		subscriber.done = true;
		subscriber.queue.length = 0;
		subscriber.queuedBytes = 0;
		subscriber.seen.clear();
		subscriber.seenOrder.length = 0;
		subscriber.lastSeqBySession.clear();
		subscriber.waiter?.();
		this.subscribers.delete(subscriber);
	}
	async drainColdTails(api) {
		this.coldRunning = true;
		try {
		while (this.coldQueue.length > 0) {
			const sessionId = this.coldQueue.shift();
			try {
					const tail = await withTimeout(readSessionTailWatermark({ sessionController: api, addressBook: this.addressBook }, sessionId), 5e3);
					if (tail.kind === "known") this.updateWatermark(sessionId, tail.lastSeq, "history");
					else this.emitStreamError(`cold-tail-${tail.reason ?? "unknown"}`, undefined, sessionId);
				} catch (error) {
					this.emitStreamError("cold-tail", error, sessionId)
				} finally {
					this.coldPending.delete(sessionId);
				}
			}
		} finally {
			this.coldRunning = false;
		}
	}
};
function controlBody(event) {
	return event.body ?? {};
}
function cloneJson(value) {
	try { return JSON.parse(JSON.stringify(value)); } catch { return void 0; }
}
function resolveInteractionSource(ctx, config) {
	const candidate = config?.interactions ?? ctx.mobileInteractions;
	if (typeof candidate === "function") {
		try { return candidate(ctx.webServer); } catch { return void 0; }
	}
  return candidate;
}
function installSessionStatusBridge(ctx, state) {
	if (!ctx || typeof ctx.on !== "function") throw new TypeError("ctx.on is required for api-session/status bridge");
	const dispose = ctx.on("api-session/status", (sessionId, running) => state.ingestSessionStatus(sessionId, running));
	return typeof dispose === "function" ? dispose : () => {};
}
function eventBelongsToChannel(event, channel) {
	const hasHostFrame = asRecord(event)?.hostFrame !== void 0;
	if (channel === "host") return hasHostFrame;
	if (channel === "v3" || channel === "mux") return !hasHostFrame;
	return true;
}
/**
 * Convert the business bridge's explicit server-request frame to the Android
 * wire contract.  `eventId` is authoritative for all interaction identity;
 * no lookup in historical session events is performed here.
 */
function normalizeInteractionServerRequest(frame) {
	const source = asRecord(frame);
	if (source === void 0) return void 0;
	const envelope = source.type === "server-request" ? source : { type: "server-request", ...source };
	const method = boundedString(envelope.method, 96);
	const payload = asRecord(envelope.payload) ?? {};
	if (method !== "approval/requested" && method !== "approval/resolved" && method !== "question/requested" && method !== "question/resolved") return void 0;
	// Resolved bridge frames use a transport rpcId generated at emit time; the
	// payload identity is authoritative and must win for correlation.
	const eventId = boundedString(envelope.eventId, 256) ?? boundedString(payload.eventId, 256) ?? boundedString(payload.approvalId, 256) ?? boundedString(payload.questionRpcId, 256) ?? boundedString(envelope.rpcId, 256) ?? boundedString(payload.rpcId, 256);
	if (eventId === void 0) return void 0;
	const sessionId = boundedString(payload.sessionId, 4096) ?? boundedString(envelope.sessionId, 4096);
	const next = {};
	if (sessionId !== void 0) next.sessionId = sessionId;
	if (method.startsWith("approval/")) {
		next.approvalId = eventId;
		for (const key of ["toolName", "callId", "reason", "outcome", "originSeq"]) {
			const value = payload[key];
			if (key === "originSeq" && !isSafeSequence(value)) continue;
			if (typeof value === "string") next[key] = value.slice(0, key === "reason" ? 4096 : 1024);
			else if (key === "originSeq" && isSafeSequence(value)) next[key] = value;
		}
	} else {
		next.questionRpcId = eventId;
		if (method === "question/requested") {
			next.questions = Array.isArray(payload.questions) ? payload.questions.slice(0, 64).map((item) => cloneJson(item)).filter(Boolean) : [];
		} else {
			for (const key of ["outcome", "reason"]) if (typeof payload[key] === "string") next[key] = payload[key].slice(0, 1024);
		}
	}
	return {
		type: "server-request",
		rpcId: eventId,
		method,
		payload: next,
	};
}
function interactionControlEvent(frame) {
	const body = { ...frame.payload };
	if (frame.method === "approval/requested" && body.requestRpcId === void 0) body.requestRpcId = frame.rpcId;
	return {
		sessionId: frame.payload?.sessionId ?? "",
		time: Date.now(),
		type: `control/${frame.method}`,
		body,
		serverRequest: frame,
	};
}
/** Stable interaction identity; wall-clock time is intentionally excluded. */
function pendingControlKey(event) {
	const body = controlBody(event);
	const session = event.sessionId ?? "";
	if (event.type === "control/approval/requested" || event.type === "control/approval/resolved") {
		const id = boundedString(body.approvalId, 256);
		return id === void 0 ? void 0 : `${session}:approval:${id}`;
	}
	if (event.type === "control/question/requested" || event.type === "control/question/resolved") {
		const id = boundedString(body.questionRpcId, 256);
		return id === void 0 ? void 0 : `${session}:question:${id}`;
	}
}
function stableBodyKey(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
/** De-duplicate replay/live overlap without colliding same-millisecond controls. */
function subscriberEventKey(event) {
	if (event.sessionId !== void 0 && event.seq !== void 0) return `event:${event.sessionId}:${event.seq}`;
	const interaction = pendingControlKey(event);
	if (interaction !== void 0) return `${interaction}:${event.type}`;
	const body = controlBody(event);
	if (event.type === "control/session-subscribed") return `subscribed:${event.sessionId ?? ""}:${stableBodyKey(body)}`;
	if (event.type === "control/session-queue" || event.type === "control/session-jobs" || event.type === "control/session-projection") return `snapshot:${event.sessionId ?? ""}:${event.type}:${stableBodyKey(body)}`;
}
function defaultV3Options(state) {
	return {
		maxEvents: DEFAULT_V3_MAX_EVENTS,
		maxBytes: DEFAULT_V3_MAX_BYTES,
		maxInlineBytes: state.maxInlineBytes,
		maxDetailChunkBytes: state.maxDetailChunkBytes,
		maxHistoryPages: DEFAULT_V3_MAX_HISTORY_PAGES,
		scanPageMessages: DEFAULT_SCAN_PAGE_MESSAGES,
		maxScanPages: DEFAULT_MAX_SCAN_PAGES,
		maxDetailCacheBytes: state.maxDetailCacheBytes
	};
}
function detailKey(sessionId, ref) {
	return `${sessionId}\u0000${ref.seq}\u0000${ref.version}\u0000${ref.field}`;
}
function withTimeout(promise, milliseconds) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("background tail timeout")), milliseconds);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
function waitWithAbort(milliseconds, signal) {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function readSessionTailWatermark(controllerOrContext, sessionId, signal) {
	const controller = controllerOrContext?.sessionController ?? controllerOrContext;
	if (!controller || typeof controller.follow !== "function") return { kind: "unknown", reason: "controller-unavailable" };
	try {
		const effectiveSignal = signal ?? new AbortController().signal;
		const address = await resolveSessionAddress(controllerOrContext, sessionId, undefined, effectiveSignal);
		const opening = await openSessionSnapshot(controller, address, 1, effectiveSignal);
		if (!isSafeSequence(opening.cursor) && opening.cursor !== -1) return { kind: "unknown", reason: "unknown-cursor" };
		return { kind: "known", lastSeq: opening.cursor };
	} catch (error) {
		return { kind: "unknown", reason: failureCategory(error) ?? "follow-failed" };
	}
}
function installDetailLoader(controllerOrContext, state, options) {
	const controller = controllerOrContext?.sessionController ?? controllerOrContext;
	state.setDetailLoader(async (sessionId, ref, signal) => {
		if (!controller || typeof controller.page !== "function") return;
		const effectiveSignal = signal ?? new AbortController().signal;
		throwIfAborted(effectiveSignal);
		const releaseBootstrap = state.acquireBootstrap === undefined
			? undefined
			: await state.acquireBootstrap(effectiveSignal, sessionId);
		try {
		let address;
		try {
			address = await resolveSessionAddress(controllerOrContext, sessionId, state, effectiveSignal);
		} catch (error) {
			throwOrReturnCancellation(error, effectiveSignal);
			return;
		}
		let beforeSeq = ref.seq + 1;
		for (let pageIndex = 0; pageIndex < (options.maxHistoryPages ?? DEFAULT_V3_MAX_HISTORY_PAGES); pageIndex += 1) {
			throwIfAborted(effectiveSignal);
			let page;
			try {
				page = unwrapControllerValue(await raceAbort(Promise.resolve(controller.page({
					address,
					throughSeq: ref.seq,
					...beforeSeq === void 0 ? {} : { beforeSeq },
					maxMessages: options.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES
				}, effectiveSignal)), effectiveSignal));
				throwIfAborted(effectiveSignal);
			} catch (error) {
				throwOrReturnCancellation(error, effectiveSignal);
				return;
			}
			if (!page || !Array.isArray(page.records)) return;
			let entries;
			try { entries = decodeHistoryRecords(page.records, ref.seq); } catch { return; }
			const target = entries.find((entry) => entry.event.seq === ref.seq);
			if (target !== void 0) {
				const scratch = new MobileSessionSyncState({
					maxInlineBytes: 0,
					maxDetailChunkBytes: options.maxDetailChunkBytes,
					maxCachedEvents: 1,
					maxDetailCacheBytes: Number.MAX_SAFE_INTEGER
				});
				convertMobileHistoryEntry(target, sessionId, scratch, {
					...options,
					maxInlineBytes: 0,
					maxDetailCacheBytes: Number.MAX_SAFE_INTEGER
				});
				const detail = scratch.readDetail(sessionId, ref);
				scratch.dispose();
				return detail;
			}
			const oldest = entries.map((entry) => entry.event.seq).filter(Number.isInteger).sort((a, b) => a - b)[0];
			if (oldest === void 0 || !page.hasMore || oldest >= ref.seq) return void 0;
			beforeSeq = oldest;
		}
		} finally {
			releaseBootstrap?.();
		}
	});
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function boundedString(value, maximum = 1024) {
	const string = stringValue(value);
	return string === void 0 ? void 0 : string.slice(0, maximum);
}
function integerValue(value) {
	return typeof value === "number" && Number.isInteger(value) ? value : void 0;
}
function boolValue(value) {
	return typeof value === "boolean" ? value : void 0;
}
function failureCategory(value) {
	const record = asRecord(value);
	const candidate = stringValue(asRecord(record?.error)?.code) ?? stringValue(record?.code) ?? stringValue(record?.kind);
	return candidate === void 0 ? void 0 : candidate.slice(0, 96);
}
function safeUsage(value) {
	const usage = asRecord(value);
	if (usage === void 0) return void 0;
	const result = {};
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens"
	]) {
		const number = integerValue(usage[key]);
		if (number !== void 0 && number >= 0) result[key] = number;
	}
	return Object.keys(result).length === 0 ? void 0 : result;
}
const SENSITIVE_TOOL_KEY = /(?:pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?key|refresh[-_]?token|client[-_]?secret)/i;
/** Redact tool-owned JSON before it can enter the process-local detail cache. */
function safeToolJson(value, depth = 0) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value === "string") return value.slice(0, 8192);
	if (depth >= 8) return { redacted: "depth-limit" };
	if (Array.isArray(value)) return value.slice(0, 128).map((item) => safeToolJson(item, depth + 1));
	const record = asRecord(value);
	if (record === void 0) return void 0;
	const result = {};
	for (const [key, item] of Object.entries(record).slice(0, 128)) {
		if (SENSITIVE_TOOL_KEY.test(key)) continue;
		if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) continue;
		const safe = safeToolJson(item, depth + 1);
		if (safe !== void 0) result[key] = safe;
	}
	return result;
}
function safeToolArguments(text) {
	try {
		const parsed = JSON.parse(text);
		return JSON.stringify(safeToolJson(parsed));
	} catch {
		return;
	}
}
function safeArgumentsDetail(text, state, sessionId, seq, field, options, forDetail = false) {
	const safe = safeToolArguments(text);
	if (safe === void 0) return {
		redacted: true,
		reason: "arguments-not-json"
	};
	// Tool arguments never belong to the default mobile projection, even when small.
	// A requested result detail is self-contained so the paged viewer need not chase refs.
	return forDetail ? { text: safe } : {
		detailRef: state.putDetail(sessionId, seq, field, safe, "application/json"),
		totalBytes: Buffer.byteLength(safe, "utf8")
	};
}
function safeDetailText(value, state, sessionId, seq, field, options, contentType = "text/plain") {
	if (Buffer.byteLength(value, "utf8") <= options.maxInlineBytes) return { text: value };
	const ref = state.putDetail(sessionId, seq, field, value, contentType);
	return {
		preview: Array.from(value).slice(0, 256).join(""),
		detailRef: ref,
		totalBytes: Buffer.byteLength(value, "utf8")
	};
}
function safeSource(source) {
	const record = asRecord(source);
	if (record === void 0) return void 0;
	const result = {};
	const kind = boundedString(record.kind, 128);
	if (kind !== void 0) result.kind = kind;
	const form = boundedString(record.form, 128);
	if (form !== void 0) result.form = form;
	const plugin = boundedString(record.plugin, 256);
	if (plugin !== void 0) result.plugin = plugin;
	const callId = boundedString(record.callId, 256);
	if (callId !== void 0) result.callId = callId;
	const provider = boundedString(record.provider, 256);
	if (provider !== void 0) result.provider = provider;
	const model = boundedString(record.model, 512);
	if (model !== void 0) result.model = model;
	const compactionId = boundedString(record.compactionId, 256);
	if (compactionId !== void 0) result.compactionId = compactionId;
	const sourceCommandId = boundedString(record.sourceCommandId, 256);
	if (sourceCommandId !== void 0) result.sourceCommandId = sourceCommandId;
	const goalId = boundedString(record.goalId, 256);
	if (goalId !== void 0) result.goalId = goalId;
	const revision = integerValue(record.revision);
	if (revision !== void 0) result.revision = revision;
	const round = integerValue(record.round);
	if (round !== void 0) result.round = round;
	return Object.keys(result).length === 0 ? void 0 : result;
}
function safeContentBlocks(content, state, sessionId, seq, options, fieldPrefix, forDetail = false) {
	if (!Array.isArray(content)) return [];
	const output = [];
	for (const [index, value] of content.entries()) {
		const block = asRecord(value);
		if (block === void 0) continue;
		const type = stringValue(block.type);
		if (type === "text" || type === "reasoning") {
			const text = stringValue(block.text);
			if (text === void 0) continue;
			output.push({
				type,
				...(forDetail ? { text } : safeDetailText(text, state, sessionId, seq, `${fieldPrefix}.${index}`, options))
			});
			continue;
		}
		if (type === "image") {
			const attachment = asRecord(block.attachment);
			const safe = { type: "image" };
			if (stringValue(attachment?.attachmentId) !== void 0) safe.attachmentId = attachment?.attachmentId;
			if (stringValue(attachment?.mediaType) !== void 0) safe.mediaType = attachment?.mediaType;
			for (const key of [
				"width",
				"height",
				"byteLength"
			]) {
				const number = integerValue(attachment?.[key]);
				if (number !== void 0 && number >= 0) safe[key] = number;
			}
			output.push(safe);
			continue;
		}
		if (type === "tool-call") {
			const safe = { type: "tool-call" };
			for (const key of ["id", "name"]) {
				const string = stringValue(block[key]);
				if (string !== void 0) safe[key] = string;
			}
			const args = stringValue(block.arguments);
			if (args !== void 0) safe.arguments = safeArgumentsDetail(args, state, sessionId, seq, `${fieldPrefix}.${index}.arguments`, options, forDetail);
			output.push(safe);
			continue;
		}
		if (type === "tool-result") {
			const safe = { type: "tool-result" };
			const callId = stringValue(block.toolCallId);
			if (callId !== void 0) safe.toolCallId = callId;
			if (boolValue(block.isError) !== void 0) safe.isError = block.isError;
			const field = `${fieldPrefix}.${index}.content`;
			const detailContent = safeContentBlocks(block.content, state, sessionId, seq, options, field, true);
			if (forDetail) safe.content = detailContent;
			else safe.detailRef = state.putDetail(sessionId, seq, field, JSON.stringify({ content: detailContent }), "application/json");
			output.push(safe);
		}
	}
	return output;
}
function safeMessage(message, state, sessionId, seq, options, field) {
	const record = asRecord(message);
	if (record === void 0) return void 0;
	const result = {};
	for (const key of ["id", "role"]) {
		const string = stringValue(record[key]);
		if (string !== void 0) result[key] = string;
	}
	const source = safeSource(record.source);
	if (source !== void 0) result.source = source;
	result.content = safeContentBlocks(record.content, state, sessionId, seq, options, field);
	return result;
}
function safePendingContent(content, state) {
	if (!Array.isArray(content)) return [];
	return content.flatMap((value) => {
		const block = asRecord(value);
		const type = stringValue(block?.type);
		if (block === void 0 || type === void 0) return [];
		if (type === "text" || type === "reasoning") {
			const text = stringValue(block.text);
			if (text === void 0) return [];
			const totalBytes = Buffer.byteLength(text, "utf8");
			if (totalBytes <= state.maxInlineBytes) return [{
				type,
				text
			}];
			return [{
				type,
				preview: Array.from(text).slice(0, 256).join(""),
				totalBytes,
				truncated: true
			}];
		}
		if (type === "tool-call") {
			const safe = { type };
			for (const key of ["id", "name"]) {
				const value = boundedString(block[key], 256);
				if (value !== void 0) safe[key] = value;
			}
			const args = stringValue(block.arguments);
			const sanitized = args === void 0 ? void 0 : safeToolArguments(args);
			if (sanitized !== void 0 && Buffer.byteLength(sanitized, "utf8") <= state.maxInlineBytes) safe.arguments = sanitized;
			else if (args !== void 0) safe.arguments = {
				redacted: true,
				detailUnavailable: true
			};
			return [safe];
		}
		if (type === "tool-result") {
			const safe = { type };
			const callId = boundedString(block.toolCallId, 256);
			if (callId !== void 0) safe.toolCallId = callId;
			if (typeof block.isError === "boolean") safe.isError = block.isError;
			safe.content = safePendingContent(block.content, state);
			return [safe];
		}
		if (type === "image") {
			const attachment = asRecord(block.attachment);
			const safe = { type };
			for (const key of ["attachmentId", "mediaType"]) {
				const value = boundedString(attachment?.[key], 256);
				if (value !== void 0) safe[key] = value;
			}
			return [safe];
		}
		return [];
	});
}
function safePendingMessage(value, state) {
	const message = asRecord(value);
	if (message === void 0) return void 0;
	const result = {};
	const id = boundedString(message.id, 256);
	const role = boundedString(message.role, 32);
	if (id !== void 0) result.id = id;
	if (role === "system" || role === "user" || role === "assistant") result.role = role;
	const source = safeSource(message.source);
	if (source !== void 0) result.source = source;
	result.content = safePendingContent(message.content, state);
	return result;
}
function safeQueueItems(value, state) {
	if (!Array.isArray(value)) return {
		items: [],
		complete: true
	};
	const items = [];
	for (const item of value.slice(0, DEFAULT_V3_MAX_EVENTS)) {
		const record = asRecord(item);
		if (record === void 0) continue;
		const id = boundedString(record.id, 256);
		const placement = boundedString(record.placement, 32);
		if (id === void 0 || placement !== "queued" && placement !== "steering" && placement !== "context") continue;
		const safe = {
			id,
			placement
		};
		const message = safePendingMessage(record.message, state);
		if (message !== void 0) safe.message = message;
		items.push(safe);
	}
	return {
		items,
		complete: items.length === value.length
	};
}
function safeJobItems(value) {
	if (!Array.isArray(value)) return {
		jobs: [],
		complete: true
	};
	const jobs = [];
	for (const item of value.slice(0, DEFAULT_V3_MAX_EVENTS)) {
		const record = asRecord(item);
		if (record === void 0) continue;
		const safe = {};
		for (const key of [
			"id",
			"kind",
			"label",
			"status",
			"detail"
		]) {
			const string = boundedString(record[key], key === "detail" ? 2048 : 512);
			if (string !== void 0) safe[key] = string;
		}
		for (const key of ["startedAt", "finishedAt"]) {
			const number = integerValue(record[key]);
			if (number !== void 0 && number >= 0) safe[key] = number;
		}
		if (safe.id !== void 0) jobs.push(safe);
	}
	return {
		jobs,
		complete: jobs.length === value.length
	};
}
const MOBILE_PROJECTION_KEYS = /* @__PURE__ */ new Set([
	"title",
	"goal",
	"todos",
	"permissions",
	"plan",
	"tokenUsage",
	"contextPressure",
	"contextBreakdown",
	"sessionStats",
	"imageLimits"
]);
function safeProjectionNumbers(value, keys) {
	const record = asRecord(value);
	if (record === void 0) return void 0;
	const result = {};
	for (const key of keys) {
		const number = integerValue(record[key]);
		if (number !== void 0 && number >= 0) result[key] = number;
	}
	return Object.keys(result).length === 0 ? void 0 : result;
}
function safeProjectionValue(key, value) {
	if (!MOBILE_PROJECTION_KEYS.has(key)) return void 0;
	if (value === null) return null;
	if (key === "title") return boundedString(value, 4096);
	if (key === "plan") {
		const record = asRecord(value);
		if (record === void 0) return void 0;
		const result = {};
		for (const field of ["active", "pending"]) if (typeof record[field] === "boolean") result[field] = record[field];
		return Object.keys(result).length === 0 ? void 0 : result;
	}
	if (key === "goal") {
		const record = asRecord(value);
		if (record === void 0) return void 0;
		const result = {};
		const goal = asRecord(record.goal);
		if (goal !== void 0) {
			const safeGoal = {};
			for (const field of [
				"id",
				"objective",
				"phase",
				"revision",
				"maxGoalRounds"
			]) {
				const string = boundedString(goal[field], 4096);
				const number = integerValue(goal[field]);
				if (string !== void 0) safeGoal[field] = string;
				else if (number !== void 0 && number >= 0) safeGoal[field] = number;
			}
			const blocked = asRecord(goal.blockedReason);
			if (blocked !== void 0) {
				const safeBlocked = {};
				for (const field of ["code", "message"]) {
					const string = boundedString(blocked[field], 1024);
					if (string !== void 0) safeBlocked[field] = string;
				}
				if (Object.keys(safeBlocked).length > 0) safeGoal.blockedReason = safeBlocked;
			}
			if (Object.keys(safeGoal).length > 0) result.goal = safeGoal;
		}
		for (const field of [
			"roundsStarted",
			"createdAt",
			"updatedAt"
		]) {
			const number = integerValue(record[field]);
			if (number !== void 0 && number >= 0) result[field] = number;
		}
		return Object.keys(result).length === 0 ? void 0 : result;
	}
	if (key === "todos") {
		if (!Array.isArray(value)) return void 0;
		return value.slice(0, DEFAULT_V3_MAX_EVENTS).flatMap((item) => {
			const record = asRecord(item);
			const content = boundedString(record?.content, 4096);
			const status = boundedString(record?.status, 32);
			return content === void 0 || status === void 0 ? [] : [{
				content,
				status
			}];
		});
	}
	if (key === "permissions") {
		const record = asRecord(value);
		if (record === void 0) return void 0;
		const result = {};
		const currentValue = boundedString(record.currentValue, 256);
		if (currentValue !== void 0) result.currentValue = currentValue;
		if (Array.isArray(record.options)) result.options = record.options.slice(0, DEFAULT_V3_MAX_EVENTS).flatMap((item) => {
			const option = asRecord(item);
			if (option === void 0) return [];
			const safe = {};
			for (const field of [
				"value",
				"name",
				"description"
			]) {
				const string = boundedString(option[field], 1024);
				if (string !== void 0) safe[field] = string;
			}
			return Object.keys(safe).length === 0 ? [] : [safe];
		});
		return Object.keys(result).length === 0 ? void 0 : result;
	}
	if (key === "imageLimits") {
		const record = asRecord(value);
		if (record === void 0) return void 0;
		const result = {};
		for (const field of [
			"maxImageBytes",
			"maxImagesPerMessage",
			"maxMessageImageBytes",
			"maxImagePixels",
			"maxImageDimension"
		]) {
			const number = integerValue(record[field]);
			if (number !== void 0 && number > 0) result[field] = number;
		}
		if (Array.isArray(record.mediaTypes)) result.mediaTypes = record.mediaTypes.flatMap((item) => {
			const string = boundedString(item, 128);
			return string === void 0 ? [] : [string];
		}).slice(0, 64);
		return Object.keys(result).length === 0 ? void 0 : result;
	}
	return safeProjectionNumbers(value, {
		tokenUsage: [
			"uncachedInputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens"
		],
		contextPressure: [
			"pressureTokens",
			"projectedTokens",
			"contextWindow"
		],
		contextBreakdown: [
			"systemTokens",
			"toolsTokens",
			"messageTokens"
		],
		sessionStats: [
			"turns",
			"steps",
			"llmMs",
			"toolMs",
			"ttftMs",
			"ttftSteps",
			"decodeMs",
			"decodeTokens"
		]
	}[key] ?? []);
}
function normalizeMobileProjectionBlock(value) {
	const record = asRecord(value);
	const asOfSeq = integerValue(record?.asOfSeq);
	const values = asRecord(record?.values);
	if (asOfSeq === void 0 || asOfSeq < -1 || values === void 0) return void 0;
	const safeValues = {};
	for (const [key, item] of Object.entries(values)) {
		const safe = safeProjectionValue(key, item);
		if (safe !== void 0) safeValues[key] = safe;
	}
	return {
		asOfSeq,
		values: safeValues
	};
}
function safeToolView(view) {
	const record = asRecord(view);
	if (record === void 0) return void 0;
	const result = {};
	const card = boundedString(record.card, 128);
	if (card !== void 0) result.card = card;
	for (const key of [
		"title",
		"description",
		"signal"
	]) {
		const string = boundedString(record[key], 512);
		if (string !== void 0) result[key] = string.slice(0, 512);
	}
	const kind = boundedString(record.kind, 128);
	if (kind !== void 0) result.kind = kind;
	const exitCode = integerValue(record.exitCode);
	if (exitCode !== void 0) result.exitCode = exitCode;
	return Object.keys(result).length === 0 ? void 0 : result;
}
function safeGoal(value) {
	const record = asRecord(value);
	if (record === void 0) return void 0;
	const result = {};
	for (const key of [
		"id",
		"objective",
		"phase",
		"status",
		"createdAt",
		"updatedAt",
		"revision",
		"maxGoalRounds",
		"maxRounds"
	]) if (typeof record[key] === "string") result[key] = record[key].slice(0, 1024);
	else if (typeof record[key] === "number" && Number.isFinite(record[key])) result[key] = record[key];
	const blocked = asRecord(record.blockedReason ?? record.blockReason);
	if (blocked !== void 0) {
		const safeBlocked = {};
		for (const key of ["code", "message"]) {
			const string = boundedString(blocked[key], 1024);
			if (string !== void 0) safeBlocked[key] = string;
		}
		if (Object.keys(safeBlocked).length > 0) result.blockedReason = safeBlocked;
	}
	return Object.keys(result).length === 0 ? void 0 : result;
}
function safeTodos(value, state, sessionId, seq, options) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		const record = asRecord(item);
		const content = stringValue(record?.content);
		const status = stringValue(record?.status);
		if (content === void 0 || status === void 0) return [];
		return [{
			status: status.slice(0, 32),
			...safeDetailText(content, state, sessionId, seq, `todos.${index}.content`, options)
		}];
	});
}
function toolCallId(data) {
	const direct = stringValue(data.callId);
	if (direct !== void 0) return direct;
	const message = asRecord(data.message);
	const fromSource = stringValue(asRecord(message?.source)?.callId);
	if (fromSource !== void 0) return fromSource;
	const blocks = Array.isArray(message?.content) ? message?.content : [];
	for (const item of blocks) {
		const fromBlock = stringValue(asRecord(item)?.toolCallId);
		if (fromBlock !== void 0) return fromBlock;
	}
}
function safeSeqList(value) {
	if (!Array.isArray(value)) return void 0;
	const result = value.flatMap((item) => {
		const seq = integerValue(item);
		return seq !== void 0 && seq >= 0 ? [seq] : [];
	});
	return result.length === 0 ? void 0 : result.slice(0, DEFAULT_V3_MAX_EVENTS * 32);
}
function safeSeqRange(value) {
	const record = asRecord(value);
	if (record === void 0) return void 0;
	const start = integerValue(record.start);
	const end = integerValue(record.end);
	if (start === void 0 || end === void 0 || start < 0 || end < 0) return void 0;
	return {
		start,
		end
	};
}
function safeCompactionFailure(value) {
	return failureCategory(value) ?? boundedString(value, 96);
}
/** Convert one durable history entry. This is also used for mux `session/event` frames. */
function convertMobileHistoryEntry(entry, sessionId, state, options = defaultV3Options(state)) {
	const raw = asRecord(entry.event) ?? {};
	const seq = raw.seq;
	if (!isSafeSequence(seq)) throw new BaselineRecoveryError("unknown-sequence");
	const time = integerValue(raw.time) ?? Date.now();
	const type = boundedString(raw.type, 128) ?? "unknown";
	const data = asRecord(raw.data) ?? {};
	const body = {};
	// Preserve the server's surface identity: text equality cannot identify a final chunk replacement.
	if (["user/message", "assistant/message", "tool/result"].includes(type)) {
		if (raw.sourceEventSeqs !== undefined) {
			if (!Array.isArray(raw.sourceEventSeqs) || !raw.sourceEventSeqs.every(value => Number.isSafeInteger(value) && value >= 0)) {
				throw new BaselineRecoveryError("unknown-source-sequence");
			}
			body.sourceEventSeqs = [...raw.sourceEventSeqs];
		}
		if (raw.surfaceOp === "append") body.surfaceOp = "append";
		else if (raw.surfaceOp !== undefined) {
			const op = asRecord(raw.surfaceOp);
			if (op?.op !== "replace" || !Number.isSafeInteger(op.start) || !Number.isSafeInteger(op.end) || op.start < 0 || op.end < op.start) {
				throw new BaselineRecoveryError("unknown-surface-operation");
			}
			body.surfaceOp = { op: "replace", start: op.start, end: op.end };
		}
	}
	switch (type) {
		case "user/message": {
			const message = safeMessage(data, state, sessionId, seq, options, "message.content");
			if (message !== void 0) body.message = message;
			break;
		}
		case "assistant/message": {
			const message = safeMessage(data.message, state, sessionId, seq, options, "message.content");
			if (message !== void 0) body.message = message;
			const usage = safeUsage(data.usage);
			if (usage !== void 0) body.usage = usage;
			if (data.interrupted === true) body.interrupted = true;
			break;
		}
		case "assistant/chunk": {
			const chunk = asRecord(data.chunk);
			if (chunk === void 0) break;
			const chunkType = stringValue(chunk.type);
			const index = integerValue(chunk.index);
			if (chunkType === "text-delta" || chunkType === "reasoning-delta") {
				const text = stringValue(chunk.text);
				if (text !== void 0) body.chunk = {
					type: chunkType,
					...index === void 0 ? {} : { index },
					...safeDetailText(text, state, sessionId, seq, `chunk.${chunkType}`, options)
				};
			} else if (chunkType === "tool-call-delta") {
				const call = { type: chunkType };
				if (index !== void 0) call.index = index;
				for (const key of ["id", "name"]) {
					const string = stringValue(chunk[key]);
					if (string !== void 0) call[key] = string;
				}
				const args = stringValue(chunk.argumentsDelta);
				if (args !== void 0) call.argumentsDelta = safeArgumentsDetail(args, state, sessionId, seq, "chunk.tool-call-delta.arguments", options);
				body.chunk = call;
			} else if (chunkType === "usage") body.chunk = {
				type: chunkType,
				usage: safeUsage(chunk.usage) ?? {}
			};
			else if (chunkType === "finish") {
				const reason = asRecord(chunk.reason);
				const safeReason = {};
				const kind = stringValue(reason?.kind);
				if (kind !== void 0) safeReason.kind = kind;
				const failure = failureCategory(reason?.failure);
				if (failure !== void 0) safeReason.failureKind = failure;
				body.chunk = {
					type: chunkType,
					reason: safeReason
				};
			} else if (chunkType === "block-start") body.chunk = {
				type: chunkType,
				...index === void 0 ? {} : { index },
				blockType: stringValue(chunk.blockType) ?? "unknown"
			};
			else if (chunkType === "block-end") {
				const block = safeContentBlocks([chunk.block], state, sessionId, seq, options, "chunk.block-end")[0];
				body.chunk = {
					type: chunkType,
					...index === void 0 ? {} : { index },
					...block === void 0 ? {} : { block }
				};
			}
			break;
		}
		case "tool/call": {
			const callId = stringValue(data.callId);
			const name = stringValue(data.name);
			if (callId !== void 0) body.callId = callId;
			if (name !== void 0) body.name = name;
			const view = entry.view?.for === "call" ? safeToolView(entry.view.view) : void 0;
			if (view !== void 0) body.summary = view;
			const args = stringValue(data.arguments);
			const safeArgs = args === void 0 ? void 0 : safeToolArguments(args);
			if (safeArgs !== void 0 && safeArgs.length > 0) body.detailRef = state.putDetail(sessionId, seq, "tool.call.arguments", safeArgs, "application/json");
			break;
		}
		case "tool/result": {
			const callId = toolCallId(data);
			if (callId !== void 0) body.callId = callId;
			const view = entry.view?.for === "result" ? safeToolView(entry.view.view) : void 0;
			if (view !== void 0) body.summary = view;
			const contentHasError = Array.isArray(asRecord(data.message)?.content) && (asRecord(data.message)?.content).some((item) => asRecord(item)?.isError === true);
			const failure = failureCategory(data.error) ?? (contentHasError ? "tool-error" : void 0);
			if (failure !== void 0) body.failureKind = failure;
			const detail = asRecord(data.message);
			if (detail !== void 0) {
				const safe = {
					callId,
					content: safeContentBlocks(detail.content, state, sessionId, seq, options, "tool.result.content", true),
					isError: failure !== void 0
				};
				body.detailRef = state.putDetail(sessionId, seq, "tool.result", JSON.stringify(safe), "application/json");
			}
			break;
		}
		case "compaction/start":
		case "compaction/end":
			for (const key of ["compactionId", "sourceCommandId"]) {
				const string = boundedString(data[key], 256);
				if (string !== void 0) body[key] = string;
			}
			if (data.turn === null) body.turn = null;
			else {
				const turn = integerValue(data.turn);
				if (turn !== void 0 && turn >= 0) body.turn = turn;
			}
			if (type === "compaction/end") {
				const failure = safeCompactionFailure(data.error);
				if (failure !== void 0) body.failureKind = failure;
			}
			break;
		case "compaction/summary": {
			for (const key of [
				"compactionId",
				"sourceCommandId",
				"provider",
				"model"
			]) {
				const string = boundedString(data[key], key === "model" ? 512 : 256);
				if (string !== void 0) body[key] = string;
			}
			const summary = safeContentBlocks(data.summary, state, sessionId, seq, options, "compaction.summary");
			if (summary.length > 0) body.summary = summary;
			const shadowedRange = safeSeqRange(data.shadowedRange);
			if (shadowedRange !== void 0) body.shadowedRange = shadowedRange;
			const shadowedSeqs = safeSeqList(data.shadowedSeqs);
			if (shadowedSeqs !== void 0) body.shadowedSeqs = shadowedSeqs;
			const shadowedTokenCount = integerValue(data.shadowedTokenCount);
			if (shadowedTokenCount !== void 0 && shadowedTokenCount >= 0) body.shadowedTokenCount = shadowedTokenCount;
			const maxTokens = integerValue(data.maxTokens);
			if (maxTokens !== void 0 && maxTokens >= 0) body.maxTokens = maxTokens;
			const usage = safeUsage(data.usage);
			if (usage !== void 0) body.usage = usage;
			break;
		}
		case "compaction/prune": {
			const shadowedRange = safeSeqRange(data.shadowedRange);
			if (shadowedRange !== void 0) body.shadowedRange = shadowedRange;
			const shadowedSeqs = safeSeqList(data.shadowedSeqs);
			if (shadowedSeqs !== void 0) body.shadowedSeqs = shadowedSeqs;
			const shadowedTokenCount = integerValue(data.shadowedTokenCount);
			if (shadowedTokenCount !== void 0 && shadowedTokenCount >= 0) body.shadowedTokenCount = shadowedTokenCount;
			break;
		}
		case "subagent/update": {
			for (const key of [
				"agentId",
				"name",
				"status"
			]) {
				const string = boundedString(data[key], 512);
				if (string !== void 0) body[key] = string;
			}
			const summary = boundedString(data.summary, 16 * 1024);
			if (summary !== void 0) body.summary = safeDetailText(summary, state, sessionId, seq, "subagent.summary", options);
			break;
		}
		case "todo/write":
			body.todos = safeTodos(data.todos, state, sessionId, seq, options);
			break;
		case "goal/change":
			for (const key of [
				"kind",
				"version",
				"operation",
				"roundsStarted",
				"createdAt",
				"updatedAt",
				"clearedAt"
			]) if (typeof data[key] === "string" || typeof data[key] === "number") body[key] = data[key];
			const goal = safeGoal(data.goal);
			const cleared = safeGoal(data.cleared);
			if (goal !== void 0) body.goal = goal;
			if (cleared !== void 0) body.cleared = cleared;
			break;
		case "request/header": {
			const header = asRecord(data.header);
			const config = asRecord(header?.config);
			const adapterDefaults = asRecord(header?.adapterDefaults);
			if (config !== void 0) {
				const model = {};
				for (const key of [
					"provider",
					"model",
					"reasoningEffort"
				]) {
					const string = boundedString(config[key], 512);
					if (string !== void 0) model[key] = string;
				}
				for (const key of ["temperature"]) {
					const number = typeof config[key] === "number" && Number.isFinite(config[key]) ? config[key] : void 0;
					if (number !== void 0) model[key] = number;
				}
				const maxTokens = integerValue(config.maxTokens);
				if (maxTokens !== void 0 && maxTokens >= 0) model.maxTokens = maxTokens;
				if (Array.isArray(config.stop)) model.stop = config.stop.flatMap((item) => {
					const string = boundedString(item, 256);
					return string === void 0 ? [] : [string];
				}).slice(0, 32);
				if (Object.keys(model).length > 0) body.model = model;
			}
			if (adapterDefaults !== void 0) {
				const safeDefaults = {};
				if (adapterDefaults.reasoningEffort === true) safeDefaults.reasoningEffort = true;
				if (adapterDefaults.maxTokens === true) safeDefaults.maxTokens = true;
				if (Object.keys(safeDefaults).length > 0) body.adapterDefaults = safeDefaults;
			}
			const reason = boundedString(data.reason, 1024);
			if (reason !== void 0) body.reason = reason;
			break;
		}
		case "request/context": {
			const model = {};
			for (const key of ["provider", "model"]) {
				const string = boundedString(data[key], 256);
				if (string !== void 0) model[key] = string;
			}
			const contextWindow = integerValue(data.contextWindow);
			if (contextWindow !== void 0 && contextWindow >= 0) model.contextWindow = contextWindow;
			if (Object.keys(model).length > 0) body.model = model;
			break;
		}
		case "plan/mode":
		case "permission/preset":
		case "sandbox/mode":
		case "approval/policy":
			for (const key of [
				"active",
				"preset",
				"mode",
				"policy",
				"source"
			]) {
				const string = boundedString(data[key], 256);
				if (string !== void 0) body[key] = string;
				else if (typeof data[key] === "boolean") body[key] = data[key];
			}
			break;
		case "approval/asked": {
			const id = stringValue(data.id);
			const toolName = stringValue(data.toolName);
			const callId = stringValue(data.callId);
			if (id !== void 0) body.approvalId = id;
			if (toolName !== void 0) body.toolName = toolName;
			if (callId !== void 0) body.callId = callId;
			const reason = boundedString(data.reason, 1024);
			if (reason !== void 0) body.reason = safeDetailText(reason, state, sessionId, seq, "approval.reason", options);
			if (id !== void 0) {
				state.noteInteractionOrigin(sessionId, "approval", id, seq);
				body.originSeq = seq;
			} else body.originSeq = null;
			break;
		}
		case "approval/decided": {
			const id = stringValue(data.id);
			const outcome = stringValue(data.outcome);
			if (id !== void 0) body.approvalId = id;
			if (outcome !== void 0) body.outcome = outcome;
			body.originSeq = id === void 0 ? null : state.getInteractionOrigin(sessionId, "approval", id) ?? null;
			break;
		}
		case "turn/start":
		case "turn/end":
		case "step/start":
		case "step/end":
		case "session/end-seed": {
			for (const key of ["turn", "step"]) {
				const number = integerValue(data[key]);
				if (number !== void 0) body[key] = number;
			}
			const reason = asRecord(data.reason);
			if (reason !== void 0) body.reason = {
				kind: stringValue(reason.kind) ?? "unknown",
				...failureCategory(reason.error) === void 0 ? {} : { failureKind: failureCategory(reason.error) }
			};
			break;
		}
		case "command/run":
		case "command/done": {
			for (const key of [
				"commandId",
				"name",
				"kind",
				"source",
				"sourceEventSeq"
			]) if (typeof data[key] === "string") body[key] = data[key].slice(0, 512);
			else if (typeof data[key] === "number") body[key] = data[key];
			const args = stringValue(data.args) ?? stringValue(data.text);
			if (args !== void 0) body.detailRef = state.putDetail(sessionId, seq, "command.text", args);
			break;
		}
		default: break;
	}
	const result = {
		sessionId,
		seq,
		time,
		type
	};
	if (Object.keys(body).length > 0) result.body = body;
	return result;
}
/** Convert one mux payload through the same history converter used by v3 history/delta. */
function convertMobileMuxFrame(payload, state, options = defaultV3Options(state), meta = {}) {
	const frame = asRecord(payload);
	if (frame === void 0) return void 0;
	const type = stringValue(frame.type);
	if (type === "session/event") {
		const sessionId = boundedString(frame.sessionId, 4096);
		const event = asRecord(frame.event);
		if (sessionId === void 0 || event === void 0) return void 0;
		const converted = convertMobileHistoryEntry({
			event,
			...frame.view === void 0 ? {} : { view: frame.view }
		}, sessionId, state, options);
		if (converted.seq !== void 0) state.updateWatermark(sessionId, converted.seq, "mux");
		return converted;
	}
	const sessionId = boundedString(frame.sessionId, 4096);
	const now = Date.now();
	if (type === "session/subscribed") {
		const lastSeq = Number.isSafeInteger(frame.lastSeq) && frame.lastSeq >= -1 && !Object.is(frame.lastSeq, -0) ? frame.lastSeq : void 0;
		if (sessionId !== void 0 && lastSeq !== void 0 && lastSeq >= -1) state.updateWatermark(sessionId, lastSeq, "mux");
		return {
			sessionId,
			time: now,
			type: "control/session-subscribed",
			body: { ...lastSeq === void 0 ? {} : {
				lastSeq,
				authoritative: true
			} }
		};
	}
	if (type === "session/projection") {
		const seq = integerValue(frame.seq);
		const key = boundedString(frame.key, 128) ?? "unknown";
		const safeValue = safeProjectionValue(key, frame.value);
		return {
			sessionId,
			time: now,
			type: "control/session-projection",
			body: {
				key,
				...seq === void 0 ? {} : { seq },
				...safeValue === void 0 ? { valueUnavailable: true } : { value: safeValue }
			}
		};
	}
	if (type === "session/queue" || type === "session/jobs") {
		const items = Array.isArray(frame.items) ? frame.items : Array.isArray(frame.jobs) ? frame.jobs : [];
		if (type === "session/queue") {
			const safe = safeQueueItems(items, state);
			return {
				sessionId,
				time: now,
				type: "control/session/queue",
				body: {
					count: items.length,
					items: safe.items,
					complete: safe.complete,
					representation: "safe-projection"
				}
			};
		}
		const safe = safeJobItems(items);
		return {
			sessionId,
			time: now,
			type: "control/session/jobs",
			body: {
				count: items.length,
				jobs: safe.jobs,
				complete: safe.complete,
				representation: "safe-projection"
			}
		};
	}
	if (type === "approval/requested" || type === "approval/resolved") {
		const body = {};
		const eventId = boundedString(frame.eventId, 256) ?? boundedString(meta.eventId, 256);
		for (const key of [
			"approvalId",
			"toolName",
			"callId",
			"outcome"
		]) {
			const string = key === "approvalId" && eventId !== void 0 ? eventId : boundedString(frame[key], 256);
			if (string !== void 0) body[key] = string;
		}
		const reason = stringValue(frame.reason);
		if (reason !== void 0) body.reason = reason.slice(0, 1024);
		const session = sessionId;
		const approvalId = eventId ?? boundedString(frame.approvalId, 256);
		body.originSeq = session === void 0 || approvalId === void 0 ? null : state.getInteractionOrigin(session, "approval", approvalId) ?? null;
		const requestRpcId = boundedString(meta.rpcId, 256);
		if (requestRpcId !== void 0 && type === "approval/requested") body.requestRpcId = requestRpcId;
		return {
			sessionId,
			time: now,
			type: `control/${type}`,
			body
		};
	}
	if (type === "question/requested") {
		const eventId = boundedString(frame.eventId, 256) ?? boundedString(meta.eventId, 256) ?? boundedString(meta.rpcId, 256);
		const questions = Array.isArray(frame.questions) ? frame.questions.flatMap((item) => {
			const question = asRecord(item);
			if (question === void 0) return [];
			const result = {};
			for (const key of [
				"id",
				"header",
				"question",
				"detail"
			]) {
				const string = boundedString(question[key], key === "id" ? 256 : 2048);
				if (string !== void 0) result[key] = string;
			}
			if (typeof question.multiSelect === "boolean") result.multiSelect = question.multiSelect;
			if (Array.isArray(question.options)) result.options = question.options.flatMap((option) => {
				const value = asRecord(option);
				if (value === void 0) return [];
				const itemResult = {};
				for (const key of ["label", "description"]) {
					const string = boundedString(value[key], 1024);
					if (string !== void 0) itemResult[key] = string;
				}
				return [itemResult];
			});
			const intent = asRecord(question.intent);
			if (intent !== void 0 && boundedString(intent.kind, 64) === "plan-review") {
				const approve = boundedString(intent.approve, 2048);
				result.intent = {
					kind: "plan-review",
					...approve === void 0 ? {} : { approve }
				};
			}
			return [result];
		}) : [];
		return {
			sessionId,
			time: now,
			type: "control/question/requested",
			body: {
				questionRpcId: eventId ?? null,
				originSeq: null,
				questions
			}
		};
	}
	if (type === "question/resolved") {
		const body = {};
		const id = boundedString(frame.eventId, 256) ?? boundedString(meta.eventId, 256) ?? boundedString(frame.questionRpcId, 256);
		const outcome = boundedString(frame.outcome, 64);
		if (id !== void 0) body.questionRpcId = id;
		if (outcome !== void 0) body.outcome = outcome;
		body.originSeq = null;
		return {
			sessionId,
			time: now,
			type: "control/question/resolved",
			body
		};
	}
	if (type === "stream/error") return {
		sessionId: "",
		time: now,
		type: "control/stream-error",
		body: { failureKind: failureCategory(frame.error) ?? "stream-error" }
	};
}
function fitV3Events(events, state, options, direction = "head") {
	const result = [];
	let bytes = 2;
	let truncated = false;
	const candidates = direction === "tail" ? events.slice().reverse() : events;
	for (const event of candidates) {
		if (result.length >= options.maxEvents) {
			truncated = true;
			break;
		}
		const size = Buffer.byteLength(JSON.stringify(event), "utf8");
		if (result.length > 0 && bytes + size > options.maxBytes) {
			truncated = true;
			break;
		}
		if (result.length === 0 && size > options.maxBytes) {
			const shell = {
				sessionId: event.sessionId,
				seq: event.seq,
				time: event.time,
				type: event.type
			};
			result.push(shell);
			bytes += Buffer.byteLength(JSON.stringify(shell), "utf8");
			truncated = true;
			break;
		}
		result.push(event);
		bytes += size;
	}
	return {
		events: direction === "tail" ? result.reverse() : result,
		truncated
	};
}
function validateV3SessionId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new TypeError("sessionId must be a bounded non-empty string");
}
function validateV3HistoryRequest(request, options) {
	if (typeof request !== "object" || request === null) throw new TypeError("payload must be an object");
	validateV3SessionId(request.sessionId);
	if (request.beforeSeq !== void 0 && (!Number.isInteger(request.beforeSeq) || request.beforeSeq < 0)) throw new TypeError("beforeSeq must be a non-negative integer");
	if (request.maxMessages !== void 0 && (!Number.isInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > options.maxEvents)) throw new TypeError(`maxMessages must be between 1 and ${String(options.maxEvents)}`);
}
async function readMobileV3History(controllerOrContext, request, state, options = defaultV3Options(state), signal) {
  const effectiveSignal = signal ?? (isAbortSignal(options) ? options : undefined) ?? new AbortController().signal
  const releaseBootstrap = state?.acquireBootstrap === undefined
    ? undefined
    : await state.acquireBootstrap(effectiveSignal, request?.sessionId)
  try {
    return await readMobileV3HistoryCore(controllerOrContext, request, state, options, effectiveSignal)
  } finally {
    releaseBootstrap?.()
  }
}

async function readMobileV3HistoryCore(controllerOrContext, request, state, options = defaultV3Options(state), signal) {
  validateV3HistoryRequest(request, options);
  const controller = controllerOrContext?.sessionController ?? controllerOrContext;
  if (!controller || typeof controller.follow !== "function" || typeof controller.page !== "function") throw new TypeError("sessionController with follow and page is required");
  installDetailLoader(controllerOrContext, state, options);
	const effectiveSignal = signal ?? (isAbortSignal(options) ? options : undefined) ?? new AbortController().signal;
	throwIfAborted(effectiveSignal);
	let opening;
	let address;
	try {
		address = await resolveSessionAddress(controllerOrContext, request.sessionId, state, effectiveSignal);
		opening = await openSessionSnapshot(controller, address, request.maxMessages ?? options.maxEvents, effectiveSignal);
	}
	catch (error) { throwOrReturnCancellation(error, effectiveSignal); return { ok: false, error: safePublicError(error) }; }
	let records = opening.records;
	let hasMore = opening.hasMore;
	let projections = opening.projections;
	if (request.beforeSeq !== void 0) {
		try {
			const page = unwrapControllerValue(await raceAbort(Promise.resolve(controller.page({ address, throughSeq: opening.cursor, beforeSeq: request.beforeSeq, maxMessages: request.maxMessages ?? options.maxEvents }, effectiveSignal)), effectiveSignal));
			if (!page || !Array.isArray(page.records) || typeof page.hasMore !== "boolean") throw new BaselineRecoveryError("invalid-history-page");
			records = page.records;
			hasMore = page.hasMore;
			projections = page.projections ?? projections;
		} catch (error) { throwOrReturnCancellation(error, effectiveSignal); return { ok: false, error: safePublicError(error) }; }
	}
	let entries;
	try { entries = decodeHistoryRecords(records, opening.cursor, request.beforeSeq); }
	catch (error) { return { ok: false, error: safePublicError(error) }; }
	const converted = entries.map((entry) => convertMobileHistoryEntry(entry, request.sessionId, state, options));
	for (const event of converted) state.rememberConvertedEvent(event);
	if (request.beforeSeq === void 0) state.updateWatermark(request.sessionId, opening.cursor, "history");
	const fitted = fitV3Events(converted.slice().sort((a, b) => a.seq - b.seq), state, options, "tail");
	const actualMore = hasMore || fitted.truncated;
	const nextBeforeSeq = actualMore ? fitted.events[0]?.seq ?? entries[0]?.event?.seq : void 0;
	const watermark = state.getWatermark(request.sessionId);
	const normalizedProjections = normalizeMobileProjectionBlock(projections);
	return { ok: true, value: {
		sessionId: request.sessionId,
		events: fitted.events,
		hasMore: actualMore,
		...nextBeforeSeq === void 0 ? {} : { nextBeforeSeq },
		lastSeq: watermark?.lastSeq ?? opening.cursor,
		lastSeqKnown: true,
		...normalizedProjections === void 0 ? {} : { projections: normalizedProjections },
	} };
}
async function readMobileV3Delta(controllerOrContext, request, state, options = defaultV3Options(state), signal) {
	validateDeltaRequest(request, options.maxEvents);
	installDetailLoader(controllerOrContext, state, options);
	const result = await readSessionDelta(controllerOrContext, request, {
		maxEvents: options.maxEvents,
		scanPageMessages: options.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES,
		maxScanPages: options.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES,
	}, signal, state);
	if (!result.ok) return { ok: false, error: rpcErrorOf(result) };
	const delta = result.value;
	if (delta.lastSeqKnown !== false && Number.isInteger(delta.lastSeq)) state.updateWatermark(request.sessionId, delta.lastSeq, "history");
	const converted = delta.events.map((entry) => convertMobileHistoryEntry(entry, request.sessionId, state, options));
	for (const event of converted) state.rememberConvertedEvent(event);
	const fitted = fitV3Events(converted, state, options);
	const throughSeq = fitted.events.at(-1)?.seq ?? request.afterSeq;
	const lastSeqKnown = delta.lastSeqKnown !== false;
	const projections = normalizeMobileProjectionBlock(delta.projections);
	return { ok: true, value: {
		sessionId: request.sessionId,
		acknowledgedSeq: delta.acknowledgedSeq,
		...fitted.events[0]?.seq === void 0 ? {} : { firstSeq: fitted.events[0].seq },
		throughSeq,
		...lastSeqKnown ? { lastSeq: delta.lastSeq } : {},
		lastSeqKnown,
		caughtUp: lastSeqKnown && !fitted.truncated && delta.caughtUp,
		scanLimitReached: delta.scanLimitReached,
		hasMore: !lastSeqKnown ? fitted.truncated : fitted.truncated || delta.throughSeq < delta.lastSeq,
		...(delta.baselineRequired === true ? { baselineRequired: true, baselineReason: delta.baselineReason } : {}),
		events: fitted.events,
		...projections === void 0 ? {} : { projections },
	} };
}
async function readMobileV3Snapshot(controllerOrContext, state, signal) {
	// Snapshot is a lightweight, non-blocking baseline. Cold tails are owned by
	// the process-wide background watcher, not scheduled by this request.
	const watermarkIndex = { getWatermark: (sessionId) => state?.getWatermark?.(sessionId) };
	const result = await readSessionSyncSnapshot(controllerOrContext, { watermarkIndex }, signal);
	if (!result.ok) return { ok: false, error: rpcErrorOf(result) };
	const sessions = result.value.sessions.map((item) => item.unknown === true ? {
		sessionId: item.sessionId,
		authoritative: false,
		unknown: true,
		pending: true,
	} : {
		sessionId: item.sessionId,
		lastSeq: item.lastSeq,
		authoritative: true,
	});
	return { ok: true, value: {
		protocolVersion: 3,
		capability: MOBILE_SESSION_V3_CAPABILITY,
		snapshotId: result.value.snapshotId,
		observedAt: result.value.observedAt,
		partial: sessions.some((item) => item.unknown === true),
		sessions,
	} };
}
async function* readMobileV3Events(source, state, options = {}, signal) {
	let backgroundSource = source;
	if (source && typeof source === "object" && source.sessionController !== void 0) {
		const addressBook = ownDataProperty(source, 'addressBook')
		const configuredEventSource = ownDataProperty(source, 'eventSource')
		const eventSource = configuredEventSource === undefined && typeof ownDataProperty(source, 'on') === 'function'
			? source
			: configuredEventSource
		backgroundSource = {
			sessionController: source.sessionController,
			workspaceController: source.workspaceController,
			subagents: source.subagents,
			...(eventSource === undefined ? {} : { eventSource }),
			...(addressBook === undefined ? {} : { addressBook }),
		};
	}
	state.startBackground(backgroundSource, options);
	const iterator = state.subscribe(options)[Symbol.asyncIterator]();
	const onAbort = () => {
		iterator.return?.();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (signal?.aborted !== true) {
			const next = await iterator.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await iterator.return?.();
	}
}
async function readMobileV3Details(state, request, options = defaultV3Options(state), signal) {
	const effectiveSignal = signal ?? new AbortController().signal;
	throwIfAborted(effectiveSignal);
	validateV3SessionId(request.sessionId);
	if (!Number.isInteger(request.seq) || request.seq < 0) throw new TypeError("seq must be a non-negative integer");
	if (!Number.isInteger(request.version) || request.version !== 1) throw new TypeError("unsupported detail version");
	const field = request.field ?? "event";
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(field)) throw new TypeError("field must be bounded");
	const offset = request.offset ?? 0;
	const limit = Math.min(request.limit ?? options.maxDetailChunkBytes, options.maxDetailChunkBytes);
	if (!Number.isInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
	if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be positive");
	const ref = {
		seq: request.seq,
		version: request.version,
		field
	};
	const detail = await state.resolveDetail(request.sessionId, ref, effectiveSignal);
	if (detail === void 0 || detail.text === void 0) return {
		ok: false,
		error: {
			code: "internal",
			message: "detail unavailable",
			details: {}
		}
	};
	const points = Array.from(detail.text);
	const totalBytes = detail.totalBytes;
	const requestedOffset = Math.min(offset, totalBytes);
	let start = 0;
	let startOffset = 0;
	while (start < points.length && startOffset < requestedOffset) {
		const width = Buffer.byteLength(points[start], "utf8");
		if (startOffset + width > requestedOffset) throw new TypeError("offset must be a UTF-8 boundary");
		startOffset += width;
		start += 1;
	}
	let end = start;
	let bytes = 0;
	let nextOffset = startOffset;
	while (end < points.length) {
		const next = points[end];
		const nextBytes = Buffer.byteLength(next, "utf8");
		if (bytes > 0 && bytes + nextBytes > limit) break;
		bytes += nextBytes;
		nextOffset += nextBytes;
		end += 1;
	}
	const text = points.slice(start, end).join("");
	return {
		ok: true,
		value: {
			sessionId: request.sessionId,
			seq: request.seq,
			version: request.version,
			field,
			contentType: detail.contentType,
			offset: startOffset,
			nextOffset,
			totalBytes,
			done: nextOffset >= totalBytes,
			text
		}
	};
}
function unwrapV3Message(message) {
	const value = asRecord(message) ?? {};
	if (value.type === "client-request" && asRecord(value.payload) !== void 0) {
		const rpcId = stringValue(value.rpcId);
		return {
			...rpcId === void 0 ? {} : { rpcId },
			payload: asRecord(value.payload)
		};
	}
	const rpcId = stringValue(value.rpcId);
	const payload = { ...value };
	delete payload.rpcId;
	return {
		...rpcId === void 0 ? {} : { rpcId },
		payload
	};
}
function v3Failure(code, message, details = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			details
		}
	};
}
function sendV3Result(res, status, rpcId, result, maxBytes) {
	sendJson(res, status, rpcId === void 0 ? result : {
		type: "server-response",
		rpcId,
		result
	}, maxBytes);
}
function parseUrl(req) {
	return new URL(req.url ?? "/", "http://127.0.0.1");
}
function handleV3DescribeRequest(ctx, req, res, maxRequestBytes, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'GET') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  let diagnostics
  try {
    if (parseUrl(req).searchParams.get('diagnostics') === 'true') diagnostics = state?.getDiagnostics?.()
  } catch { /* an invalid query simply keeps diagnostics out of the response */ }
  return sendJson(res, 200, {
    protocolVersion: MOBILE_SESSION_V3_PROTOCOL_VERSION,
    capability: MOBILE_SESSION_V3_CAPABILITY,
    compatibility: { v2: true, rc1Controllers: true },
    limits: {
      maxRequestBytes,
      maxResponseBytes: options.maxResponseBytes,
      maxEvents: options.maxEvents,
      maxBytes: options.maxBytes,
      maxInlineBytes: options.maxInlineBytes,
      maxDetailChunkBytes: options.maxDetailChunkBytes,
      maxHistoryPages: options.maxHistoryPages,
      maxDetailCacheBytes: options.maxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES,
      maxSubscriberQueue: options.maxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE,
      maxSubscriberBytes: options.maxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES,
    },
    routes: {
      snapshot: MOBILE_SESSION_V3_SNAPSHOT_PATH,
      delta: MOBILE_SESSION_V3_DELTA_PATH,
      history: MOBILE_SESSION_V3_HISTORY_PATH,
      events: MOBILE_SESSION_V3_EVENTS_PATH,
      details: MOBILE_SESSION_V3_DETAILS_PATH,
    },
    ...(diagnostics === undefined ? {} : { diagnostics }),
  }, options.maxResponseBytes)
}
async function readV3JsonBody(req, maxRequestBytes, signal) {
  const text = await readBody(req, maxRequestBytes, signal)
  if (text.trim() === '') return { payload: {} }
  return unwrapV3Message(JSON.parse(text))
}
async function handleV3JsonRequest(ctx, req, res, maxRequestBytes, options, operation) {
  const lifetime = createRequestLifetime(req, res, options.requestTimeoutMs)
  let rpcId
  try {
    const message = await raceAbort(readV3JsonBody(req, maxRequestBytes, lifetime.signal), lifetime.signal)
    rpcId = typeof message?.rpcId === 'string' && message.rpcId.length > 0 ? message.rpcId : undefined
    const result = await operation(message?.payload ?? {}, lifetime.signal)
    if (lifetime.timedOut) return sendJson(res, 408, { error: 'request timeout' }, options.maxResponseBytes)
    if (lifetime.clientClosed) return
    if (result?.ok === true) return sendV3Result(res, 200, rpcId, result.value, options.maxResponseBytes)
    const error = result?.error ?? {}
    const safe = safePublicError(error)
    return sendV3Result(res, 400, rpcId, v3Failure(
      safe.code,
      safe.message,
      safe.details ?? {},
    ), options.maxResponseBytes)
  } catch (error) {
    if (lifetime.clientClosed) return
    if (lifetime.timedOut) return sendJson(res, 408, { error: 'request timeout' }, options.maxResponseBytes)
    if (error instanceof RequestTooLargeError) return sendJson(res, 413, { error: 'request body too large' }, options.maxResponseBytes)
    if (isAbortError(error)) return
    return sendV3Result(res, 400, rpcId, v3Failure('bad-request', 'invalid request'), options.maxResponseBytes)
  } finally {
    lifetime.dispose()
  }
}
async function handleV3SnapshotRequest(ctx, req, res, maxRequestBytes, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  if (!isJsonContentType(req)) return sendJson(res, 415, v3Failure('unsupported-media-type', 'content type must be application/json'), options.maxResponseBytes)
  return handleV3JsonRequest(ctx, req, res, maxRequestBytes, options, (_payload, signal) =>
    readMobileV3Snapshot(ctx, state, signal))
}
async function handleV3DeltaRequest(ctx, req, res, maxRequestBytes, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  if (!isJsonContentType(req)) return sendJson(res, 415, v3Failure('unsupported-media-type', 'content type must be application/json'), options.maxResponseBytes)
  return handleV3JsonRequest(ctx, req, res, maxRequestBytes, options, (payload, signal) =>
    readMobileV3Delta(ctx, payload, state, options, signal))
}
async function handleV3HistoryRequest(ctx, req, res, maxRequestBytes, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  if (!isJsonContentType(req)) return sendJson(res, 415, v3Failure('unsupported-media-type', 'content type must be application/json'), options.maxResponseBytes)
  return handleV3JsonRequest(ctx, req, res, maxRequestBytes, options, (payload, signal) =>
    readMobileV3History(ctx, payload, state, options, signal))
}
function waitForV3Drain(res, signal) {
  if (signal.aborted || res.writableEnded || res.destroyed) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      res.removeListener?.('drain', onDrain)
      res.removeListener?.('close', onClose)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onDrain = () => finish(true)
    const onClose = () => finish(false)
    const onAbort = () => finish(false)
    res.once?.('drain', onDrain)
    res.once?.('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
async function writeV3SseFrame(res, event, signal) {
  if (signal.aborted || res.writableEnded || res.destroyed) return false
  const payload = `data: ${JSON.stringify(event)}\n\n`
  if (typeof res.write !== 'function') return false
  return res.write(payload) || await waitForV3Drain(res, signal)
}
async function handleV3EventsRequest(ctx, req, res, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'GET') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  let sessionId
  let sinceSeq
  try {
    const url = parseUrl(req)
    sessionId = url.searchParams.get('sessionId') ?? undefined
    const sinceRaw = url.searchParams.get('sinceSeq')
    sinceSeq = sinceRaw === null ? undefined : Number(sinceRaw)
    if (sessionId !== undefined) validateV3SessionId(sessionId)
    if (sinceSeq !== undefined && (!Number.isSafeInteger(sinceSeq) || sinceSeq < -1)) throw new TypeError('invalid sinceSeq')
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid events request'), options.maxResponseBytes)
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  })
  // Node keeps writeHead() buffered until the first body write.  An idle SSE
  // stream must still complete its HTTP handshake immediately, otherwise a
  // client waits for the server keep-alive timeout before seeing 200.
  flushSseHeaders(res)
  const controller = new AbortController()
  const onRequestClose = () => controller.abort()
  req.once?.('aborted', onRequestClose)
  req.once?.('close', onRequestClose)
  res.once?.('close', onRequestClose)
  try {
    for await (const event of readMobileV3Events(ctx, state, {
      channel: 'v3',
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sinceSeq === undefined ? {} : { sinceSeq }),
    }, controller.signal)) {
      if (controller.signal.aborted || res.writableEnded) break
      if (!await writeV3SseFrame(res, event, controller.signal)) break
    }
  } catch {
    if (!res.writableEnded && !controller.signal.aborted) await writeV3SseFrame(res, {
      sessionId: '', type: 'control/stream-error', time: Date.now(), body: { failureKind: 'stream-error' },
    }, controller.signal)
  } finally {
    req.removeListener?.('aborted', onRequestClose)
    req.removeListener?.('close', onRequestClose)
    res.removeListener?.('close', onRequestClose)
    if (!res.writableEnded) res.end()
  }
}
async function handleV3DetailsRequest(ctx, req, res, maxRequestBytes, state, options) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'), options.maxResponseBytes)
  if (req.method === 'POST') {
    if (!isJsonContentType(req)) return sendJson(res, 415, v3Failure('unsupported-media-type', 'content type must be application/json'), options.maxResponseBytes)
    return handleV3JsonRequest(ctx, req, res, maxRequestBytes, options, (payload, signal) => readMobileV3Details(state, payload, options, signal))
  }
  let lifetime
  try {
    const url = parseUrl(req)
    const payload = {
      sessionId: url.searchParams.get('sessionId') ?? '',
      seq: Number(url.searchParams.get('seq')),
      version: Number(url.searchParams.get('version') ?? '1'),
      ...(url.searchParams.get('field') === null ? {} : { field: url.searchParams.get('field') }),
      ...(url.searchParams.get('offset') === null ? {} : { offset: Number(url.searchParams.get('offset')) }),
      ...(url.searchParams.get('limit') === null ? {} : { limit: Number(url.searchParams.get('limit')) }),
    }
    lifetime = createRequestLifetime(req, res, options.requestTimeoutMs)
    const result = await readMobileV3Details(state, payload, options, lifetime.signal)
    if (lifetime.timedOut) return sendJson(res, 408, { error: 'request timeout' }, options.maxResponseBytes)
    if (lifetime.clientClosed) return
    return sendV3Result(res, result.ok ? 200 : 404, undefined, result.ok ? result.value : v3Failure('detail-not-found', 'detail unavailable'), options.maxResponseBytes)
  } catch (error) {
    if (lifetime?.timedOut) return sendJson(res, 408, { error: 'request timeout' }, options.maxResponseBytes)
    if (lifetime?.clientClosed || isAbortError(error)) return
    return sendJson(res, 400, v3Failure('bad-request', 'invalid detail request'), options.maxResponseBytes)
  } finally {
    lifetime?.dispose()
  }
}
/** Share the existing ordered mux without a second connection or background synchronizer. */
export function createMobileSessionEvents(state) {
  return Object.freeze({
    async * subscribe({ sessionId, signal } = {}) {
      if (signal?.aborted) return;
      const iterator = state.subscribe({ sessionId, channel: 'mux' })[Symbol.asyncIterator]();
      const stop = () => { iterator.return?.(); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        while (!signal?.aborted) {
          const next = await iterator.next();
          if (next.done) break;
          const frame = compatServerRequestFromEvent(next.value, 'mux');
          if (frame) yield frame;
        }
      } finally {
        signal?.removeEventListener('abort', stop);
        await iterator.return?.();
      }
    },
  });
}
function compatServerRequestFromEvent(event, kind) {
	if (kind === 'host') {
		const payload = cloneJson(event?.hostFrame);
		if (!asRecord(payload)) return undefined;
		const wirePayload = payload.type === 'api-session/status'
			? { sessionId: payload.sessionId, running: payload.running }
			: payload;
		return {
			type: 'server-request',
			rpcId: 'mobile-host-stream',
			method: payload.type === 'api-session/status' ? 'api-session/status' : 'workspace/follow',
			payload: wirePayload,
		};
	}
	if (event?.serverRequest) return cloneJson(event.serverRequest)
  const body = controlBody(event ?? {})
  const sessionId = event?.sessionId ?? ''
  if (event?.type === 'control/session-subscribed') return {
    type: 'server-request', rpcId: `session-${sessionId || 'unknown'}-subscribed`, method: 'session/subscribed',
    payload: { sessionId, lastSeq: body.lastSeq },
  }
  if (event?.type === 'control/session/queue') return {
    type: 'server-request', rpcId: `session-${sessionId || 'unknown'}-queue`, method: 'session/queue',
    payload: { sessionId, items: body.items ?? [] },
  }
  if (event?.type === 'control/session/jobs') return {
    type: 'server-request', rpcId: `session-${sessionId || 'unknown'}-jobs`, method: 'session/jobs',
    payload: { sessionId, jobs: body.jobs ?? [] },
  }
  if (event?.type === 'control/session-projection') return {
    type: 'server-request', rpcId: `session-${sessionId || 'unknown'}-projection-${body.key ?? 'unknown'}`, method: 'session/projection',
    payload: { sessionId, key: body.key, ...(body.seq === undefined ? {} : { seq: body.seq }), ...(body.value === undefined ? {} : { value: body.value }) },
  }
  if (event?.type === 'control/approval/requested' || event?.type === 'control/approval/resolved') return {
    type: 'server-request', rpcId: body.approvalId ?? body.requestRpcId ?? 'mobile-approval', method: event.type.slice('control/'.length),
    payload: { sessionId, ...cloneJson(body) },
  }
  if (event?.type === 'control/question/requested' || event?.type === 'control/question/resolved') return {
    type: 'server-request', rpcId: body.questionRpcId ?? 'mobile-question', method: event.type.slice('control/'.length),
    payload: { sessionId, ...cloneJson(body) },
  }
  if (event?.type === 'control/stream-error') return {
    type: 'server-request', rpcId: 'mobile-stream-error', method: 'stream/error', payload: { sessionId, error: body },
  }
  if (event?.sessionId !== undefined && event?.seq !== undefined) return {
    type: 'server-request', rpcId: `session-${sessionId}-${event.seq}`, method: 'session/event',
    payload: { sessionId, event: {
      type: event.type, seq: event.seq, time: event.time,
      ...(body.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: body.sourceEventSeqs }),
      ...(body.surfaceOp === undefined ? {} : { surfaceOp: body.surfaceOp }),
      data: Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'sourceEventSeqs' && key !== 'surfaceOp')),
    } },
  }
  return undefined
}
async function handleCompatEventsRequest(ctx, req, res, state, options, kind) {
  if (!authorizeHttpRequest(ctx, req, res, options.maxResponseBytes)) return
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, options.maxResponseBytes)
  let sessionId
  let sinceSeq
  try {
    const url = parseUrl(req)
    sessionId = url.searchParams.get('sessionId') ?? undefined
    const raw = url.searchParams.get('sinceSeq')
    sinceSeq = raw === null ? undefined : Number(raw)
    if (sessionId !== undefined) validateV3SessionId(sessionId)
    if (sinceSeq !== undefined && (!Number.isSafeInteger(sinceSeq) || sinceSeq < -1)) throw new TypeError('invalid sinceSeq')
  } catch {
    return sendJson(res, 400, { error: 'bad request' }, options.maxResponseBytes)
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive' })
  // See handleV3EventsRequest: an idle compatibility stream must flush its
  // headers before waiting for a controller/interaction event.
  flushSseHeaders(res)
  const controller = new AbortController()
  const onClose = () => controller.abort()
  req.once?.('aborted', onClose)
  req.once?.('close', onClose)
  res.once?.('close', onClose)
  try {
    for await (const event of readMobileV3Events(ctx, state, { channel: kind, ...(sessionId === undefined ? {} : { sessionId }), ...(sinceSeq === undefined ? {} : { sinceSeq }) }, controller.signal)) {
      const frame = compatServerRequestFromEvent(event, kind)
      if (frame && !await writeV3SseFrame(res, frame, controller.signal)) break
    }
  } catch {
    if (!controller.signal.aborted && !res.writableEnded) await writeV3SseFrame(res, { type: 'server-request', rpcId: 'mobile-stream-error', method: 'stream/error', payload: { error: { code: 'stream-error' } } }, controller.signal)
  } finally {
    req.removeListener?.('aborted', onClose)
    req.removeListener?.('close', onClose)
    res.removeListener?.('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

function flushSseHeaders(res) {
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}
//#endregion
export { Config, MOBILE_EVENTS_HOST_PATH, MOBILE_EVENTS_MUX_PATH, MOBILE_SESSION_DELTA_PATH, MOBILE_SESSION_SYNC_CAPABILITY, MOBILE_SESSION_SYNC_DESCRIBE_PATH, MOBILE_SESSION_SYNC_PROTOCOL_VERSION, MOBILE_SESSION_SYNC_SNAPSHOT_PATH, MOBILE_SESSION_V3_BASE_PATH, MOBILE_SESSION_V3_CAPABILITY, MOBILE_SESSION_V3_DELTA_PATH, MOBILE_SESSION_V3_DESCRIBE_PATH, MOBILE_SESSION_V3_DETAILS_PATH, MOBILE_SESSION_V3_EVENTS_PATH, MOBILE_SESSION_V3_HISTORY_PATH, MOBILE_SESSION_V3_PROTOCOL_VERSION, MOBILE_SESSION_V3_SNAPSHOT_PATH, MobileSessionSyncState, apply, convertMobileHistoryEntry, convertMobileMuxFrame, inject, name, normalizeMobileProjectionBlock, readMobileV3Delta, readMobileV3Details, readMobileV3Events, readMobileV3History, readMobileV3Snapshot, readSessionDelta, readSessionSyncSnapshot, readSessionTailWatermark };
