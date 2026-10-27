// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                             
                                                                                                                                                   

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BrowserStreamError,
  CURRENT_RUNTIME_VERSION,
  LEGACY_RUNTIME_VERSION,
  classifyStreamFailure,
  sanitizeStreamFailure,
  wrapHostCarrier,
} from '../packages/runtime-interface/src/index.js'
import { createRemoteHostsClient } from '../packages/runtime-interface/src/client/index.js'

test('stream failure classification exposes only stable transport fields', () => {
  const error = new Error('secret bearer token and private socket details')
  error.code = 'transport/timeout'
  const failure = classifyStreamFailure(error, { stage: 'live', source: 'carrier' })
  assert.deepEqual(failure, {
    source: 'carrier',
    reason: 'transport-timeout',
    recoverable: true,
    stage: 'live',
  })
  assert.equal('code' in failure, false)
  assert.equal('message' in failure, false)
})

test('stream failure sanitization derives recoverability from the reason allowlist', () => {
  assert.deepEqual(sanitizeStreamFailure({
    source: 'queue',
    reason: 'resource-limit',
    recoverable: true,
    stage: 'live',
    expected: 4096,
    actual: 4097,
    code: 'secret-code',
    message: 'secret-message',
    extra: 'discarded',
  }), {
    source: 'queue',
    reason: 'resource-limit',
    recoverable: false,
    stage: 'live',
    expected: 4096,
    actual: 4097,
  })
})

test('abort signal and interface errors stay non-recoverable', () => {
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(classifyStreamFailure(new Error('socket disconnected'), {
    stage: 'live',
    source: 'carrier',
    signal: controller.signal,
  }), {
    source: 'carrier',
    reason: 'aborted',
    recoverable: false,
    stage: 'live',
  })
  const error = new BrowserStreamError('runtime-interface/invalid-stream', 'interface', { expected: 4, actual: 9 })
  assert.deepEqual(classifyStreamFailure(error, { stage: 'bootstrap', source: 'interface' }), {
    source: 'interface',
    reason: 'invalid-frame',
    recoverable: false,
    stage: 'bootstrap',
    expected: 4,
    actual: 9,
  })
})

const address = { kind: 'session', sessionId: 'session-a' }
const currentRequest = { args: { request: { address, assistantStream: true } } }

function recordingJournal() {
  const events = []
  return { events, record(row) { events.push(row) } }
}

function snapshot(cursor = 2, assistantStream, records = []) {
  return { type: 'snapshot', header: { id: 'session-a' }, cursor, records, hasMore: false, ...(assistantStream === undefined ? {} : { assistantStream }) }
}

function currentChunk(index, revision, text = 'x') {
  return {
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'attempt-a', revision, index, time: index + 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

test('a stream that ends normally records exactly one terminal row', async () => {
  const journal = recordingJournal()
  const carrier = { call: async () => ({ ok: true, value: {} }), async *open() { yield snapshot(2) } }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION, diagnostics: journal })
  await collect(wrapped.open('session/follow', currentRequest))
  assert.deepEqual(journal.events.map(row => row.phase), ['stream_open', 'stream_end'])
  assert.equal(journal.events[0].endpoint, 'session/follow')
  assert.equal(journal.events[1].code, undefined)
  assert.equal(journal.events[1].lastSeq, 2)
})

test('a connect failure before the first frame records one recoverable bootstrap row', async () => {
  const journal = recordingJournal()
  const carrier = { call: async () => ({ ok: true, value: {} }), open: async () => { throw Object.assign(new Error('socket disconnected for host secret'), { code: 'ECONNRESET' }) } }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION, diagnostics: journal })
  await assert.rejects(async () => collect(wrapped.open('session/follow', currentRequest)), /disconnected/)
  assert.deepEqual(journal.events.map(row => row.phase), ['stream_error'])
  assert.deepEqual({ ...journal.events[0], durationMs: undefined }, {
    phase: 'stream_error', endpoint: 'session/follow', hostId: 'host-a', sessionId: undefined,
    count: 0, lastSeq: undefined, durationMs: undefined, closeCode: undefined,
    code: 'transport', source: 'carrier', reason: 'transport-disconnected', recoverable: true, stage: 'bootstrap',
  })
  assert.equal(JSON.stringify(journal.events).includes('secret'), false)
})

test('a mid-stream failure is recoverable while an ordering failure is not', async () => {
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open() {
      yield snapshot(2, { revision: 1, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 100, stream: [] } })
      throw Object.assign(new Error('transport reset'), { code: 'ECONNRESET' })
    },
  }
  const liveJournal = recordingJournal()
  const live = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: CURRENT_RUNTIME_VERSION, diagnostics: liveJournal })
  await assert.rejects(async () => collect(live.open('session/follow', currentRequest)), /transport reset/)
  const terminal = liveJournal.events.at(-1)
  assert.equal(terminal.phase, 'stream_error')
  assert.equal(terminal.reason, 'transport-disconnected')
  assert.equal(terminal.recoverable, true)
  assert.equal(terminal.stage, 'live')
  assert.equal(terminal.count, 1)

  const gapCarrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open() {
      yield snapshot(2, { revision: 1, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 100, stream: [] } })
      yield currentChunk(105, 2, 'gap')
    },
  }
  const gapJournal = recordingJournal()
  const gap = wrapHostCarrier({ hostId: 'host-a', carrier: gapCarrier, upstreamVersion: CURRENT_RUNTIME_VERSION, diagnostics: gapJournal })
  await assert.rejects(async () => collect(gap.open('session/follow', currentRequest)), error => error.reason === 'sequence-gap')
  const gapRow = gapJournal.events.at(-1)
  assert.equal(gapRow.phase, 'stream_error')
  assert.equal(gapRow.code, 'protocol')
  assert.equal(gapRow.source, 'interface')
  assert.equal(gapRow.reason, 'sequence-gap')
  assert.equal(gapRow.recoverable, false)
  assert.equal(gapRow.expected, 100)
  assert.equal(gapRow.actual, 105)
})

test('cancellation records one cancel row and never a second terminal row', async () => {
  const journal = recordingJournal()
  const controller = new AbortController()
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open() {
      yield snapshot(2)
      yield { type: 'event', event: { type: 'assistant/chunk', seq: 3, time: 30, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'late' } } } }
    },
  }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION, diagnostics: journal })
  const values = []
  for await (const value of wrapped.open('session/follow', currentRequest, controller.signal)) {
    values.push(value)
    controller.abort()
  }
  // start + chunk + the durable row + the abandoned end frame
  assert.equal(values.length, 4)
  assert.deepEqual(journal.events.map(row => row.phase), ['stream_open', 'stream_cancel'])
  assert.equal(journal.events[1].recoverable, undefined)
})

test('authentication and protocol failures are never marked recoverable', async () => {
  const cases = [
    [Object.assign(new Error('unauthorized'), { code: 'runtime-interface/unauthorized' }), 'unauthorized'],
    [Object.assign(new Error('bad version'), { code: 'runtime-interface/unsupported-version' }), 'incompatible'],
    [Object.assign(new Error('queue overflow'), { code: 'runtime-interface/queue-overflow' }), 'resource-limit'],
    [Object.assign(new Error('bad frame'), { code: 'runtime-interface/invalid-stream' }), 'invalid-frame'],
  ]
  for (const [error, reason] of cases) {
    const failure = classifyStreamFailure(error, { stage: 'live' })
    assert.equal(failure.reason, reason)
    assert.equal(failure.recoverable, false)
  }
  const controller = new AbortController()
  controller.abort()
  assert.equal(classifyStreamFailure(new Error('cancelled'), { stage: 'live', signal: controller.signal }).recoverable, false)
})

test('a current snapshot above the former cumulative limit remains readable', async () => {
  const carrier = {
    call: async () => ({ ok: true, value: {} }),
    async *open() {
      yield snapshot(2, {
        revision: 1,
        activeAttempt: {
          attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 65537,
          stream: new Array(65537).fill({ type: 'chunk', time: 1, chunk: { type: 'text-delta', index: 0, text: '' } }),
        },
      })
    },
  }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: CURRENT_RUNTIME_VERSION })
  const frames = await collect(wrapped.open('session/follow', currentRequest))
  assert.equal(frames[0].assistantStream.activeAttempt.nextIndex, 65537)
})

test('bootstrap timeout is recoverable but cancellation and unknown failures are not', () => {
  const timeout = Object.assign(new Error('private timeout context'), { code: 'runtime-interface/stream-first-frame-timeout' })
  assert.deepEqual(classifyStreamFailure(timeout, { stage: 'bootstrap' }), {
    source: 'interface', reason: 'first-frame-timeout', recoverable: true, stage: 'bootstrap',
  })
  const abort = Object.assign(new Error('cancel'), { name: 'AbortError' })
  assert.equal(classifyStreamFailure(abort, { stage: 'bootstrap' }).reason, 'aborted')
  assert.equal(classifyStreamFailure(new Error('unknown'), { stage: 'live' }).reason, 'unknown')
  assert.equal(classifyStreamFailure({ code: 'unexpected-timeout-policy' }).recoverable, false)
})

test('legacy carrier errors and nested transport causes are classified only at the interface', () => {
  for (const [error, reason, recoverable] of [
    [new Error('CARRIER_DISCONNECTED'), 'transport-disconnected', true],
    [new Error('CARRIER_STREAM_ENDED'), 'stream-ended', true],
    [new Error('HOST_CONNECTION_FAILED_FORWARD'), 'connect-failed', true],
    [new Error('HOST_CONNECTION_FAILED_AUTHENTICATION'), 'unauthorized', false],
    [new Error('CARRIER_RESULT_HTTP_401'), 'unauthorized', false],
    [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 'transport-disconnected', true],
  ]) {
    const failure = classifyStreamFailure(error, { stage: 'bootstrap' })
    assert.equal(failure.reason, reason)
    assert.equal(failure.recoverable, recoverable)
    assert.equal(failure.source, 'carrier')
  }
})

test('streaming never replays a write request', async () => {
  const calls = []
  const carrier = {
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: {} } },
    async *open() { yield snapshot(2) },
  }
  const wrapped = wrapHostCarrier({ hostId: 'host-a', carrier, upstreamVersion: LEGACY_RUNTIME_VERSION })
  await collect(wrapped.open('session/follow', currentRequest))
  assert.deepEqual(calls, [])
  await wrapped.call('session/prompt', { args: { sessionId: 'session-a' } })
  assert.equal(calls.length, 1)
})

test('journal rows keep old readers working while adding the new fields', async () => {
  const legacyRow = { time: 1, phase: 'stream_error', endpoint: 'session/follow', code: 'transport', closeCode: 1006, count: 12, durationMs: 900, lastSeq: 41 }
  assert.equal(sanitizeStreamFailure(legacyRow), undefined)
  const extended = { ...legacyRow, source: 'hub', reason: 'transport-disconnected', recoverable: false, stage: 'live' }
  assert.deepEqual(sanitizeStreamFailure(extended), {
    source: 'hub', reason: 'transport-disconnected', recoverable: true, stage: 'live',
  })
  const client = createRemoteHostsClient({ call: async () => ({ ok: true, value: {
    schemaVersion: 1, scope: 'local-hub-only', generatedAt: 'now', limit: 512, dropped: 0, persistenceAvailable: true,
    events: [legacyRow, extended, { ...extended, expected: 4096, actual: 4097, message: 'SECRET', stack: 'SECRET' }],
  } }) })
  const result = await client.call('exportDiagnostics')
  assert.equal(result.events[0].code, 'transport')
  assert.equal(result.events[0].reason, undefined)
  assert.equal(result.events[1].recoverable, true)
  assert.equal(result.events[2].expected, 4096)
  assert.equal(result.events[2].actual, 4097)
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})
