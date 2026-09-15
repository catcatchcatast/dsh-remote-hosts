import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeInterface, CURRENT_RUNTIME_VERSION } from '../packages/runtime-interface/src/index.js'
import { MobileSessionSyncState, createMobileSessionEvents, readMobileV3History, convertMobileHistoryEntry } from '../packages/mobile-stream-compat-rc1/src/index.js'

function fixture(session = {}) {
  const listeners = new Map()
  const runtime = createRuntimeInterface({ sessionController: session, workspaceController: {}, connection: {}, subagents: {},
    upstreamVersion: CURRENT_RUNTIME_VERSION, historyEpoch: { datasetId: 'fixture', sequenceFormatGeneration: 3, generation: 1 } })
  const source = runtime.bindEventSource({ on(name, listener, options) {
    assert.deepEqual(options, { global: true })
    assert.equal(listeners.has(name), false)
    listeners.set(name, listener); return () => listeners.delete(name)
  } })
  const state = new MobileSessionSyncState()
  state.installGlobalSessionBridge(source, {})
  const emit = frame => listeners.get('agent/assistant-stream')({ agent: { session: { id: 's', seq: 8, ctx: { secret: 'private' } } }, frame })
  return { runtime, source, state, emit, listeners }
}

test('one global hook sends transient mux frames without history, cursor or private tool arguments', async () => {
  let reads = 0
  const f = fixture({ follow() { reads++; throw Error('cold follow forbidden') } })
  const iterator = createMobileSessionEvents(f.state).subscribe()[Symbol.asyncIterator]()
  const first = iterator.next()
  f.emit({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
  const start = (await first).value
  assert.equal(start.method, 'session/assistant-stream')
  assert.equal(start.payload.frame.startedAfterSeq, 7)
  assert.equal(start.payload.historyEpoch, f.runtime.describe().historyEpoch)
  f.emit({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 10,
    chunk: { type: 'tool-call-delta', index: 0, id: 'tool', name: 'shell', argumentsDelta: 'PRIVATE-COMMAND' } })
  const chunk = (await iterator.next()).value
  assert.equal(chunk.payload.frame.chunk.argumentsDelta, '')
  assert.equal(JSON.stringify(chunk).includes('PRIVATE'), false)
  assert.equal(f.state.getWatermark('s'), undefined)
  assert.deepEqual(f.state.cachedEvents('s'), [])
  assert.equal(reads, 0)
  await iterator.return()
  const reconnect = createMobileSessionEvents(f.state).subscribe()[Symbol.asyncIterator]()
  const baseline = (await reconnect.next()).value
  assert.equal(baseline.payload.frame.type, 'baseline')
  assert.equal(baseline.payload.frame.activeAttempt.nextIndex, 1)
  await reconnect.return()
  f.state.replaceArchivedSessions(['s'])
  assert.deepEqual(f.source.assistantSnapshots(), [])
  f.state.dispose(); assert.equal(f.listeners.size, 0)
})

test('current history snapshot exposes a sanitized transient baseline separately from durable events', async () => {
  let request
  const f = fixture({ async *follow(input) {
    request = input
    yield { type: 'snapshot', cursor: 7, records: [], hasMore: false, header: { id: 's' },
      assistantStream: { revision: 2, activeAttempt: { attemptId: 'a', startedAfterSeq: 7, turn: 1, step: 1, nextIndex: 1,
        stream: [{ type: 'chunk', time: 10, chunk: { type: 'tool-call-delta', index: 0, id: 'tool', name: 'shell', argumentsDelta: 'PRIVATE-COMMAND' } }] } } }
  }, page() { throw Error('page not needed') }, list() { return { items: [] } } })
  const history = await readMobileV3History({ session: f.runtime.session, subagents: f.runtime.subagents }, { sessionId: 's' }, f.state)
  assert.equal(request.assistantStream, true)
  assert.equal(history.ok, true)
  assert.deepEqual(history.value.events, [])
  assert.equal(history.value.lastSeq, 7)
  assert.equal(history.value.assistantStream.activeAttempt.nextIndex, 1)
  assert.equal(JSON.stringify(history.value).includes('PRIVATE'), false)
  f.state.dispose()
})

test('many reconnect baselines are drained before their live suffix and an oversized attempt stays local', async () => {
  const state = new MobileSessionSyncState({ maxSubscriberBytes: 1024, maxSubscriberQueue: 2 })
  state.assistantEventSource = { assistantSnapshots: () => Array.from({ length: 5 }, (_, i) => ({
    sessionId: `s${i}`, historyEpoch: 'epoch', frame: { type: 'baseline', revision: 2,
      activeAttempt: { attemptId: `a${i}`, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(i === 1 ? 2048 : 220) } }] } },
  })) }
  const iterator = createMobileSessionEvents(state).subscribe()[Symbol.asyncIterator]()
  const pending = iterator.next()
  state.emit({ sessionId: 's0', time: 2, type: 'control/assistant-stream', body: { historyEpoch: 'epoch',
    frame: { type: 'chunk', revision: 3, attemptId: 'a0', index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'live' } } } })
  const values = [(await pending).value]
  for (let i = 1; i < 6; i++) values.push((await iterator.next()).value)
  assert.equal(values[1].method, 'stream/error')
  assert.equal(values[1].payload.sessionId, 's1')
  assert.equal(values[5].payload.frame.revision, 3)
  assert.deepEqual(values.filter(item => item.method === 'session/assistant-stream').slice(0, 4).map(item => item.payload.sessionId), ['s0', 's2', 's3', 's4'])
  assert.equal(state.subscribers.size, 1)
  await iterator.return(); state.dispose()
})

test('legacy global durable chunks retain readable text through the same mobile boundary as history', async () => {
  const listeners = new Map()
  const runtime = createRuntimeInterface({ sessionController: {}, workspaceController: {}, connection: {}, subagents: {} })
  const state = new MobileSessionSyncState()
  state.installGlobalSessionBridge(runtime.bindEventSource({ on(name, listener) {
    listeners.set(name, listener); return () => listeners.delete(name)
  } }), { maxInlineBytes: 16 * 1024 })
  const iterator = createMobileSessionEvents(state).subscribe()[Symbol.asyncIterator]()
  const pending = iterator.next()
  listeners.get('session/event')({ id: 'legacy' }, { type: 'assistant/chunk', seq: 3, time: 10,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'legacy live body' } } })
  const frame = (await pending).value
  assert.equal(frame.method, 'session/event')
  assert.equal(frame.payload.event.type, 'assistant/chunk')
  assert.equal(frame.payload.event.data.chunk.text, 'legacy live body')
  assert.equal(state.getWatermark('legacy').lastSeq, 3)
  await iterator.return(); state.dispose()
})

test('a settled attempt retains only control coordinates, never fabricating a surface message', () => {
  const state = new MobileSessionSyncState()
  const result = convertMobileHistoryEntry({ event: { type: 'assistant/attempt', seq: 9, time: 10,
    data: { turn: 3, step: 2, stream: [{ type: 'chunk', time: 9, chunk: { type: 'tool-call-delta', argumentsDelta: 'private' } }] } } }, 's', state)
  assert.equal(result.type, 'assistant/attempt')
  assert.deepEqual(result.body, { turn: 3, step: 2 })
  state.dispose()
})
