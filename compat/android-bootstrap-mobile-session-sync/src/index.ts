/** Loopback-only sequence-cursor delta transport for native mobile clients. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RpcId, type ApiProxy, type HistoryEntry, type RpcError, type RpcResult } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const name = 'mobile-session-sync'
export const inject = ['webServer', 'apiProxy']
export const MOBILE_SESSION_DELTA_PATH = '/api/mobile.sessionDelta'
export const MOBILE_SESSION_SYNC_DESCRIBE_PATH = '/api/mobile.sessionSyncDescribe'
export const MOBILE_SESSION_SYNC_SNAPSHOT_PATH = '/api/mobile.sessionSyncSnapshot'

/** v3 is intentionally a separate lightweight transport; it does not extend the core RPC map. */
export const MOBILE_SESSION_V3_BASE_PATH = '/api/mobile/v3'
export const MOBILE_SESSION_V3_DESCRIBE_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/describe`
export const MOBILE_SESSION_V3_SNAPSHOT_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/snapshot`
export const MOBILE_SESSION_V3_DELTA_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/delta`
export const MOBILE_SESSION_V3_HISTORY_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/history`
export const MOBILE_SESSION_V3_EVENTS_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/events`
export const MOBILE_SESSION_V3_DETAILS_PATH = `${MOBILE_SESSION_V3_BASE_PATH}/details`

export const MOBILE_SESSION_SYNC_PROTOCOL_VERSION = 2
export const MOBILE_SESSION_SYNC_CAPABILITY = 'mobile-session-sync-v2'
export const MOBILE_SESSION_V3_PROTOCOL_VERSION = 3
export const MOBILE_SESSION_V3_CAPABILITY = 'mobile-session-sync-v3'

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_MAX_EVENTS = 512
const DEFAULT_SCAN_PAGE_MESSAGES = 24
const DEFAULT_MAX_SCAN_PAGES = 32
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

export interface Config {
  maxRequestBytes?: number
  maxEvents?: number
  scanPageMessages?: number
  maxScanPages?: number
  v3MaxEvents?: number
  v3MaxBytes?: number
  v3MaxInlineBytes?: number
  v3MaxDetailChunkBytes?: number
  v3MaxHistoryPages?: number
  v3MaxCachedEvents?: number
  v3MaxDetailCacheBytes?: number
  v3MaxSubscriberQueue?: number
  v3MaxSubscriberBytes?: number
}

export const Config: z<Config> = z.object({
  maxRequestBytes: z.natural().min(1024).default(DEFAULT_MAX_REQUEST_BYTES),
  maxEvents: z.natural().min(1).max(4096).default(DEFAULT_MAX_EVENTS),
  scanPageMessages: z.natural().min(1).max(256).default(DEFAULT_SCAN_PAGE_MESSAGES),
  maxScanPages: z.natural().min(1).max(256).default(DEFAULT_MAX_SCAN_PAGES),
  v3MaxEvents: z.natural().min(1).max(DEFAULT_V3_MAX_EVENTS).default(DEFAULT_V3_MAX_EVENTS),
  v3MaxBytes: z.natural().min(1024).max(DEFAULT_V3_MAX_BYTES).default(DEFAULT_V3_MAX_BYTES),
  v3MaxInlineBytes: z.natural().min(256).max(DEFAULT_V3_MAX_INLINE_BYTES).default(DEFAULT_V3_MAX_INLINE_BYTES),
  v3MaxDetailChunkBytes: z.natural().min(256).max(DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES).default(DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES),
  v3MaxHistoryPages: z.natural().min(1).max(256).default(DEFAULT_V3_MAX_HISTORY_PAGES),
  v3MaxCachedEvents: z.natural().min(128).max(8192).default(DEFAULT_V3_MAX_CACHED_EVENTS),
  v3MaxDetailCacheBytes: z.natural().min(64 * 1024).max(64 * 1024 * 1024).default(DEFAULT_V3_MAX_DETAIL_CACHE_BYTES),
  v3MaxSubscriberQueue: z.natural().min(8).max(4096).default(DEFAULT_V3_MAX_SUBSCRIBER_QUEUE),
  v3MaxSubscriberBytes: z.natural().min(1024).max(DEFAULT_V3_MAX_BYTES).default(DEFAULT_V3_MAX_SUBSCRIBER_BYTES),
})

export interface SessionDeltaRequest {
  sessionId: string
  afterSeq: number
  maxEvents?: number
}

export interface SessionDeltaValue {
  acknowledgedSeq: number
  firstSeq?: number
  throughSeq: number
  lastSeq: number
  /** False means lastSeq is only the caller's lower bound, not a live tail. */
  lastSeqKnown?: boolean
  caughtUp: boolean
  scanLimitReached: boolean
  events: HistoryEntry[]
  projections?: unknown
}

export interface SessionSyncSnapshotValue {
  protocolVersion: number
  snapshotId: string
  observedAt: number
  sessions: Array<{
    sessionId: string
    /** Absent when the host has not yet proved the cold tail. */
    lastSeq?: number
    /** True only for a mux or tail-history watermark. v2 clients may ignore this extension. */
    authoritative?: boolean
    /** Unknown is not an empty log; clients must schedule a normal history read. */
    unknown?: true
  }>
}

interface DeltaOptions {
  maxEvents: number
  scanPageMessages: number
  maxScanPages: number
  watermarkIndex?: WatermarkIndexLike
}

/** Read later events from contiguous history pages and preserve Host `seq` order verbatim. */
export async function readSessionDelta(
  sessions: ApiProxy['sessions'],
  request: SessionDeltaRequest,
  options: DeltaOptions,
): Promise<RpcResult<SessionDeltaValue>> {
  validateDeltaRequest(request, options.maxEvents)
  const rpcId = RpcId(`mobile-delta-${randomUUID()}`)
  const pages: HistoryEntry[][] = []
  let beforeSeq: number | undefined
  let hasMore = true
  let tailLastSeq = request.afterSeq
  let tailLastSeqKnown = false
  let tailProjections: unknown

  for (let pageIndex = 0; pageIndex < options.maxScanPages && hasMore; pageIndex += 1) {
    const response = await sessions.history({
      rpcId,
      payload: {
        sessionId: request.sessionId as SessionId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: options.scanPageMessages,
      },
    })
    const pageResult = response.result
    if (!pageResult.ok) return { ok: false, error: rpcErrorOf(pageResult) }
    const page = pageResult.value
    const ordered = [...page.events].sort((left, right) => left.event.seq - right.event.seq)
    if (beforeSeq === undefined) {
      tailProjections = page.projections
      if (ordered.length > 0) {
        // The tail page is a live-history cut; its greatest event seq is the
        // only history-derived watermark. Do not clamp it to afterSeq: a
        // caller may legitimately hold a baseline newer than a short log.
        tailLastSeq = Math.max(...ordered.map(entry => entry.event.seq))
        tailLastSeqKnown = true
      } else if (!page.hasMore) {
        tailLastSeq = -1
        tailLastSeqKnown = true
      }
    }
    pages.unshift(ordered)
    const oldest = ordered[0]?.event.seq
    if (oldest === undefined || oldest <= request.afterSeq || !page.hasMore) {
      hasMore = false
      break
    }
    beforeSeq = oldest
  }

  const indexed = options.watermarkIndex?.getWatermark(request.sessionId)
  if (indexed !== undefined) {
    tailLastSeq = indexed.lastSeq
    tailLastSeqKnown = true
  }

  const later = dedupeBySeq(pages.flat()).filter(entry => entry.event.seq > request.afterSeq)
  if (hasMore && later[0]?.event.seq !== request.afterSeq + 1) {
    return {
      ok: true,
      value: {
        acknowledgedSeq: request.afterSeq,
        throughSeq: request.afterSeq,
        lastSeq: tailLastSeq,
        ...(tailLastSeqKnown ? {} : { lastSeqKnown: false }),
        caughtUp: false,
        scanLimitReached: true,
        events: [],
        ...(tailProjections === undefined ? {} : { projections: tailProjections }),
      },
    }
  }
  const requestedLimit = request.maxEvents ?? options.maxEvents
  const events = later.slice(0, requestedLimit)
  const throughSeq = events.at(-1)?.event.seq ?? request.afterSeq
  return {
    ok: true,
    value: {
      acknowledgedSeq: request.afterSeq,
      ...(events[0] === undefined ? {} : { firstSeq: events[0].event.seq }),
      throughSeq,
      lastSeq: tailLastSeq,
      ...(tailLastSeqKnown ? {} : { lastSeqKnown: false }),
      caughtUp: tailLastSeqKnown && throughSeq >= tailLastSeq,
      scanLimitReached: false,
      events,
      ...(tailProjections === undefined ? {} : { projections: tailProjections }),
    },
  }
}

/** Register the exact loopback route ahead of the generic `/api` prefix. */
export function apply(ctx: Context, config?: Config): void {
  const syncState = new MobileSessionSyncState({
    maxInlineBytes: config?.v3MaxInlineBytes ?? DEFAULT_V3_MAX_INLINE_BYTES,
    maxDetailChunkBytes: config?.v3MaxDetailChunkBytes ?? DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES,
    maxCachedEvents: config?.v3MaxCachedEvents ?? DEFAULT_V3_MAX_CACHED_EVENTS,
    maxDetailCacheBytes: config?.v3MaxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES,
    maxSubscriberQueue: config?.v3MaxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE,
    maxSubscriberBytes: config?.v3MaxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES,
  })
  const options: DeltaOptions = {
    maxEvents: config?.maxEvents ?? DEFAULT_MAX_EVENTS,
    scanPageMessages: config?.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES,
    maxScanPages: config?.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES,
    watermarkIndex: syncState,
  }
  const v3Options: V3Options = {
    maxEvents: config?.v3MaxEvents ?? DEFAULT_V3_MAX_EVENTS,
    maxBytes: config?.v3MaxBytes ?? DEFAULT_V3_MAX_BYTES,
    maxInlineBytes: config?.v3MaxInlineBytes ?? DEFAULT_V3_MAX_INLINE_BYTES,
    maxDetailChunkBytes: config?.v3MaxDetailChunkBytes ?? DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES,
    maxHistoryPages: config?.v3MaxHistoryPages ?? DEFAULT_V3_MAX_HISTORY_PAGES,
    maxDetailCacheBytes: config?.v3MaxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES,
    maxSubscriberQueue: config?.v3MaxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE,
    maxSubscriberBytes: config?.v3MaxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES,
  }
  const maxRequestBytes = config?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  ctx.effect(() => {
    syncState.startMux(ctx.apiProxy)
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_DELTA_PATH,
        handler: (req, res) => handleDeltaRequest(ctx.apiProxy, req, res, options, maxRequestBytes),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_SYNC_DESCRIBE_PATH,
        handler: (req, res) => handleDescribeRequest(req, res, options, maxRequestBytes),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_SYNC_SNAPSHOT_PATH,
        handler: (req, res) => handleSnapshotRequest(ctx.apiProxy, req, res, maxRequestBytes, syncState),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_DESCRIBE_PATH,
        handler: (req, res) => handleV3DescribeRequest(req, res, maxRequestBytes, v3Options),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_SNAPSHOT_PATH,
        handler: (req, res) => handleV3SnapshotRequest(ctx.apiProxy, req, res, maxRequestBytes, syncState, v3Options),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_DELTA_PATH,
        handler: (req, res) => handleV3DeltaRequest(ctx.apiProxy, req, res, maxRequestBytes, syncState, v3Options),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_HISTORY_PATH,
        handler: (req, res) => handleV3HistoryRequest(ctx.apiProxy, req, res, maxRequestBytes, syncState, v3Options),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_EVENTS_PATH,
        handler: (req, res) => handleV3EventsRequest(ctx.apiProxy, req, res, syncState, v3Options),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: MOBILE_SESSION_V3_DETAILS_PATH,
        handler: (req, res) => handleV3DetailsRequest(req, res, maxRequestBytes, syncState, v3Options),
      }),
    ]
    return () => {
      disposers.reverse().forEach(dispose => dispose())
      syncState.dispose()
    }
  }, 'mobile-session-sync: v2/v3 routes')
}

function handleDescribeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DeltaOptions,
  maxRequestBytes: number,
): void {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' })
  sendJson(res, 200, {
    protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
    capability: MOBILE_SESSION_SYNC_CAPABILITY,
    limits: {
      maxRequestBytes,
      maxEvents: options.maxEvents,
      scanPageMessages: options.scanPageMessages,
      maxScanPages: options.maxScanPages,
    },
  })
}

export interface WatermarkEntry {
  lastSeq: number
  source: 'mux' | 'history'
  confirmedEmpty: boolean
}

export interface WatermarkIndexLike {
  getWatermark(sessionId: string): WatermarkEntry | undefined
  scheduleColdTail?(api: ApiProxy, sessionId: string): void
}

export interface SnapshotReadOptions {
  watermarkIndex?: WatermarkIndexLike
  scheduleColdTail?: (sessionId: string) => void
}

/** Capture one Host-side notification baseline without trusting the phone clock. */
export async function readSessionSyncSnapshot(
  api: ApiProxy,
  readOptions?: SnapshotReadOptions | WatermarkIndexLike,
): Promise<RpcResult<SessionSyncSnapshotValue>> {
  const snapshotId = randomUUID()
  const [listed, workspaces] = await Promise.all([
    api.sessions.list({ rpcId: RpcId(`mobile-snapshot-sessions-${snapshotId}`), payload: {} }),
    api.workspace.list({ rpcId: RpcId(`mobile-snapshot-workspaces-${snapshotId}`), payload: {} }),
  ])
  const listedResult = listed.result
  const workspaceResult = workspaces.result
  if (!listedResult.ok) return { ok: false, error: rpcErrorOf(listedResult) }
  if (!workspaceResult.ok) return { ok: false, error: rpcErrorOf(workspaceResult) }
  const archived = new Set<string>(workspaceResult.value.archivedSessionIds)
  const sessions: SessionSyncSnapshotValue['sessions'] = []

  const options: SnapshotReadOptions = readOptions === undefined
    ? {}
    : 'getWatermark' in readOptions
      ? { watermarkIndex: readOptions }
      : readOptions
  if (options.watermarkIndex !== undefined || options.scheduleColdTail !== undefined) {
    for (const summary of listedResult.value.items) {
      if (archived.has(summary.sessionId)) continue
      const indexed = options.watermarkIndex?.getWatermark(summary.sessionId)
      if (indexed !== undefined) {
        sessions.push({ sessionId: summary.sessionId, lastSeq: indexed.lastSeq, authoritative: true })
        continue
      }
      sessions.push({ sessionId: summary.sessionId, unknown: true, authoritative: false })
      if (options.scheduleColdTail !== undefined) options.scheduleColdTail(summary.sessionId)
      else options.watermarkIndex?.scheduleColdTail?.(api, summary.sessionId)
    }
    return {
      ok: true,
      value: {
        protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
        snapshotId,
        observedAt: Date.now(),
        sessions,
      },
    }
  }

  // Without the mounted authoritative index, probe each tail sequentially. A failed or
  // non-terminal probe remains unknown; projection checkpoints are not realtime watermarks.
  for (const summary of listedResult.value.items) {
    if (archived.has(summary.sessionId)) continue
    const tail = await readSessionTailWatermark(api, summary.sessionId)
    if (tail.kind === 'known') {
      sessions.push({ sessionId: summary.sessionId, lastSeq: tail.lastSeq, authoritative: true })
    } else {
      sessions.push({ sessionId: summary.sessionId, unknown: true, authoritative: false })
    }
  }
  return {
    ok: true,
    value: {
      protocolVersion: MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
      snapshotId,
      observedAt: Date.now(),
      sessions,
    },
  }
}

async function handleSnapshotRequest(
  api: ApiProxy,
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBytes: number,
  watermarkIndex?: WatermarkIndexLike,
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' })
  let message: any
  try {
    message = JSON.parse(await readBody(req, maxRequestBytes))
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
  }
  const rpcId = typeof message?.rpcId === 'string' && message.rpcId.length > 0 ? message.rpcId : 'invalid'
  if (message?.type !== 'client-request' || message?.method !== 'mobile.sessionSyncSnapshot') {
    return sendJson(res, 400, serverFailure(rpcId, 'invalid mobile.sessionSyncSnapshot request'))
  }
  try {
    const result = await readSessionSyncSnapshot(api, watermarkIndex === undefined ? undefined : { watermarkIndex })
    if (result.ok) {
      const unknownSessionIds = result.value.sessions.filter(item => item.unknown).map(item => item.sessionId)
      if (unknownSessionIds.length > 0) {
        // The fixed v2 Android decoder reads lastSeq as a number. A pending cold tail is not an
        // empty log, so fail fast and let the client retry after the background index settles.
        return sendJson(res, 503, {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'snapshot-pending',
              message: 'snapshot tail pending',
              details: { unknownSessionIds },
            },
          },
          unknownSessionIds,
        })
      }
    }
    return sendJson(res, 200, { type: 'server-response', rpcId, result })
  } catch (error) {
    return sendJson(res, 400, serverFailure(rpcId, error instanceof Error ? error.message : 'invalid request'))
  }
}

async function handleDeltaRequest(
  api: ApiProxy,
  req: IncomingMessage,
  res: ServerResponse,
  options: DeltaOptions,
  maxRequestBytes: number,
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' })
  let message: any
  try {
    message = JSON.parse(await readBody(req, maxRequestBytes))
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
  }
  const rpcId = typeof message?.rpcId === 'string' && message.rpcId.length > 0 ? message.rpcId : 'invalid'
  if (message?.type !== 'client-request' || message?.method !== 'mobile.sessionDelta') {
    return sendJson(res, 400, serverFailure(rpcId, 'invalid mobile.sessionDelta request'))
  }
  try {
    const result = await readSessionDelta(api.sessions, message.payload as SessionDeltaRequest, options)
    return sendJson(res, 200, { type: 'server-response', rpcId, result })
  } catch (error) {
    return sendJson(res, 400, serverFailure(rpcId, error instanceof Error ? error.message : 'invalid request'))
  }
}

function validateDeltaRequest(request: SessionDeltaRequest, configuredMaxEvents: number): void {
  if (typeof request !== 'object' || request === null) throw new TypeError('payload must be an object')
  if (typeof request.sessionId !== 'string' || request.sessionId.length === 0 || request.sessionId.length > 4096) {
    throw new TypeError('sessionId must be a bounded non-empty string')
  }
  if (!Number.isInteger(request.afterSeq) || request.afterSeq < -1) {
    throw new TypeError('afterSeq must be an integer greater than or equal to -1')
  }
  if (request.maxEvents !== undefined &&
      (!Number.isInteger(request.maxEvents) || request.maxEvents < 1 || request.maxEvents > configuredMaxEvents)) {
    throw new TypeError(`maxEvents must be between 1 and ${String(configuredMaxEvents)}`)
  }
}

function dedupeBySeq(entries: HistoryEntry[]): HistoryEntry[] {
  const bySeq = new Map<number, HistoryEntry>()
  for (const entry of entries) bySeq.set(entry.event.seq, entry)
  return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function serverFailure(rpcId: string, message: string): object {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read the failure arm across the core's generic RpcResult without leaking payload details. */
function rpcErrorOf(result: RpcResult<unknown>): RpcError {
  return (result as { ok: false; error: RpcError }).error
}

// ---------------------------------------------------------------------------
// mobile-session-sync-v3
// ---------------------------------------------------------------------------

export interface V3Options {
  maxEvents: number
  maxBytes: number
  maxInlineBytes: number
  maxDetailChunkBytes: number
  maxHistoryPages: number
  scanPageMessages?: number
  maxScanPages?: number
  maxDetailCacheBytes?: number
  maxSubscriberQueue?: number
  maxSubscriberBytes?: number
}

/** The projection block keeps the Host's values/asOfSeq shape, but only for
 * mobile-safe built-in keys. Unknown/plugin projection values are absent. */
export interface MobileV3ProjectionBlock {
  asOfSeq: number
  values: Record<string, unknown>
}

export interface MobileV3DetailRef {
  seq: number
  version: number
  field: string
}

export interface MobileV3Event {
  sessionId?: string
  seq?: number
  time: number
  type: string
  body?: Record<string, unknown>
}

export interface MobileV3SnapshotValue {
  protocolVersion: number
  capability: string
  snapshotId: string
  observedAt: number
  partial: boolean
  sessions: Array<{
    sessionId: string
    lastSeq?: number
    authoritative: boolean
    unknown?: true
  }>
}

export interface MobileV3HistoryRequest {
  sessionId: string
  beforeSeq?: number
  maxMessages?: number
}

export interface MobileV3HistoryValue {
  sessionId: string
  events: MobileV3Event[]
  hasMore: boolean
  nextBeforeSeq?: number
  lastSeq?: number
  lastSeqKnown: boolean
  projections?: MobileV3ProjectionBlock
}

export interface MobileV3DeltaRequest {
  sessionId: string
  afterSeq: number
  maxEvents?: number
}

export interface MobileV3DeltaValue {
  sessionId: string
  acknowledgedSeq: number
  firstSeq?: number
  throughSeq: number
  lastSeq?: number
  lastSeqKnown: boolean
  caughtUp: boolean
  scanLimitReached: boolean
  hasMore: boolean
  events: MobileV3Event[]
  projections?: MobileV3ProjectionBlock
}

export interface MobileV3DetailsRequest {
  sessionId: string
  seq: number
  version: number
  field?: string
  offset?: number
  limit?: number
}

export interface MobileV3DetailsValue {
  sessionId: string
  seq: number
  version: number
  field: string
  contentType: string
  offset: number
  nextOffset: number
  totalBytes: number
  done: boolean
  text: string
}

interface V3DetailRecord {
  text?: string
  contentType: string
  totalBytes: number
}

interface V3Subscriber {
  queue: MobileV3Event[]
  seen: Set<string>
  seenOrder: string[]
  lastSeqBySession: Map<string, number>
  queuedBytes: number
  waiter?: () => void
  done: boolean
  sessionId?: string
  sinceSeq?: number
}

interface V3StateOptions {
  maxInlineBytes: number
  maxDetailChunkBytes: number
  maxCachedEvents: number
  maxDetailCacheBytes: number
  maxSubscriberQueue: number
  maxSubscriberBytes: number
  maxSubscriberSeen: number
}

type V3DetailLoader = (sessionId: string, ref: MobileV3DetailRef) => Promise<V3DetailRecord | undefined>

/**
 * Process-local authority/cache for the plugin. It intentionally observes the
 * existing mux instead of adding a core API. `session/subscribed.lastSeq` and
 * `session/event.seq` are the only live-tail sources; projection frames never
 * advance this index.
 */
export class MobileSessionSyncState implements WatermarkIndexLike {
  private readonly watermarks = new Map<string, WatermarkEntry>()
  private readonly events = new Map<string, Map<number, MobileV3Event>>()
  private readonly details = new Map<string, V3DetailRecord>()
  private readonly detailOrder: string[] = []
  private detailBytes = 0
  private readonly interactionOrigins = new Map<string, Map<string, number>>()
  private readonly pendingControls = new Map<string, MobileV3Event>()
  private readonly subscribers = new Set<V3Subscriber>()
  private readonly coldPending = new Set<string>()
  private readonly coldQueue: string[] = []
  private readonly options: V3StateOptions
  private muxAbort: AbortController | undefined
  private detailLoader: V3DetailLoader | undefined
  private coldRunning = false
  private muxRunning = false

  constructor(options: Partial<V3StateOptions> = {}) {
    this.options = {
      maxInlineBytes: options.maxInlineBytes ?? DEFAULT_V3_MAX_INLINE_BYTES,
      maxDetailChunkBytes: options.maxDetailChunkBytes ?? DEFAULT_V3_MAX_DETAIL_CHUNK_BYTES,
      maxCachedEvents: options.maxCachedEvents ?? DEFAULT_V3_MAX_CACHED_EVENTS,
      maxDetailCacheBytes: options.maxDetailCacheBytes ?? DEFAULT_V3_MAX_DETAIL_CACHE_BYTES,
      maxSubscriberQueue: options.maxSubscriberQueue ?? DEFAULT_V3_MAX_SUBSCRIBER_QUEUE,
      maxSubscriberBytes: options.maxSubscriberBytes ?? DEFAULT_V3_MAX_SUBSCRIBER_BYTES,
      maxSubscriberSeen: options.maxSubscriberSeen ?? DEFAULT_V3_MAX_SUBSCRIBER_SEEN,
    }
  }

  getWatermark(sessionId: string): WatermarkEntry | undefined {
    return this.watermarks.get(sessionId)
  }

  /** The conversion layer uses this bound to keep normal event bodies small. */
  get maxInlineBytes(): number {
    return this.options.maxInlineBytes
  }

  get maxDetailChunkBytes(): number {
    return this.options.maxDetailChunkBytes
  }

  get maxDetailCacheBytes(): number {
    return this.options.maxDetailCacheBytes
  }

  /** Install the bounded history reloader used when an oversized detail was evicted. */
  setDetailLoader(loader: V3DetailLoader | undefined): void {
    this.detailLoader = loader
  }

  updateWatermark(sessionId: string, lastSeq: number, source: WatermarkEntry['source']): void {
    if (!Number.isInteger(lastSeq) || lastSeq < -1) return
    const previous = this.watermarks.get(sessionId)
    // A history probe may lag a live mux baseline, but neither source may move
    // an already observed tail backwards. `-1` is therefore retained only as
    // the first/explicitly confirmed empty value, never as a failure fallback.
    if (previous !== undefined && lastSeq < previous.lastSeq) return
    if (previous?.source === 'mux' && source === 'history') return
    this.watermarks.set(sessionId, { lastSeq, source, confirmedEmpty: lastSeq === -1 })
  }

  putDetail(sessionId: string, seq: number, field: string, text: string, contentType = 'text/plain'): MobileV3DetailRef {
    const ref: MobileV3DetailRef = { seq, version: 1, field }
    const key = detailKey(sessionId, ref)
    const totalBytes = Buffer.byteLength(text, 'utf8')
    const previous = this.details.get(key)
    if (previous?.text !== undefined) this.detailBytes -= previous.totalBytes
    if (!this.details.has(key)) this.detailOrder.push(key)
    // Keep only bounded resident detail. Oversized records retain metadata so
    // readDetail can ask the history reloader for an uncropped copy later.
    this.details.set(key, {
      ...(totalBytes <= this.options.maxDetailCacheBytes ? { text } : {}),
      contentType,
      totalBytes,
    })
    if (totalBytes <= this.options.maxDetailCacheBytes) this.detailBytes += totalBytes
    const maximumEntries = this.options.maxCachedEvents * 4
    while (this.detailOrder.length > maximumEntries || this.detailBytes > this.options.maxDetailCacheBytes) {
      const oldest = this.detailOrder.shift()
      if (oldest !== undefined) {
        const evicted = this.details.get(oldest)
        if (evicted?.text !== undefined) this.detailBytes -= evicted.totalBytes
        this.details.delete(oldest)
      }
    }
    return ref
  }

  readDetail(sessionId: string, ref: MobileV3DetailRef): V3DetailRecord | undefined {
    return this.details.get(detailKey(sessionId, ref))
  }

  async resolveDetail(sessionId: string, ref: MobileV3DetailRef): Promise<V3DetailRecord | undefined> {
    const cached = this.readDetail(sessionId, ref)
    if (cached?.text !== undefined) return cached
    if (this.detailLoader === undefined) return cached
    return this.detailLoader(sessionId, ref)
  }

  /** Index a durable approval ask; question requests have no durable core event. */
  noteInteractionOrigin(sessionId: string, kind: 'approval', interactionId: string, seq: number): void {
    if (!Number.isInteger(seq) || seq < 0 || interactionId.length === 0) return
    let byId = this.interactionOrigins.get(sessionId)
    if (byId === undefined) this.interactionOrigins.set(sessionId, byId = new Map())
    const key = `${kind}:${interactionId}`
    if (!byId.has(key)) byId.set(key, seq)
  }

  getInteractionOrigin(sessionId: string, kind: 'approval', interactionId: string): number | undefined {
    return this.interactionOrigins.get(sessionId)?.get(`${kind}:${interactionId}`)
  }

  /** Cache a converted history event for replay to a newly opened v3 stream. */
  rememberConvertedEvent(event: MobileV3Event): void {
    this.rememberEvent(event)
  }

  cachedEvents(sessionId?: string): MobileV3Event[] {
    const entries: MobileV3Event[] = []
    const maps = sessionId === undefined
      ? [...this.events.entries()]
      : [[sessionId, this.events.get(sessionId)]] as Array<[string, Map<number, MobileV3Event> | undefined]>
    for (const [id, map] of maps) {
      if (map === undefined) continue
      for (const event of map.values()) entries.push({ ...event, ...event.sessionId === undefined ? { sessionId: id } : {} })
    }
    // Session sequence is the ordering authority. Wall-clock time may tie or
    // arrive out of order after a reconnect and must never reorder one log.
    return entries.sort((left, right) => {
      const sessionOrder = (left.sessionId ?? '').localeCompare(right.sessionId ?? '')
      if (sessionOrder !== 0) return sessionOrder
      const leftSeq = left.seq ?? -1
      const rightSeq = right.seq ?? -1
      return (leftSeq - rightSeq) || (left.time - right.time)
    })
  }

  /** Register the one shared mux watcher used by snapshots and v3 events. */
  startMux(api: ApiProxy): void {
    if (typeof api.events?.mux !== 'function') return
    if (this.muxRunning) return
    installDetailLoader(api, this, defaultV3Options(this))
    const controller = new AbortController()
    this.muxAbort = controller
    this.muxRunning = true
    void this.runMux(api, controller)
  }

  private async runMux(api: ApiProxy, controller: AbortController): Promise<void> {
    let backoff = 100
    try {
      while (!controller.signal.aborted) {
        try {
          const stream = api.events.mux({ rpcId: RpcId(`mobile-v3-mux-${randomUUID()}`), payload: { since: {} } }, controller.signal)
          for await (const frame of stream) {
            if (controller.signal.aborted) return
            const rpcId = typeof frame.rpcId === 'string' ? frame.rpcId : undefined
            const event = convertMobileMuxFrame(frame.payload, this, defaultV3Options(this), { ...(rpcId === undefined ? {} : { rpcId }) })
            if (event === undefined) continue
            if (event.seq !== undefined && event.sessionId !== undefined) this.rememberEvent(event)
            this.emit(event)
          }
          if (controller.signal.aborted) return
          this.emit({ sessionId: '', time: Date.now(), type: 'control/stream-error', body: { failureKind: 'mux-ended', action: 'reconnect' } })
        } catch (error) {
          if (controller.signal.aborted) return
          // Never hide a broken watcher: clients receive a safe category and
          // the bounded retry keeps a transient transport failure recoverable.
          this.emit({ sessionId: '', time: Date.now(), type: 'control/stream-error', body: { failureKind: failureCategory(error) ?? 'mux-unavailable', action: 'reconnect' } })
        }
        const continued = await waitWithAbort(backoff, controller.signal)
        if (!continued) return
        backoff = Math.min(backoff * 2, 5000)
      }
    } finally {
      if (this.muxAbort === controller) this.muxAbort = undefined
      if (this.muxAbort === undefined || this.muxAbort === controller) this.muxRunning = false
    }
  }

  subscribe(options: { sessionId?: string; sinceSeq?: number } = {}): AsyncIterable<MobileV3Event> {
    const subscriber: V3Subscriber = {
      queue: [],
      seen: new Set<string>(),
      seenOrder: [],
      lastSeqBySession: new Map<string, number>(),
      queuedBytes: 0,
      done: false,
      ...options,
    }
    // Pending approvals/questions are process-local control state, not durable
    // history. Replay them before cached log events so reconnecting clients do
    // not lose an interaction that was already waiting at stream open.
    for (const event of this.pendingControls.values()) {
      if (event.sessionId !== undefined && event.sessionId !== '' && options.sessionId !== undefined && event.sessionId !== options.sessionId) continue
      this.enqueue(subscriber, event)
    }
    // A Host-wide stream is a live tail, not a history replay. Replaying every cached
    // session here can fill the bounded queue before the client observes new controls/events.
    if (options.sessionId !== undefined) {
      for (const event of this.cachedEvents(options.sessionId)) {
        if (event.seq !== undefined && options.sinceSeq !== undefined && event.seq <= options.sinceSeq) continue
        this.enqueue(subscriber, event)
      }
    }
    if (!subscriber.done) this.subscribers.add(subscriber)
    const state = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<MobileV3Event> {
        return {
          next(): Promise<IteratorResult<MobileV3Event>> {
            if (subscriber.queue.length > 0) {
              return Promise.resolve({ done: false, value: state.takeQueued(subscriber) })
            }
            if (subscriber.done) return Promise.resolve({ done: true, value: undefined as never })
            return new Promise(resolve => {
              subscriber.waiter = () => {
                subscriber.waiter = undefined
                if (subscriber.queue.length > 0) {
                  resolve({ done: false, value: state.takeQueued(subscriber) })
                } else {
                  resolve({ done: true, value: undefined as never })
                }
              }
            })
          },
          return(): Promise<IteratorResult<MobileV3Event>> {
            state.closeSubscriber(subscriber)
            return Promise.resolve({ done: true, value: undefined as never })
          },
        }
      },
    }
  }

  emit(event: MobileV3Event): void {
    this.updatePendingControl(event)
    for (const subscriber of this.subscribers) {
      if (subscriber.done) continue
      if (subscriber.sessionId !== undefined && event.sessionId !== undefined && event.sessionId !== '' && event.sessionId !== subscriber.sessionId) continue
      if (event.seq !== undefined && subscriber.sinceSeq !== undefined && event.seq <= subscriber.sinceSeq) continue
      this.enqueue(subscriber, event)
    }
  }

  scheduleColdTail(api: ApiProxy, sessionId: string): void {
    if (this.getWatermark(sessionId)?.source === 'mux' || this.coldPending.has(sessionId)) return
    this.coldPending.add(sessionId)
    this.coldQueue.push(sessionId)
    if (!this.coldRunning) void this.drainColdTails(api)
  }

  dispose(): void {
    this.muxAbort?.abort()
    this.muxAbort = undefined
    for (const subscriber of this.subscribers) {
      subscriber.done = true
      subscriber.waiter?.()
    }
    this.subscribers.clear()
    this.coldQueue.length = 0
    this.coldPending.clear()
    this.events.clear()
    this.details.clear()
    this.detailOrder.length = 0
    this.detailBytes = 0
    this.pendingControls.clear()
    this.interactionOrigins.clear()
    this.watermarks.clear()
  }

  private rememberEvent(event: MobileV3Event): void {
    if (event.sessionId === undefined || event.seq === undefined) return
    let map = this.events.get(event.sessionId)
    if (map === undefined) this.events.set(event.sessionId, map = new Map())
    if (map.has(event.seq)) return
    map.set(event.seq, event)
    while (map.size > this.options.maxCachedEvents) {
      const oldest = map.keys().next().value as number | undefined
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  private enqueue(subscriber: V3Subscriber, event: MobileV3Event): void {
    if (subscriber.done) return
    if (event.sessionId !== undefined && event.seq !== undefined) {
      const last = subscriber.lastSeqBySession.get(event.sessionId)
      if (last !== undefined && event.seq <= last) return
      if (subscriber.sinceSeq !== undefined && event.seq <= subscriber.sinceSeq) return
      subscriber.lastSeqBySession.set(event.sessionId, event.seq)
    }
    const key = subscriberEventKey(event)
    if (key !== undefined) {
      if (subscriber.seen.has(key)) return
      this.rememberSubscriberKey(subscriber, key)
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (subscriber.queue.length >= this.options.maxSubscriberQueue
      || subscriber.queuedBytes + eventBytes > this.options.maxSubscriberBytes) {
      this.failSubscriber(subscriber)
      return
    }
    subscriber.queue.push(event)
    subscriber.queuedBytes += eventBytes
    subscriber.waiter?.()
  }

  private takeQueued(subscriber: V3Subscriber): MobileV3Event {
    const event = subscriber.queue.shift() as MobileV3Event
    subscriber.queuedBytes = Math.max(0, subscriber.queuedBytes - Buffer.byteLength(JSON.stringify(event), 'utf8'))
    return event
  }

  private rememberSubscriberKey(subscriber: V3Subscriber, key: string): void {
    subscriber.seen.add(key)
    subscriber.seenOrder.push(key)
    while (subscriber.seenOrder.length > this.options.maxSubscriberSeen) {
      const oldest = subscriber.seenOrder.shift()
      if (oldest !== undefined) subscriber.seen.delete(oldest)
    }
  }

  private failSubscriber(subscriber: V3Subscriber): void {
    if (subscriber.done) return
    subscriber.queue.length = 0
    subscriber.queuedBytes = 0
    subscriber.seen.clear()
    subscriber.seenOrder.length = 0
    subscriber.lastSeqBySession.clear()
    subscriber.done = true
    // A bounded explicit terminal shell tells the client to reopen and repair
    // via delta; dropping the suffix would look like a successful live stream.
    const overflow: MobileV3Event = {
      sessionId: subscriber.sessionId ?? '',
      time: Date.now(),
      type: 'control/stream-overflow',
      body: { failureKind: 'subscriber-overflow', action: 'resync-delta' },
    }
    subscriber.queue.push(overflow)
    subscriber.queuedBytes = Buffer.byteLength(JSON.stringify(overflow), 'utf8')
    this.subscribers.delete(subscriber)
    subscriber.waiter?.()
  }

  private updatePendingControl(event: MobileV3Event): void {
    const key = pendingControlKey(event)
    if (key === undefined) return
    if (event.type.endsWith('/requested')) this.pendingControls.set(key, event)
    else if (event.type.endsWith('/resolved')) this.pendingControls.delete(key)
  }

  private closeSubscriber(subscriber: V3Subscriber): void {
    subscriber.done = true
    subscriber.queue.length = 0
    subscriber.queuedBytes = 0
    subscriber.seen.clear()
    subscriber.seenOrder.length = 0
    subscriber.lastSeqBySession.clear()
    subscriber.waiter?.()
    this.subscribers.delete(subscriber)
  }

  private async drainColdTails(api: ApiProxy): Promise<void> {
    this.coldRunning = true
    try {
      while (this.coldQueue.length > 0) {
        const sessionId = this.coldQueue.shift() as string
        try {
          const tail = await withTimeout(readSessionTailWatermark(api, sessionId), 5000)
          if (tail.kind === 'known') this.updateWatermark(sessionId, tail.lastSeq, 'history')
        } catch {
          // Keep the session unknown. In particular, never turn an I/O failure into -1.
        } finally {
          this.coldPending.delete(sessionId)
        }
      }
    } finally {
      this.coldRunning = false
    }
  }
}

function controlBody(event: MobileV3Event): Record<string, unknown> {
  return event.body ?? {}
}

/** Stable interaction identity; wall-clock time is intentionally excluded. */
function pendingControlKey(event: MobileV3Event): string | undefined {
  const body = controlBody(event)
  const session = event.sessionId ?? ''
  if (event.type === 'control/approval/requested' || event.type === 'control/approval/resolved') {
    const id = boundedString(body.approvalId, 256)
    return id === undefined ? undefined : `${session}:approval:${id}`
  }
  if (event.type === 'control/question/requested' || event.type === 'control/question/resolved') {
    const id = boundedString(body.questionRpcId, 256)
    return id === undefined ? undefined : `${session}:question:${id}`
  }
  return undefined
}

function stableBodyKey(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** De-duplicate replay/live overlap without colliding same-millisecond controls. */
function subscriberEventKey(event: MobileV3Event): string | undefined {
  if (event.sessionId !== undefined && event.seq !== undefined) return `event:${event.sessionId}:${event.seq}`
  const interaction = pendingControlKey(event)
  if (interaction !== undefined) return `${interaction}:${event.type}`
  const body = controlBody(event)
  if (event.type === 'control/session-subscribed') {
    return `subscribed:${event.sessionId ?? ''}:${stableBodyKey(body)}`
  }
  if (event.type === 'control/session-queue' || event.type === 'control/session-jobs'
    || event.type === 'control/session-projection') {
    return `snapshot:${event.sessionId ?? ''}:${event.type}:${stableBodyKey(body)}`
  }
  // Unknown controls have no durable identity. Do not invent one from time;
  // two same-ms controls must remain observable even when their payloads match.
  return undefined
}

function defaultV3Options(state: MobileSessionSyncState): V3Options {
  return {
    maxEvents: DEFAULT_V3_MAX_EVENTS,
    maxBytes: DEFAULT_V3_MAX_BYTES,
    maxInlineBytes: state.maxInlineBytes,
    maxDetailChunkBytes: state.maxDetailChunkBytes,
    maxHistoryPages: DEFAULT_V3_MAX_HISTORY_PAGES,
    scanPageMessages: DEFAULT_SCAN_PAGE_MESSAGES,
    maxScanPages: DEFAULT_MAX_SCAN_PAGES,
    maxDetailCacheBytes: state.maxDetailCacheBytes,
  }
}

function detailKey(sessionId: string, ref: MobileV3DetailRef): string {
  return `${sessionId}\u0000${ref.seq}\u0000${ref.version}\u0000${ref.field}`
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('background tail timeout')), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type SessionTailWatermark =
  | { kind: 'known'; lastSeq: number }
  | { kind: 'unknown'; reason: string }

export async function readSessionTailWatermark(api: ApiProxy, sessionId: string): Promise<SessionTailWatermark> {
  try {
    const response = await api.sessions.history({
      rpcId: RpcId(`mobile-tail-${randomUUID()}`),
      payload: { sessionId: sessionId as SessionId, maxMessages: 1 },
    })
    const pageResult = response.result
    if (!pageResult.ok) return { kind: 'unknown', reason: rpcErrorOf(pageResult).code }
    const page = pageResult.value
    const seqs = page.events.map(entry => entry.event.seq).filter(Number.isInteger)
    if (seqs.length > 0) return { kind: 'known', lastSeq: Math.max(...seqs) }
    // An empty, terminal page is the sole history-based proof of an empty log.
    if (page.hasMore === false) return { kind: 'known', lastSeq: -1 }
    return { kind: 'unknown', reason: 'tail-not-terminal' }
  } catch {
    return { kind: 'unknown', reason: 'history-failed' }
  }
}

function installDetailLoader(api: ApiProxy, state: MobileSessionSyncState, options: V3Options): void {
  state.setDetailLoader(async (sessionId, ref) => {
    let beforeSeq: number | undefined = ref.seq + 1
    for (let pageIndex = 0; pageIndex < (options.maxHistoryPages ?? DEFAULT_V3_MAX_HISTORY_PAGES); pageIndex += 1) {
      let response: Awaited<ReturnType<ApiProxy['sessions']['history']>>
      try {
        response = await api.sessions.history({
          rpcId: RpcId(`mobile-v3-detail-${randomUUID()}`),
          payload: {
            sessionId: sessionId as SessionId,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages: options.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES,
          },
        })
      } catch {
        return undefined
      }
      if (!response.result.ok) return undefined
      const page = response.result.value
      const target = page.events.find(entry => entry.event.seq === ref.seq)
      if (target !== undefined) {
        // Rebuild into a disposable unbounded-by-cache converter: the caller
        // still receives bounded chunks, while a multi-megabyte record never
        // becomes resident in the long-lived state cache.
        const scratch = new MobileSessionSyncState({
          maxInlineBytes: 0,
          maxDetailChunkBytes: options.maxDetailChunkBytes,
          maxCachedEvents: 1,
          maxDetailCacheBytes: Number.MAX_SAFE_INTEGER,
        })
        const scratchOptions = { ...options, maxInlineBytes: 0, maxDetailCacheBytes: Number.MAX_SAFE_INTEGER }
        convertMobileHistoryEntry(target, sessionId, scratch, scratchOptions)
        const detail = scratch.readDetail(sessionId, ref)
        scratch.dispose()
        return detail
      }
      const oldest = page.events.map(entry => entry.event.seq).filter(Number.isInteger).sort((a, b) => a - b)[0]
      if (oldest === undefined || !page.hasMore || oldest >= ref.seq) return undefined
      beforeSeq = oldest
    }
    return undefined
  })
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function boundedString(value: unknown, maximum = 1024): string | undefined {
  const string = stringValue(value)
  return string === undefined ? undefined : string.slice(0, maximum)
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function failureCategory(value: unknown): string | undefined {
  const record = asRecord(value)
  const error = asRecord(record?.error)
  const candidate = stringValue(error?.code) ?? stringValue(record?.code) ?? stringValue(record?.kind)
  return candidate === undefined ? undefined : candidate.slice(0, 96)
}

function safeUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = asRecord(value)
  if (usage === undefined) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const number = integerValue(usage[key])
    if (number !== undefined && number >= 0) result[key] = number
  }
  return Object.keys(result).length === 0 ? undefined : result
}

const SENSITIVE_TOOL_KEY = /(?:pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?key|refresh[-_]?token|client[-_]?secret)/i

/** Redact tool-owned JSON before it can enter the process-local detail cache. */
function safeToolJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.slice(0, 8192)
  if (depth >= 8) return { redacted: 'depth-limit' }
  if (Array.isArray(value)) return value.slice(0, 128).map(item => safeToolJson(item, depth + 1))
  const record = asRecord(value)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record).slice(0, 128)) {
    if (SENSITIVE_TOOL_KEY.test(key)) continue
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) continue
    const safe = safeToolJson(item, depth + 1)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

function safeToolArguments(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return JSON.stringify(safeToolJson(parsed))
  } catch {
    // Unparseable model arguments are not copied verbatim into the detail ref.
    return undefined
  }
}

function safeArgumentsDetail(
  text: string,
  state: MobileSessionSyncState,
  sessionId: string,
  seq: number,
  field: string,
  options: V3Options,
): Record<string, unknown> {
  const safe = safeToolArguments(text)
  if (safe === undefined) return { redacted: true, reason: 'arguments-not-json' }
  return safeDetailText(safe, state, sessionId, seq, field, options, 'application/json')
}

function safeDetailText(
  value: string,
  state: MobileSessionSyncState,
  sessionId: string,
  seq: number,
  field: string,
  options: V3Options,
  contentType = 'text/plain',
): Record<string, unknown> {
  if (Buffer.byteLength(value, 'utf8') <= options.maxInlineBytes) return { text: value }
  const ref = state.putDetail(sessionId, seq, field, value, contentType)
  const preview = Array.from(value).slice(0, 256).join('')
  return { preview, detailRef: ref, totalBytes: Buffer.byteLength(value, 'utf8') }
}

function safeSource(source: unknown): Record<string, unknown> | undefined {
  const record = asRecord(source)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  const kind = boundedString(record.kind, 128)
  if (kind !== undefined) result.kind = kind
  const form = boundedString(record.form, 128)
  if (form !== undefined) result.form = form
  const plugin = boundedString(record.plugin, 256)
  if (plugin !== undefined) result.plugin = plugin
  const callId = boundedString(record.callId, 256)
  if (callId !== undefined) result.callId = callId
  const provider = boundedString(record.provider, 256)
  if (provider !== undefined) result.provider = provider
  const model = boundedString(record.model, 512)
  if (model !== undefined) result.model = model
  const compactionId = boundedString(record.compactionId, 256)
  if (compactionId !== undefined) result.compactionId = compactionId
  const sourceCommandId = boundedString(record.sourceCommandId, 256)
  if (sourceCommandId !== undefined) result.sourceCommandId = sourceCommandId
  const goalId = boundedString(record.goalId, 256)
  if (goalId !== undefined) result.goalId = goalId
  const revision = integerValue(record.revision)
  if (revision !== undefined) result.revision = revision
  const round = integerValue(record.round)
  if (round !== undefined) result.round = round
  return Object.keys(result).length === 0 ? undefined : result
}

function safeContentBlocks(
  content: unknown,
  state: MobileSessionSyncState,
  sessionId: string,
  seq: number,
  options: V3Options,
  fieldPrefix: string,
): unknown[] {
  if (!Array.isArray(content)) return []
  const output: unknown[] = []
  for (const [index, value] of content.entries()) {
    const block = asRecord(value)
    if (block === undefined) continue
    const type = stringValue(block.type)
    if (type === 'text' || type === 'reasoning') {
      const text = stringValue(block.text)
      if (text === undefined) continue
      output.push({ type, ...safeDetailText(text, state, sessionId, seq, `${fieldPrefix}.${index}`, options) })
      continue
    }
    if (type === 'image') {
      const attachment = asRecord(block.attachment)
      const safe: Record<string, unknown> = { type: 'image' }
      if (stringValue(attachment?.attachmentId) !== undefined) safe.attachmentId = attachment?.attachmentId
      if (stringValue(attachment?.mediaType) !== undefined) safe.mediaType = attachment?.mediaType
      for (const key of ['width', 'height', 'byteLength']) {
        const number = integerValue(attachment?.[key])
        if (number !== undefined && number >= 0) safe[key] = number
      }
      output.push(safe)
      continue
    }
    if (type === 'tool-call') {
      const safe: Record<string, unknown> = { type: 'tool-call' }
      for (const key of ['id', 'name']) {
        const string = stringValue(block[key])
        if (string !== undefined) safe[key] = string
      }
      const args = stringValue(block.arguments)
      if (args !== undefined) safe.arguments = safeArgumentsDetail(args, state, sessionId, seq, `${fieldPrefix}.${index}.arguments`, options)
      output.push(safe)
      continue
    }
    if (type === 'tool-result') {
      const safe: Record<string, unknown> = { type: 'tool-result' }
      const callId = stringValue(block.toolCallId)
      if (callId !== undefined) safe.toolCallId = callId
      if (boolValue(block.isError) !== undefined) safe.isError = block.isError
      safe.content = safeContentBlocks(block.content, state, sessionId, seq, options, `${fieldPrefix}.${index}.content`)
      output.push(safe)
    }
    // Plugin-added blocks are intentionally omitted. The event shell remains present.
  }
  return output
}

function safeMessage(
  message: unknown,
  state: MobileSessionSyncState,
  sessionId: string,
  seq: number,
  options: V3Options,
  field: string,
): Record<string, unknown> | undefined {
  const record = asRecord(message)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ['id', 'role']) {
    const string = stringValue(record[key])
    if (string !== undefined) result[key] = string
  }
  const source = safeSource(record.source)
  if (source !== undefined) result.source = source
  result.content = safeContentBlocks(record.content, state, sessionId, seq, options, field)
  return result
}

function safePendingContent(content: unknown, state: MobileSessionSyncState): unknown[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    const block = asRecord(value)
    const type = stringValue(block?.type)
    if (block === undefined || type === undefined) return []
    if (type === 'text' || type === 'reasoning') {
      const text = stringValue(block.text)
      if (text === undefined) return []
      const totalBytes = Buffer.byteLength(text, 'utf8')
      if (totalBytes <= state.maxInlineBytes) return [{ type, text }]
      return [{ type, preview: Array.from(text).slice(0, 256).join(''), totalBytes, truncated: true }]
    }
    if (type === 'tool-call') {
      const safe: Record<string, unknown> = { type }
      for (const key of ['id', 'name']) {
        const value = boundedString(block[key], 256)
        if (value !== undefined) safe[key] = value
      }
      const args = stringValue(block.arguments)
      const sanitized = args === undefined ? undefined : safeToolArguments(args)
      if (sanitized !== undefined && Buffer.byteLength(sanitized, 'utf8') <= state.maxInlineBytes) safe.arguments = sanitized
      else if (args !== undefined) safe.arguments = { redacted: true, detailUnavailable: true }
      return [safe]
    }
    if (type === 'tool-result') {
      const safe: Record<string, unknown> = { type }
      const callId = boundedString(block.toolCallId, 256)
      if (callId !== undefined) safe.toolCallId = callId
      if (typeof block.isError === 'boolean') safe.isError = block.isError
      safe.content = safePendingContent(block.content, state)
      return [safe]
    }
    if (type === 'image') {
      const attachment = asRecord(block.attachment)
      const safe: Record<string, unknown> = { type }
      for (const key of ['attachmentId', 'mediaType']) {
        const value = boundedString(attachment?.[key], 256)
        if (value !== undefined) safe[key] = value
      }
      return [safe]
    }
    return []
  })
}

function safePendingMessage(value: unknown, state: MobileSessionSyncState): Record<string, unknown> | undefined {
  const message = asRecord(value)
  if (message === undefined) return undefined
  const result: Record<string, unknown> = {}
  const id = boundedString(message.id, 256)
  const role = boundedString(message.role, 32)
  if (id !== undefined) result.id = id
  if (role === 'system' || role === 'user' || role === 'assistant') result.role = role
  const source = safeSource(message.source)
  if (source !== undefined) result.source = source
  result.content = safePendingContent(message.content, state)
  return result
}

function safeQueueItems(value: unknown, state: MobileSessionSyncState): { items: unknown[]; complete: boolean } {
  if (!Array.isArray(value)) return { items: [], complete: true }
  const items: unknown[] = []
  for (const item of value.slice(0, DEFAULT_V3_MAX_EVENTS)) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = boundedString(record.id, 256)
    const placement = boundedString(record.placement, 32)
    if (id === undefined || (placement !== 'queued' && placement !== 'steering' && placement !== 'context')) continue
    const safe: Record<string, unknown> = { id, placement }
    const message = safePendingMessage(record.message, state)
    if (message !== undefined) safe.message = message
    items.push(safe)
  }
  return { items, complete: items.length === value.length }
}

function safeJobItems(value: unknown): { jobs: unknown[]; complete: boolean } {
  if (!Array.isArray(value)) return { jobs: [], complete: true }
  const jobs: unknown[] = []
  for (const item of value.slice(0, DEFAULT_V3_MAX_EVENTS)) {
    const record = asRecord(item)
    if (record === undefined) continue
    const safe: Record<string, unknown> = {}
    for (const key of ['id', 'kind', 'label', 'status', 'detail']) {
      const string = boundedString(record[key], key === 'detail' ? 2048 : 512)
      if (string !== undefined) safe[key] = string
    }
    for (const key of ['startedAt', 'finishedAt']) {
      const number = integerValue(record[key])
      if (number !== undefined && number >= 0) safe[key] = number
    }
    if (safe.id !== undefined) jobs.push(safe)
  }
  return { jobs, complete: jobs.length === value.length }
}

const MOBILE_PROJECTION_KEYS = new Set([
  'title', 'goal', 'todos', 'permissions', 'plan', 'tokenUsage',
  'contextPressure', 'contextBreakdown', 'sessionStats', 'imageLimits',
])

function safeProjectionNumbers(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const number = integerValue(record[key])
    if (number !== undefined && number >= 0) result[key] = number
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function safeProjectionValue(key: string, value: unknown): unknown {
  if (!MOBILE_PROJECTION_KEYS.has(key)) return undefined
  if (value === null) return null
  if (key === 'title') return boundedString(value, 4096)
  if (key === 'plan') {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const result: Record<string, unknown> = {}
    for (const field of ['active', 'pending']) if (typeof record[field] === 'boolean') result[field] = record[field]
    return Object.keys(result).length === 0 ? undefined : result
  }
  if (key === 'goal') {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const result: Record<string, unknown> = {}
    const goal = asRecord(record.goal)
    if (goal !== undefined) {
      const safeGoal: Record<string, unknown> = {}
      for (const field of ['id', 'objective', 'phase', 'revision', 'maxGoalRounds']) {
        const string = boundedString(goal[field], 4096)
        const number = integerValue(goal[field])
        if (string !== undefined) safeGoal[field] = string
        else if (number !== undefined && number >= 0) safeGoal[field] = number
      }
      const blocked = asRecord(goal.blockedReason)
      if (blocked !== undefined) {
        const safeBlocked: Record<string, unknown> = {}
        for (const field of ['code', 'message']) {
          const string = boundedString(blocked[field], 1024)
          if (string !== undefined) safeBlocked[field] = string
        }
        if (Object.keys(safeBlocked).length > 0) safeGoal.blockedReason = safeBlocked
      }
      if (Object.keys(safeGoal).length > 0) result.goal = safeGoal
    }
    for (const field of ['roundsStarted', 'createdAt', 'updatedAt']) {
      const number = integerValue(record[field])
      if (number !== undefined && number >= 0) result[field] = number
    }
    return Object.keys(result).length === 0 ? undefined : result
  }
  if (key === 'todos') {
    if (!Array.isArray(value)) return undefined
    return value.slice(0, DEFAULT_V3_MAX_EVENTS).flatMap(item => {
      const record = asRecord(item)
      const content = boundedString(record?.content, 4096)
      const status = boundedString(record?.status, 32)
      return content === undefined || status === undefined ? [] : [{ content, status }]
    })
  }
  if (key === 'permissions') {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const result: Record<string, unknown> = {}
    const currentValue = boundedString(record.currentValue, 256)
    if (currentValue !== undefined) result.currentValue = currentValue
    if (Array.isArray(record.options)) {
      result.options = record.options.slice(0, DEFAULT_V3_MAX_EVENTS).flatMap(item => {
        const option = asRecord(item)
        if (option === undefined) return []
        const safe: Record<string, unknown> = {}
        for (const field of ['value', 'name', 'description']) {
          const string = boundedString(option[field], 1024)
          if (string !== undefined) safe[field] = string
        }
        return Object.keys(safe).length === 0 ? [] : [safe]
      })
    }
    return Object.keys(result).length === 0 ? undefined : result
  }
  if (key === 'imageLimits') {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const result: Record<string, unknown> = {}
    for (const field of ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension']) {
      const number = integerValue(record[field])
      if (number !== undefined && number > 0) result[field] = number
    }
    if (Array.isArray(record.mediaTypes)) result.mediaTypes = record.mediaTypes.flatMap(item => {
      const string = boundedString(item, 128)
      return string === undefined ? [] : [string]
    }).slice(0, 64)
    return Object.keys(result).length === 0 ? undefined : result
  }
  const numberKeys: Record<string, readonly string[]> = {
    tokenUsage: ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
    contextPressure: ['pressureTokens', 'projectedTokens', 'contextWindow'],
    contextBreakdown: ['systemTokens', 'toolsTokens', 'messageTokens'],
    sessionStats: ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'],
  }
  return safeProjectionNumbers(value, numberKeys[key] ?? [])
}

export function normalizeMobileProjectionBlock(value: unknown): MobileV3ProjectionBlock | undefined {
  const record = asRecord(value)
  const asOfSeq = integerValue(record?.asOfSeq)
  const values = asRecord(record?.values)
  if (asOfSeq === undefined || asOfSeq < -1 || values === undefined) return undefined
  const safeValues: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(values)) {
    const safe = safeProjectionValue(key, item)
    if (safe !== undefined) safeValues[key] = safe
  }
  return { asOfSeq, values: safeValues }
}

function safeToolView(view: unknown): Record<string, unknown> | undefined {
  const record = asRecord(view)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  const card = boundedString(record.card, 128)
  if (card !== undefined) result.card = card
  for (const key of ['title', 'description', 'signal']) {
    const string = boundedString(record[key], 512)
    if (string !== undefined) result[key] = string.slice(0, 512)
  }
  const kind = boundedString(record.kind, 128)
  if (kind !== undefined) result.kind = kind
  const exitCode = integerValue(record.exitCode)
  if (exitCode !== undefined) result.exitCode = exitCode
  return Object.keys(result).length === 0 ? undefined : result
}

function safeGoal(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ['id', 'objective', 'phase', 'status', 'createdAt', 'updatedAt', 'revision', 'maxGoalRounds', 'maxRounds']) {
    if (typeof record[key] === 'string') result[key] = (record[key] as string).slice(0, 1024)
    else if (typeof record[key] === 'number' && Number.isFinite(record[key])) result[key] = record[key]
  }
  const blocked = asRecord(record.blockedReason ?? record.blockReason)
  if (blocked !== undefined) {
    const safeBlocked: Record<string, unknown> = {}
    for (const key of ['code', 'message']) {
      const string = boundedString(blocked[key], 1024)
      if (string !== undefined) safeBlocked[key] = string
    }
    if (Object.keys(safeBlocked).length > 0) result.blockedReason = safeBlocked
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function safeTodos(value: unknown, state: MobileSessionSyncState, sessionId: string, seq: number, options: V3Options): unknown[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const record = asRecord(item)
    const content = stringValue(record?.content)
    const status = stringValue(record?.status)
    if (content === undefined || status === undefined) return []
    return [{ status: status.slice(0, 32), ...safeDetailText(content, state, sessionId, seq, `todos.${index}.content`, options) }]
  })
}

function toolCallId(data: Record<string, any>): string | undefined {
  const direct = stringValue(data.callId)
  if (direct !== undefined) return direct
  const message = asRecord(data.message)
  const source = asRecord(message?.source)
  const fromSource = stringValue(source?.callId)
  if (fromSource !== undefined) return fromSource
  const blocks = Array.isArray(message?.content) ? message?.content : []
  for (const item of blocks) {
    const block = asRecord(item)
    const fromBlock = stringValue(block?.toolCallId)
    if (fromBlock !== undefined) return fromBlock
  }
  return undefined
}

function safeSeqList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.flatMap(item => {
    const seq = integerValue(item)
    return seq !== undefined && seq >= 0 ? [seq] : []
  })
  return result.length === 0 ? undefined : result.slice(0, DEFAULT_V3_MAX_EVENTS * 32)
}

function safeSeqRange(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const start = integerValue(record.start)
  const end = integerValue(record.end)
  if (start === undefined || end === undefined || start < 0 || end < 0) return undefined
  return { start, end }
}

function safeCompactionFailure(value: unknown): string | undefined {
  return failureCategory(value) ?? boundedString(value, 96)
}

/** Convert one durable history entry. This is also used for mux `session/event` frames. */
export function convertMobileHistoryEntry(
  entry: HistoryEntry,
  sessionId: string,
  state: MobileSessionSyncState,
  options: V3Options = defaultV3Options(state),
): MobileV3Event {
  const raw = asRecord(entry.event) ?? {}
  const seq = integerValue(raw.seq) ?? 0
  const time = integerValue(raw.time) ?? Date.now()
  const type = boundedString(raw.type, 128) ?? 'unknown'
  const data = asRecord(raw.data) ?? {}
  const body: Record<string, unknown> = {}
  switch (type) {
    case 'user/message': {
      const message = safeMessage(data, state, sessionId, seq, options, 'message.content')
      if (message !== undefined) body.message = message
      break
    }
    case 'assistant/message': {
      const message = safeMessage(data.message, state, sessionId, seq, options, 'message.content')
      if (message !== undefined) body.message = message
      const usage = safeUsage(data.usage)
      if (usage !== undefined) body.usage = usage
      if (data.interrupted === true) body.interrupted = true
      break
    }
    case 'assistant/chunk': {
      const chunk = asRecord(data.chunk)
      if (chunk === undefined) break
      const chunkType = stringValue(chunk.type)
      const index = integerValue(chunk.index)
      if (chunkType === 'text-delta' || chunkType === 'reasoning-delta') {
        const text = stringValue(chunk.text)
        if (text !== undefined) body.chunk = { type: chunkType, ...(index === undefined ? {} : { index }), ...safeDetailText(text, state, sessionId, seq, `chunk.${chunkType}`, options) }
      } else if (chunkType === 'tool-call-delta') {
        const call: Record<string, unknown> = { type: chunkType }
        if (index !== undefined) call.index = index
        for (const key of ['id', 'name']) {
          const string = stringValue(chunk[key])
          if (string !== undefined) call[key] = string
        }
        const args = stringValue(chunk.argumentsDelta)
        if (args !== undefined) call.argumentsDelta = safeArgumentsDetail(args, state, sessionId, seq, 'chunk.tool-call-delta.arguments', options)
        body.chunk = call
      } else if (chunkType === 'usage') {
        body.chunk = { type: chunkType, usage: safeUsage(chunk.usage) ?? {} }
      } else if (chunkType === 'finish') {
        const reason = asRecord(chunk.reason)
        const safeReason: Record<string, unknown> = {}
        const kind = stringValue(reason?.kind)
        if (kind !== undefined) safeReason.kind = kind
        const failure = failureCategory(reason?.failure)
        if (failure !== undefined) safeReason.failureKind = failure
        body.chunk = { type: chunkType, reason: safeReason }
      } else if (chunkType === 'block-start') {
        body.chunk = { type: chunkType, ...(index === undefined ? {} : { index }), blockType: stringValue(chunk.blockType) ?? 'unknown' }
      } else if (chunkType === 'block-end') {
        const block = safeContentBlocks([chunk.block], state, sessionId, seq, options, 'chunk.block-end')[0]
        body.chunk = { type: chunkType, ...(index === undefined ? {} : { index }), ...(block === undefined ? {} : { block }) }
      }
      break
    }
    case 'tool/call': {
      const callId = stringValue(data.callId)
      const name = stringValue(data.name)
      if (callId !== undefined) body.callId = callId
      if (name !== undefined) body.name = name
      const view = entry.view?.for === 'call' ? safeToolView(entry.view.view) : undefined
      if (view !== undefined) body.summary = view
      const args = stringValue(data.arguments)
      const safeArgs = args === undefined ? undefined : safeToolArguments(args)
      if (safeArgs !== undefined && safeArgs.length > 0) body.detailRef = state.putDetail(sessionId, seq, 'tool.call.arguments', safeArgs, 'application/json')
      break
    }
    case 'tool/result': {
      const callId = toolCallId(data)
      if (callId !== undefined) body.callId = callId
      const view = entry.view?.for === 'result' ? safeToolView(entry.view.view) : undefined
      if (view !== undefined) body.summary = view
      const contentHasError = Array.isArray(asRecord(data.message)?.content)
        && (asRecord(data.message)?.content as unknown[]).some(item => asRecord(item)?.isError === true)
      const failure = failureCategory(data.error) ?? (contentHasError ? 'tool-error' : undefined)
      if (failure !== undefined) body.failureKind = failure
      const detail = asRecord(data.message)
      if (detail !== undefined) {
        const safe = {
          callId,
          content: safeContentBlocks(detail.content, state, sessionId, seq, options, 'tool.result.content'),
          isError: failure !== undefined,
        }
        body.detailRef = state.putDetail(sessionId, seq, 'tool.result', JSON.stringify(safe), 'application/json')
      }
      break
    }
    case 'compaction/start':
    case 'compaction/end': {
      for (const key of ['compactionId', 'sourceCommandId']) {
        const string = boundedString(data[key], 256)
        if (string !== undefined) body[key] = string
      }
      if (data.turn === null) body.turn = null
      else {
        const turn = integerValue(data.turn)
        if (turn !== undefined && turn >= 0) body.turn = turn
      }
      if (type === 'compaction/end') {
        const failure = safeCompactionFailure(data.error)
        if (failure !== undefined) body.failureKind = failure
      }
      break
    }
    case 'compaction/summary': {
      for (const key of ['compactionId', 'sourceCommandId', 'provider', 'model']) {
        const string = boundedString(data[key], key === 'model' ? 512 : 256)
        if (string !== undefined) body[key] = string
      }
      const summary = safeContentBlocks(data.summary, state, sessionId, seq, options, 'compaction.summary')
      if (summary.length > 0) body.summary = summary
      const shadowedRange = safeSeqRange(data.shadowedRange)
      if (shadowedRange !== undefined) body.shadowedRange = shadowedRange
      const shadowedSeqs = safeSeqList(data.shadowedSeqs)
      if (shadowedSeqs !== undefined) body.shadowedSeqs = shadowedSeqs
      const shadowedTokenCount = integerValue(data.shadowedTokenCount)
      if (shadowedTokenCount !== undefined && shadowedTokenCount >= 0) body.shadowedTokenCount = shadowedTokenCount
      const maxTokens = integerValue(data.maxTokens)
      if (maxTokens !== undefined && maxTokens >= 0) body.maxTokens = maxTokens
      const usage = safeUsage(data.usage)
      if (usage !== undefined) body.usage = usage
      break
    }
    case 'compaction/prune': {
      const shadowedRange = safeSeqRange(data.shadowedRange)
      if (shadowedRange !== undefined) body.shadowedRange = shadowedRange
      const shadowedSeqs = safeSeqList(data.shadowedSeqs)
      if (shadowedSeqs !== undefined) body.shadowedSeqs = shadowedSeqs
      const shadowedTokenCount = integerValue(data.shadowedTokenCount)
      if (shadowedTokenCount !== undefined && shadowedTokenCount >= 0) body.shadowedTokenCount = shadowedTokenCount
      break
    }
    case 'subagent/update': {
      for (const key of ['agentId', 'name', 'status']) {
        const string = boundedString(data[key], 512)
        if (string !== undefined) body[key] = string
      }
      const summary = boundedString(data.summary, 16 * 1024)
      if (summary !== undefined) body.summary = safeDetailText(summary, state, sessionId, seq, 'subagent.summary', options)
      break
    }
    case 'todo/write':
      body.todos = safeTodos(data.todos, state, sessionId, seq, options)
      break
    case 'goal/change':
      for (const key of ['kind', 'version', 'operation', 'roundsStarted', 'createdAt', 'updatedAt', 'clearedAt']) {
        if (typeof data[key] === 'string' || typeof data[key] === 'number') body[key] = data[key]
      }
      const goal = safeGoal(data.goal)
      const cleared = safeGoal(data.cleared)
      if (goal !== undefined) body.goal = goal
      if (cleared !== undefined) body.cleared = cleared
      break
    case 'request/header': {
      const header = asRecord(data.header)
      const config = asRecord(header?.config)
      const adapterDefaults = asRecord(header?.adapterDefaults)
      if (config !== undefined) {
        const model: Record<string, unknown> = {}
        for (const key of ['provider', 'model', 'reasoningEffort']) {
          const string = boundedString(config[key], 512)
          if (string !== undefined) model[key] = string
        }
        for (const key of ['temperature']) {
          const number = typeof config[key] === 'number' && Number.isFinite(config[key]) ? config[key] : undefined
          if (number !== undefined) model[key] = number
        }
        const maxTokens = integerValue(config.maxTokens)
        if (maxTokens !== undefined && maxTokens >= 0) model.maxTokens = maxTokens
        if (Array.isArray(config.stop)) model.stop = config.stop.flatMap(item => {
          const string = boundedString(item, 256)
          return string === undefined ? [] : [string]
        }).slice(0, 32)
        if (Object.keys(model).length > 0) body.model = model
      }
      if (adapterDefaults !== undefined) {
        const safeDefaults: Record<string, unknown> = {}
        if (adapterDefaults.reasoningEffort === true) safeDefaults.reasoningEffort = true
        if (adapterDefaults.maxTokens === true) safeDefaults.maxTokens = true
        if (Object.keys(safeDefaults).length > 0) body.adapterDefaults = safeDefaults
      }
      const reason = boundedString(data.reason, 1024)
      if (reason !== undefined) body.reason = reason
      break
    }
    case 'request/context': {
      const model: Record<string, unknown> = {}
      for (const key of ['provider', 'model']) {
        const string = boundedString(data[key], 256)
        if (string !== undefined) model[key] = string
      }
      const contextWindow = integerValue(data.contextWindow)
      if (contextWindow !== undefined && contextWindow >= 0) model.contextWindow = contextWindow
      if (Object.keys(model).length > 0) body.model = model
      break
    }
    case 'plan/mode':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy': {
      for (const key of ['active', 'preset', 'mode', 'policy', 'source']) {
        const string = boundedString(data[key], 256)
        if (string !== undefined) body[key] = string
        else if (typeof data[key] === 'boolean') body[key] = data[key]
      }
      break
    }
    case 'approval/asked': {
      const id = stringValue(data.id)
      const toolName = stringValue(data.toolName)
      const callId = stringValue(data.callId)
      if (id !== undefined) body.approvalId = id
      if (toolName !== undefined) body.toolName = toolName
      if (callId !== undefined) body.callId = callId
      const reason = boundedString(data.reason, 1024)
      if (reason !== undefined) body.reason = safeDetailText(reason, state, sessionId, seq, 'approval.reason', options)
      if (id !== undefined) {
        state.noteInteractionOrigin(sessionId, 'approval', id, seq)
        body.originSeq = seq
      } else {
        body.originSeq = null
      }
      break
    }
    case 'approval/decided': {
      const id = stringValue(data.id)
      const outcome = stringValue(data.outcome)
      if (id !== undefined) body.approvalId = id
      if (outcome !== undefined) body.outcome = outcome
      body.originSeq = id === undefined ? null : state.getInteractionOrigin(sessionId, 'approval', id) ?? null
      break
    }
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'session/end-seed': {
      for (const key of ['turn', 'step']) {
        const number = integerValue(data[key])
        if (number !== undefined) body[key] = number
      }
      const reason = asRecord(data.reason)
      if (reason !== undefined) {
        body.reason = { kind: stringValue(reason.kind) ?? 'unknown', ...(failureCategory(reason.error) === undefined ? {} : { failureKind: failureCategory(reason.error) }) }
      }
      break
    }
    case 'command/run':
    case 'command/done': {
      for (const key of ['commandId', 'name', 'kind', 'source', 'sourceEventSeq']) {
        if (typeof data[key] === 'string') body[key] = (data[key] as string).slice(0, 512)
        else if (typeof data[key] === 'number') body[key] = data[key]
      }
      const args = stringValue(data.args) ?? stringValue(data.text)
      if (args !== undefined) body.detailRef = state.putDetail(sessionId, seq, 'command.text', args)
      break
    }
    default:
      // Unknown durable payloads are deliberately not copied. The seq/time/type shell is required
      // for ordering and forward-compatible clients can decide whether to fetch history later.
      break
  }
  const result: MobileV3Event = { sessionId, seq, time, type }
  if (Object.keys(body).length > 0) result.body = body
  return result
}

/** Convert one mux payload through the same history converter used by v3 history/delta. */
export function convertMobileMuxFrame(
  payload: unknown,
  state: MobileSessionSyncState,
  options: V3Options = defaultV3Options(state),
  meta: { rpcId?: string } = {},
): MobileV3Event | undefined {
  const frame = asRecord(payload)
  if (frame === undefined) return undefined
  const type = stringValue(frame.type)
  if (type === 'session/event') {
    const sessionId = boundedString(frame.sessionId, 4096)
    const event = asRecord(frame.event)
    if (sessionId === undefined || event === undefined) return undefined
    const converted = convertMobileHistoryEntry({ event: event as any, ...(frame.view === undefined ? {} : { view: frame.view as any }) }, sessionId, state, options)
    if (converted.seq !== undefined) state.updateWatermark(sessionId, converted.seq, 'mux')
    return converted
  }
    const sessionId = boundedString(frame.sessionId, 4096)
  const now = Date.now()
  if (type === 'session/subscribed') {
    const lastSeq = integerValue(frame.lastSeq)
    if (sessionId !== undefined && lastSeq !== undefined && lastSeq >= -1) state.updateWatermark(sessionId, lastSeq, 'mux')
    return { sessionId, time: now, type: 'control/session-subscribed', body: { ...(lastSeq === undefined ? {} : { lastSeq, authoritative: true }) } }
  }
  if (type === 'session/projection') {
    const seq = integerValue(frame.seq)
    const key = boundedString(frame.key, 128) ?? 'unknown'
    const safeValue = safeProjectionValue(key, frame.value)
    return {
      sessionId,
      time: now,
      type: 'control/session-projection',
      body: {
        key,
        ...(seq === undefined ? {} : { seq }),
        ...(safeValue === undefined ? { valueUnavailable: true } : { value: safeValue }),
      },
    }
  }
  if (type === 'session/queue' || type === 'session/jobs') {
    const items = Array.isArray(frame.items) ? frame.items : Array.isArray(frame.jobs) ? frame.jobs : []
    if (type === 'session/queue') {
      const safe = safeQueueItems(items, state)
      return {
        sessionId,
        time: now,
        type: 'control/session/queue',
        body: { count: items.length, items: safe.items, complete: safe.complete, representation: 'safe-projection' },
      }
    }
    const safe = safeJobItems(items)
    return {
      sessionId,
      time: now,
      type: 'control/session/jobs',
      body: { count: items.length, jobs: safe.jobs, complete: safe.complete, representation: 'safe-projection' },
    }
  }
  if (type === 'approval/requested' || type === 'approval/resolved') {
    const body: Record<string, unknown> = {}
    for (const key of ['approvalId', 'toolName', 'callId', 'outcome']) {
      const string = boundedString(frame[key], 256)
      if (string !== undefined) body[key] = string
    }
    const reason = stringValue(frame.reason)
    if (reason !== undefined) body.reason = reason.slice(0, 1024)
    const session = sessionId
    const approvalId = boundedString(frame.approvalId, 256)
    body.originSeq = session === undefined || approvalId === undefined
      ? null
      : state.getInteractionOrigin(session, 'approval', approvalId) ?? null
    const requestRpcId = boundedString(meta.rpcId, 256)
    if (requestRpcId !== undefined && type === 'approval/requested') body.requestRpcId = requestRpcId
    return { sessionId, time: now, type: `control/${type}`, body }
  }
  if (type === 'question/requested') {
    const questions = Array.isArray(frame.questions)
      ? frame.questions.flatMap(item => {
        const question = asRecord(item)
        if (question === undefined) return []
        const result: Record<string, unknown> = {}
        for (const key of ['id', 'header', 'question', 'detail']) {
          const string = boundedString(question[key], key === 'id' ? 256 : 2048)
          if (string !== undefined) result[key] = string
        }
        if (typeof question.multiSelect === 'boolean') result.multiSelect = question.multiSelect
        if (Array.isArray(question.options)) {
          result.options = question.options.flatMap(option => {
            const value = asRecord(option)
            if (value === undefined) return []
            const itemResult: Record<string, unknown> = {}
            for (const key of ['label', 'description']) {
              const string = boundedString(value[key], 1024)
              if (string !== undefined) itemResult[key] = string
            }
            return [itemResult]
          })
        }
        const intent = asRecord(question.intent)
        if (intent !== undefined && boundedString(intent.kind, 64) === 'plan-review') {
          const approve = boundedString(intent.approve, 2048)
          result.intent = { kind: 'plan-review', ...(approve === undefined ? {} : { approve }) }
        }
        return [result]
      })
      : []
    return {
      sessionId,
      time: now,
      type: 'control/question/requested',
      body: {
        questionRpcId: boundedString(meta.rpcId, 256) ?? null,
        originSeq: null,
        questions,
      },
    }
  }
  if (type === 'question/resolved') {
    const body: Record<string, unknown> = {}
    const id = boundedString(frame.questionRpcId, 256)
    const outcome = boundedString(frame.outcome, 64)
    if (id !== undefined) body.questionRpcId = id
    if (outcome !== undefined) body.outcome = outcome
    body.originSeq = null
    return { sessionId, time: now, type: 'control/question/resolved', body }
  }
  if (type === 'stream/error') return { sessionId: '', time: now, type: 'control/stream-error', body: { failureKind: failureCategory(frame.error) ?? 'stream-error' } }
  return undefined
}

function fitV3Events(events: MobileV3Event[], state: MobileSessionSyncState, options: V3Options): { events: MobileV3Event[]; truncated: boolean } {
  const result: MobileV3Event[] = []
  let bytes = 2
  let truncated = false
  for (const event of events) {
    if (result.length >= options.maxEvents) { truncated = true; break }
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (result.length > 0 && bytes + size > options.maxBytes) { truncated = true; break }
    if (result.length === 0 && size > options.maxBytes) {
      // Known large structured bodies are retained by their detail refs; this shell is still
      // emitted instead of silently dropping the sequence.
      const shell: MobileV3Event = { sessionId: event.sessionId, seq: event.seq, time: event.time, type: event.type }
      result.push(shell)
      bytes += Buffer.byteLength(JSON.stringify(shell), 'utf8')
      truncated = true
      break
    }
    result.push(event)
    bytes += size
  }
  return { events: result, truncated }
}

function validateV3SessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new TypeError('sessionId must be a bounded non-empty string')
}

function validateV3HistoryRequest(request: MobileV3HistoryRequest, options: V3Options): void {
  if (typeof request !== 'object' || request === null) throw new TypeError('payload must be an object')
  validateV3SessionId(request.sessionId)
  if (request.beforeSeq !== undefined && (!Number.isInteger(request.beforeSeq) || request.beforeSeq < 0)) throw new TypeError('beforeSeq must be a non-negative integer')
  if (request.maxMessages !== undefined && (!Number.isInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > options.maxEvents)) throw new TypeError(`maxMessages must be between 1 and ${String(options.maxEvents)}`)
}

export async function readMobileV3History(
  api: ApiProxy,
  request: MobileV3HistoryRequest,
  state: MobileSessionSyncState,
  options: V3Options = defaultV3Options(state),
): Promise<RpcResult<MobileV3HistoryValue>> {
  validateV3HistoryRequest(request, options)
  installDetailLoader(api, state, options)
  const response = await api.sessions.history({
    rpcId: RpcId(`mobile-v3-history-${randomUUID()}`),
    payload: {
      sessionId: request.sessionId as SessionId,
      ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
      maxMessages: request.maxMessages ?? options.maxEvents,
    },
  })
  const pageResult = response.result
  if (!pageResult.ok) return { ok: false, error: rpcErrorOf(pageResult) }
  const page = pageResult.value
  const converted = page.events.map(entry => convertMobileHistoryEntry(entry, request.sessionId, state, options))
  for (const event of converted) state.rememberConvertedEvent(event)
  if (request.beforeSeq === undefined) {
    const seqs = page.events.map(entry => entry.event.seq).filter(Number.isInteger)
    if (seqs.length > 0) state.updateWatermark(request.sessionId, Math.max(...seqs), 'history')
    else if (page.hasMore === false) state.updateWatermark(request.sessionId, -1, 'history')
  }
  // Core maxMessages bounds append-origin messages, not events. History must keep the newest
  // suffix when the mobile event/byte budget is smaller, then restore server order.
  // Delta below intentionally keeps the oldest prefix so afterSeq can advance.
  const fitted = fitV3Events(converted.reverse(), state, options)
  fitted.events.reverse()
  const hasMore = page.hasMore || fitted.truncated
  const nextBeforeSeq = hasMore ? fitted.events[0]?.seq : undefined
  const watermark = state.getWatermark(request.sessionId)
  const projections = normalizeMobileProjectionBlock(page.projections)
  return {
    ok: true,
    value: {
      sessionId: request.sessionId,
      events: fitted.events,
      hasMore,
      ...(nextBeforeSeq === undefined ? {} : { nextBeforeSeq }),
      ...(watermark === undefined ? {} : { lastSeq: watermark.lastSeq }),
      lastSeqKnown: watermark !== undefined,
      ...(projections === undefined ? {} : { projections }),
    },
  }
}

export async function readMobileV3Delta(
  api: ApiProxy,
  request: MobileV3DeltaRequest,
  state: MobileSessionSyncState,
  options: V3Options = defaultV3Options(state),
): Promise<RpcResult<MobileV3DeltaValue>> {
  validateDeltaRequest(request, options.maxEvents)
  installDetailLoader(api, state, options)
  const result = await readSessionDelta(api.sessions, request, {
    maxEvents: options.maxEvents,
    scanPageMessages: options.scanPageMessages ?? DEFAULT_SCAN_PAGE_MESSAGES,
    maxScanPages: options.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES,
    watermarkIndex: state,
  })
  if (!result.ok) return { ok: false, error: rpcErrorOf(result) }
  const delta = result.value
  const converted = delta.events.map(entry => convertMobileHistoryEntry(entry, request.sessionId, state, options))
  for (const event of converted) state.rememberConvertedEvent(event)
  const fitted = fitV3Events(converted, state, options)
  const throughSeq = fitted.events.at(-1)?.seq ?? request.afterSeq
  const lastSeqKnown = delta.lastSeqKnown !== false
  const projections = normalizeMobileProjectionBlock(delta.projections)
  return {
    ok: true,
    value: {
      sessionId: request.sessionId,
      acknowledgedSeq: delta.acknowledgedSeq,
      ...(fitted.events[0]?.seq === undefined ? {} : { firstSeq: fitted.events[0].seq }),
      throughSeq,
      ...(lastSeqKnown ? { lastSeq: delta.lastSeq } : {}),
      lastSeqKnown,
      caughtUp: lastSeqKnown && !fitted.truncated && delta.caughtUp,
      scanLimitReached: delta.scanLimitReached,
      hasMore: !lastSeqKnown ? fitted.truncated : fitted.truncated || delta.throughSeq < delta.lastSeq,
      events: fitted.events,
      ...(projections === undefined ? {} : { projections }),
    },
  }
}

export async function readMobileV3Snapshot(
  api: ApiProxy,
  state: MobileSessionSyncState,
): Promise<RpcResult<MobileV3SnapshotValue>> {
  const result = await readSessionSyncSnapshot(api, { watermarkIndex: state })
  if (!result.ok) return { ok: false, error: rpcErrorOf(result) }
  const sessions = result.value.sessions.map(item => item.unknown === true
    ? { sessionId: item.sessionId, authoritative: false, unknown: true as const }
    : { sessionId: item.sessionId, lastSeq: item.lastSeq as number, authoritative: true })
  return {
    ok: true,
    value: {
      protocolVersion: MOBILE_SESSION_V3_PROTOCOL_VERSION,
      capability: MOBILE_SESSION_V3_CAPABILITY,
      snapshotId: result.value.snapshotId,
      observedAt: result.value.observedAt,
      partial: sessions.some(item => item.unknown === true),
      sessions,
    },
  }
}

export async function* readMobileV3Events(
  api: ApiProxy,
  state: MobileSessionSyncState,
  options: { sessionId?: string; sinceSeq?: number } = {},
  signal?: AbortSignal,
): AsyncGenerator<MobileV3Event> {
  state.startMux(api)
  const stream = state.subscribe(options)
  const iterator = stream[Symbol.asyncIterator]()
  const onAbort = (): void => { void iterator.return?.() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (signal?.aborted !== true) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await iterator.return?.()
  }
}

export async function readMobileV3Details(
  state: MobileSessionSyncState,
  request: MobileV3DetailsRequest,
  options: V3Options = defaultV3Options(state),
): Promise<RpcResult<MobileV3DetailsValue>> {
  validateV3SessionId(request.sessionId)
  if (!Number.isInteger(request.seq) || request.seq < 0) throw new TypeError('seq must be a non-negative integer')
  if (!Number.isInteger(request.version) || request.version !== 1) throw new TypeError('unsupported detail version')
  const field = request.field ?? 'event'
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(field)) throw new TypeError('field must be bounded')
  const offset = request.offset ?? 0
  const limit = Math.min(request.limit ?? options.maxDetailChunkBytes, options.maxDetailChunkBytes)
  if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative integer')
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be positive')
  const ref: MobileV3DetailRef = { seq: request.seq, version: request.version, field }
  const detail = await state.resolveDetail(request.sessionId, ref)
  if (detail === undefined || detail.text === undefined) return { ok: false, error: { code: 'internal', message: 'detail unavailable', details: {} } }
  const points = Array.from(detail.text)
  const totalBytes = detail.totalBytes
  const requestedOffset = Math.min(offset, totalBytes)
  let start = 0
  let startOffset = 0
  while (start < points.length && startOffset < requestedOffset) {
    const width = Buffer.byteLength(points[start] as string, 'utf8')
    if (startOffset + width > requestedOffset) throw new TypeError('offset must be a UTF-8 boundary')
    startOffset += width
    start += 1
  }
  let end = start
  let bytes = 0
  let nextOffset = startOffset
  while (end < points.length) {
    const next = points[end] as string
    const nextBytes = Buffer.byteLength(next, 'utf8')
    if (bytes > 0 && bytes + nextBytes > limit) break
    bytes += nextBytes
    nextOffset += nextBytes
    end += 1
  }
  const text = points.slice(start, end).join('')
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
      text,
    },
  }
}

function unwrapV3Message(message: unknown): { rpcId?: string; payload: Record<string, any> } {
  const value = asRecord(message) ?? {}
  if (value.type === 'client-request' && asRecord(value.payload) !== undefined) {
    const rpcId = stringValue(value.rpcId)
    return { ...(rpcId === undefined ? {} : { rpcId }), payload: asRecord(value.payload) as Record<string, any> }
  }
  const rpcId = stringValue(value.rpcId)
  const payload = { ...value }
  delete payload.rpcId
  return { ...(rpcId === undefined ? {} : { rpcId }), payload }
}

function v3Failure(code: string, message: string, details: Record<string, unknown> = {}): object {
  return { ok: false, error: { code, message, details } }
}

function sendV3Result(res: ServerResponse, status: number, rpcId: string | undefined, result: unknown): void {
  sendJson(res, status, rpcId === undefined ? result : { type: 'server-response', rpcId, result })
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1')
}

function handleV3DescribeRequest(req: IncomingMessage, res: ServerResponse, maxRequestBytes: number, options: V3Options): void {
  if (req.method !== 'GET') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  sendJson(res, 200, {
    protocolVersion: MOBILE_SESSION_V3_PROTOCOL_VERSION,
    capability: MOBILE_SESSION_V3_CAPABILITY,
    compatibility: { v2: true },
    limits: {
      maxRequestBytes,
      maxEvents: options.maxEvents,
      maxBytes: options.maxBytes,
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
  })
}

async function readV3JsonBody(req: IncomingMessage, maxRequestBytes: number): Promise<{ rpcId?: string; payload: Record<string, any> }> {
  const text = await readBody(req, maxRequestBytes)
  if (text.trim() === '') return { payload: {} }
  return unwrapV3Message(JSON.parse(text))
}

async function handleV3SnapshotRequest(api: ApiProxy, req: IncomingMessage, res: ServerResponse, maxRequestBytes: number, state: MobileSessionSyncState, options: V3Options): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  try {
    const request = await readV3JsonBody(req, maxRequestBytes)
    const result = await readMobileV3Snapshot(api, state)
    return sendV3Result(res, result.ok ? 200 : 503, request.rpcId, result.ok ? result.value : v3Failure('snapshot-failed', 'snapshot unavailable'))
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid snapshot request'))
  }
}

async function handleV3DeltaRequest(api: ApiProxy, req: IncomingMessage, res: ServerResponse, maxRequestBytes: number, state: MobileSessionSyncState, options: V3Options): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  try {
    const request = await readV3JsonBody(req, maxRequestBytes)
    const result = await readMobileV3Delta(api, request.payload as MobileV3DeltaRequest, state, options)
    if (result.ok) return sendV3Result(res, 200, request.rpcId, result.value)
    return sendV3Result(res, 400, request.rpcId, v3Failure(rpcErrorOf(result).code, 'delta unavailable'))
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid delta request'))
  }
}

async function handleV3HistoryRequest(api: ApiProxy, req: IncomingMessage, res: ServerResponse, maxRequestBytes: number, state: MobileSessionSyncState, options: V3Options): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  try {
    const request = await readV3JsonBody(req, maxRequestBytes)
    const result = await readMobileV3History(api, request.payload as MobileV3HistoryRequest, state, options)
    if (result.ok) return sendV3Result(res, 200, request.rpcId, result.value)
    return sendV3Result(res, 400, request.rpcId, v3Failure(rpcErrorOf(result).code, 'history unavailable'))
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid history request'))
  }
}

function waitForV3Drain(res: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || res.writableEnded || res.destroyed) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onDrain = (): void => finish(true)
    const onClose = (): void => finish(false)
    const onAbort = (): void => finish(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function writeV3SseFrame(res: ServerResponse, event: MobileV3Event, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || res.writableEnded || res.destroyed) return false
  const accepted = res.write(`data: ${JSON.stringify(event)}\n\n`)
  return accepted || await waitForV3Drain(res, signal)
}

async function handleV3EventsRequest(api: ApiProxy, req: IncomingMessage, res: ServerResponse, state: MobileSessionSyncState, options: V3Options): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  let sessionId: string | undefined
  let sinceSeq: number | undefined
  try {
    const url = parseUrl(req)
    sessionId = url.searchParams.get('sessionId') ?? undefined
    const sinceRaw = url.searchParams.get('sinceSeq')
    sinceSeq = sinceRaw === null ? undefined : Number(sinceRaw)
    if (sessionId !== undefined) validateV3SessionId(sessionId)
    if (sinceSeq !== undefined && (!Number.isInteger(sinceSeq) || sinceSeq < -1)) throw new TypeError('invalid sinceSeq')
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid events request'))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const controller = new AbortController()
  const onRequestClose = (): void => controller.abort()
  req.on('close', onRequestClose)
  try {
    for await (const event of readMobileV3Events(api, state, { ...(sessionId === undefined ? {} : { sessionId }), ...(sinceSeq === undefined ? {} : { sinceSeq }) }, controller.signal)) {
      if (controller.signal.aborted || res.writableEnded) break
      if (!await writeV3SseFrame(res, event, controller.signal)) break
    }
  } catch {
    if (!res.writableEnded) {
      await writeV3SseFrame(res, { sessionId: '', type: 'control/stream-error', time: Date.now(), body: { failureKind: 'stream-error' } }, controller.signal)
    }
  } finally {
    req.removeListener('close', onRequestClose)
    if (!res.writableEnded) res.end()
  }
}

async function handleV3DetailsRequest(req: IncomingMessage, res: ServerResponse, maxRequestBytes: number, state: MobileSessionSyncState, options: V3Options): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, v3Failure('method-not-allowed', 'method not allowed'))
  if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, v3Failure('forbidden', 'forbidden'))
  try {
    let rpcId: string | undefined
    const request = req.method === 'GET'
      ? (() => {
        const url = parseUrl(req)
        return {
          sessionId: url.searchParams.get('sessionId') ?? '',
          seq: Number(url.searchParams.get('seq')),
          version: Number(url.searchParams.get('version') ?? '1'),
          ...(url.searchParams.get('field') === null ? {} : { field: url.searchParams.get('field') as string }),
          ...(url.searchParams.get('offset') === null ? {} : { offset: Number(url.searchParams.get('offset')) }),
          ...(url.searchParams.get('limit') === null ? {} : { limit: Number(url.searchParams.get('limit')) }),
        }
      })()
      : await (async () => {
        const message = await readV3JsonBody(req, maxRequestBytes)
        rpcId = message.rpcId
        return message.payload as MobileV3DetailsRequest
      })()
    const result = await readMobileV3Details(state, request as MobileV3DetailsRequest, options)
    return sendV3Result(res, result.ok ? 200 : 404, rpcId, result.ok ? result.value : v3Failure('detail-not-found', 'detail unavailable'))
  } catch {
    return sendJson(res, 400, v3Failure('bad-request', 'invalid detail request'))
  }
}
