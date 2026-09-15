
const DEFAULT_MAX_BYTES_PER_SESSION = 1024 * 1024
const DEFAULT_MAX_ACTIVE_ATTEMPTS = 64
const MAX_STRING_LENGTH = 4096
const BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result'])

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MobileAssistantStreamError('invalid-input', `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new MobileAssistantStreamError('invalid-input', `${label} must be a plain object`)
  return value
}

function boundedString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_LENGTH || value.includes('\u0000')) throw new MobileAssistantStreamError('invalid-input', `${label} must be a bounded non-empty string`)
  return value
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) throw new MobileAssistantStreamError('invalid-input', `${label} must be a safe integer no smaller than ${minimum}`)
  return value
}

function nonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) throw new MobileAssistantStreamError('invalid-input', `${label} must be a finite non-negative number`)
  return value
}

function snapshotJson(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new MobileAssistantStreamError('invalid-input', `${label} must contain finite JSON numbers`)
    return value
  }
  if (typeof value !== 'object') throw new MobileAssistantStreamError('invalid-input', `${label} must be JSON-serializable`)
  if (seen.has(value)) throw new MobileAssistantStreamError('invalid-input', `${label} must not be cyclic`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw new MobileAssistantStreamError('invalid-input', `${label} must contain plain JSON values`)
  seen.add(value)
  let result
  if (Array.isArray(value)) result = value.map((item, index) => snapshotJson(item, `${label}[${index}]`, seen))
  else {
    result = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'agent' || key === 'ctx' || key === 'rawFrame' || key === 'rawBaseline') throw new MobileAssistantStreamError('invalid-input', `${label} contains a private runtime object`)
      Object.defineProperty(result, key, { enumerable: true, value: snapshotJson(item, `${label}.${key}`, seen), writable: true, configurable: true })
    }
  }
  seen.delete(value)
  return result
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

function error(code, message, details = {}) {
  return new MobileAssistantStreamError(code, message, details)
}

function sanitizeFailure(value) {
  const input = record(value, 'finish.reason.failure')
  const result = { message: boundedString(input.message, 'finish.reason.failure.message'), code: boundedString(input.code, 'finish.reason.failure.code') }
  for (const key of ['status', 'providerRetryAfterMs']) if (input[key] !== undefined) result[key] = nonNegativeNumber(input[key], `finish.reason.failure.${key}`)
  if (input.requestId !== undefined) result.requestId = boundedString(input.requestId, 'finish.reason.failure.requestId')
  return result
}

function sanitizeReason(value) {
  const input = record(value, 'finish.reason')
  const kind = boundedString(input.kind, 'finish.reason.kind')
  if (!['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(kind)) throw error('invalid-input', 'finish.reason.kind is unsupported')
  const result = { kind }
  if (kind === 'aborted' || kind === 'error') result.failure = sanitizeFailure(input.failure)
  return result
}

function sanitizeBlock(value) {
  const input = record(value, 'block-end.block')
  const type = boundedString(input.type, 'block-end.block.type')
  if (!BLOCK_TYPES.has(type)) throw error('invalid-input', 'block-end.block.type is unsupported')
  if (type === 'tool-call') {
    return { type, id: boundedString(input.id, 'block-end.block.id'), name: boundedString(input.name, 'block-end.block.name') }
  }
  if (type === 'tool-result') return { type, toolCallId: boundedString(input.toolCallId, 'block-end.block.toolCallId') }
  if (type === 'text' || type === 'reasoning') return { type, text: typeof input.text === 'string' ? input.text : (() => { throw error('invalid-input', `block-end.block.${type}.text must be a string`) })() }
  if (type === 'image' || type === 'file') return { type, attachment: snapshotJson(input.attachment, `block-end.block.${type}.attachment`) }
  throw error('invalid-input', 'block-end.block.type is unsupported')
}

function sanitizeUsage(value) {
  const input = record(value, 'usage.usage')
  const result = { inputTokens: nonNegativeNumber(input.inputTokens, 'usage.inputTokens'), outputTokens: nonNegativeNumber(input.outputTokens, 'usage.outputTokens') }
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (input[key] !== undefined) result[key] = nonNegativeNumber(input[key], `usage.${key}`)
  return result
}

function sanitizeChunk(value) {
  const input = record(value, 'frame.chunk')
  const type = boundedString(input.type, 'frame.chunk.type')
  switch (type) {
    case 'text-delta':
    case 'reasoning-delta':
      return { type, index: integer(input.index, `${type}.index`), text: typeof input.text === 'string' ? input.text : (() => { throw error('invalid-input', `${type}.text must be a string`) })() }
    case 'tool-call-delta': {
      const result = { type, index: integer(input.index, `${type}.index`), id: boundedString(input.id, `${type}.id`) }
      if (input.name !== undefined) result.name = boundedString(input.name, `${type}.name`)
      if (typeof input.argumentsDelta !== 'string') throw error('invalid-input', `${type}.argumentsDelta must be a string`)
      result.argumentsDelta = ''
      return result
    }
    case 'block-start':
      if (!BLOCK_TYPES.has(input.blockType)) throw error('invalid-input', `${type}.blockType is unsupported`)
      return { type, index: integer(input.index, `${type}.index`), blockType: input.blockType }
    case 'block-end':
      return { type, index: integer(input.index, `${type}.index`), block: sanitizeBlock(input.block) }
    case 'usage':
      return { type, usage: sanitizeUsage(input.usage) }
    case 'finish': {
      const result = { type, reason: sanitizeReason(input.reason) }
      // replayState is adapter-private and must never cross this boundary.
      return result
    }
    default:
      throw error('invalid-input', `unsupported assistant stream chunk type: ${type}`)
  }
}

function sanitizeRawFrame(value) {
  const input = record(value, 'rawFrame')
  const type = boundedString(input.type, 'frame.type')
  const attemptId = boundedString(input.attemptId, 'frame.attemptId')
  const revision = integer(input.revision, 'frame.revision')
  if (type === 'start') return { type, attemptId, revision, turn: integer(input.turn, 'frame.turn'), step: integer(input.step, 'frame.step') }
  if (type === 'chunk') return { type, attemptId, revision, index: integer(input.index, 'frame.index'), time: integer(input.time, 'frame.time'), chunk: sanitizeChunk(input.chunk) }
  if (type === 'end') {
    const outcome = record(input.outcome, 'frame.outcome')
    const kind = boundedString(outcome.kind, 'frame.outcome.kind')
    if (kind === 'abandoned') return { type, attemptId, revision, index: integer(input.index, 'frame.index'), outcome: { kind } }
    if (kind !== 'committed') throw error('invalid-input', 'frame.outcome.kind is unsupported')
    const eventType = boundedString(outcome.eventType, 'frame.outcome.eventType')
    if (eventType !== 'assistant/message' && eventType !== 'assistant/attempt') throw error('invalid-input', 'frame.outcome.eventType is unsupported')
    return { type, attemptId, revision, index: integer(input.index, 'frame.index'), outcome: { kind, eventType, seq: integer(outcome.seq, 'frame.outcome.seq') } }
  }
  throw error('invalid-input', `unsupported assistant stream frame type: ${type}`)
}

function sanitizeCompactRecord(value, index) {
  const input = record(value, `baseline.activeAttempt.stream[${index}]`)
  const type = boundedString(input.type, `baseline.activeAttempt.stream[${index}].type`)
  if (type === 'chunk') return { type, time: integer(input.time, 'baseline chunk.time'), chunk: sanitizeChunk(input.chunk) }
  if (type === 'text-chunks' || type === 'reasoning-chunks') {
    const texts = Array.isArray(input.texts) && input.texts.length > 0 ? input.texts.map((item, i) => typeof item === 'string' ? item : (() => { throw error('invalid-input', `baseline ${type}.texts[${i}] must be a string`) })()) : (() => { throw error('invalid-input', `baseline ${type}.texts must be non-empty`) })()
    const dt = Array.isArray(input.dt) ? input.dt.map((item, i) => integer(item, `baseline ${type}.dt[${i}]`)) : (() => { throw error('invalid-input', `baseline ${type}.dt must be an array`) })()
    if (dt.length !== texts.length - 1) throw error('invalid-input', `baseline ${type}.dt length must match texts`)
    return { type, time0: integer(input.time0, `baseline ${type}.time0`), index: integer(input.index, `baseline ${type}.index`), dt, texts }
  }
  if (type === 'tool-call-chunks') {
    const args = Array.isArray(input.args) && input.args.length > 0 ? input.args.map((item, i) => typeof item === 'string' ? item : (() => { throw error('invalid-input', `baseline tool-call-chunks.args[${i}] must be a string`) })()) : (() => { throw error('invalid-input', 'baseline tool-call-chunks.args must be non-empty') })()
    const dt = Array.isArray(input.dt) ? input.dt.map((item, i) => integer(item, `baseline tool-call-chunks.dt[${i}]`)) : (() => { throw error('invalid-input', 'baseline tool-call-chunks.dt must be an array') })()
    if (dt.length !== args.length - 1) throw error('invalid-input', 'baseline tool-call-chunks.dt length must match args')
    const result = { type, time0: integer(input.time0, 'baseline tool-call-chunks.time0'), index: integer(input.index, 'baseline tool-call-chunks.index'), dt, id: boundedString(input.id, 'baseline tool-call-chunks.id'), args: args.map(() => '') }
    if (input.name !== undefined) result.name = boundedString(input.name, 'baseline tool-call-chunks.name')
    return result
  }
  throw error('invalid-input', `unsupported baseline stream record type: ${type}`)
}

function sanitizeBaseline(value) {
  const input = record(value, 'rawBaseline')
  const revision = integer(input.revision, 'baseline.revision')
  if (input.activeAttempt === undefined) return { revision }
  const attempt = record(input.activeAttempt, 'baseline.activeAttempt')
  const result = {
    attemptId: boundedString(attempt.attemptId, 'baseline.activeAttempt.attemptId'),
    startedAfterSeq: integer(attempt.startedAfterSeq, 'baseline.activeAttempt.startedAfterSeq', -1),
    turn: integer(attempt.turn, 'baseline.activeAttempt.turn'),
    step: integer(attempt.step, 'baseline.activeAttempt.step'),
    nextIndex: integer(attempt.nextIndex, 'baseline.activeAttempt.nextIndex'),
    stream: Array.isArray(attempt.stream) ? attempt.stream.map(sanitizeCompactRecord) : (() => { throw error('invalid-input', 'baseline.activeAttempt.stream must be an array') })(),
  }
  if (result.stream.length > result.nextIndex || expandCompactStream(result.stream).length !== result.nextIndex) throw error('invalid-input', 'baseline.activeAttempt.stream does not match nextIndex')
  return { revision, activeAttempt: result }
}

export function sanitizeMobileAssistantStreamFrame(value) {
  return freeze(sanitizeRawFrame(value))
}

export function sanitizeMobileAssistantStreamBaseline(value) {
  return freeze(sanitizeBaseline(value))
}

function expandCompactStream(records) {
  const chunks = []
  for (const record of records) {
    if (record.type === 'chunk') {
      chunks.push({ time: record.time, chunk: record.chunk })
      continue
    }
    let time = record.time0
    const values = record.type === 'tool-call-chunks' ? record.args : record.texts
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) {
        const nextTime = time + record.dt[index - 1]
        if (!Number.isSafeInteger(nextTime)) throw error('invalid-input', 'baseline stream timestamp overflow')
        time = nextTime
      }
      const chunk = record.type === 'tool-call-chunks'
        ? { type: 'tool-call-delta', index: record.index, id: record.id, ...(record.name === undefined ? {} : { name: record.name }), argumentsDelta: '' }
        : { type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text: values[index] }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

function publicChunks(chunks) {
  return chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk }))
}

function timedChunkBytes(timed) {
  return Buffer.byteLength(JSON.stringify(timed), 'utf8') + 1
}

function fixedAttemptBytes(attempt) {
  return Buffer.byteLength(JSON.stringify({ attemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq, turn: attempt.turn, step: attempt.step, nextIndex: 0, stream: [] }), 'utf8')
}

function measuredAttemptBytes(attempt) {
  return fixedAttemptBytes(attempt) + attempt.chunks.reduce((total, timed) => total + timedChunkBytes(timed), 0)
}

function publicAttempt(attempt) {
  if (attempt === undefined) return undefined
  return {
    attemptId: attempt.attemptId,
    startedAfterSeq: attempt.startedAfterSeq,
    turn: attempt.turn,
    step: attempt.step,
    nextIndex: attempt.nextIndex,
    stream: publicChunks(attempt.chunks),
  }
}

function stateBaseline(state) {
  const output = { revision: state.publicRevision }
  if (state.active !== undefined) output.activeAttempt = publicAttempt(state.active)
  return output
}

export class MobileAssistantStreamError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MobileAssistantStreamError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
  get baselineRequired() { return this.details.baselineRequired === true }
}

export class MobileAssistantStream {
  #sessions = new Map()
  #activeAttempts = 0
  #maxBytesPerSession
  #maxActiveAttempts

  constructor({ maxBytesPerSession = DEFAULT_MAX_BYTES_PER_SESSION, maxActiveAttempts = DEFAULT_MAX_ACTIVE_ATTEMPTS } = {}) {
    this.#maxBytesPerSession = integer(maxBytesPerSession, 'maxBytesPerSession', 1)
    this.#maxActiveAttempts = integer(maxActiveAttempts, 'maxActiveAttempts', 1)
  }

  #state(sessionId) {
    let state = this.#sessions.get(sessionId)
    if (state === undefined) {
      state = { offset: 0, lastRawRevision: 0, publicRevision: 0, active: undefined, retired: new Set(), counters: { starts: 0, ends: 0 } }
      this.#sessions.set(sessionId, state)
    }
    return state
  }

  #fail(code, message, details = {}) {
    throw error(code, message, { baselineRequired: true, ...details })
  }

  #checkSize(attempt, bytes) {
    if (bytes > this.#maxBytesPerSession) this.#fail('reconnect-baseline-required', 'assistant stream cache exceeds the per-session limit', { bytes, limit: this.#maxBytesPerSession })
    attempt.bytes = bytes
  }

  #retire(state, attemptId) {
    state.retired.add(attemptId)
    while (state.retired.size > DEFAULT_MAX_ACTIVE_ATTEMPTS) state.retired.delete(state.retired.values().next().value)
  }

  ingest(sessionId, rawFrame, durableCursor) {
    boundedString(sessionId, 'sessionId')
    integer(durableCursor, 'durableCursor', -1)
    const frame = sanitizeRawFrame(rawFrame)
    const state = this.#state(sessionId)
    const active = state.active
    if (frame.type !== 'start' && active !== undefined && frame.attemptId !== active.attemptId) return undefined
    const restarting = frame.type === 'start' && frame.revision === 1 && state.lastRawRevision > 0
    if (restarting && (active?.attemptId === frame.attemptId || state.retired.has(frame.attemptId))) return undefined
    if (frame.revision <= state.lastRawRevision && !restarting) return undefined
    const nextOffset = restarting ? state.publicRevision : state.offset
    const expectedRawRevision = restarting ? 1 : state.lastRawRevision + 1
    if (frame.revision !== expectedRawRevision) this.#fail('revision-gap', 'assistant stream revision is not contiguous', { expected: expectedRawRevision, received: frame.revision })
    const publicRevision = nextOffset + frame.revision
    if (!Number.isSafeInteger(publicRevision)) this.#fail('invalid-input', 'assistant stream revision mapping overflow')
    if (frame.type === 'start') {
      if (state.active === undefined && this.#activeAttempts >= this.#maxActiveAttempts) this.#fail('active-attempt-limit', 'active assistant stream attempt limit reached')
      const next = { attemptId: frame.attemptId, startedAfterSeq: durableCursor, turn: frame.turn, step: frame.step, nextIndex: 0, chunks: [], bytes: 0 }
      this.#checkSize(next, fixedAttemptBytes(next))
      if (state.active !== undefined) this.#retire(state, state.active.attemptId)
      state.offset = nextOffset
      state.active = next
      if (state.active !== undefined && active === undefined) this.#activeAttempts += 1
      state.counters.starts += 1
    } else if (state.active === undefined || state.active.attemptId !== frame.attemptId) {
      return undefined
    } else if (frame.type === 'chunk') {
      if (frame.index !== state.active.nextIndex) this.#fail('index-gap', 'assistant stream chunk index is not contiguous', { expected: state.active.nextIndex, received: frame.index })
      const next = { time: frame.time, chunk: frame.chunk }
      const nextBytes = state.active.bytes + timedChunkBytes(next)
      this.#checkSize(state.active, nextBytes)
      state.active.chunks.push(next)
      state.active.nextIndex += 1
    } else if (frame.type === 'end') {
      if (frame.index !== state.active.nextIndex) this.#fail('index-gap', 'assistant stream end index does not match the next chunk index', { expected: state.active.nextIndex, received: frame.index })
      this.#retire(state, state.active.attemptId)
      state.active = undefined
      this.#activeAttempts -= 1
      state.counters.ends += 1
    }
    state.lastRawRevision = frame.revision
    state.publicRevision = publicRevision
    const output = frame.type === 'start'
      ? { type: 'start', attemptId: frame.attemptId, revision: publicRevision, startedAfterSeq: durableCursor, turn: frame.turn, step: frame.step }
      : frame.type === 'chunk'
        ? { type: 'chunk', attemptId: frame.attemptId, revision: publicRevision, index: frame.index, time: frame.time, chunk: frame.chunk }
        : { type: 'end', attemptId: frame.attemptId, revision: publicRevision, index: frame.index, outcome: frame.outcome }
    return freeze(output)
  }

  baseline(sessionId, rawBaseline) {
    boundedString(sessionId, 'sessionId')
    const incoming = sanitizeBaseline(rawBaseline)
    const state = this.#state(sessionId)
    // A live stream is authoritative. Sanitizing a late history baseline must not
    // make the reconnect response roll back to the history attempt.
    if (state.active !== undefined) return freeze(stateBaseline(state))

    const wasEmpty = state.publicRevision === 0
    const incomingAttempt = incoming.activeAttempt === undefined
      ? undefined
      : { ...incoming.activeAttempt, chunks: expandCompactStream(incoming.activeAttempt.stream), bytes: 0 }
    const isRestart = incoming.activeAttempt !== undefined && incoming.revision === 1 && state.lastRawRevision > 0
    const isRetiredAttempt = incomingAttempt !== undefined && state.retired.has(incomingAttempt.attemptId)
    const isNewRevision = incoming.revision > state.lastRawRevision
    const canInstall = wasEmpty || (!isRetiredAttempt && (isNewRevision || isRestart))
    if (!canInstall) return freeze(stateBaseline(state))

    const nextOffset = isRestart ? state.publicRevision : state.offset
    const nextPublicRevision = nextOffset + incoming.revision
    if (!Number.isSafeInteger(nextPublicRevision)) this.#fail('invalid-input', 'baseline revision mapping overflow')
    if (incomingAttempt !== undefined) {
      if (this.#activeAttempts >= this.#maxActiveAttempts) this.#fail('active-attempt-limit', 'active assistant stream attempt limit reached')
      this.#checkSize(incomingAttempt, measuredAttemptBytes(incomingAttempt))
    }

    state.offset = nextOffset
    state.lastRawRevision = incoming.revision
    state.publicRevision = nextPublicRevision
    if (incomingAttempt !== undefined) {
      state.active = incomingAttempt
      this.#activeAttempts += 1
    }
    return freeze(stateBaseline(state))
  }

  snapshots() {
    const output = []
    for (const [sessionId, state] of this.#sessions) if (state.active !== undefined) {
      output.push(freeze({ sessionId, frame: { type: 'baseline', revision: state.publicRevision, activeAttempt: publicAttempt(state.active) } }))
    }
    return Object.freeze(output)
  }

  disposeSession(sessionId) {
    boundedString(sessionId, 'sessionId')
    const state = this.#sessions.get(sessionId)
    if (state?.active !== undefined) this.#activeAttempts -= 1
    this.#sessions.delete(sessionId)
  }

  reset() {
    this.#sessions.clear()
    this.#activeAttempts = 0
  }
}

export const MOBILE_ASSISTANT_STREAM_LIMITS = Object.freeze({ maxBytesPerSession: DEFAULT_MAX_BYTES_PER_SESSION, maxActiveAttempts: DEFAULT_MAX_ACTIVE_ATTEMPTS })
