
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CURRENT_RUNTIME_VERSION,
  LEGACY_RUNTIME_VERSION,
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
