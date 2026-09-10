/**
 * Android's subagent compatibility surface for the official rc1 subagents
 * service.  This module deliberately has no import from index.js: the
 * history decoder is supplied by the caller through `ctx.mobileHistoryMapper`.
 *
 */

export const MOBILE_SUBAGENT_COMPAT_METHODS = Object.freeze([
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'subagent.interrupt',
])

/**
 * Dispatch one Android subagent RPC against the official public services.
 *
 * The host adapter must inject `subagents` and `sessionController`.  It must
 * also inject `mobileHistoryMapper` (the bridge's existing
 * `mapHistoryRecords` export) so this file cannot accidentally grow a second
 * history decoder or create an import cycle.
 */
export async function dispatchSubagent(ctx, method, payload, signal, rpcId) {
  if (!MOBILE_SUBAGENT_COMPAT_METHODS.includes(method)) {
    throw new CapabilityUnavailableError(`${method} is not implemented by this bridge`)
  }
  throwIfAborted(signal)
  switch (method) {
    case 'subagent.list':
      return listSubagents(ctx, payload, signal)
    case 'subagent.history':
      return readSubagentHistory(ctx, payload, signal)
    case 'subagent.prompt':
      return promptSubagent(ctx, payload, signal, rpcId)
    case 'subagent.interrupt':
      return interruptSubagent(ctx, payload, signal)
  }
}

async function listSubagents(ctx, payload, signal) {
  expectObject(payload)
  const parentSessionId = normalizeSessionId(payload.parentSessionId, 'parentSessionId')
  const service = ctx?.subagents
  assertService(service, 'subagents', ['remoteExportList'])
  const value = unwrapControllerValue(await service.remoteExportList(parentSessionId, signal))
  if (!isPlainObject(value) || !Array.isArray(value.entries) || typeof value.parentAvailable !== 'boolean') {
    throw new SubagentMappingError('official subagent catalog is malformed')
  }
  return {
    entries: value.entries.map(validateCatalogEntry),
    parentAvailable: value.parentAvailable,
  }
}

async function readSubagentHistory(ctx, payload, signal) {
  expectObject(payload)
  const request = normalizeHistoryRequest(payload)
  const controller = ctx?.sessionController
  assertService(controller, 'sessionController', ['follow', 'page'])
  const mapper = resolveHistoryMapper(ctx)
  const address = subagentAddress(request.parentSessionId, request.childSessionId, request.mode)
  const source = await controller.follow({
    address,
    ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
  }, signal)
  const iterator = await toAsyncIterator(source)
  try {
    const first = await raceAbort(iterator.next(), signal)
    if (first?.done || !first?.value || first.value.type !== 'snapshot') {
      throw new SubagentMappingError('official subagent follow did not yield a snapshot')
    }
    const cursor = normalizeSequence(first.value.cursor, 'follow cursor', -1)
    if (!Array.isArray(first.value.records) || typeof first.value.hasMore !== 'boolean') {
      throw new SubagentMappingError('official subagent follow snapshot is malformed')
    }

    let records = first.value.records
    let hasMore = first.value.hasMore
    if (request.beforeSeq !== undefined) {
      // The page is deliberately tied to the exact same address and the
      // cursor observed by follow.  A child id must never be read as a parent
      // session or silently fall back to the local session route.
      const page = unwrapControllerValue(await controller.page({
        address,
        throughSeq: cursor,
        beforeSeq: request.beforeSeq,
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      }, signal))
      if (!isPlainObject(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        throw new SubagentMappingError('official subagent history page is malformed')
      }
      records = page.records
      hasMore = page.hasMore
    }

    const events = mapper(records, {
      throughSeq: cursor,
      ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
    })
    if (!Array.isArray(events)) throw new SubagentMappingError('subagent history mapper returned a non-array')
    const value = { events, hasMore }
    if (Object.hasOwn(first.value, 'projections') && first.value.projections !== undefined) {
      value.projections = first.value.projections
    }
    return value
  } finally {
    await closeIterator(iterator, signal)
  }
}

async function promptSubagent(ctx, payload, signal, rpcId) {
  expectObject(payload)
  const requestId = requireRpcId(rpcId)
  const request = normalizePromptRequest(payload, requestId)
  const service = ctx?.subagents
  assertService(service, 'subagents', ['prompt'])
  return unwrapControllerValue(await service.prompt(request, signal))
}

async function interruptSubagent(ctx, payload, signal) {
  expectObject(payload)
  const parentSessionId = normalizeSessionId(payload.parentSessionId, 'parentSessionId')
  const childSessionId = normalizeSessionId(payload.childSessionId, 'childSessionId')
  requireContinuableMode(payload.mode)
  const service = ctx?.subagents
  assertService(service, 'subagents', ['interruptByParent'])
  // The official primitive is synchronous and has no signal parameter.  Do
  // not turn cancellation into a different request; only avoid invoking it
  // when the caller was already cancelled.
  throwIfAborted(signal)
  const value = unwrapControllerValue(await service.interruptByParent(
    childSessionId,
    parentSessionId,
    'continuable',
  ))
  return value
}

function resolveHistoryMapper(ctx) {
  const mapper = ctx?.mobileHistoryMapper ?? ctx?.mapHistoryRecords
  if (typeof mapper !== 'function') {
    throw new CapabilityUnavailableError('subagent history mapper is unavailable')
  }
  return mapper
}

function normalizeHistoryRequest(payload) {
  return {
    parentSessionId: normalizeSessionId(payload.parentSessionId, 'parentSessionId'),
    childSessionId: normalizeSessionId(payload.childSessionId, 'childSessionId'),
    mode: requireSubagentMode(payload.mode),
    beforeSeq: optionalSequence(payload.beforeSeq, 'beforeSeq', 0),
    maxMessages: optionalPositiveInteger(payload.maxMessages, 'maxMessages'),
  }
}

function normalizePromptRequest(payload, requestId) {
  const parentSessionId = normalizeSessionId(payload.parentSessionId, 'parentSessionId')
  const childSessionId = normalizeSessionId(payload.childSessionId, 'childSessionId')
  requireContinuableMode(payload.mode)
  if (!Array.isArray(payload.content)) throw new BadRequestError('content must be an array')
  const content = payload.content.map((part, index) => {
    if (!isPlainObject(part) || typeof part.type !== 'string') {
      throw new BadRequestError(`content[${index}] is invalid`)
    }
    if (part.type === 'text') {
      return {
        type: 'text',
        text: requireString(part.text, `content[${index}].text`, { allowEmpty: true }),
      }
    }
    if (part.type === 'image') {
      const mediaType = requireString(part.mediaType, `content[${index}].mediaType`)
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        throw new BadRequestError(`content[${index}].mediaType is unsupported`)
      }
      return optionalFields({
        type: 'image',
        mediaType,
        data: requireString(part.data, `content[${index}].data`),
        name: optionalString(part.name, `content[${index}].name`),
      })
    }
    throw new BadRequestError(`content[${index}] has unsupported type`)
  })
  return {
    requestId,
    parentSessionId,
    childSessionId,
    mode: 'continuable',
    content,
    ...(payload.clientTimeZone === undefined ? {} : {
      clientTimeZone: requireString(payload.clientTimeZone, 'clientTimeZone'),
    }),
  }
}

function validateCatalogEntry(entry) {
  if (!isPlainObject(entry) || entry.kind === undefined) {
    throw new SubagentMappingError('official subagent catalog entry is malformed')
  }
  if (entry.kind === 'diagnostic') {
    if (typeof entry.id !== 'string' || !['corrupt', 'unsupported', 'unavailable'].includes(entry.reason)) {
      throw new SubagentMappingError('official subagent diagnostic entry is malformed')
    }
    return { kind: 'diagnostic', id: entry.id, reason: entry.reason }
  }
  if (entry.kind !== 'child' || typeof entry.id !== 'string'
      || !['running', 'inactive'].includes(entry.activity) || typeof entry.hasChildren !== 'boolean') {
    throw new SubagentMappingError('official subagent child entry is malformed')
  }
  if (entry.mode === 'continuable') {
    if (typeof entry.label !== 'string') throw new SubagentMappingError('official continuable child entry is malformed')
    return {
      kind: 'child', id: entry.id, activity: entry.activity, hasChildren: entry.hasChildren,
      mode: 'continuable', label: entry.label,
    }
  }
  if (entry.mode === 'one-shot') {
    return {
      kind: 'child', id: entry.id, activity: entry.activity, hasChildren: entry.hasChildren,
      mode: 'one-shot', ...(entry.label === undefined ? {} : { label: entry.label }),
    }
  }
  throw new SubagentMappingError('official subagent child mode is unsupported')
}

function subagentAddress(parentSessionId, childSessionId, mode) {
  return { kind: 'subagent', parentSessionId, childSessionId, mode }
}

function assertService(service, name, methods) {
  if (!service || methods.some(method => typeof service[method] !== 'function')) {
    throw new CapabilityUnavailableError(`${name} is unavailable`)
  }
}

function expectObject(value, name = 'payload') {
  if (!isPlainObject(value)) throw new BadRequestError(`${name} must be an object`)
  return value
}

function normalizeSessionId(value, name) {
  const id = requireString(value, name)
  if (id.startsWith('rh1.')) throw new BadRequestError(`${name} must be a local Session id`)
  return id
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
      || value.length > 64 * 1024 * 1024 || value.includes('\u0000')) {
    throw new BadRequestError(`${name} must be a bounded string`)
  }
  return value
}

function optionalString(value, name) {
  return value === undefined ? undefined : requireString(value, name)
}

function requireRpcId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\u0000')) {
    throw new BadRequestError('rpcId must be a non-empty string')
  }
  return value
}

function requireContinuableMode(value) {
  return requireSubagentMode(value, 'continuable')
}

function requireSubagentMode(value, expected) {
  if (value !== 'one-shot' && value !== 'continuable') {
    throw new BadRequestError('mode must be one-shot or continuable')
  }
  if (expected !== undefined && value !== expected) {
    throw new BadRequestError(`mode must be ${expected}`)
  }
  return value
}

function optionalSequence(value, name, min) {
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

function optionalFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
}

export class CapabilityUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CapabilityUnavailableError'
    this.code = 'gateway/capability-unavailable'
  }
}

export class SubagentMappingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SubagentMappingError'
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
