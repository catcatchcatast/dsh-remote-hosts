
/**
 * Stable history-import port for both official persistence contracts.
 *
 * The legacy service addressed logs by id (`inspect`/`append`).  The current
 * service addresses a log through a short-lived `SessionHandle`.  This module
 * owns that difference so import code only sees ids, detached allowlisted
 * metadata/event snapshots, and completed writes.  No official header object
 * or handle crosses the port boundary.
 */

export const SESSION_PERSISTENCE_READ_CHUNK = 256
const CURRENT_SESSION_FORMAT_VERSION = 3
const CURRENT_HEADER_FIELDS = Object.freeze([
  'createdAt',
  'cwd',
  'parentSession',
  'isSeeded',
  'origin',
  'delegationDepth',
  'agentPreset',
])
const DETACHED_METADATA_FIELDS = Object.freeze([
  'version',
  'id',
  'createdAt',
  'cwd',
  'parentSession',
  'isSeeded',
  'origin',
  'delegationDepth',
  'agentPreset',
  'sourceId',
  'provider',
  'model',
  'title',
])

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function makeError(ErrorType, code, message, details) {
  const error = ErrorType instanceof Function
    ? (ErrorType === Error ? new Error(message) : new ErrorType(code, message, details))
    : new Error(message)
  if (error.code === undefined) error.code = code
  if (details !== undefined && error.details === undefined) error.details = details
  return error
}

function requireId(value, ErrorType) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\u0000')) {
    throw makeError(ErrorType, 'runtime-interface/invalid-identity', 'session id must be a bounded non-empty string')
  }
  return value
}

function requireEvents(value, ErrorType) {
  if (!Array.isArray(value)) throw makeError(ErrorType, 'runtime-interface/invalid-events', 'session events must be an array')
  return value
}

function notFound(error) {
  return error?.code === 'ENOENT'
    || error?.code === 'SESSION_NOT_FOUND'
    || error?.code === 'session/not-found'
    || /not found|does not exist|no such session/i.test(String(error?.message ?? error))
}

function normalizeLegacySourcePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\u0000') ? value : null
}

function isImportMarker(event) {
  return isRecord(event) && event.type === 'session/imported' && isRecord(event.data)
}

function importMarkerPath(event) {
  if (!isImportMarker(event)) return null
  return normalizeLegacySourcePath(event.data.sourcePath)
}

function normalizeMetadata({ exists, readable, eventCount, legacySourcePath }) {
  return Object.freeze({
    exists: exists === true,
    readable: readable === true,
    eventCount: Number.isSafeInteger(eventCount) && eventCount >= 0 ? eventCount : null,
    legacySourcePath: normalizeLegacySourcePath(legacySourcePath),
  })
}

function serviceHasCurrentContract(service) {
  return typeof service?.open === 'function' && typeof service?.stat === 'function'
}

function serviceHasLegacyContract(service) {
  return typeof service?.inspect === 'function' || typeof service?.load === 'function'
}

// dsh-chat-import 0.11 emits its historical converter metadata (format v0 and
// source-only fields such as sourceId).  The current public persistence writer
// accepts the current Session header only.  Keep this translation here so a
// compatibility package never has to parse or know the installed format.
function currentHeader(meta) {
  const header = {
    version: CURRENT_SESSION_FORMAT_VERSION,
    id: meta.id,
  }
  for (const field of CURRENT_HEADER_FIELDS) {
    if (meta[field] !== undefined) header[field] = meta[field]
  }
  if (header.isSeeded === undefined) header.isSeeded = false
  return header
}

// The old import converter emits complete assistant messages without the
// current settlement stream field.  An empty stream is lossless for such a
// message: the converter deliberately discarded source chunks before this
// boundary.  Preserve a supplied stream verbatim so current callers retain
// any already-materialized assistant presentation data.
function currentEvents(events) {
  return events.map(event => {
    if (!isRecord(event) || event.type !== 'assistant/message' || !isRecord(event.data) || event.data.stream !== undefined) return event
    return { ...event, data: { ...event.data, stream: [] } }
  })
}

function detachedValue(value) {
  try {
    return structuredClone(value)
  } catch (error) {
    throw makeError(Error, 'runtime-interface/non-serializable', 'session persistence value is not losslessly serializable', { cause: error })
  }
}

// Read consumers (export, verify, sync, and diagnostics) receive a copied,
// allowlisted metadata snapshot.  The provider's header object never escapes
// the runtime-interface boundary.
function detachedMetadata(value) {
  const source = isRecord(value?.header)
    ? value.header
    : isRecord(value?.meta)
      ? value.meta
      : value
  if (!isRecord(source)) throw new Error('session persistence metadata is invalid')
  const metadata = {}
  for (const field of DETACHED_METADATA_FIELDS) {
    if (source[field] !== undefined) metadata[field] = detachedValue(source[field])
  }
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) throw new Error('session persistence metadata has no id')
  return Object.freeze(metadata)
}

function detachedEvents(value) {
  if (!Array.isArray(value)) throw new Error('session persistence events are invalid')
  return Object.freeze(value.map(event => detachedValue(event)))
}

function capabilityError(ErrorType, method) {
  return makeError(ErrorType, 'runtime-interface/capability-unavailable', `session persistence ${method} is unavailable on the official runtime`, { method })
}

function knownCreateFailure(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? error)
  return /already.?exists|duplicate/i.test(code) || /already exists|duplicate/i.test(message)
    || error instanceof TypeError
    || /format|invalid metadata|unsupported session/i.test(`${code} ${message}`)
}

function unknownWriteError(ErrorType, id, error) {
  const detail = { sessionId: id, outcome: 'unknown' }
  const wrapped = makeError(ErrorType, 'runtime-interface/write-outcome-unknown', `session ${id} write outcome is unknown`, detail)
  if (error !== undefined) wrapped.cause = error
  return wrapped
}

/**
 * Adapt old and current official persistence services to a narrow import port.
 * The returned object is safe to hand to compatibility packages.
 */
export function createSessionPersistencePort({ service, ErrorType = Error, readChunkSize = SESSION_PERSISTENCE_READ_CHUNK } = {}) {
  if (!Number.isSafeInteger(readChunkSize) || readChunkSize < 1 || readChunkSize > 4096) throw new TypeError('readChunkSize must be a bounded positive integer')

  const queues = new Map()
  const uncertain = new Set()

  const enqueueWrite = (id, operation) => {
    requireId(id, ErrorType)
    if (uncertain.has(id)) return Promise.reject(unknownWriteError(ErrorType, id))
    const previous = queues.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      if (uncertain.has(id)) throw unknownWriteError(ErrorType, id)
      try {
        return await operation()
      } catch (error) {
        if (error?.code === 'runtime-interface/write-outcome-unknown') uncertain.add(id)
        throw error
      }
    })
    const tracked = result.catch(() => {}).finally(() => {
      if (queues.get(id) === tracked) queues.delete(id)
    })
    queues.set(id, tracked)
    return result
  }

  const listIds = async () => {
    if (!service || typeof service.list !== 'function') throw capabilityError(ErrorType, 'list')
    let listed
    try {
      listed = await service.list()
    } catch (error) {
      throw error
    }
    if (!Array.isArray(listed)) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence list returned an invalid value')
    const ids = []
    const seen = new Set()
    for (const item of listed) {
      // Old list() returns headers; current list() returns snapshots whose id
      // lives on the detached header.  Neither object is returned to callers.
      const id = item?.header?.id ?? item?.id
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return Object.freeze(ids)
  }

  const list = async () => {
    if (!service || typeof service.list !== 'function') throw capabilityError(ErrorType, 'list')
    const listed = await service.list()
    if (!Array.isArray(listed)) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence list returned an invalid value')
    const headers = []
    const seen = new Set()
    for (const item of listed) {
      try {
        const header = detachedMetadata(item)
        if (seen.has(header.id)) continue
        seen.add(header.id)
        headers.push(header)
      } catch {
        // `listIds` follows the official list's tolerant discovery behavior;
        // malformed entries must not become business-visible metadata.
      }
    }
    return Object.freeze(headers)
  }

  const inspectLegacy = async id => {
    const inspect = service.inspect ?? service.load
    if (typeof inspect !== 'function') throw capabilityError(ErrorType, 'inspect')
    try {
      const result = await inspect.call(service, id)
      const events = result?.events
      if (!Array.isArray(events)) return normalizeMetadata({ exists: true, readable: false })
      const firstMarker = events.find(isImportMarker)
      return normalizeMetadata({
        exists: true,
        readable: true,
        eventCount: events.length,
        legacySourcePath: importMarkerPath(firstMarker),
      })
    } catch (error) {
      if (notFound(error)) return normalizeMetadata({ exists: false, readable: false })
      return normalizeMetadata({ exists: true, readable: false })
    }
  }

  const inspectCurrent = async id => {
    if (typeof service.stat !== 'function') throw capabilityError(ErrorType, 'stat')
    let snapshot
    try {
      snapshot = await service.stat(id)
    } catch (error) {
      if (notFound(error)) return normalizeMetadata({ exists: false, readable: false })
      return normalizeMetadata({ exists: true, readable: false })
    }
    if (snapshot === undefined || snapshot === null) return normalizeMetadata({ exists: false, readable: false })
    if (typeof service.open !== 'function') return normalizeMetadata({ exists: true, readable: false })

    let handle
    let result
    let failure
    try {
      handle = await service.open(id, 'read')
      if (!handle || typeof handle.read !== 'function') throw makeError(ErrorType, 'runtime-interface/invalid-handle', 'session persistence read handle is invalid')
      let offset = 0
      let eventCount = 0
      let firstPath = null
      let markerSeen = false
      while (true) {
        const chunk = await handle.read(offset, readChunkSize)
        const events = chunk?.events
        if (!Array.isArray(events)) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence read returned an invalid value')
        if (events.length === 0) break
        if (!markerSeen) {
          for (const event of events) {
            if (isImportMarker(event)) {
              markerSeen = true
              firstPath = importMarkerPath(event)
              break
            }
          }
        }
        eventCount += events.length
        if (!Number.isSafeInteger(eventCount)) throw makeError(ErrorType, 'runtime-interface/history-too-large', 'session persistence event count exceeds safe integer range')
        offset += events.length
        if (events.length > readChunkSize) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence read exceeded the bounded chunk size')
      }
      result = normalizeMetadata({ exists: true, readable: true, eventCount, legacySourcePath: firstPath })
    } catch (error) {
      failure = error
    } finally {
      try {
        await handle?.close?.()
      } catch (error) {
        if (failure === undefined) failure = error
      }
    }
    if (failure !== undefined) {
      if (notFound(failure)) return normalizeMetadata({ exists: false, readable: false })
      return normalizeMetadata({ exists: true, readable: false })
    }
    return result
  }

  const inspect = async id => {
    requireId(id, ErrorType)
    if (serviceHasCurrentContract(service)) return inspectCurrent(id)
    if (serviceHasLegacyContract(service)) return inspectLegacy(id)
    throw capabilityError(ErrorType, 'inspect')
  }

  const readFrom = async (id, fromSeq = 0) => {
    id = requireId(id, ErrorType)
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw makeError(ErrorType, 'runtime-interface/invalid-offset', 'session persistence read offset must be a non-negative safe integer')
    if (serviceHasCurrentContract(service)) {
      let handle
      let failure
      try {
        handle = await service.open(id, 'read')
        if (!handle || typeof handle.read !== 'function') throw makeError(ErrorType, 'runtime-interface/invalid-handle', 'session persistence read handle is invalid')
        const meta = detachedMetadata(handle.header)
        const events = []
        let offset = fromSeq
        while (true) {
          const chunk = await handle.read(offset, readChunkSize)
          if (!isRecord(chunk) || !Array.isArray(chunk.events)) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence read returned an invalid value')
          if (chunk.events.length === 0) break
          if (chunk.events.length > readChunkSize) throw makeError(ErrorType, 'runtime-interface/invalid-result', 'session persistence read exceeded the bounded chunk size')
          events.push(...chunk.events.map(event => detachedValue(event)))
          if (!Number.isSafeInteger(offset + chunk.events.length)) throw makeError(ErrorType, 'runtime-interface/history-too-large', 'session persistence event offset exceeds safe integer range')
          offset += chunk.events.length
        }
        const result = {
          meta,
          events: Object.freeze(events),
          ...(Number.isSafeInteger(handle.inheritedEventCount) && handle.inheritedEventCount >= 0
            ? { inheritedEventCount: handle.inheritedEventCount }
            : {}),
        }
        return Object.freeze(result)
      } catch (error) {
        failure = error
      } finally {
        try {
          await handle?.close?.()
        } catch (error) {
          if (failure === undefined) failure = error
        }
      }
      throw failure
    }
    if (!service || typeof service.readFrom !== 'function') {
      const inspect = service?.inspect ?? service?.load
      if (typeof inspect !== 'function') throw capabilityError(ErrorType, 'readFrom')
      const result = await inspect.call(service, id)
      const events = Array.isArray(result?.events) ? result.events.slice(fromSeq) : []
      return Object.freeze({
        meta: detachedMetadata(result?.meta ?? result?.header ?? { id }),
        events: detachedEvents(events),
        ...(Number.isSafeInteger(result?.inheritedEventCount) && result.inheritedEventCount >= 0
          ? { inheritedEventCount: result.inheritedEventCount }
          : {}),
      })
    }
    const result = await service.readFrom(id, fromSeq)
    return Object.freeze({
      meta: detachedMetadata(result?.meta ?? result?.header ?? { id }),
      events: detachedEvents(result?.events ?? []),
      ...(Number.isSafeInteger(result?.inheritedEventCount) && result.inheritedEventCount >= 0
        ? { inheritedEventCount: result.inheritedEventCount }
        : {}),
    })
  }

  const withCurrentWriteHandle = (id, openHandle, events, { create = false } = {}) => enqueueWrite(id, async () => {
    let handle
    let failure
    try {
      handle = await openHandle()
    } catch (error) {
      // Opening is a known admission failure (duplicate/not-found/ownership)
      // and must remain distinguishable from a write whose result is unknown.
      if (!create || knownCreateFailure(error)) throw error
      throw unknownWriteError(ErrorType, id, error)
    }
    try {
      if (!handle || typeof handle.append !== 'function') throw makeError(ErrorType, 'runtime-interface/invalid-handle', 'session persistence write handle is invalid')
      if (events.length > 0) await handle.append(events)
      if (typeof handle.flush !== 'function') throw makeError(ErrorType, 'runtime-interface/invalid-handle', 'session persistence write handle has no flush method')
      await handle.flush()
    } catch (error) {
      failure = unknownWriteError(ErrorType, id, error)
    } finally {
      try {
        await handle?.close?.()
      } catch (error) {
        if (failure === undefined) failure = unknownWriteError(ErrorType, id, error)
      }
    }
    if (failure !== undefined) throw failure
  })

  const create = async (meta, events = []) => {
    if (!isRecord(meta) || typeof meta.id !== 'string') throw makeError(ErrorType, 'runtime-interface/invalid-request', 'session metadata with id is required')
    const id = requireId(meta.id, ErrorType)
    const batch = requireEvents(events, ErrorType)
    if (serviceHasCurrentContract(service)) {
      return withCurrentWriteHandle(id, () => service.create(currentHeader(meta)), currentEvents(batch), { create: true })
    }
    if (!service || typeof service.create !== 'function' || typeof service.append !== 'function') throw capabilityError(ErrorType, 'create')
    return enqueueWrite(id, async () => {
      try {
        await service.create(meta)
      } catch (error) {
        if (knownCreateFailure(error)) throw error
        throw unknownWriteError(ErrorType, id, error)
      }
      try {
        if (batch.length > 0) await service.append(id, batch)
      } catch (error) {
        throw unknownWriteError(ErrorType, id, error)
      }
    })
  }

  const append = async (id, events = []) => {
    id = requireId(id, ErrorType)
    const batch = requireEvents(events, ErrorType)
    if (serviceHasCurrentContract(service)) return withCurrentWriteHandle(id, () => service.open(id, 'write'), currentEvents(batch))
    if (!service || typeof service.append !== 'function') throw capabilityError(ErrorType, 'append')
    return enqueueWrite(id, async () => {
      try {
        if (batch.length > 0) await service.append(id, batch)
      } catch (error) {
        throw unknownWriteError(ErrorType, id, error)
      }
    })
  }

  return Object.freeze({ listIds, list, inspect, readFrom, create, append })
}
