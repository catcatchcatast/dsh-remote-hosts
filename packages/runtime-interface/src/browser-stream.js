
/**
 * Versioned Session follow stream adapter owned by the runtime boundary.
 *
 * The legacy controller has only durable `assistant/chunk` events.  The current
 * Browser contract also has process-local `assistant-stream` frames.  This
 * module keeps that difference out of Host business code and deliberately
 * retains the original durable sequence on every history event.
 */

export const LEGACY_STREAM_RUNTIME_VERSION = '0.1.2-rc.1'
export const CURRENT_STREAM_RUNTIME_VERSION = '0.1.5-rc.2'

const SUPPORTED_VERSIONS = new Set([
  LEGACY_STREAM_RUNTIME_VERSION,
  CURRENT_STREAM_RUNTIME_VERSION,
])
const DEFAULT_MAX_ASSISTANT_CHUNKS = 4096
const MAX_ASSISTANT_CHUNKS = 65536

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isSafeSequence(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0)
}
function isBoundedString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\u0000')
}

export class BrowserStreamError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BrowserStreamError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function invalid(message, details) {
  throw new BrowserStreamError('runtime-interface/invalid-stream', message, details)
}

function normalizeVersion(value, fallback) {
  const version = value ?? fallback
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new BrowserStreamError('runtime-interface/unsupported-version', 'The upstream runtime version is not supported', { version })
  }
  return version
}

function followRequestOf(value) {
  if (!isRecord(value)) return undefined
  if (isRecord(value.args?.request)) return value.args.request
  if (isRecord(value.request)) return value.request
  if (own(value, 'address')) return value
  return undefined
}

/** Whether one canonical Session follow payload opts into transient Assistant frames. */
export function sessionFollowAssistantStreamRequested(value) {
  return followRequestOf(value)?.assistantStream === true
}

/**
 * Prepare a direct Session follow request for one official runtime.
 * `forceAssistantStream` is used only by the current local controller port;
 * remote Browser payloads keep their explicit opt-in so old Browser clients
 * retain the old snapshot/event contract.
 */
export function prepareSessionFollowRequest(request, runtimeVersion, { forceAssistantStream = false } = {}) {
  const version = normalizeVersion(runtimeVersion, LEGACY_STREAM_RUNTIME_VERSION)
  if (!isRecord(request)) return request
  const result = { ...request }
  if (version === LEGACY_STREAM_RUNTIME_VERSION) {
    delete result.assistantStream
  } else if (forceAssistantStream) {
    result.assistantStream = true
  }
  return result
}

/** Prepare the `{ args: { request } }` payload used by a Host carrier. */
export function prepareSessionFollowPayload(payload, runtimeVersion, options = {}) {
  const version = normalizeVersion(runtimeVersion, LEGACY_STREAM_RUNTIME_VERSION)
  if (!isRecord(payload)) return payload
  const nested = isRecord(payload.args?.request)
    ? { kind: 'args', args: payload.args, request: payload.args.request }
    : isRecord(payload.request)
      ? { kind: 'root', args: payload, request: payload.request }
      : undefined
  if (nested === undefined) return payload
  const request = prepareSessionFollowRequest(nested.request, version, options)
  if (nested.kind === 'args') return { ...payload, args: { ...nested.args, request } }
  return { ...payload, request }
}

function eventOf(frame) {
  if (isRecord(frame?.event)) return frame.event
  if (isRecord(frame) && own(frame, 'seq') && own(frame, 'data') && typeof frame.type === 'string') return frame
  return undefined
}

function assertSnapshot(frame, requireAssistantStream, maxChunks = MAX_ASSISTANT_CHUNKS) {
  if (!isRecord(frame) || frame.type !== 'snapshot') invalid('Session follow stream must begin with a snapshot')
  if (!isSafeSequence(frame.cursor, -1)) invalid('Session snapshot cursor is invalid')
  if (!Array.isArray(frame.records)) invalid('Session snapshot records must be an array')
  if (!requireAssistantStream) return
  const baseline = frame.assistantStream
  if (!isRecord(baseline)) invalid('Session snapshot omitted its assistant stream baseline')
  if (!isSafeSequence(baseline.revision)) invalid('Session assistant stream revision is invalid')
  const attempt = baseline.activeAttempt
  if (attempt === undefined) return
  if (!isRecord(attempt)
    || !isBoundedString(attempt.attemptId)
    || !isSafeSequence(attempt.startedAfterSeq, -1)
    || !isSafeSequence(attempt.turn)
    || !isSafeSequence(attempt.step)
    || !isSafeSequence(attempt.nextIndex)
    || !Array.isArray(attempt.stream)) {
    invalid('Session assistant stream baseline attempt is invalid')
  }
  if (attempt.nextIndex > maxChunks || attempt.stream.length > attempt.nextIndex) invalid('Session assistant stream baseline exceeds its bound')
}

function assertDurableSequence(event, cursor) {
  if (!isRecord(event) || typeof event.type !== 'string' || !isSafeSequence(event.seq) || !own(event, 'data')) {
    invalid('Session follow emitted an invalid durable event')
  }
  if (event.seq !== cursor + 1) {
    invalid(`Session follow durable sequence skipped ${String(cursor + 1)}`, { expectedSeq: cursor + 1, actualSeq: event.seq })
  }
}

function coordinates(event) {
  const data = event?.data
  if (!isRecord(data)) return undefined
  if (!isSafeSequence(data.turn) || !isSafeSequence(data.step)) return undefined
  return { turn: data.turn, step: data.step }
}

function legacyChunk(event) {
  if (!isRecord(event)) return undefined
  const source = event.type === 'legacy/assistant-chunk' && event.data?.legacyType === 'assistant/chunk'
    ? event.data.data
    : event.type === 'assistant/chunk'
      ? event.data
      : undefined
  if (!isRecord(source) || !isRecord(source.chunk)) return undefined
  const position = coordinates({ data: source })
  if (position === undefined || !isSafeSequence(event.seq) || !isSafeSequence(event.time)) return undefined
  return { seq: event.seq, time: event.time, ...position, chunk: source.chunk }
}

function openingAttempt(snapshot, maxChunks = DEFAULT_MAX_ASSISTANT_CHUNKS) {
  const candidates = []
  for (const record of snapshot.records) {
    const event = record?.event ?? record
    const chunk = legacyChunk(event)
    if (chunk !== undefined) {
      const previous = candidates.at(-1)
      if (previous !== undefined && (previous.turn !== chunk.turn || previous.step !== chunk.step)) candidates.length = 0
      candidates.push(chunk)
      continue
    }
    if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') candidates.length = 0
    else if (event?.type === 'turn/start' || event?.type === 'step/start') candidates.length = 0
  }
  if (candidates.length === 0) return undefined
  if (candidates.length > maxChunks) invalid('Legacy opening assistant stream exceeds its bound')
  const first = candidates[0]
  return {
    attemptId: `legacy-attempt-${first.seq}`,
    startedAfterSeq: snapshot.cursor,
    turn: first.turn,
    step: first.step,
    nextIndex: candidates.length,
    stream: candidates.map(member => ({ type: 'chunk', time: member.time, chunk: member.chunk })),
  }
}

function sameCoordinates(left, right) {
  return left !== undefined && right !== undefined && left.turn === right.turn && left.step === right.step
}

/**
 * Create one stateful encoder for a Session follow connection.
 *
 * `mapFrame` converts an official frame to canonical DTOs. `encodeFrame` is the
 * final Browser-version mapping and is intentionally supplied by index.js so
 * this low-level state machine never imports an official/private package.
 * `push` returns zero or more frames because one legacy durable chunk becomes
 * a start/chunk transient pair plus the original durable event.
 */
export function createSessionFollowStreamEncoder({
  upstreamVersion = LEGACY_STREAM_RUNTIME_VERSION,
  targetVersion = CURRENT_STREAM_RUNTIME_VERSION,
  request,
  enabled,
  mapFrame = value => value,
  encodeFrame = value => value,
  maxChunks = DEFAULT_MAX_ASSISTANT_CHUNKS,
} = {}) {
  const sourceVersion = normalizeVersion(upstreamVersion, LEGACY_STREAM_RUNTIME_VERSION)
  const browserVersion = normalizeVersion(targetVersion, CURRENT_STREAM_RUNTIME_VERSION)
  if (typeof mapFrame !== 'function' || typeof encodeFrame !== 'function') throw new TypeError('stream frame mappers must be functions')
  if (!isSafeSequence(maxChunks) || maxChunks === 0 || maxChunks > MAX_ASSISTANT_CHUNKS) throw new TypeError('maxChunks is outside the bounded range')
  const requested = enabled === undefined
    ? request === undefined || sessionFollowAssistantStreamRequested(request)
    : enabled === true
  const activeStream = requested

  let opened = false
  let closed = false
  let revision = 0
  let durableCursor = -1
  let activeAttempt

  function emit(value) {
    if (value === undefined) return []
    if (browserVersion === LEGACY_STREAM_RUNTIME_VERSION && value?.type === 'assistant-stream') return []
    if (browserVersion === LEGACY_STREAM_RUNTIME_VERSION && value?.type === 'snapshot' && own(value, 'assistantStream')) {
      const { assistantStream: _assistantStream, ...withoutAssistantStream } = value
      value = withoutAssistantStream
    }
    const mapped = encodeFrame(value)
    return mapped === undefined ? [] : [mapped]
  }

  function nextRevision() {
    revision += 1
    return revision
  }

  function abandon() {
    const attempt = activeAttempt
    if (attempt === undefined) return []
    activeAttempt = undefined
    return emit({
      type: 'assistant-stream',
      frame: {
        type: 'end',
        attemptId: attempt.attemptId,
        revision: nextRevision(),
        index: attempt.nextIndex,
        outcome: { kind: 'abandoned' },
      },
    })
  }

  function start(position) {
    const attempt = {
      attemptId: `legacy-attempt-${durableCursor + 1}`,
      startedAfterSeq: durableCursor,
      turn: position.turn,
      step: position.step,
      nextIndex: 0,
    }
    activeAttempt = attempt
    return emit({
      type: 'assistant-stream',
      frame: {
        type: 'start',
        attemptId: attempt.attemptId,
        revision: nextRevision(),
        startedAfterSeq: attempt.startedAfterSeq,
        turn: attempt.turn,
        step: attempt.step,
      },
    })
  }

  function append(position, event) {
    if (activeAttempt === undefined) return start(position)
    if (activeAttempt.nextIndex >= maxChunks) invalid('Legacy assistant stream exceeds its bound')
    const output = emit({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: activeAttempt.attemptId,
        revision: nextRevision(),
        index: activeAttempt.nextIndex,
        time: event.time,
        chunk: position.chunk,
      },
    })
    activeAttempt.nextIndex += 1
    return output
  }

  function pushLegacy(frame) {
    if (!opened) {
      // Legacy snapshots have no assistantStream field.  The adapter derives
      // only a bounded trailing attempt from durable rows and preserves the
      // real snapshot cursor as its baseline.
      assertSnapshot(frame, false, maxChunks)
      opened = true
      durableCursor = frame.cursor
      revision = 0
      const opening = openingAttempt(frame, maxChunks)
      if (opening !== undefined) {
        if (opening.nextIndex > maxChunks) invalid('Legacy opening assistant stream exceeds its bound')
        activeAttempt = opening
        return emit({ ...frame, assistantStream: { revision: 0, activeAttempt: opening } })
      }
      return emit({ ...frame, assistantStream: { revision: 0 } })
    }
    if (frame?.type === 'snapshot') invalid('Session follow emitted a second snapshot')
    if (frame?.type === 'assistant-stream') invalid('Legacy Session follow emitted assistant stream frames')
    const event = eventOf(frame)
    assertDurableSequence(event, durableCursor)
    const output = []
    const chunk = legacyChunk(event)
    if (chunk !== undefined) {
      const position = { turn: chunk.turn, step: chunk.step, chunk: chunk.chunk }
      if (activeAttempt !== undefined && !sameCoordinates(activeAttempt, position)) output.push(...abandon())
      if (activeAttempt === undefined) output.push(...start(position))
      output.push(...append(position, chunk))
      output.push(...emit(frame))
      durableCursor = event.seq
      return output
    }

    const position = coordinates(event)
    const current = activeAttempt
    const boundary = event.type === 'turn/end'
      || event.type === 'step/end'
      || (event.type === 'turn/start' && current !== undefined && position?.turn !== current.turn)
      || (event.type === 'step/start' && current !== undefined && !sameCoordinates(position, current))
    if (current !== undefined && boundary) output.push(...abandon())

    output.push(...emit(frame))
    durableCursor = event.seq
    const settlement = event.type === 'assistant/message' || event.type === 'assistant/attempt'
    if (settlement && current !== undefined && activeAttempt !== undefined) {
      const matching = sameCoordinates(position, current)
        && (event.type !== 'assistant/message' || event.surfaceOp === 'append')
      if (!matching) {
        output.push(...abandon())
      } else {
        activeAttempt = undefined
        output.push(...emit({
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: current.attemptId,
            revision: nextRevision(),
            index: current.nextIndex,
            outcome: { kind: 'committed', eventType: event.type, seq: event.seq },
          },
        }))
      }
    }
    return output
  }

  function validateCurrentAssistantFrame(frame) {
    if (!isRecord(frame) || !['start', 'chunk', 'end'].includes(frame.type)) invalid('Current assistant stream frame type is invalid')
    if (!isBoundedString(frame.attemptId) || !isSafeSequence(frame.revision, 1)) invalid('Current assistant stream frame identity is invalid')
    if (frame.revision !== revision + 1) invalid(`Session assistant stream skipped revision ${String(revision + 1)}`, { expectedRevision: revision + 1, actualRevision: frame.revision })
    if (frame.type === 'start') {
      if (!isSafeSequence(frame.startedAfterSeq, -1) || !isSafeSequence(frame.turn) || !isSafeSequence(frame.step)) invalid('Current assistant stream start frame is invalid')
      if (activeAttempt !== undefined) invalid('Current assistant stream started a mismatched attempt')
    } else if (frame.type === 'chunk') {
      if (!activeAttempt || activeAttempt.attemptId !== frame.attemptId || frame.index !== activeAttempt.nextIndex || !isSafeSequence(frame.time)) invalid('Current assistant stream chunk is out of order')
      if (activeAttempt.nextIndex >= maxChunks) invalid('Current assistant stream exceeds its bound')
    } else {
      if (!activeAttempt || activeAttempt.attemptId !== frame.attemptId || frame.index !== activeAttempt.nextIndex) invalid('Current assistant stream end is out of order')
      if (!isRecord(frame.outcome) || !['committed', 'abandoned'].includes(frame.outcome.kind)) invalid('Current assistant stream outcome is invalid')
      if (frame.outcome.kind === 'committed'
        && (!['assistant/message', 'assistant/attempt'].includes(frame.outcome.eventType) || !isSafeSequence(frame.outcome.seq))) invalid('Current assistant stream committed outcome is invalid')
    }
  }

  function pushCurrent(frame) {
    if (!opened) {
      assertSnapshot(frame, true, maxChunks)
      opened = true
      durableCursor = frame.cursor
      revision = frame.assistantStream.revision
      const opening = frame.assistantStream.activeAttempt
      activeAttempt = opening === undefined ? undefined : {
        attemptId: opening.attemptId,
        startedAfterSeq: opening.startedAfterSeq,
        turn: opening.turn,
        step: opening.step,
        nextIndex: opening.nextIndex,
        pending: new Map(),
      }
      return emit(frame)
    }
    if (frame?.type === 'snapshot') invalid('Session follow emitted a second snapshot')
    if (frame?.type === 'assistant-stream') {
      const assistant = frame.frame
      validateCurrentAssistantFrame(assistant)
      revision = assistant.revision
      if (assistant.type === 'start') {
        activeAttempt = {
          attemptId: assistant.attemptId,
          startedAfterSeq: assistant.startedAfterSeq,
          turn: assistant.turn,
          step: assistant.step,
          nextIndex: 0,
          pending: new Map(),
        }
      } else if (assistant.type === 'chunk') {
        activeAttempt.nextIndex += 1
      } else {
        if (assistant.outcome.kind === 'committed') {
          const settlement = activeAttempt.pending.get(assistant.outcome.seq)
          if (settlement === undefined || settlement.type !== assistant.outcome.eventType) invalid('Current assistant stream committed outcome has no matching durable settlement')
          activeAttempt.pending.delete(assistant.outcome.seq)
        } else if (activeAttempt.pending.size > 0) {
          invalid('Current assistant stream abandoned an attempt with a pending durable settlement')
        }
        activeAttempt = undefined
      }
      return emit(frame)
    }
    const event = eventOf(frame)
    assertDurableSequence(event, durableCursor)
    durableCursor = event.seq
    if (activeAttempt !== undefined && (event.type === 'assistant/message' || event.type === 'assistant/attempt')) {
      const position = coordinates(event)
      const matching = event.seq > activeAttempt.startedAfterSeq
        && sameCoordinates(position, activeAttempt)
        && (event.type !== 'assistant/message' || event.surfaceOp === 'append')
      if (matching) activeAttempt.pending.set(event.seq, event)
    }
    return emit(frame)
  }

  function push(frame) {
    if (closed) throw new BrowserStreamError('runtime-interface/stream-closed', 'Session follow stream encoder is closed')
    const canonical = mapFrame(frame)
    if (!activeStream) return emit(canonical)
    return sourceVersion === LEGACY_STREAM_RUNTIME_VERSION
      ? pushLegacy(canonical)
      : pushCurrent(canonical)
  }

  function close() {
    if (closed) return
    closed = true
    activeAttempt = undefined
  }

  return Object.freeze({ push, close, release: close })
}

/** Generic name used by the Browser Host Hub; it is still Session-follow only. */
export const createBrowserStreamEncoder = createSessionFollowStreamEncoder
