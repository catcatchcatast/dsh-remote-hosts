// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                     
                                                                                                                                                   
                                                                                                                                             

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT_RUNTIME_VERSION,
  LEGACY_RUNTIME_VERSION,
  LEGACY_STREAM_RUNTIME_VERSION,
  createSessionFollowStreamEncoder,
  wrapHostCarrier,
} from '../packages/runtime-interface/src/index.js'
import { BrowserHostHub, encodeCompositeId } from '../packages/browser-host-hub-rc1/src/index.js'

const address = { kind: 'session', sessionId: 'session-a' }
const currentRequest = { args: { request: { address, assistantStream: true } } }
const legacyRequest = { args: { request: { address } } }

function snapshot(cursor = 2, assistantStream) {
  return {
    type: 'snapshot',
    header: { id: 'session-a' },
    cursor,
    records: [],
    hasMore: false,
    ...(assistantStream === undefined ? {} : { assistantStream }),
  }
}

function oldEvent(type, seq, data, time = seq * 10, surfaceOp) {
  return { type: 'event', event: { type, seq, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } }
}

function textChunk(turn = 1, step = 1, text = 'x') {
  return { turn, step, chunk: { type: 'text-delta', index: 0, text } }
}

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

test('legacy follow emits bounded transient frames before the durable message and preserves seq', async () => {
  const requests = []
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open(endpoint, payload) {
      requests.push({ endpoint, payload })
      yield snapshot()
      yield oldEvent('assistant/chunk', 3, textChunk())
      yield oldEvent('assistant/message', 4, { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, 40, 'append')
    },
  }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION })
  const values = await collect(wrapped.open('session/follow', currentRequest))

  assert.deepEqual(requests[0].payload.args.request, { address })
  assert.equal(values[0].type, 'snapshot')
  assert.deepEqual(values[0].assistantStream, { revision: 0 })
  assert.deepEqual(values.map(value => value.type === 'assistant-stream' ? `assistant:${value.frame.type}` : value.type), [
    'snapshot', 'assistant:start', 'assistant:chunk', 'event', 'event', 'assistant:end',
  ])
  assert.equal(values[1].frame.startedAfterSeq, 2)
  assert.equal(values[2].frame.index, 0)
  assert.equal(values[2].frame.revision, 2)
  assert.equal(values[3].event.type, 'legacy/assistant-chunk')
  assert.equal(values[3].event.seq, 3)
  assert.equal(values[3].event.ignorable, true)
  assert.equal(values[4].event.seq, 4)
  assert.deepEqual(values[5].frame.outcome, { kind: 'committed', eventType: 'assistant/message', seq: 4 })
  assert.equal(values[5].frame.index, 1)
})

test('legacy without assistantStream remains equivalent and the old request field is removed', async () => {
  const input = [snapshot(), oldEvent('assistant/chunk', 3, textChunk())]
  const requests = []
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open(endpoint, payload) {
      requests.push(payload)
      yield * input
    },
  }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION })
  const values = await collect(wrapped.open('session/follow', legacyRequest))
  assert.deepEqual(requests[0], legacyRequest)
  assert.equal(values.some(value => value.type === 'assistant-stream'), false)
  assert.equal(values[0].assistantStream, undefined)
  assert.equal(values[1].event.type, 'legacy/assistant-chunk')

  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: LEGACY_RUNTIME_VERSION,
    targetVersion: LEGACY_RUNTIME_VERSION,
    request: legacyRequest,
    mapFrame: value => value,
  })
  assert.deepEqual(encoder.push(input[0]), [input[0]])
  assert.deepEqual(encoder.push(input[1]), [input[1]])
})

test('current follow validates revision/index/seq continuity and otherwise passes frames through', () => {
  const frames = [
    snapshot(2, { revision: 7 }),
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-a', revision: 8, startedAfterSeq: 2, turn: 1, step: 1 } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-a', revision: 9, index: 0, time: 30, chunk: { type: 'text-delta', index: 0, text: 'x' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, time: 31, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, surfaceOp: 'append' } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt-a', revision: 10, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } } },
  ]
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  assert.deepEqual(frames.flatMap(frame => encoder.push(frame)), frames)

  const invalid = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  invalid.push(snapshot(2, { revision: 0 }))
  assert.throws(() => invalid.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-a', revision: 2, startedAfterSeq: 2, turn: 1, step: 1 } }), error => error.code === 'runtime-interface/invalid-stream')
})

test('legacy cancellation boundary closes the attempt as abandoned and release clears the encoder', () => {
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: LEGACY_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  encoder.push(snapshot(0))
  encoder.push(oldEvent('assistant/chunk', 1, textChunk()))
  const canceled = encoder.push(oldEvent('turn/end', 2, { turn: 1, step: 1, reason: { kind: 'aborted' } }))
  assert.equal(canceled[0].type, 'assistant-stream')
  assert.deepEqual(canceled[0].frame.outcome, { kind: 'abandoned' })
  assert.equal(canceled[1].event.type, 'turn/end')
  const nextAttempt = encoder.push(oldEvent('assistant/chunk', 3, textChunk(1, 2, 'next')))
  assert.equal(nextAttempt[0].frame.type, 'start')
  assert.equal(nextAttempt[0].frame.startedAfterSeq, 2)
  encoder.release()
  assert.throws(() => encoder.push(oldEvent('assistant/chunk', 4, textChunk())), error => error.code === 'runtime-interface/stream-closed')
})

test('Hub asks only the interface stream encoder to expose a legacy transient stream to a current Browser', async () => {
  let openedPayload
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open(endpoint, payload) {
      openedPayload = payload
      yield snapshot()
      yield oldEvent('assistant/chunk', 3, textChunk())
      yield oldEvent('assistant/message', 4, { turn: 1, step: 1, message: { role: 'assistant', content: [] } }, 40, 'append')
    },
  }
  const hub = new BrowserHostHub({
    perHost: { 'host-a': { carrier, upstreamVersion: LEGACY_RUNTIME_VERSION } },
    selectedHost: 'host-a',
    browserVersion: CURRENT_RUNTIME_VERSION,
  })
  const stream = hub.openStream('session/follow', {
    args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('host-a', 'session-a') }, assistantStream: true } },
  })
  const values = await collect(stream)
  assert.equal(openedPayload.args.request.assistantStream, undefined)
  assert.deepEqual(values.map(value => value.type === 'assistant-stream' ? `assistant:${value.frame.type}` : value.type), [
    'snapshot', 'assistant:start', 'assistant:chunk', 'event', 'event', 'assistant:end',
  ])
  assert.equal(values[0].header.id, encodeCompositeId('host-a', 'session-a'))
})

test('current continuation accepts cumulative nextIndex beyond the legacy cache bound', () => {
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  const baseline = snapshot(4096, {
    revision: 7,
    activeAttempt: {
      attemptId: 'attempt-a',
      startedAfterSeq: 4096,
      turn: 1,
      step: 1,
      nextIndex: 4097,
      stream: [],
    },
  })
  assert.deepEqual(encoder.push(baseline), [baseline])
  const continuation = {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'attempt-a',
      revision: 8,
      index: 4097,
      time: 4100,
      chunk: { type: 'text-delta', index: 0, text: 'after-cache-bound' },
    },
  }
  assert.deepEqual(encoder.push(continuation), [continuation])
})

test('current continuation accepts a cumulative nextIndex above the legacy safe stream bound', () => {
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  const baseline = snapshot(0, {
    revision: 0,
    activeAttempt: {
      attemptId: 'attempt-a',
      startedAfterSeq: 0,
      turn: 1,
      step: 1,
      nextIndex: 65537,
      stream: [],
    },
  })
  assert.deepEqual(encoder.push(baseline), [baseline])
  const continuation = currentChunk(65537, 1, 'after-safe-bound')
  assert.deepEqual(encoder.push(continuation), [continuation])
})

test('current continuation reports sequence gaps with bounded expected and actual indices', () => {
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  encoder.push(snapshot(0, {
    revision: 4,
    activeAttempt: {
      attemptId: 'attempt-a',
      startedAfterSeq: 0,
      turn: 1,
      step: 1,
      nextIndex: 4097,
      stream: [],
    },
  }))
  assert.throws(() => encoder.push({
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: 'attempt-a',
      revision: 5,
      index: 4099,
      time: 10,
      chunk: { type: 'text-delta', index: 0, text: 'gap' },
    },
  }), error => error.reason === 'sequence-gap'
    && error.source === 'interface'
    && error.details.expected === 4097
    && error.details.actual === 4099)
})

const CUMULATIVE_BOUNDS = [4095, 4096, 4097, 65537]

function currentEncoder() {
  return createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
}

function currentBaseline(nextIndex, revision = 1, attemptId = 'attempt-a') {
  return snapshot(nextIndex, {
    revision,
    activeAttempt: { attemptId, startedAfterSeq: nextIndex, turn: 1, step: 1, nextIndex, stream: [] },
  })
}

function currentChunk(index, revision, text = 'x', attemptId = 'attempt-a') {
  return {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId, revision, index, time: index <= Math.floor((Number.MAX_SAFE_INTEGER - 1) / 10) ? index * 10 + 1 : 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}

test('current continuation keeps updating across the legacy cache bound (4095/4096/4097)', () => {
  for (const start of CUMULATIVE_BOUNDS) {
    const encoder = currentEncoder()
    assert.deepEqual(encoder.push(currentBaseline(start)), [currentBaseline(start)])
    const first = encoder.push(currentChunk(start, 2, `chunk-${start}`))
    assert.equal(first.length, 1)
    assert.equal(first[0].frame.index, start)
    assert.equal(first[0].frame.revision, 2)
    const second = encoder.push(currentChunk(start + 1, 3, `chunk-${start + 1}`))
    assert.equal(second[0].frame.index, start + 1)
    assert.equal(second[0].frame.chunk.text, `chunk-${start + 1}`)
  }
})

test('current continuation keeps the safe integer guard without a cumulative chunk cap', () => {
  const encoder = currentEncoder()
  const start = Number.MAX_SAFE_INTEGER
  encoder.push(currentBaseline(start, 1))
  assert.throws(() => encoder.push(currentChunk(start, 2, 'overflow')), error => error.reason === 'resource-limit'
    && error.recoverable === false)
})

test('current continuation resumes beyond 65536 and preserves the final durable body', () => {
  const encoder = currentEncoder()
  const baseline = currentBaseline(65537, 7, 'attempt-long')
  assert.deepEqual(encoder.push(baseline), [baseline])
  const continuation = currentChunk(65537, 8, 'after-reconnect', 'attempt-long')
  assert.deepEqual(encoder.push(continuation), [continuation])

  const finalBody = oldEvent('assistant/message', 65538, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'final body' }] },
  }, 655380, 'append')
  assert.deepEqual(encoder.push(finalBody), [finalBody])
  const committed = {
    type: 'assistant-stream',
    frame: {
      type: 'end',
      attemptId: 'attempt-long',
      revision: 9,
      index: 65538,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 65538 },
    },
  }
  assert.deepEqual(encoder.push(committed), [committed])
  assert.deepEqual(finalBody.event.data.message.content, [{ type: 'text', text: 'final body' }])
})

test('current continuation resumes from a snapshot beyond the legacy cache bound', () => {
  const encoder = currentEncoder()
  const baseline = currentBaseline(9000, 12)
  assert.deepEqual(encoder.push(baseline), [baseline])
  assert.deepEqual(encoder.push(currentChunk(9000, 13, 'resumed-0')), [currentChunk(9000, 13, 'resumed-0')])
  assert.deepEqual(encoder.push(currentChunk(9001, 14, 'resumed-1')), [currentChunk(9001, 14, 'resumed-1')])
})

test('current continuation still rejects repetition, gaps and a foreign attempt id', () => {
  const repeated = currentEncoder()
  repeated.push(currentBaseline(4097, 1))
  repeated.push(currentChunk(4097, 2, 'first'))
  assert.throws(() => repeated.push(currentChunk(4097, 3, 'again')), error => error.reason === 'sequence-gap'
    && error.details.expected === 4098
    && error.details.actual === 4097)

  const skipped = currentEncoder()
  skipped.push(currentBaseline(10, 1))
  assert.throws(() => skipped.push(currentChunk(12, 2, 'skipped')), error => error.reason === 'sequence-gap'
    && error.details.expected === 10
    && error.details.actual === 12)

  const foreign = currentEncoder()
  foreign.push(currentBaseline(10, 1))
  assert.throws(() => foreign.push(currentChunk(10, 2, 'foreign', 'attempt-b')), error => error.reason === 'attempt-mismatch'
    && error.recoverable === false)
})

function legacyChunkFrame(seq, text = 'x') {
  const inner = oldEvent('assistant/chunk', seq, textChunk(1, 1, text)).event
  return { ...inner, type: 'legacy/assistant-chunk', data: { legacyType: 'assistant/chunk', data: inner.data } }
}

test('the legacy converter keeps a small configurable chunk bound', () => {
  // A legacy source can still be browsed by a current Browser, so the transient
  // frames are visible and the cache bound stays observable.
  const encoder = createSessionFollowStreamEncoder({
    upstreamVersion: LEGACY_STREAM_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: legacyRequest,
    mapFrame: value => value,
    enabled: true,
  })
  encoder.push(snapshot(2))
  assert.equal(encoder.push(legacyChunkFrame(3)).length, 3)

  const bounded = createSessionFollowStreamEncoder({
    upstreamVersion: LEGACY_STREAM_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: legacyRequest,
    mapFrame: value => value,
    enabled: true,
    maxChunks: 3,
  })
  bounded.push(snapshot(2))
  // start + chunk + the original durable frame
  assert.equal(bounded.push(legacyChunkFrame(3)).length, 3)
  // The bound counts chunks, so indices 1 and 2 still fit.
  assert.equal(bounded.push(legacyChunkFrame(4)).length, 2)
  assert.equal(bounded.push(legacyChunkFrame(5)).length, 2)
  assert.throws(() => bounded.push(legacyChunkFrame(6)), error => error.reason === 'resource-limit'
    && error.recoverable === false)
})

test('mixed runtime versions keep each direction on its own bound', () => {
  const legacyToCurrent = createSessionFollowStreamEncoder({
    upstreamVersion: LEGACY_RUNTIME_VERSION,
    targetVersion: CURRENT_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  const legacyBaseline = legacyToCurrent.push(snapshot(2))
  assert.equal(legacyBaseline[0].type, 'snapshot')
  assert.equal(legacyBaseline[0].cursor, 2)
  assert.deepEqual(legacyBaseline[0].assistantStream, { revision: 0 })
  assert.throws(() => legacyToCurrent.push(snapshot(3)), error => error.code === 'runtime-interface/invalid-stream')

  const currentToLegacy = createSessionFollowStreamEncoder({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    targetVersion: LEGACY_RUNTIME_VERSION,
    request: currentRequest,
    mapFrame: value => value,
  })
  const currentBaselineOut = currentToLegacy.push(currentBaseline(4097, 3))
  assert.equal(currentBaselineOut.length, 1)
  assert.equal(currentBaselineOut[0].assistantStream, undefined)
  assert.equal(currentBaselineOut[0].cursor, 4097)
  assert.deepEqual(currentToLegacy.push(currentChunk(4097, 4, 'legacy-view')), [])
})
