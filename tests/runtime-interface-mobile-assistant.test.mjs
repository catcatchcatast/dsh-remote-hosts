import assert from 'node:assert/strict'
import test from 'node:test'
import { MobileAssistantStream, MobileAssistantStreamError } from '../packages/runtime-interface/src/mobile-assistant-stream.js'

const start = (attemptId, revision = 1, turn = 1, step = 1) => ({ type: 'start', attemptId, revision, turn, step })
const chunk = (attemptId, revision, index, value, time = 100) => ({ type: 'chunk', attemptId, revision, index, time, chunk: { type: 'text-delta', index: 0, text: value } })
const end = (attemptId, revision, index, outcome = { kind: 'abandoned' }) => ({ type: 'end', attemptId, revision, index, outcome })

test('sanitizes raw frames, freezes output, and removes tool/replay payloads', () => {
  const stream = new MobileAssistantStream()
  assert.deepEqual(stream.ingest('s', start('a'), 7), { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 7, turn: 1, step: 1 })
  const tool = stream.ingest('s', {
    type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 101,
    chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read', argumentsDelta: '{"secret":true}', agent: { ctx: 'private' } },
  }, 7)
  assert.deepEqual(tool.chunk, { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read', argumentsDelta: '' })
  const block = stream.ingest('s', {
    type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 102,
    chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"secret":true}', results: ['private'] } },
  }, 7)
  assert.deepEqual(block.chunk, { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'read' } })
  const finish = stream.ingest('s', {
    type: 'chunk', attemptId: 'a', revision: 4, index: 2, time: 103,
    chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'private' } },
  }, 7)
  assert.deepEqual(finish.chunk, { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(Object.hasOwn(finish.chunk, 'replayState'), false)
  assert.ok(Object.isFrozen(finish) && Object.isFrozen(finish.chunk))
})

test('keeps public revisions monotone across Agent recreation and ignores late old attempts', () => {
  const stream = new MobileAssistantStream()
  assert.equal(stream.ingest('s', start('old'), 10).revision, 1)
  assert.equal(stream.ingest('s', chunk('old', 2, 0, 'old'), 10).revision, 2)
  assert.equal(stream.ingest('s', end('old', 3, 1, { kind: 'committed', eventType: 'assistant/message', seq: 11 }), 11).revision, 3)
  assert.equal(stream.ingest('s', start('new'), 20).revision, 4)
  assert.equal(stream.ingest('s', chunk('new', 2, 0, 'new'), 20).revision, 5)
  assert.equal(stream.ingest('s', chunk('old', 4, 1, 'late'), 20), undefined)
  assert.equal(stream.ingest('s', start('old'), 20), undefined)
  assert.deepEqual(stream.snapshots(), [{ sessionId: 's', frame: { type: 'baseline', revision: 5, activeAttempt: { attemptId: 'new', startedAfterSeq: 20, turn: 1, step: 1, nextIndex: 1, stream: [{ type: 'chunk', time: 100, chunk: { type: 'text-delta', index: 0, text: 'new' } }] } } }])
})

test('late history baselines return the newer live state without replacing it', () => {
  const stream = new MobileAssistantStream()
  stream.ingest('s', start('b'), 4)
  stream.ingest('s', chunk('b', 2, 0, 'live'), 4)
  const baseline = stream.baseline('s', {
    revision: 1,
    activeAttempt: { attemptId: 'a', startedAfterSeq: 3, turn: 1, step: 1, nextIndex: 1, stream: [{ type: 'text-chunks', time0: 90, index: 0, dt: [], texts: ['old'] }] },
  })
  assert.equal(baseline.revision, 2)
  assert.equal(baseline.activeAttempt.attemptId, 'b')
  assert.equal(stream.snapshots()[0].frame.activeAttempt.attemptId, 'b')
  assert.equal(stream.snapshots()[0].frame.revision, 2)
})

test('installs a newer baseline after an ended attempt and reconnects from it', () => {
  const stream = new MobileAssistantStream()
  stream.ingest('s', start('a'), 4)
  stream.ingest('s', end('a', 2, 0), 4)
  const baseline = stream.baseline('s', {
    revision: 1,
    activeAttempt: { attemptId: 'b', startedAfterSeq: 4, turn: 2, step: 1, nextIndex: 1, stream: [{ type: 'text-chunks', time0: 20, index: 0, dt: [], texts: ['recovered'] }] },
  })
  assert.equal(baseline.revision, 3)
  assert.equal(baseline.activeAttempt.attemptId, 'b')
  assert.equal(stream.snapshots()[0].frame.activeAttempt.attemptId, 'b')
  assert.equal(stream.ingest('s', chunk('b', 2, 1, 'next'), 4).revision, 4)
})

test('does not advance the mapper for a late old baseline without an active attempt', () => {
  const stream = new MobileAssistantStream()
  stream.ingest('s', start('a'), 4)
  stream.ingest('s', end('a', 2, 0), 4)
  assert.deepEqual(stream.baseline('s', { revision: 1 }), { revision: 2 })
  assert.deepEqual(stream.baseline('s', { revision: 1 }), { revision: 2 })
})

test('rejects revision/index gaps and invalid outcomes without advancing state', () => {
  const stream = new MobileAssistantStream()
  stream.ingest('s', start('a'), 8)
  assert.throws(() => stream.ingest('s', chunk('a', 3, 0, 'gap'), 8), error => error instanceof MobileAssistantStreamError && error.code === 'revision-gap' && error.baselineRequired)
  assert.throws(() => stream.ingest('s', chunk('a', 2, 1, 'wrong-index'), 8), error => error instanceof MobileAssistantStreamError && error.code === 'index-gap' && error.baselineRequired)
  assert.equal(stream.ingest('s', chunk('a', 2, 0, 'ok'), 8).revision, 2)
  assert.throws(() => stream.ingest('s', end('a', 3, 1, { kind: 'committed', eventType: 'assistant/message', seq: -1 }), 12), error => error instanceof MobileAssistantStreamError && error.code === 'invalid-input')
  const committed = stream.ingest('s', end('a', 3, 1, { kind: 'committed', eventType: 'assistant/message', seq: 0 }), 12)
  assert.equal(committed.outcome.seq, 0)
  assert.equal(stream.snapshots().length, 0)
})

test('enforces bounded active caches and active-session count with local baseline errors', () => {
  const stream = new MobileAssistantStream({ maxBytesPerSession: 160, maxActiveAttempts: 1 })
  stream.ingest('one', start('a'), 0)
  assert.throws(() => stream.ingest('one', chunk('a', 2, 0, 'x'.repeat(500)), 0), error => error.code === 'reconnect-baseline-required' && error.baselineRequired)
  assert.equal(stream.ingest('one', chunk('a', 2, 0, 'ok'), 0).index, 0)
  assert.throws(() => stream.ingest('two', start('b'), 0), error => error.code === 'active-attempt-limit' && error.baselineRequired)
  stream.ingest('one', end('a', 3, 1), 0)
  assert.equal(stream.ingest('two', start('b'), 0).attemptId, 'b')
  stream.disposeSession('two')
  assert.deepEqual(stream.snapshots(), [])
})

test('baseline sanitizes compact records and snapshots only active attempts', () => {
  const stream = new MobileAssistantStream()
  const baseline = stream.baseline('s', {
    revision: 4,
    activeAttempt: {
      attemptId: 'a', startedAfterSeq: -1, turn: 2, step: 3, nextIndex: 3,
      stream: [
        { type: 'tool-call-chunks', time0: 1, index: 0, dt: [1], id: 'tool', name: 'run', args: ['{"secret":1}', 'more'] },
        { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'tool', name: 'run', arguments: 'secret' } } },
      ],
    },
  })
  assert.equal(baseline.revision, 4)
  assert.deepEqual(baseline.activeAttempt.stream.map(frame => frame.type), ['chunk', 'chunk', 'chunk'])
  assert.deepEqual(baseline.activeAttempt.stream[0].chunk, { type: 'tool-call-delta', index: 0, id: 'tool', name: 'run', argumentsDelta: '' })
  assert.deepEqual(baseline.activeAttempt.stream[1].chunk, { type: 'tool-call-delta', index: 0, id: 'tool', name: 'run', argumentsDelta: '' })
  assert.deepEqual(baseline.activeAttempt.stream[2].chunk.block, { type: 'tool-call', id: 'tool', name: 'run' })
  assert.deepEqual(stream.snapshots()[0].frame, { type: 'baseline', revision: 4, activeAttempt: baseline.activeAttempt })
  stream.reset()
  assert.deepEqual(stream.snapshots(), [])
})
