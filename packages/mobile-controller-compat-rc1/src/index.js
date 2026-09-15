/**
 * Narrow Android business-RPC compatibility bridge for the official rc1
 * Session/Workspace controller faces. It intentionally owns no event stream
 * or token bootstrap state.
 *
 */

import { homedir } from 'node:os'
import { canonicalToMobileHistoryEvent } from 'dsh-runtime-interface'
import { dispatchSubagent, MOBILE_SUBAGENT_COMPAT_METHODS } from './subagents.js'
import { dispatchAuxiliary, MOBILE_AUXILIARY_COMPAT_METHODS } from './auxiliary.js'

// The official commands/execute route already owns its public wire shape.
const auxiliaryMethods = MOBILE_AUXILIARY_COMPAT_METHODS.filter(method => method.startsWith('goal.'))

export const name = 'mobile-controller-compat-rc1'
export const inject = [
  'webServer',
  'runtimeInterface',
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'directoryPickerController',
  'goals',
]

export const MOBILE_CONTROLLER_COMPAT_METHODS = Object.freeze([
  ...MOBILE_SUBAGENT_COMPAT_METHODS,
  ...auxiliaryMethods,
  'host.describe',
  'host.listDirectory',
  'host.createDirectory',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'session.list',
  'session.create',
  'session.rename',
  'session.search',
  'session.fork',
  'session.history',
  'session.prompt',
  'session.cancel',
  'session.models',
  'session.selectModel',
  'session.updateQueue',
  'session.attachment',
  'agentPreset.list',
  'agentPreset.select',
])

export const MOBILE_CONTROLLER_COMPAT_PATHS = Object.freeze(
  MOBILE_CONTROLLER_COMPAT_METHODS.map(method => `/api/${method}`),
)

/** Routes intentionally left to the official gateway or another bridge. */
export const MOBILE_CONTROLLER_COMPAT_UNSUPPORTED_METHODS = Object.freeze([
  'events.host',
  'tokenbootstrap',
  'session.openWorkspacePath',
  'commands/execute',
  'skills.list',
  'fileReferences.list',
])

export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const RC1_RUNTIME_VERSION = '0.1.2-rc.1'

const DEFAULT_CONFIG = Object.freeze({
  maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
})

export const Config = Object.freeze({
  parse(value) {
    return normalizeConfig(value)
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-mobile-controller-compat-rc1',
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
  if (!runtime || typeof runtime !== 'object') throw new CapabilityUnavailableError('runtime interface is unavailable')
  return runtime
}

function sessionPortOf(ctx, methods = []) {
  const port = runtimeOf(ctx).session
  assertController(port, 'runtimeInterface.session', methods)
  return port
}

function workspacePortOf(ctx, methods = []) {
  const port = runtimeOf(ctx).workspace
  assertController(port, 'runtimeInterface.workspace', methods)
  return port
}

function subagentsPortOf(ctx, methods = []) {
  const port = runtimeOf(ctx).subagents
  assertController(port, 'runtimeInterface.subagents', methods)
  return port
}

function connectionPortOf(ctx) {
  const port = runtimeOf(ctx).connection
  assertController(port, 'runtimeInterface.connection', ['requestRejection'])
  return port
}

/**
 * Map official SessionHistoryRecord rows to Android history entries.
 *
 * `options.throughSeq` is the inclusive cursor from the same official follow
 * snapshot. `options.beforeSeq`, when present, is an exclusive older-page
 * bound. Numeric second/third arguments are accepted for the v2 sync helper
 * shape so the stream bridge can reuse this exact decoder without a second
 * implementation.
 */
export function mapHistoryRecords(records, options, legacyBeforeSeq) {
  if (typeof options === 'number' || options === undefined || options === null) {
    options = {
      ...(options === undefined || options === null ? {} : { throughSeq: options }),
      ...(legacyBeforeSeq === undefined ? {} : { beforeSeq: legacyBeforeSeq }),
    }
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('history mapping options must be an object')
  }
  if (!Array.isArray(records)) throw new HistoryMappingError('records must be an array')
  const throughSeq = normalizeOptionalSequence(options.throughSeq, 'throughSeq', -1)
  const beforeSeq = normalizeOptionalSequence(options.beforeSeq, 'beforeSeq', 0)
  const entries = []
  for (const record of records) {
    for (const entry of decodeHistoryRecord(record)) {
      const seq = entry.event?.seq
      if (!isSequence(seq) || (throughSeq !== undefined && seq > throughSeq)) {
        throw new HistoryMappingError('history record is outside the official cursor')
      }
      if (beforeSeq !== undefined && seq >= beforeSeq) {
        throw new HistoryMappingError('history page violates its beforeSeq bound')
      }
      entries.push(entry)
    }
  }
  return entries
}

/** Compatibility name for callers that used the sync adapter's decoder. */
export const decodeHistoryRecords = mapHistoryRecords

/** Read one Android-shaped session history value from official controllers. */
export async function readSessionHistory(sessionPort, payload, signal) {
  assertController(sessionPort, 'runtimeInterface.session', ['follow', 'page'])
  const request = normalizeHistoryRequest(payload)
  const effectiveSignal = signal ?? new AbortController().signal
  throwIfAborted(effectiveSignal)
  const address = { kind: 'session', sessionId: request.sessionId }
  const followRequest = {
    address,
    ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
  }
  const source = await sessionPort.follow(followRequest, effectiveSignal)
  const iterator = await toAsyncIterator(source)
  try {
    const first = await raceAbort(iterator.next(), effectiveSignal)
    if (first?.done || !first?.value || first.value.type !== 'snapshot') {
      throw new HistoryMappingError('official follow did not yield a snapshot')
    }
    const cursor = normalizeSequence(first.value.cursor, 'follow cursor', -1)
    if (!Array.isArray(first.value.records) || typeof first.value.hasMore !== 'boolean') {
      throw new HistoryMappingError('official follow snapshot is malformed')
    }

    let records = first.value.records
    let hasMore = first.value.hasMore
    if (request.beforeSeq !== undefined) {
      const pageRequest = {
        address,
        throughSeq: cursor,
        beforeSeq: request.beforeSeq,
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      }
      const page = unwrapControllerValue(await sessionPort.page(pageRequest, effectiveSignal))
      if (!page || typeof page !== 'object' || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        throw new HistoryMappingError('official history page is malformed')
      }
      records = page.records
      hasMore = page.hasMore
    }

    const value = {
      events: mapHistoryRecords(records, {
        throughSeq: cursor,
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
      }),
      hasMore,
    }
    if (Object.hasOwn(first.value, 'projections') && first.value.projections !== undefined) {
      value.projections = first.value.projections
    }
    return value
  } finally {
    await closeIterator(iterator, effectiveSignal)
  }
}

/** Read the first complete Workspace baseline as the legacy list value. */
export async function readWorkspaceList(workspacePort, signal) {
  assertController(workspacePort, 'runtimeInterface.workspace', ['follow'])
  const effectiveSignal = signal ?? new AbortController().signal
  throwIfAborted(effectiveSignal)
  const source = await workspacePort.follow(effectiveSignal)
  const iterator = await toAsyncIterator(source)
  try {
    const first = await raceAbort(iterator.next(), effectiveSignal)
    if (first?.done || !first?.value || first.value.type !== 'baseline') {
      throw new HistoryMappingError('official workspace follow did not yield a baseline')
    }
    const baseline = first.value.value
    if (!baseline || typeof baseline !== 'object'
        || !Array.isArray(baseline.items) || !Array.isArray(baseline.archivedSessionIds)) {
      throw new HistoryMappingError('official workspace baseline is malformed')
    }
    return {
      items: baseline.items,
      archivedSessionIds: baseline.archivedSessionIds,
    }
  } finally {
    await closeIterator(iterator, effectiveSignal)
  }
}

/** Build the required legacy Host description from process and official services. */
export async function describeHost(ctx, config = {}, signal) {
  throwIfAborted(signal)
  const selection = await readDefaultSelection(ctx)
  const attachedSessions = await readAttachedSessionCount(ctx, signal)
  let canOpenPath = false
  const session = sessionPortOf(ctx)
  try { canOpenPath = Boolean(await session.canOpenWorkspacePath()) }
  catch (error) { if (error?.code !== 'runtime-interface/capability-unavailable') throw error }
  if (attachedSessions === undefined) throw new CapabilityUnavailableError('attached session count is unavailable')
  const result = {
    version: runtimeOf(ctx).upstreamVersion,
    cwd: process.cwd(),
    attachedSessions,
    home: homedir(),
    platform: process.platform,
    canOpenPath,
  }
  if (selection) {
    if (result.provider === undefined) result.provider = selection.provider
    if (result.model === undefined) result.model = selection.model
    if (result.reasoningEffort === undefined && selection.reasoningEffort !== undefined) {
      result.reasoningEffort = selection.reasoningEffort
    }
  }
  return result
}

/** Adapt the official generation model catalog to Android's boolean `routable`. */
export async function readSessionModels(ctx, payload, signal) {
  const controller = sessionPortOf(ctx, ['modelCatalog'])
  const sessionId = normalizeSessionId(payload?.sessionId)
  throwIfAborted(signal)
  const catalog = unwrapControllerValue(await controller.modelCatalog())
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.groups)) {
    throw new CapabilityUnavailableError('official model catalog is unavailable')
  }
  const current = await readSessionSelection(ctx, controller, sessionId, catalog, signal)
  if (!current) throw new CapabilityUnavailableError('session model selection is unavailable')
  return {
    current,
    routable: typeof catalog.routable === 'boolean'
      ? catalog.routable
      : Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0,
    groups: catalog.groups,
    ...(Array.isArray(catalog.failures) ? { failures: catalog.failures } : {}),
  }
}

/** Adapt AgentPresets' path-free roster to Android's old catalog shape. */
export async function readAgentPresetCatalog(ctx) {
  const presets = ctx?.agentPresets
  if (!presets || typeof presets.remoteExportList !== 'function') {
    throw new CapabilityUnavailableError('agent preset roster is unavailable')
  }
  const roster = unwrapControllerValue(await presets.remoteExportList())
  if (!roster || typeof roster !== 'object' || !Array.isArray(roster.presets)) {
    throw new CapabilityUnavailableError('agent preset roster is unavailable')
  }
  return {
    presets: roster.presets,
    authorable: typeof roster.authorable === 'boolean' ? roster.authorable : false,
    // rc1 has no document-authoring field. False is an explicit unsupported
    // capability, never a claim that a document service is present.
    hasDocument: typeof roster.hasDocument === 'boolean' ? roster.hasDocument : false,
  }
}

/** Select an AgentPreset through the official Session Agent and preset service. */
export async function selectAgentPreset(ctx, payload, signal) {
  const operations = runtimeOf(ctx).agentOperations
  if (!operations?.agentPresets || typeof operations.agentPresets.select !== 'function') {
    throw new CapabilityUnavailableError('agent preset selection is unavailable')
  }
  const sessionId = normalizeSessionId(payload?.sessionId)
  const agentPreset = requireString(payload?.agentPreset, 'agentPreset')
  throwIfAborted(signal)
  const selected = await operations.agentPresets.select({ sessionId, agentPreset })
  return { agentPreset: typeof selected === 'string' ? selected : agentPreset }
}

/** Register the exact Android business paths over the official controller faces. */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('webServer is required')
  }
  connectionPortOf(ctx)
  const register = () => {
    const disposers = []
    try {
      for (const method of MOBILE_CONTROLLER_COMPAT_METHODS) {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: `/api/${method}`,
          handler: (req, res) => handleRoute(ctx, method, req, res, resolved),
        }))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try { dispose?.() } catch { /* preserve registration failure */ }
      }
      throw error
    }
    return () => disposers.reverse().forEach(dispose => dispose?.())
  }
  return typeof ctx.effect === 'function'
    ? ctx.effect(register, 'mobile-controller-compat-rc1: Android business routes')
    : register()
}

async function dispatch(ctx, method, payload, signal, rpcId, config) {
  if (auxiliaryMethods.includes(method)) {
    return dispatchAuxiliary({ agentOperations: runtimeOf(ctx).agentOperations }, method, payload, signal)
  }
  if (MOBILE_SUBAGENT_COMPAT_METHODS.includes(method)) {
    return dispatchSubagent({ subagents: subagentsPortOf(ctx), session: sessionPortOf(ctx), mobileHistoryMapper: mapHistoryRecords }, method, payload, signal, rpcId)
  }
  switch (method) {
    case 'host.describe':
      expectObject(payload)
      return describeHost(ctx, config, signal)
    case 'host.listDirectory':
      expectObject(payload)
      return ctx.directoryPickerController.list(optionalString(payload.path, 'path'), signal)
    case 'host.createDirectory':
      return { path: await ctx.directoryPickerController.createDirectory(requireString(payload?.path, 'path'), requireString(payload?.name, 'name')) }

    case 'workspace.list':
      expectObject(payload)
      return readWorkspaceList(workspacePortOf(ctx, ['follow']), signal)
    case 'workspace.create':
      return invokeWorkspace(ctx, 'create', { path: requireString(payload?.path, 'path') })
    case 'workspace.rename':
      return invokeWorkspace(ctx, 'rename', {
        workspaceId: requireString(payload?.workspaceId, 'workspaceId'),
        title: requireString(payload?.title, 'title'),
      })
    case 'workspace.delete':
      return invokeWorkspace(ctx, 'delete', {
        workspaceId: requireString(payload?.workspaceId, 'workspaceId'),
      })
    case 'workspace.insertBefore':
      return invokeWorkspace(ctx, 'insertBefore', optionalFields({
        workspaceId: requireString(payload?.workspaceId, 'workspaceId'),
        beforeWorkspaceId: optionalString(payload?.beforeWorkspaceId, 'beforeWorkspaceId'),
      }))
    case 'workspace.insertSessionBefore':
      return invokeWorkspace(ctx, 'insertSessionBefore', optionalFields({
        workspaceId: requireString(payload?.workspaceId, 'workspaceId'),
        sessionId: requireString(payload?.sessionId, 'sessionId'),
        beforeSessionId: optionalString(payload?.beforeSessionId, 'beforeSessionId'),
      }))
    case 'workspace.archiveSession':
      return invokeWorkspace(ctx, 'archiveSession', {
        sessionId: normalizeSessionId(payload?.sessionId),
      })

    case 'session.list':
      return readSessionList(ctx, normalizeSessionListRequest(payload), signal)
    case 'session.create':
      return invokeSession(ctx, 'create', normalizeSessionCreateRequest(payload))
    case 'session.rename':
      return invokeSession(ctx, 'rename', {
        sessionId: normalizeSessionId(payload?.sessionId),
        title: requireString(payload?.title, 'title'),
      })
    case 'session.search':
      return invokeSession(ctx, 'search', {
        query: requireString(payload?.query, 'query'),
      }, signal)
    case 'session.fork':
      return invokeSession(ctx, 'fork', optionalFields({
        sessionId: normalizeSessionId(payload?.sessionId),
        atSeq: optionalSequence(payload?.atSeq, 'atSeq', 0),
      }))
    case 'session.history':
      return readSessionHistory(sessionPortOf(ctx, ['follow', 'page']), payload, signal)
    case 'session.prompt':
      return invokeSession(ctx, 'prompt', {
        // Android's envelope rpcId is the only client-minted correlation id;
        // rc1 prompt requires requestId, so preserve that id exactly.
        requestId: requireRpcId(rpcId),
        sessionId: normalizeSessionId(payload?.sessionId),
        mode: requireMode(payload?.mode),
        content: normalizePromptContent(payload?.content),
        ...(payload?.clientTimeZone === undefined ? {} : {
          clientTimeZone: requireString(payload.clientTimeZone, 'clientTimeZone'),
        }),
      }, signal)
    case 'session.cancel':
      return invokeSession(ctx, 'cancel', { sessionId: normalizeSessionId(payload?.sessionId) })
    case 'session.models':
      return readSessionModels(ctx, payload, signal)
    case 'session.selectModel':
      return invokeSession(ctx, 'selectModel', optionalFields({
        sessionId: normalizeSessionId(payload?.sessionId),
        provider: requireString(payload?.provider, 'provider'),
        model: requireString(payload?.model, 'model'),
        reasoningEffort: optionalString(payload?.reasoningEffort, 'reasoningEffort'),
      }))
    case 'session.updateQueue':
      return invokeSession(ctx, 'updateQueue', {
        sessionId: normalizeSessionId(payload?.sessionId),
        itemId: requireString(payload?.itemId, 'itemId'),
        action: normalizeQueueAction(payload?.action),
      })
    case 'session.attachment':
      return invokeSession(ctx, 'attachment', {
        sessionId: normalizeSessionId(payload?.sessionId),
        attachmentId: requireString(payload?.attachmentId, 'attachmentId'),
      })

    case 'agentPreset.list':
      expectObject(payload)
      return readAgentPresetCatalog(ctx)
    case 'agentPreset.select':
      return selectAgentPreset(ctx, payload, signal)
    default:
      throw new CapabilityUnavailableError(`${method} is not implemented by this bridge`)
  }
}

function invokeSession(ctx, method, request, signal) {
  const controller = sessionPortOf(ctx, [method])
  const args = signal === undefined ? [request] : [request, signal]
  return Promise.resolve(controller[method](...args)).then(unwrapControllerValue)
}

async function readSessionList(ctx, request, signal) {
  const controller = sessionPortOf(ctx, ['list'])
  const value = unwrapControllerValue(await controller.list(request, signal))
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return value
  return {
    ...value,
    items: value.items.map(summary => {
      if (!isPlainObject(summary) || summary.agentPreset !== undefined) return summary
      const projection = summary.projections?.values?.agentPreset
      return typeof projection === 'string' ? { ...summary, agentPreset: projection } : summary
    }),
  }
}

function invokeWorkspace(ctx, method, request) {
  const controller = workspacePortOf(ctx, [method])
  return Promise.resolve(controller[method](request)).then(unwrapControllerValue)
}

function handleRoute(ctx, method, req, res, config) {
  if (!authorizeHttpRequest(ctx, req, res, config.maxResponseBytes)) return
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, config.maxResponseBytes)
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content type must be application/json' }, config.maxResponseBytes)
    return
  }
  return handleJsonRequest(ctx, method, req, res, config)
}

async function handleJsonRequest(ctx, method, req, res, config) {
  const lifetime = createRequestLifetime(req, res, config.requestTimeoutMs)
  let rpcId = 'invalid'
  try {
    const body = await raceAbort(readBody(req, config.maxRequestBytes, lifetime.signal), lifetime.signal)
    const ingress = runtimeOf(ctx).decodeMobileIngress({
      route: method,
      body,
      headers: req.headers,
      type: 'client-request',
      method,
      requirePayloadObject: true,
    })
    rpcId = ingress.rpcId
    const value = await raceAbort(
      dispatch(ctx, method, ingress.payload, lifetime.signal, rpcId, config),
      lifetime.signal,
    )
    if (lifetime.timedOut) {
      sendJson(res, 408, { error: 'request timeout' }, config.maxResponseBytes)
      return
    }
    if (lifetime.clientClosed) return
    sendJson(res, 200, {
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    }, config.maxResponseBytes)
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
    sendJson(res, 200, serverFailure(rpcId, error), config.maxResponseBytes)
  } finally {
    lifetime.dispose()
  }
}

function authorizeHttpRequest(ctx, req, res, maxResponseBytes) {
  let connection
  try { connection = connectionPortOf(ctx) } catch {
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
    const candidate = typeof rejection === 'number' ? rejection : rejection?.status
    const status = candidate === 401 || candidate === 403 ? candidate : 503
    sendJson(res, status, {
      error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication unavailable',
    }, maxResponseBytes)
    return false
  }
  return true
}

function normalizeConfig(value) {
  if (value === undefined || value === null) value = {}
  if (!isPlainObject(value)) throw new TypeError('config must be an object')
  const hostDescription = value.hostDescription === undefined
    ? undefined
    : freezePlainObject(value.hostDescription, 'hostDescription')
  return Object.freeze({
    maxRequestBytes: boundedInteger(value.maxRequestBytes ?? DEFAULT_CONFIG.maxRequestBytes, 'maxRequestBytes', 1024, 64 * 1024 * 1024),
    maxResponseBytes: boundedInteger(value.maxResponseBytes ?? DEFAULT_CONFIG.maxResponseBytes, 'maxResponseBytes', 1024, 64 * 1024 * 1024),
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs, 'requestTimeoutMs', 1, 10 * 60 * 1000),
    ...(hostDescription === undefined ? {} : { hostDescription }),
  })
}

function normalizeHistoryRequest(payload) {
  expectObject(payload)
  return {
    sessionId: normalizeSessionId(payload.sessionId),
    beforeSeq: optionalSequence(payload.beforeSeq, 'beforeSeq', 0),
    maxMessages: optionalPositiveInteger(payload.maxMessages, 'maxMessages'),
  }
}

function normalizeSessionListRequest(payload) {
  expectObject(payload)
  return payload.cursor === undefined ? {} : { cursor: requireString(payload.cursor, 'cursor') }
}

function normalizeSessionCreateRequest(payload) {
  expectObject(payload)
  const request = optionalFields({
    workspaceId: optionalString(payload.workspaceId, 'workspaceId'),
    cwd: optionalString(payload.cwd, 'cwd'),
    sessionId: optionalString(payload.sessionId, 'sessionId'),
    agentPreset: optionalString(payload.agentPreset, 'agentPreset'),
  })
  if (request.workspaceId !== undefined && request.cwd !== undefined) {
    throw new BadRequestError('workspaceId and cwd are mutually exclusive')
  }
  return request
}

function normalizePromptContent(content) {
  if (!Array.isArray(content)) throw new BadRequestError('content must be an array')
  return content.map((part, index) => {
    if (!isPlainObject(part) || typeof part.type !== 'string') {
      throw new BadRequestError(`content[${index}] is invalid`)
    }
    if (part.type === 'text') {
      return { type: 'text', text: requireString(part.text, `content[${index}].text`, { allowEmpty: true }) }
    }
    if (part.type === 'image') {
      return optionalFields({
        type: 'image',
        mediaType: requireString(part.mediaType, `content[${index}].mediaType`),
        data: requireString(part.data, `content[${index}].data`),
        name: optionalString(part.name, `content[${index}].name`),
      })
    }
    throw new BadRequestError(`content[${index}] has unsupported type`)
  })
}

function normalizeQueueAction(action) {
  expectObject(action, 'action')
  if (action.kind === 'remove' || action.kind === 'steer') return { kind: action.kind }
  if (action.kind === 'edit') {
    return { kind: 'edit', content: normalizeQueueContent(action.content) }
  }
  throw new BadRequestError('action.kind is unsupported')
}

function normalizeQueueContent(content) {
  if (!Array.isArray(content)) throw new BadRequestError('action.content must be an array')
  return content.map((part, index) => {
    if (!isPlainObject(part) || typeof part.type !== 'string' || part.type.length === 0) {
      throw new BadRequestError(`action.content[${index}] is invalid`)
    }
    // Queue content is an extensible dsh-llm ContentBlock. Preserve every
    // official field instead of narrowing a forward-compatible block to text
    // and image only.
    return { ...part }
  })
}

async function readDefaultSelection(ctx) {
  const service = ctx?.agentDefaultModel
  if (!service || typeof service.currentSelection !== 'function') return undefined
  const value = await service.currentSelection()
  return isSelection(value) ? value : undefined
}

async function readAttachedSessionCount(ctx, signal) {
  const agents = ctx?.agents
  if (agents && typeof agents.list === 'function') {
    const rows = await agents.list()
    if (Array.isArray(rows)) return rows.length
  }
  // The official Agent list is optional in small test compositions. Avoid
  // invoking session.list here because that would turn describe into a cold
  // history read and could activate a custom controller.
  throwIfAborted(signal)
  return undefined
}

async function readSessionSelection(ctx, controller, sessionId, catalog, signal) {
  assertController(controller, 'runtimeInterface.session', ['follow'])
  const effectiveSignal = signal ?? new AbortController().signal
  const iterator = await toAsyncIterator(await controller.follow({
    address: { kind: 'session', sessionId }, maxMessages: 1,
  }, effectiveSignal))
  try {
    const first = await raceAbort(iterator.next(), effectiveSignal)
    if (first.done || first.value?.type !== 'snapshot') throw new HistoryMappingError('model projection snapshot is unavailable')
    return extractSelection(first.value.projections?.values?.modelSelection) ?? extractSelection(catalog.default)
  } finally {
    await closeIterator(iterator, effectiveSignal)
  }
}
function extractSelection(candidate) {
  if (isSelection(candidate)) return candidate
  if (!candidate || typeof candidate !== 'object') return undefined
  for (const key of ['next', 'pending', 'current', 'lastUsed']) {
    if (isSelection(candidate[key])) return candidate[key]
  }
  return undefined
}

function isSelection(value) {
  return isPlainObject(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

function expectObject(value, name = 'payload') {
  if (!isPlainObject(value)) throw new BadRequestError(`${name} must be an object`)
  return value
}

function assertController(controller, name, methods) {
  if (!controller || methods.some(method => typeof controller[method] !== 'function')) {
    throw new CapabilityUnavailableError(`${name} is unavailable`)
  }
}

function normalizeSessionId(value) {
  const sessionId = requireString(value, 'sessionId')
  if (sessionId.startsWith('rh1.')) throw new BadRequestError('sessionId must be a local Session id')
  return sessionId
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > DEFAULT_MAX_REQUEST_BYTES || value.includes('\u0000')) {
    throw new BadRequestError(`${name} must be a bounded string`)
  }
  return value
}

function optionalString(value, name) {
  return value === undefined ? undefined : requireString(value, name)
}

function requireMode(value) {
  if (value !== 'queue' && value !== 'steer') throw new BadRequestError('mode must be queue or steer')
  return value
}

function optionalFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function optionalSequence(value, name, min) {
  return value === undefined ? undefined : normalizeSequence(value, name, min)
}

function normalizeOptionalSequence(value, name, min) {
  return value === undefined ? undefined : normalizeSequence(value, name, min)
}

function normalizeSequence(value, name, min) {
  if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) {
    throw new BadRequestError(`${name} must be a safe integer >= ${String(min)}`)
  }
  return value
}

function optionalPositiveInteger(value, name) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw new BadRequestError(`${name} must be a positive safe integer`)
  }
  return value
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max || Object.is(value, -0)) {
    throw new TypeError(`${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return value
}

function normalizeRpcId(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\u0000')) return value
  return undefined
}

function requireRpcId(value) {
  const rpcId = normalizeRpcId(value)
  if (rpcId === undefined) throw new BadRequestError('rpcId must be a non-empty string')
  return rpcId
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freezePlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`)
  return Object.freeze({ ...value })
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

function decodeHistoryRecord(record) {
  if (!isPlainObject(record)) throw new HistoryMappingError('unsupported history record')
  if (record.type === 'event') {
    const event = canonicalEventForMobileHistory(record.event)
    if (!isPlainObject(event) || typeof event.type !== 'string'
        || !isSequence(event.seq) || !Number.isSafeInteger(event.time)) {
      throw new HistoryMappingError('unsupported event record')
    }
    return [copyHistoryEntry(event, record.view)]
  }
  throw new HistoryMappingError('unsupported history record')
}

/** The interface owns legacy packed history; this only emits v2 stable data. */
function canonicalEventForMobileHistory(event) {
  return canonicalToMobileHistoryEvent(event)
}

function copyHistoryEntry(event, view) {
  return {
    event,
    ...(view === undefined ? {} : { view }),
  }
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
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
  const onResponseClose = () => {
    if (!res.writableEnded) onAborted()
  }
  req.once?.('aborted', onAborted)
  req.once?.('close', onClose)
  res.once?.('close', onResponseClose)
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    get clientClosed() { return clientClosed },
    dispose() {
      clearTimeout(timeout)
      req.off?.('aborted', onAborted)
      req.off?.('close', onClose)
      res.off?.('close', onResponseClose)
    },
  }
}

async function readBody(req, maxBytes, signal) {
  const contentLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume?.()
    throw new RequestTooLargeError()
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)
    if (body.byteLength > maxBytes) throw new RequestTooLargeError()
    return body.toString('utf8')
  }
  const chunks = []
  let total = 0
  if (typeof req[Symbol.asyncIterator] !== 'function') return ''
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
  try { body = JSON.stringify(value) } catch { body = JSON.stringify({ error: 'response unavailable' }); status = 500 }
  if (body === undefined) body = JSON.stringify({ error: 'response unavailable' })
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    status = 413
    body = JSON.stringify({ error: 'response too large' })
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

function serverFailure(rpcId, error) {
  const safe = safePublicError(error)
  return {
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
        ...(safe.details === undefined ? {} : { details: safe.details }),
      },
    },
  }
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  'gateway/bad-request': 'request rejected',
  'gateway/capability-unavailable': 'requested capability is unavailable',
  'gateway/cancelled': 'request cancelled',
  'gateway/history-unsupported': 'session history format is unsupported',
  'gateway/internal': 'mobile controller unavailable',
  'gateway/request-too-large': 'request body too large',
  'session/not-found': 'session unavailable',
  'session/agent-busy': 'session unavailable',
  'session/model-unavailable': 'model unavailable',
  'subagent/not-found': 'session unavailable',
  'subagent/unauthorized': 'session unavailable',
  'workspace/invalid-path': 'workspace path is invalid',
  'workspace/name-conflict': 'workspace name is already used',
  'workspace/move-invalid': 'workspace order request is invalid',
  'agent-preset/not-found': 'agent preset unavailable',
  'agent-preset/conflict': 'agent preset conflicts with the session',
})

function safePublicError(error) {
  const code = safeErrorCode(error)
  const message = PUBLIC_ERROR_MESSAGES[code] ?? genericErrorMessage(code)
  return {
    code,
    message,
    ...(error?.details && isPlainObject(error.details) && Array.isArray(error.details.issues)
      ? { details: { issues: [] } }
      : {}),
  }
}

function safeErrorCode(error) {
  if (error instanceof BadRequestError || error instanceof TypeError || error instanceof SyntaxError) return 'gateway/bad-request'
  if (error instanceof CapabilityUnavailableError) return 'gateway/capability-unavailable'
  if (error instanceof HistoryMappingError) return 'gateway/history-unsupported'
  if (error instanceof RequestTooLargeError) return 'gateway/request-too-large'
  if (error?.code === 'runtime-interface/capability-unavailable') return 'gateway/capability-unavailable'
  if (error?.code === 'history-format-incompatible') return 'gateway/history-unsupported'
  if (error?.name === 'ApiSessionNotFound') return 'session/not-found'
  const candidate = typeof error?.code === 'string' ? error.code : undefined
  if (candidate && /^[a-z][a-z0-9-]{0,48}\/[a-z][a-z0-9-]{0,64}$/.test(candidate)) return candidate
  return 'gateway/internal'
}

function genericErrorMessage(code) {
  if (code.startsWith('workspace/')) return 'workspace request rejected'
  if (code.startsWith('session/')) return 'session request rejected'
  if (code.startsWith('agent-preset/')) return 'agent preset request rejected'
  return 'request failed'
}

function isJsonContentType(req) {
  const contentType = req.headers?.['content-type']
  if (Array.isArray(contentType)) return isJsonContentType({ headers: { 'content-type': contentType[0] } })
  return typeof contentType === 'string'
    && contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

async function toAsyncIterator(value) {
  const resolved = await value
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') return resolved[Symbol.asyncIterator]()
  if (resolved && typeof resolved[Symbol.iterator] === 'function') return resolved[Symbol.iterator]()
  return (async function * one() { yield resolved })()
}

async function closeIterator(iterator, signal) {
  if (typeof iterator?.return !== 'function') return
  try { await iterator.return() } catch (error) {
    if (!signal?.aborted) throw error
  }
}

function raceAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise)
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'request failed')
}

export class CapabilityUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CapabilityUnavailableError'
    this.code = 'gateway/capability-unavailable'
  }
}

export class HistoryMappingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HistoryMappingError'
    this.code = 'gateway/history-unsupported'
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
    this.code = 'gateway/bad-request'
  }
}

class RequestTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'RequestTooLargeError'
    this.code = 'gateway/request-too-large'
  }
}

/** In-process adapter entry; returns the same raw value as the authenticated HTTP dispatcher. */
export { dispatch as dispatchMobileControllerRpc }
