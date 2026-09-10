import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  apply,
  MOBILE_SESSION_V3_CAPABILITY,
  MOBILE_SESSION_V3_PROTOCOL_VERSION,
  MobileSessionSyncState,
  MOBILE_SESSION_SYNC_CAPABILITY,
  MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
  convertMobileHistoryEntry,
  convertMobileMuxFrame,
  readMobileV3Delta,
  readMobileV3Details,
  readMobileV3History,
  readMobileV3Snapshot,
  readSessionDelta,
  readSessionTailWatermark,
  readSessionSyncSnapshot,
} from '../compat/android-bootstrap-mobile-session-sync/src/index.ts'

const V3_DEFAULTS = {
  maxEvents: 128,
  maxBytes: 512 * 1024,
  maxInlineBytes: 16 * 1024,
  maxDetailChunkBytes: 64 * 1024,
  maxHistoryPages: 64,
  scanPageMessages: 24,
  maxScanPages: 32,
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function event(seq, type = 'assistant/chunk') {
  return { event: { seq, time: seq, type, data: {} } }
}

function response(events, hasMore, asOfSeq) {
  return {
    rpcId: 'server',
    result: {
      ok: true,
      value: {
        events,
        hasMore,
        ...(asOfSeq === undefined ? {} : { projections: { asOfSeq, values: {} } }),
      },
    },
  }
}

test('delta pages from acknowledged seq and returns earliest authoritative events first', async () => {
  const calls = []
  const sessions = {
    history: async request => {
      calls.push(request.payload)
      return request.payload.beforeSeq === undefined
        ? response([event(8), event(9), event(10)], true, 10)
        : response([event(5), event(6), event(7)], true)
    },
  }

  const result = await readSessionDelta(
    sessions,
    { sessionId: 's-1', afterSeq: 6, maxEvents: 2 },
    { maxEvents: 8, scanPageMessages: 3, maxScanPages: 4 },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(item => item.event.seq), [7, 8])
  assert.deepEqual(result.value, {
    acknowledgedSeq: 6,
    firstSeq: 7,
    throughSeq: 8,
    lastSeq: 10,
    caughtUp: false,
    scanLimitReached: false,
    events: [event(7), event(8)],
    projections: { asOfSeq: 10, values: {} },
  })
  assert.deepEqual(calls.map(call => call.beforeSeq), [undefined, 8])
})

test('delta preserves every event regardless of event type', async () => {
  const sessions = {
    history: async () => response([
      event(41, 'assistant/chunk'),
      event(42, 'tool/call'),
      event(43, 'assistant/message'),
      event(44, 'turn/end'),
    ], false, 44),
  }

  const result = await readSessionDelta(
    sessions,
    { sessionId: 's-1', afterSeq: 40 },
    { maxEvents: 8, scanPageMessages: 8, maxScanPages: 2 },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(item => item.event.type), [
    'assistant/chunk',
    'tool/call',
    'assistant/message',
    'turn/end',
  ])
  assert.equal(result.value.caughtUp, true)
  assert.equal(result.value.scanLimitReached, false)
})

test('delta reports a scan boundary without returning a discontinuous suffix', async () => {
  const sessions = {
    history: async request => request.payload.beforeSeq === undefined
      ? response([event(100), event(101)], true, 101)
      : response([event(98), event(99)], true),
  }

  const result = await readSessionDelta(
    sessions,
    { sessionId: 's-1', afterSeq: 1 },
    { maxEvents: 8, scanPageMessages: 2, maxScanPages: 2 },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events, [])
  assert.equal(result.value.throughSeq, 1)
  assert.equal(result.value.lastSeq, 101)
  assert.equal(result.value.caughtUp, false)
  assert.equal(result.value.scanLimitReached, true)
})

test('snapshot excludes archived sessions and uses history tails instead of projections', async () => {
  const api = {
    sessions: {
      list: async request => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'active-projected', projections: { asOfSeq: 9, values: {} } },
              { sessionId: 'active-cold' },
              { sessionId: 'archived', projections: { asOfSeq: 20, values: {} } },
            ],
          },
        },
      }),
      history: async request => response([event(4)], false, 4),
    },
    workspace: {
      list: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: ['archived'] } },
      }),
    },
  }

  const result = await readSessionSyncSnapshot(api)

  assert.equal(result.ok, true)
  assert.equal(result.value.protocolVersion, MOBILE_SESSION_SYNC_PROTOCOL_VERSION)
  assert.equal(MOBILE_SESSION_SYNC_CAPABILITY, 'mobile-session-sync-v2')
  assert.equal(typeof result.value.snapshotId, 'string')
  assert.deepEqual(result.value.sessions, [
    { sessionId: 'active-projected', lastSeq: 4, authoritative: true },
    { sessionId: 'active-cold', lastSeq: 4, authoritative: true },
  ])
})

test('snapshot marks unreadable tails unknown instead of fabricating empty', async () => {
  const api = {
    sessions: {
      list: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [
          { sessionId: 'legacy', projections: undefined },
          { sessionId: 'healthy', projections: { asOfSeq: 7 } },
        ] } },
      }),
      history: async () => ({ result: { ok: false, error: { code: 'internal', message: 'unsupported log' } } }),
    },
    workspace: {
      list: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      }),
    },
  }
  const result = await readSessionSyncSnapshot(api)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.sessions, [
    { sessionId: 'legacy', unknown: true, authoritative: false },
    { sessionId: 'healthy', unknown: true, authoritative: false },
  ])
})

test('authoritative cold snapshot returns unknown without waiting or trusting projections', async () => {
  let scheduled = 0
  const api = {
    sessions: {
      list: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [{ sessionId: 'cold', projections: { asOfSeq: 999 } }] } },
      }),
      history: async () => { throw new Error('history must stay in the background') },
    },
    workspace: {
      list: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      }),
    },
  }
  const start = Date.now()
  const result = await readSessionSyncSnapshot(api, {
    watermarkIndex: { getWatermark: () => undefined },
    scheduleColdTail: () => { scheduled += 1 },
  })
  assert.equal(Date.now() - start < 100, true)
  assert.equal(scheduled, 1)
  assert.deepEqual(result.value.sessions, [{ sessionId: 'cold', unknown: true, authoritative: false }])
})

test('cold tail only confirms -1 for an explicit terminal empty history and never on failure', async () => {
  const terminalEmpty = await readSessionTailWatermark({ sessions: { history: async () => response([], false) } }, 'empty')
  assert.deepEqual(terminalEmpty, { kind: 'known', lastSeq: -1 })

  const failed = await readSessionTailWatermark({ sessions: { history: async () => ({ result: { ok: false, error: { code: 'internal', message: 'no read', details: {} } } }) } }, 'failed')
  assert.equal(failed.kind, 'unknown')

  const state = new MobileSessionSyncState()
  state.scheduleColdTail({ sessions: { history: async () => ({ result: { ok: false, error: { code: 'internal', message: 'no read', details: {} } } }) } }, 'failed')
  await wait(10)
  assert.equal(state.getWatermark('failed'), undefined)
  state.dispose()
})

test('mux subscribed/event watermarks are authoritative and projection frames do not advance them', () => {
  const state = new MobileSessionSyncState()
  state.updateWatermark('s-1', 4, 'history')
  const subscribed = convertMobileMuxFrame({ type: 'session/subscribed', sessionId: 's-1', lastSeq: 7 }, state)
  assert.equal(subscribed.body.lastSeq, 7)
  assert.equal(state.getWatermark('s-1').lastSeq, 7)
  convertMobileMuxFrame({ type: 'session/projection', sessionId: 's-1', key: 'title', value: { text: 'stale' }, seq: 999 }, state)
  assert.equal(state.getWatermark('s-1').lastSeq, 7)
  const event = convertMobileMuxFrame({
    type: 'session/event',
    sessionId: 's-1',
    event: { seq: 8, time: 8, type: 'future/plugin', data: { secret: 'never-wire' } },
  }, state)
  assert.deepEqual(event, { sessionId: 's-1', seq: 8, time: 8, type: 'future/plugin' })
  assert.equal(state.getWatermark('s-1').lastSeq, 8)
  state.dispose()
})

test('approval controls use indexed durable originSeq while questions state unknown origin explicitly', () => {
  const state = new MobileSessionSyncState()
  const asked = convertMobileHistoryEntry({
    event: { seq: 20, time: 20, type: 'approval/asked', data: { id: 'approval-20', toolName: 'bash', callId: 'call-20' } },
  }, 's-1', state)
  state.rememberConvertedEvent(asked)
  const approval = convertMobileMuxFrame({
    type: 'approval/requested',
    sessionId: 's-1',
    approvalId: 'approval-20',
    toolName: 'bash',
    callId: 'call-20',
  }, state, undefined, { rpcId: 'approval-rpc-20' })
  assert.equal(approval.body.approvalId, 'approval-20')
  assert.equal(approval.body.originSeq, 20)
  assert.equal(approval.body.requestRpcId, 'approval-rpc-20')
  const question = convertMobileMuxFrame({
    type: 'question/requested',
    sessionId: 's-1',
    questions: [{ id: 'q-1', question: 'Continue?' }],
  }, state, undefined, { rpcId: 'question-rpc-1' })
  assert.equal(question.body.questionRpcId, 'question-rpc-1')
  assert.equal(question.body.originSeq, null)
  state.dispose()
})

test('v3 converter preserves text/reasoning, isolates tool payloads, and serves large details by ref', async () => {
  const state = new MobileSessionSyncState({ maxInlineBytes: 16, maxDetailChunkBytes: 32 })
  const options = { ...V3_DEFAULTS, maxInlineBytes: 16, maxDetailChunkBytes: 32 }
  const longText = '正文-' + 'x'.repeat(64)
  const assistant = convertMobileHistoryEntry({
    event: {
      seq: 11,
      time: 11,
      type: 'assistant/message',
      data: {
        message: {
          id: 'm-11',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '公开推理' },
            { type: 'text', text: longText },
          ],
          source: { kind: 'assistant', privateSecret: 'drop' },
        },
        usage: { inputTokens: 1, outputTokens: 2 },
        interrupted: true,
      },
    },
  }, 's-1', state, options)
  assert.equal(assistant.body.message.content[0].text, '公开推理')
  const textBlock = assistant.body.message.content[1]
  assert.equal(textBlock.text, undefined)
  assert.equal(typeof textBlock.detailRef.field, 'string')
  assert.equal(assistant.body.message.source.privateSecret, undefined)
  const toolCallMessage = convertMobileHistoryEntry({
    event: {
      seq: 13,
      time: 13,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-13', name: 'run', arguments: JSON.stringify({ command: 'echo ok', password: 'secret' }) }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    },
  }, 's-1', state, options)
  const toolCallArgs = toolCallMessage.body.message.content[0].arguments
  assert.equal(JSON.stringify(toolCallArgs).includes('secret'), false)
  let offset = 0
  let collected = ''
  let done = false
  while (!done) {
    const detail = await readMobileV3Details(state, {
      sessionId: 's-1',
      seq: 11,
      version: textBlock.detailRef.version,
      field: textBlock.detailRef.field,
      offset,
      limit: 32,
    }, options)
    assert.equal(detail.ok, true)
    collected += detail.value.text
    offset = detail.value.nextOffset
    done = detail.value.done
  }
  assert.equal(collected, longText)

  const tool = convertMobileHistoryEntry({
    event: {
      seq: 12,
      time: 12,
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-12' },
          content: [{ type: 'text', text: 'secret tool body' }],
          rawSecret: 'must not be copied',
        },
        error: { code: 'tool-failed', name: 'Failure' },
      },
    },
    view: { for: 'result', view: { card: 'terminal', title: 'summary only' } },
  }, 's-1', state, options)
  assert.deepEqual(Object.keys(tool.body).sort(), ['callId', 'detailRef', 'failureKind', 'summary'])
  assert.equal(tool.body.callId, 'call-12')
  assert.equal(tool.body.failureKind, 'tool-failed')
  assert.equal(tool.body.rawSecret, undefined)
  state.dispose()
})

test('v3 converter preserves compaction provenance, subagent updates, and goal round caps through allowlists', () => {
  const state = new MobileSessionSyncState()
  const options = { ...V3_DEFAULTS }
  const start = convertMobileHistoryEntry({
    event: { seq: 21, time: 21, type: 'compaction/start', data: {
      compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null, secret: 'drop',
    } },
  }, 's-1', state, options)
  assert.deepEqual(start.body, { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null })

  const summary = convertMobileHistoryEntry({
    event: { seq: 22, time: 22, type: 'compaction/summary', data: {
      compactionId: 'compact-1', sourceCommandId: 'command-1', provider: 'deepseek', model: 'm',
      summary: [{ type: 'text', text: 'safe summary' }],
      rawOutput: [{ type: 'text', text: 'must not be copied' }],
      shadowedRange: { start: 2, end: 20 }, shadowedSeqs: [2, 5, 20], shadowedTokenCount: 37,
      maxTokens: 512, usage: { inputTokens: 10, outputTokens: 11 },
    } },
  }, 's-1', state, options)
  assert.equal(summary.body.compactionId, 'compact-1')
  assert.equal(summary.body.summary[0].text, 'safe summary')
  assert.deepEqual(summary.body.shadowedRange, { start: 2, end: 20 })
  assert.deepEqual(summary.body.shadowedSeqs, [2, 5, 20])
  assert.equal(summary.body.shadowedTokenCount, 37)
  assert.equal(summary.body.rawOutput, undefined)

  const checkpoint = convertMobileHistoryEntry({
    event: { seq: 23, time: 23, type: 'user/message', data: {
      id: 'checkpoint-1', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1', private: 'drop' },
    } },
  }, 's-1', state, options)
  assert.deepEqual(checkpoint.body.message.source, { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' })

  const update = convertMobileHistoryEntry({
    event: { seq: 24, time: 24, type: 'subagent/update', data: {
      agentId: 'agent-1', name: 'Research child', status: 'running', summary: 'working', hidden: 'drop',
    } },
  }, 's-1', state, options)
  assert.deepEqual(update.body, { agentId: 'agent-1', name: 'Research child', status: 'running', summary: { text: 'working' } })

  const goal = convertMobileHistoryEntry({
    event: { seq: 25, time: 25, type: 'goal/change', data: {
      goal: {
        id: 'goal-1', objective: 'finish', phase: 'active', revision: 2, maxGoalRounds: 8,
        blockedReason: { code: 'busy', message: 'later' },
      },
    } },
  }, 's-1', state, options)
  assert.equal(goal.body.goal.maxGoalRounds, 8)
  assert.equal(goal.body.goal.maxRounds, undefined)
  assert.deepEqual(goal.body.goal.blockedReason, { code: 'busy', message: 'later' })
  state.dispose()
})

test('v3 SSE waits for drain when response backpressure rejects a write', async () => {
  const handlers = new Map()
  let cleanup
  const apiProxy = {
    events: {
      mux: async function* (_request, _signal) {
        yield { payload: { type: 'session/event', sessionId: 's-1', event: { seq: 1, time: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } } } }
      },
    },
    sessions: { history: async () => response([], false) },
  }
  const ctx = {
    apiProxy,
    webServer: { register(spec) { handlers.set(spec.path, spec.handler); return () => {} } },
    effect(setup) { cleanup = setup() },
  }
  apply(ctx)
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/api/mobile/v3/events?sessionId=s-1'
  request.socket = { remoteAddress: '127.0.0.1' }
  let drained = false
  let writes = 0
  const responseStream = new EventEmitter()
  responseStream.writableEnded = false
  responseStream.destroyed = false
  responseStream.writeHead = () => {}
  responseStream.write = chunk => {
    writes += 1
    assert.equal(writes === 1 || drained, true)
    if (writes === 1) {
      setTimeout(() => { drained = true; responseStream.emit('drain') }, 20)
      return false
    }
    setTimeout(() => request.emit('close'), 5)
    return true
  }
  responseStream.end = () => { responseStream.writableEnded = true }
  const handler = handlers.get('/api/mobile/v3/events')
  assert.equal(typeof handler, 'function')
  const running = handler(request, responseStream)
  await wait(5)
  assert.equal(writes, 1)
  await running
  assert.equal(drained, true)
  assert.equal(writes >= 1, true)
  cleanup?.()
})

test('v3 history and delta use the same converter and expose unknown tail without a false caught-up state', async () => {
  const historyCalls = []
  const api = {
    sessions: {
      history: async request => {
        historyCalls.push(request.payload)
        if (request.payload.sessionId === 'known') {
          return response([
            event(2, 'assistant/message'),
            event(3, 'future/plugin'),
          ], false, 3)
        }
        return response([], true)
      },
    },
  }
  const state = new MobileSessionSyncState()
  const history = await readMobileV3History(api, { sessionId: 'known', maxMessages: 2 }, state, V3_DEFAULTS)
  assert.equal(history.ok, true)
  assert.deepEqual(history.value.events.map(item => item.seq), [2, 3])
  assert.equal(history.value.events[1].body, undefined)
  assert.equal(history.value.lastSeq, 3)
  assert.equal(state.cachedEvents('known').length, 2)

  const delta = await readMobileV3Delta(api, { sessionId: 'unknown-tail', afterSeq: -1 }, state, {
    ...V3_DEFAULTS,
    maxScanPages: 1,
  })
  assert.equal(delta.ok, true)
  assert.equal(delta.value.lastSeqKnown, false)
  assert.equal(delta.value.lastSeq, undefined)
  assert.equal(delta.value.caughtUp, false)
  assert.equal(delta.value.hasMore, false)
  assert.deepEqual(historyCalls.map(call => ({ beforeSeq: call.beforeSeq, maxMessages: call.maxMessages })), [
    { beforeSeq: undefined, maxMessages: 2 },
    { beforeSeq: undefined, maxMessages: 24 },
  ])
  state.dispose()
})

test('v3 snapshot is partial with unknown sessions and history page obeys event/byte caps without dropping a seq shell', async () => {
  const state = new MobileSessionSyncState()
  const api = {
    sessions: {
      list: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [{ sessionId: 'cold' }] } } }),
      history: async request => request.payload.sessionId === 's-1'
        ? response([event(1, 'future/plugin'), event(2, 'future/plugin')], false)
        : response([], true),
    },
    workspace: {
      list: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
    },
  }
  const snapshot = await readMobileV3Snapshot(api, state)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.value.protocolVersion, MOBILE_SESSION_V3_PROTOCOL_VERSION)
  assert.equal(snapshot.value.capability, MOBILE_SESSION_V3_CAPABILITY)
  assert.equal(snapshot.value.partial, true)
  assert.deepEqual(snapshot.value.sessions, [{ sessionId: 'cold', authoritative: false, unknown: true }])

  const page = await readMobileV3History(api, { sessionId: 's-1' }, state, {
    ...V3_DEFAULTS,
    maxEvents: 1,
    maxBytes: 32,
  })
  assert.equal(page.ok, true)
  assert.equal(page.value.events.length, 1)
  assert.equal(page.value.events[0].seq, 2)
  assert.equal(page.value.events[0].body, undefined)
  assert.equal(page.value.hasMore, true)
  assert.equal(page.value.nextBeforeSeq, 2)
  state.dispose()
})

test('bounded v3 history keeps the newest suffix and backward pagination loses no sequence', async () => {
  const state = new MobileSessionSyncState()
  const all = Array.from({ length: 340 }, (_, seq) => event(seq, 'future/plugin'))
  const api = { sessions: { history: async request => {
    const available = all.filter(item => request.payload.beforeSeq === undefined || item.event.seq < request.payload.beforeSeq)
    return response(available, false, 339)
  } } }
  let beforeSeq
  let reconstructed = []
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const page = await readMobileV3History(api, { sessionId: 's-1', ...(beforeSeq === undefined ? {} : { beforeSeq }) }, state, V3_DEFAULTS)
    assert.equal(page.ok, true)
    const seqs = page.value.events.map(item => item.seq)
    assert.equal(seqs.at(-1), beforeSeq === undefined ? 339 : beforeSeq - 1)
    assert.equal(seqs.length <= 128, true)
    reconstructed = [...seqs, ...reconstructed]
    if (!page.value.hasMore) break
    assert.equal(page.value.nextBeforeSeq, seqs[0])
    beforeSeq = page.value.nextBeforeSeq
  }
  assert.deepEqual(reconstructed, all.map(item => item.event.seq))
  state.dispose()
})

test('v3 history byte budget selects a suffix while delta keeps a prefix', async () => {
  const state = new MobileSessionSyncState()
  const all = Array.from({ length: 9 }, (_, seq) => event(seq, 'future/plugin'))
  const api = { sessions: { history: async request => response(
    all.filter(item => request.payload.beforeSeq === undefined || item.event.seq < request.payload.beforeSeq),
    false,
    8,
  ) } }
  const options = { ...V3_DEFAULTS, maxBytes: 160 }
  const history = await readMobileV3History(api, { sessionId: 's-1' }, state, options)
  assert.equal(history.ok, true)
  assert.equal(history.value.events.at(-1).seq, 8)
  assert.equal(history.value.hasMore, true)
  const delta = await readMobileV3Delta(api, { sessionId: 's-1', afterSeq: -1 }, state, options)
  assert.equal(delta.ok, true)
  assert.equal(delta.value.events[0].seq, 0)
  assert.equal(delta.value.caughtUp, false)
  assert.equal(delta.value.throughSeq, delta.value.events.at(-1).seq)
  state.dispose()
})

test('mux failure is explicit and the watcher rebuilds instead of becoming permanently inert', async () => {
  let opens = 0
  const state = new MobileSessionSyncState({ maxSubscriberQueue: 16 })
  const iterator = state.subscribe()[Symbol.asyncIterator]()
  const api = {
    events: {
      mux: async function* (_request, signal) {
        opens += 1
        if (opens === 1) throw new Error('transport down')
        yield { rpcId: 'mux-2', payload: { type: 'session/subscribed', sessionId: 's-1', lastSeq: 4 } }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    },
  }
  state.startMux(api)
  const first = await iterator.next()
  assert.equal(first.value.type, 'control/stream-error')
  assert.equal(first.value.sessionId, '')
  assert.equal(first.value.body.failureKind, 'mux-unavailable')
  const second = await iterator.next()
  assert.equal(second.value.type, 'control/session-subscribed')
  assert.equal(second.value.body.lastSeq, 4)
  assert.equal(opens >= 2, true)
  state.dispose()
})

test('subscriber overflow is bounded and terminates with a delta-resync shell', async () => {
  const state = new MobileSessionSyncState({ maxSubscriberQueue: 2, maxSubscriberBytes: 1024 * 1024 })
  const iterator = state.subscribe({ sessionId: 's-1' })[Symbol.asyncIterator]()
  state.emit({ sessionId: 's-1', seq: 1, time: 1, type: 'future/a' })
  state.emit({ sessionId: 's-1', seq: 2, time: 2, type: 'future/b' })
  state.emit({ sessionId: 's-1', seq: 3, time: 3, type: 'future/c' })
  const overflow = await iterator.next()
  assert.equal(overflow.value.type, 'control/stream-overflow')
  assert.deepEqual(overflow.value.body, { failureKind: 'subscriber-overflow', action: 'resync-delta' })
  assert.equal((await iterator.next()).done, true)
  state.dispose()
})

test('global subscriber skips cached history but replays pending controls and receives live tail', async () => {
  const state = new MobileSessionSyncState({ maxSubscriberQueue: 2 })
  for (let seq = 0; seq < 600; seq += 1) {
    state.rememberConvertedEvent({ sessionId: 's-1', seq, time: seq, type: 'future/history' })
  }
  state.emit({
    sessionId: 's-1',
    time: 600,
    type: 'control/question/requested',
    body: { questionRpcId: 'q-global', originSeq: null, questions: [] },
  })

  const iterator = state.subscribe()[Symbol.asyncIterator]()
  const pending = await iterator.next()
  assert.equal(pending.value.type, 'control/question/requested')
  assert.equal(pending.value.body.questionRpcId, 'q-global')

  state.emit({ sessionId: 's-1', seq: 600, time: 600, type: 'future/live' })
  const live = await iterator.next()
  assert.equal(live.value.type, 'future/live')
  assert.equal(live.value.seq, 600)
  await iterator.return()
  state.dispose()
})

test('session subscriber retains sinceSeq cached replay semantics', async () => {
  const state = new MobileSessionSyncState()
  for (let seq = 1; seq <= 3; seq += 1) {
    state.rememberConvertedEvent({ sessionId: 's-1', seq, time: seq, type: `future/${seq}` })
  }
  const iterator = state.subscribe({ sessionId: 's-1', sinceSeq: 1 })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.seq, 2)
  assert.equal((await iterator.next()).value.seq, 3)
  await iterator.return()
  state.dispose()
})

test('control dedupe uses stable identities and replays pending controls after reconnect', async () => {
  const state = new MobileSessionSyncState()
  const first = state.subscribe({ sessionId: 's-1' })[Symbol.asyncIterator]()
  state.emit({ sessionId: 's-1', time: 10, type: 'control/question/requested', body: { questionRpcId: 'q-1', originSeq: null, questions: [] } })
  state.emit({ sessionId: 's-1', time: 10, type: 'control/question/requested', body: { questionRpcId: 'q-2', originSeq: null, questions: [] } })
  assert.equal((await first.next()).value.body.questionRpcId, 'q-1')
  assert.equal((await first.next()).value.body.questionRpcId, 'q-2')
  await first.return()

  const replay = state.subscribe({ sessionId: 's-1' })[Symbol.asyncIterator]()
  assert.equal((await replay.next()).value.body.questionRpcId, 'q-1')
  await replay.return()
  state.emit({ sessionId: 's-1', time: 11, type: 'control/question/resolved', body: { questionRpcId: 'q-1', originSeq: null, outcome: 'answered' } })
  const afterResolved = state.subscribe({ sessionId: 's-1' })[Symbol.asyncIterator]()
  assert.equal((await afterResolved.next()).value.body.questionRpcId, 'q-2')
  const noPending = await Promise.race([
    afterResolved.next().then(() => 'unexpected'),
    wait(10).then(() => 'empty'),
  ])
  assert.equal(noPending, 'empty')
  await afterResolved.return()
  state.dispose()
})

test('cached durable events are ordered by session and seq rather than wall-clock time', () => {
  const state = new MobileSessionSyncState()
  state.rememberConvertedEvent({ sessionId: 's-1', seq: 2, time: 1, type: 'future/two' })
  state.rememberConvertedEvent({ sessionId: 's-1', seq: 1, time: 99, type: 'future/one' })
  assert.deepEqual(state.cachedEvents('s-1').map(item => item.seq), [1, 2])
  state.dispose()
})

test('queue/jobs retain safe editable/status views and projections stay allowlisted', () => {
  const state = new MobileSessionSyncState({ maxInlineBytes: 32 })
  const queue = convertMobileMuxFrame({
    type: 'session/queue',
    sessionId: 's-1',
    items: [{
      id: 'm-1', placement: 'queued', message: {
        id: 'm-1', role: 'user', content: [{ type: 'text', text: 'edit me' }],
        source: { kind: 'user', rawSecret: 'drop' },
      },
    }],
  }, state)
  assert.equal(queue.body.count, 1)
  assert.equal(queue.body.items[0].id, 'm-1')
  assert.equal(queue.body.items[0].message.source.rawSecret, undefined)
  const jobs = convertMobileMuxFrame({
    type: 'session/jobs', sessionId: 's-1', jobs: [{ id: 'bash-1', kind: 'bash', label: 'ls', status: 'running', startedAt: 1, internal: 'drop' }],
  }, state)
  assert.equal(jobs.body.jobs[0].status, 'running')
  assert.equal(jobs.body.jobs[0].internal, undefined)
  const projection = convertMobileMuxFrame({
    type: 'session/projection', sessionId: 's-1', key: 'goal', seq: 9,
    value: { goal: { id: 'g-1', objective: 'ship', phase: 'active', secret: 'drop' }, roundsStarted: 1, unknown: 'drop' },
  }, state)
  assert.equal(projection.body.value.goal.id, 'g-1')
  assert.equal(projection.body.value.unknown, undefined)
  state.dispose()
})

test('tool call details are redacted before caching and oversized detail can reload from history', async () => {
  const state = new MobileSessionSyncState({ maxInlineBytes: 4, maxDetailCacheBytes: 16 })
  const call = convertMobileHistoryEntry({
    event: { seq: 30, time: 30, type: 'tool/call', data: {
      callId: 'c-30', name: 'run', arguments: JSON.stringify({ command: 'echo ok', password: 'secret', apiKey: 'secret-2' }),
    } },
  }, 's-1', state, { ...V3_DEFAULTS, maxInlineBytes: 4 })
  const record = state.readDetail('s-1', call.body.detailRef)
  assert.equal(record.text, undefined)
  assert.equal(record.totalBytes > 16, true)
  state.setDetailLoader(async () => ({ text: '{"command":"echo ok"}', contentType: 'application/json', totalBytes: 21 }))
  const detail = await readMobileV3Details(state, {
    sessionId: 's-1', seq: 30, version: 1, field: 'tool.call.arguments', limit: 64,
  }, { ...V3_DEFAULTS, maxInlineBytes: 4 })
  assert.equal(detail.ok, true)
  assert.equal(detail.value.text.includes('secret'), false)
  state.dispose()
})

test('v3 history carries safe current projections for cold goal/todo/permission state', async () => {
  const state = new MobileSessionSyncState()
  const api = { sessions: { history: async () => response([], false, 12) } }
  const original = api.sessions.history
  api.sessions.history = async request => ({
    rpcId: request.rpcId,
    result: { ok: true, value: {
      events: [], hasMore: false, projections: {
        asOfSeq: 12,
        values: {
          goal: { goal: { id: 'g-1', objective: 'keep', phase: 'active', private: 'drop' }, roundsStarted: 2 },
          todos: [{ content: 'todo', status: 'pending', private: 'drop' }],
          permissions: { currentValue: 'workspace-write', options: [{ value: 'workspace-write', name: 'Workspace' }], private: 'drop' },
          unknownPlugin: { secret: 'drop' },
        },
      },
    },
  }})
  const result = await readMobileV3History(api, { sessionId: 's-1' }, state, V3_DEFAULTS)
  assert.equal(result.ok, true)
  assert.equal(result.value.projections.asOfSeq, 12)
  assert.equal(result.value.projections.values.goal.goal.id, 'g-1')
  assert.equal(result.value.projections.values.permissions.private, undefined)
  assert.equal(result.value.projections.values.unknownPlugin, undefined)
  void original
  state.dispose()
})
