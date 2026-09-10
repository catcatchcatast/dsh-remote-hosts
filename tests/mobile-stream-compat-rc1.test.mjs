import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import {
  Config,
  MOBILE_EVENTS_HOST_PATH,
  MOBILE_EVENTS_MUX_PATH,
  MOBILE_SESSION_V3_CAPABILITY,
  MOBILE_SESSION_V3_DELTA_PATH,
  MOBILE_SESSION_V3_DESCRIBE_PATH,
  MOBILE_SESSION_V3_EVENTS_PATH,
  MOBILE_SESSION_V3_HISTORY_PATH,
  MOBILE_SESSION_V3_PROTOCOL_VERSION,
  MOBILE_SESSION_V3_SNAPSHOT_PATH,
  MobileSessionSyncState,
  apply,
  convertMobileHistoryEntry,
  readMobileV3Details,
  readMobileV3Delta,
  readMobileV3Events,
  readMobileV3History,
  readMobileV3Snapshot,
  readSessionDelta,
} from '../packages/mobile-stream-compat-rc1/src/index.js'

function event(seq, type = 'assistant/message', data = { marker: seq }) {
  return { type: 'event', event: { seq, time: seq * 10, type, data } }
}
function followSnapshot(cursor, records, hasMore = false, projections = { asOfSeq: cursor, values: {} }) {
  return (async function * snapshot() {
    yield { type: 'snapshot', header: { id: 's-1' }, cursor, records, hasMore, projections }
  })()
}

class MockRequest extends EventEmitter {
  constructor(body, { method = 'GET', remoteAddress = '127.0.0.1', headers = {}, url = '/' } = {}) {
    super(); this.method = method; this.headers = headers; this.socket = { remoteAddress }; this.remoteAddress = remoteAddress
    this.complete = true; this.body = Buffer.from(body); this.url = url
  }
  async *[Symbol.asyncIterator]() { if (this.body.byteLength) yield this.body }
  resume() {}
}
class MockResponse extends EventEmitter {
  constructor() { super(); this.headersSent = false; this.writableEnded = false; this.destroyed = false; this.body = ''; this.chunks = [] }
  writeHead(status, headers) { this.headersSent = true; this.statusCode = status; this.headers = headers }
  write(value) { this.chunks.push(String(value)); return true }
  end(value = '') { this.body = String(value); this.writableEnded = true }
}
function harness({ sessionController = {}, workspaceController = {}, subagents, interactions, requestRejection, config = {} } = {}) {
  const routes = new Map(); const authRequests = []; const listeners = new Map()
  const on = (event, listener) => {
    let bucket = listeners.get(event)
    if (!bucket) listeners.set(event, bucket = new Set())
    bucket.add(listener)
    return () => { bucket.delete(listener); if (bucket.size === 0) listeners.delete(event) }
  }
  const emit = (event, ...args) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args) }
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection(request) { authRequests.push(request); return requestRejection } },
    sessionController, workspaceController, subagents, mobileInteractions: interactions,
    on,
    provide(key, value) { this[key] = value },
    effect(fn) { return fn() },
  }
  const dispose = apply(ctx, config)
  return { routes, authRequests, dispose, ctx, emit, listeners }
}

function strictContext(values, unexpectedReads = []) {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (!Object.hasOwn(target, key)) {
        unexpectedReads.push(String(key))
        throw new Error(`unexpected un-injected context property: ${String(key)}`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
}

test('direct RC1 delta pins follow cursor, expands chunk rows, and preserves sparse order', async () => {
  const calls = []
  const controller = {
    follow: (_request, signal) => { assert.ok(signal); return followSnapshot(31, [
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 26, time: 100, data: { turn: 1, step: 2, index: 0, dt: [4], texts: ['hello ', 'world'] } } },
      { type: 'chunks', event: { type: 'chunkrow/reasoning-chunks', seq: 28, time: 110, data: { turn: 1, step: 2, index: 1, dt: [3], texts: ['think ', 'more'] } } },
      { type: 'chunks', event: { type: 'chunkrow/tool-call-chunks', seq: 30, time: 120, data: { turn: 1, step: 2, index: 2, id: 'call-1', name: 'lookup', dt: [2], args: ['{', '"x":1}'] } } },
    ], true) },
    page: (request) => { calls.push(request); return { records: [event(10), event(20)], hasMore: false } },
  }
  const result = await readSessionDelta(controller, { sessionId: 'sparse', afterSeq: 20 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(entry => entry.event.seq), [26, 27, 28, 29, 30, 31])
  assert.deepEqual(result.value.events.map(entry => entry.event.time), [100, 104, 110, 113, 120, 122])
  assert.equal(calls[0].throughSeq, 31); assert.equal(calls[0].beforeSeq, 26)
})

test('direct delta adopts a rejected next after cancellation without unhandled rejection', async () => {
  const abort = new AbortController()
  const cancellation = new Error('request cancelled')
  const queryFailure = new Error('session query failed')
  let closed = false
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  const controller = {
    follow(_request, signal) {
      assert.equal(signal, abort.signal)
      abort.abort(cancellation)
      return {
        next() { return Promise.reject(queryFailure) },
        async return() { closed = true; return { done: true } },
        [Symbol.asyncIterator]() { return this },
      }
    },
    page() { throw new Error('page must not be called after cancellation') },
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(
      readSessionDelta(controller, { sessionId: 's-1', afterSeq: 0 }, { maxEvents: 8 }, abort.signal),
      error => error === cancellation,
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.equal(closed, true)
})

test('v3 history keeps complete text/reasoning through bounded details and tool details stay lazy', async () => {
  const controller = {
    follow: () => followSnapshot(2, [
      event(1, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }, { type: 'reasoning', text: 'think hard' }] } }),
      event(2, 'tool/call', { callId: 'call-1', name: 'lookup', arguments: '{"password":"secret","x":1}' }),
    ], false),
    page: () => ({ records: [], hasMore: false }),
  }
  const state = new MobileSessionSyncState({ maxInlineBytes: 4, maxDetailChunkBytes: 8 })
  const result = await readMobileV3History(controller, { sessionId: 's' }, state, { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 4, maxDetailChunkBytes: 8, maxHistoryPages: 4 })
  assert.equal(result.ok, true)
  const message = result.value.events[0].body.message
  assert.ok(message.content[0].detailRef); assert.ok(message.content[1].detailRef)
  assert.equal(result.value.events[1].body.callId, 'call-1')
  assert.ok(result.value.events[1].body.detailRef)
  const details = await readMobileV3Details(state, { sessionId: 's', ...message.content[0].detailRef }, { maxDetailChunkBytes: 8 })
  assert.equal(details.value.text, 'hello wo'); assert.equal(details.value.done, false)
  state.dispose()
})

test('v3 history and delta use the official catalog address for subagent sessions', async () => {
  const calls = []
  const context = {
    subagents: {
      remoteExportList: async (parentSessionId, signal) => {
        calls.push({ kind: 'catalog', parentSessionId, signal })
        return {
          entries: [{ kind: 'child', id: 'child', mode: 'one-shot', activity: 'inactive', hasChildren: false }],
          parentAvailable: true,
        }
      },
    },
    sessionController: {
      list: async () => ({ items: [
        { sessionId: 'parent', origin: 'session' },
        { sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' },
      ] }),
      follow: (request, signal) => {
        calls.push({ kind: 'follow', request, signal })
        return followSnapshot(2, [event(1), event(2)], false)
      },
      page: (request) => {
        calls.push({ kind: 'page', request })
        return { records: [], hasMore: false }
      },
    },
  }
  const state = new MobileSessionSyncState()
  state.setAddressSource(context)
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const history = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(history.ok, true)
    const historyFollow = calls.find(call => call.kind === 'follow')
    assert.deepEqual(historyFollow.request.address, {
      kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot'
    })
    calls.length = 0

    const delta = await readMobileV3Delta(context, { sessionId: 'child', afterSeq: 1 }, state, options)
    assert.equal(delta.ok, true)
    const deltaFollow = calls.find(call => call.kind === 'follow')
    assert.deepEqual(deltaFollow.request.address, {
      kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot'
    })
    assert.equal(calls.filter(call => call.kind === 'catalog').length, 0)
  } finally {
    state.dispose()
  }
})

test('v3 history retries a temporarily unavailable child against a refreshed catalog', async () => {
  let catalogCalls = 0
  const context = {
    subagents: {
      remoteExportList: async () => {
        catalogCalls += 1
        return {
          entries: catalogCalls === 1 ? [] : [{ kind: 'child', id: 'child', mode: 'continuable' }],
          parentAvailable: true,
        }
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1)], false),
      page: () => ({ records: [], hasMore: false }),
    },
  }
  const state = new MobileSessionSyncState()
  state.setAddressSource(context)
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const first = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(first.ok, false)
    assert.deepEqual(first.error.details, { reason: 'unavailable' })

    const second = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(second.ok, false)
    assert.deepEqual(second.error.details, { reason: 'unavailable' })
    assert.equal(catalogCalls, 1)

    await new Promise(resolve => setTimeout(resolve, 1_010))
    const recovered = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(recovered.ok, true)
    assert.equal(catalogCalls, 2)
  } finally {
    state.dispose()
  }
})

test('v3 history preserves a catalog diagnostic entry by child id', async () => {
  let catalogCalls = 0
  const context = {
    subagents: {
      remoteExportList: async () => {
        catalogCalls += 1
        return {
          entries: [{ kind: 'diagnostic', id: 'child', reason: 'corrupt', secret: 'hidden' }],
          parentAvailable: false,
        }
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1)], false),
      page: () => ({ records: [], hasMore: false }),
    },
  }
  const state = new MobileSessionSyncState()
  state.setAddressSource(context)
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const first = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(first.ok, false)
    assert.deepEqual(first.error.details, { reason: 'corrupt' })
    const second = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(second.ok, false)
    assert.deepEqual(second.error.details, { reason: 'corrupt' })
    assert.equal(catalogCalls, 1)
  } finally {
    state.dispose()
  }
})

test('v3 history coalesces concurrent catalog refreshes for one parent', async () => {
  let catalogCalls = 0
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const context = {
    subagents: {
      remoteExportList: async () => {
        catalogCalls += 1
        if (catalogCalls === 1) return { entries: [], parentAvailable: true }
        await refreshGate
        return { entries: [{ kind: 'child', id: 'child', mode: 'continuable' }], parentAvailable: true }
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1)], false),
      page: () => ({ records: [], hasMore: false }),
    },
  }
  const state = new MobileSessionSyncState()
  state.setAddressSource(context)
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const first = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(first.ok, false)
    now += 1_001
    const pending = Promise.all([
      readMobileV3History(context, { sessionId: 'child' }, state, options),
      readMobileV3History(context, { sessionId: 'child' }, state, options),
      readMobileV3History(context, { sessionId: 'child' }, state, options),
    ])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(catalogCalls, 2)
    releaseRefresh()
    const results = await pending
    assert.deepEqual(results.map(result => result.ok), [true, true, true])
    assert.equal(catalogCalls, 2)
  } finally {
    Date.now = originalNow
    state.dispose()
  }
})

// Backend-thrown corrupt failures retain their shorter diagnostic TTL.
test('v3 catalog corrupt diagnostics expire so a repaired catalog can recover', async () => {
  let catalogCalls = 0
  const context = {
    subagents: {
      remoteExportList: async () => {
        catalogCalls += 1
        if (catalogCalls === 1) {
          const error = new Error('private catalog failure')
          error.code = 'subagent/catalog-diagnostic'
          error.details = { reason: 'corrupt', secret: 'hidden' }
          throw error
        }
        return { entries: [{ kind: 'child', id: 'child', mode: 'continuable' }], parentAvailable: true }
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1)], false),
      page: () => ({ records: [], hasMore: false }),
    },
  }
  const state = new MobileSessionSyncState()
  state.setAddressSource(context)
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const first = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(first.ok, false)
    assert.deepEqual(first.error.details, { reason: 'corrupt' })
    const cached = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(cached.ok, false)
    assert.equal(catalogCalls, 1)

    await new Promise(resolve => setTimeout(resolve, 260))
    const recovered = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(recovered.ok, true)
    assert.equal(catalogCalls, 2)
  } finally {
    state.dispose()
  }
})

test('v3 history keeps the newest tail when the page is capped', async () => {
  const controller = {
    follow: () => followSnapshot(4, [event(1), event(2), event(3), event(4)], false),
    page: () => ({ records: [], hasMore: false }),
  }
  const state = new MobileSessionSyncState()
  try {
    const result = await readMobileV3History(controller, { sessionId: 's' }, state, {
      maxEvents: 2,
      maxBytes: 64 * 1024,
      maxInlineBytes: 64 * 1024,
      maxDetailChunkBytes: 1024,
      maxHistoryPages: 4,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.events.map(item => item.seq), [3, 4])
    assert.equal(result.value.hasMore, true)
    assert.equal(result.value.nextBeforeSeq, 3)
  } finally {
    state.dispose()
  }
})

test('session-scoped follower errors request a session retry instead of Host reconnect', async () => {
  const state = new MobileSessionSyncState()
  try {
    const iterator = state.subscribe({ channel: 'v3', sessionId: 'child' })[Symbol.asyncIterator]()
    state.emitStreamError('session-follow', { code: 'session/agent-busy' }, 'child')
    const result = await iterator.next()
    assert.equal(result.value.sessionId, 'child')
    assert.equal(result.value.body.action, 'retry-session')
    assert.equal(result.value.body.source, 'session/agent-busy')
    await iterator.return?.()
  } finally {
    // Dispose also closes the iterator when an assertion rejects.
    state.dispose()
  }
})

test('background v3 events keep catalog metadata without opening per-session history followers', async () => {
  const calls = []
  const context = {
    subagents: {
      remoteExportList: async (parentSessionId) => ({
        entries: [{ kind: 'child', id: 'child', mode: 'continuable' }],
        parentAvailable: true,
      }),
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: (request, signal) => {
        calls.push({ request, signal })
        return (async function * () {
          yield { type: 'snapshot', header: { id: 's-bg' }, cursor: 0, records: [], hasMore: false, projections: { asOfSeq: 0, values: {} } }
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        })()
      },
    },
  }
  const state = new MobileSessionSyncState()
  const abort = new AbortController()
  const stream = readMobileV3Events(context, state, { channel: 'v3' }, abort.signal)
  const iterator = stream[Symbol.asyncIterator]()
  try {
    const first = iterator.next()
    const deadline = Date.now() + 500
    while (calls.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls.length, 0)
    abort.abort()
    await first
  } finally {
    abort.abort()
    await iterator.return?.()
    state.dispose()
  }
})

test('strict Cordis Context never reads plugin-private addressBook while opening streams and v3 readers', async () => {
  const records = [event(1, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'strict context detail' }] } })]
  const unexpectedReads = []
  const controller = {
    list: async () => ({ items: [{ sessionId: 's' }] }),
    follow: () => followSnapshot(1, records, false),
    page: () => ({ records, hasMore: false }),
  }
  const strict = strictContext({
    sessionController: controller,
    workspaceController: { follow: () => (async function * () { yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } } })() },
    subagents: undefined,
    mobileInteractions: undefined,
    webServer: { register() { return () => {} } },
    connection: { requestRejection() {} },
    on() { return () => {} },
    provide(key, value) { this[key] = value },
    effect(fn) { return fn() },
  }, unexpectedReads)
  const state = new MobileSessionSyncState({ maxInlineBytes: 1 })
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 1, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const history = await readMobileV3History(strict, { sessionId: 's' }, state, options)
    assert.equal(history.ok, true)
    const ref = history.value.events[0].body.message.content[0].detailRef
    assert.ok(ref)
    state.details.clear(); state.detailOrder.length = 0; state.detailBytes = 0
    const details = await readMobileV3Details(state, { sessionId: 's', ...ref }, options)
    assert.equal(details.ok, true)
    assert.equal(details.value.text, 'strict context detail')

    const snapshot = await readMobileV3Snapshot(strict, state)
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.value.sessions, [{ sessionId: 's', lastSeq: 1, authoritative: true }])

    const h = { routes: new Map(), register(route) { this.routes.set(route.path, route); return () => this.routes.delete(route.path) } }
    const streamContext = strictContext({ ...strict, webServer: h }, unexpectedReads)
    const dispose = apply(streamContext)
    try {
      for (const path of [MOBILE_SESSION_V3_EVENTS_PATH, MOBILE_EVENTS_MUX_PATH]) {
        const request = new MockRequest('', { url: path })
        const response = new MockResponse()
        const pending = h.routes.get(path).handler(request, response)
        assert.equal(response.statusCode, 200)
        request.emit('close')
        await pending
        assert.equal(response.writableEnded, true)
      }
      assert.deepEqual(unexpectedReads, [])
    } finally {
      dispose()
    }
  } finally {
    state.dispose()
  }

  const facadeCalls = []
  const facade = {
    addressBook: { resolve: async () => ({ kind: 'session', sessionId: 's' }) },
    sessionController: {
      follow: request => { facadeCalls.push(request); return followSnapshot(0, [], false) },
      page: () => ({ records: [], hasMore: false }),
    },
  }
  const facadeState = new MobileSessionSyncState()
  try {
    const result = await readMobileV3History(facade, { sessionId: 's' }, facadeState)
    assert.equal(result.ok, true)
    assert.deepEqual(facadeCalls[0].address, { kind: 'session', sessionId: 's' })
  } finally {
    facadeState.dispose()
  }
})

test('apply installs one global session bridge and forwards live events without cold followers', async () => {
  const calls = []
  const h = harness({
    subagents: {
      remoteExportList: async () => ({ entries: [{ kind: 'child', id: 'child', mode: 'continuable' }], parentAvailable: true }),
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: request => {
        calls.push(request)
        return followSnapshot(0, [], false)
      },
    },
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(calls.length, 0)
    assert.equal(h.listeners.get('session/event')?.size, 1)
    assert.equal(h.listeners.get('session/created')?.size, 1)
  } finally {
    h.dispose()
  }
})

test('created suffix is synchronous, uses firstLiveSeq and precedes the next live event', async () => {
  const state = new MobileSessionSyncState()
  const stream = state.subscribe({ sessionId: 's', channel: 'v3' })[Symbol.asyncIterator]()
  const starts = []
  try {
    const session = { id: 's', firstLiveSeq: 10, lastSeq: 999, snapshotEvents(start) {
      starts.push(start)
      return [event(10).event, event(11).event].filter(value => value.seq >= start)
    } }
    state.ingestGlobalSessionCreated(session)
    state.ingestGlobalSessionEvent(session, event(12).event)
    assert.deepEqual(starts, [10])
    assert.deepEqual([(await stream.next()).value.seq, (await stream.next()).value.seq, (await stream.next()).value.seq], [10, 11, 12])
    state.ingestGlobalSessionCreated(session)
    assert.deepEqual(starts, [10, 13])
  } finally { state.dispose() }
})

test('bad global payload stays local and does not publish a false watermark', () => {
  const state = new MobileSessionSyncState({ diagnostics: true })
  try {
    const invalid = event(10).event
    invalid.sourceEventSeqs = [1, 'invalid']
    assert.doesNotThrow(() => state.ingestGlobalSessionEvent({ id: 's' }, invalid))
    assert.equal(state.getWatermark('s'), undefined)
    state.ingestGlobalSessionEvent({ id: 's' }, event(11).event)
    assert.equal(state.getWatermark('s').lastSeq, 11)
    assert.equal(state.getDiagnostics().errorCounts['session-event'], 1)
  } finally { state.dispose() }
})

test('official history can advance a live tail but cannot regress it', () => {
  const state = new MobileSessionSyncState()
  try {
    state.updateWatermark('s', 100, 'mux')
    state.updateWatermark('s', 120, 'history')
    assert.equal(state.getWatermark('s').lastSeq, 120)
    state.updateWatermark('s', 120, 'mux')
    state.updateWatermark('s', 100, 'history')
    state.updateWatermark('s', 120, 'history')
    assert.equal(state.getWatermark('s').lastSeq, 120)
    assert.equal(state.getWatermark('s').source, 'mux')
  } finally { state.dispose() }
})

test('partial global listener installation is released and not marked running', () => {
  const state = new MobileSessionSyncState()
  let disposed = 0
  try {
    const installed = state.installGlobalSessionBridge({ on(name) {
      if (name === 'session/created') throw new Error('registration failed')
      return () => { disposed++ }
    } })
    assert.equal(installed, false)
    assert.equal(disposed, 1)
    assert.equal(state.globalEventsRunning, false)
  } finally { state.dispose() }
})

test('baseline overflow preserves bounded recent events and resumes live delivery', () => {
  const state = new MobileSessionSyncState({ maxPendingGlobalEvents: 2 })
  try {
    state.workspaceBaselineKnown = false
    for (let seq = 1; seq <= 4; seq++) state.ingestGlobalSessionEvent('s', event(seq).event)
    assert.equal(state.pendingGlobalEvents.length, 2)
    state.workspaceBaselineKnown = true
    state.flushPendingGlobalEvents()
    state.ingestGlobalSessionEvent('s', event(5).event)
    assert.equal(state.getWatermark('s').lastSeq, 5)
    assert.deepEqual(state.cachedEvents('s').map(value => value.seq), [3, 4, 5])
    state.replaceArchivedSessions(['s'])
    state.ingestGlobalSessionEvent('s', event(6).event)
    assert.equal(state.getWatermark('s').lastSeq, 5)
    state.replaceArchivedSessions([])
    assert.equal(state.getWatermark('s').lastSeq, 5)
    state.ingestGlobalSessionEvent('s', event(7).event)
    assert.equal(state.getWatermark('s').lastSeq, 7)
  } finally { state.dispose() }
})

test('background catalog success does not restart a 100ms polling loop', async () => {
  let catalogCalls = 0
  const state = new MobileSessionSyncState({ diagnostics: true })
  try {
    state.startBackground({
      list: async () => {
        catalogCalls += 1
        return { items: [] }
      },
      follow: () => followSnapshot(-1, [], false),
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(catalogCalls, 1)
    assert.deepEqual(state.getDiagnostics(), {
      clientCount: 0,
      activeBootstrap: 0,
      maxBootstrap: 0,
      bootstrapTotal: 0,
      catalogCalls: 1,
      errorCounts: {},
    })
  } finally {
    state.dispose()
  }
})

test('background catalog never opens a per-session full-history follower', async () => {
  let followCalls = 0
  const state = new MobileSessionSyncState({ diagnostics: true })
  try {
    state.startBackground({
      list: async () => ({ items: [{ sessionId: 's' }] }),
      follow: () => {
        followCalls += 1
        return followSnapshot(0, [], false)
      },
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(followCalls, 0)
    assert.equal(state.getDiagnostics().bootstrapTotal, 0)
  } finally {
    state.dispose()
  }
})

test('on-demand history bootstrap is capped at two per Host and serialized per session', async () => {
  const sessionIds = ['s-1', 's-2', 's-3', 's-4']
  const release = new Map()
  const followCalls = []
  let controlStarted = false
  const state = new MobileSessionSyncState({ diagnostics: true })
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 64 * 1024, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    state.startBackground({
      sessionController: {
        list: async () => ({ items: [] }),
        control: signal => {
          controlStarted = true
          return (async function * () {
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
          })()
        },
      },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(controlStarted, true)
    const controller = {
      follow: (request) => {
        const sessionId = request.address.sessionId
        followCalls.push(sessionId)
        let resolveGate
        const gate = new Promise(resolve => { resolveGate = resolve })
        release.set(sessionId, resolveGate)
        return (async function * () {
          if (sessionIds.indexOf(sessionId) < 2) await gate
          yield { type: 'snapshot', cursor: 0, records: [], hasMore: false, projections: { asOfSeq: 0, values: {} } }
        })()
      },
      page: () => ({ records: [], hasMore: false }),
    }
    const pending = sessionIds.map(sessionId => readMobileV3History(controller, { sessionId }, state, options))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(followCalls, ['s-1', 's-2'])
    assert.deepEqual(state.getDiagnostics(), {
      clientCount: 0,
      activeBootstrap: 2,
      maxBootstrap: 2,
      bootstrapTotal: 2,
      catalogCalls: 1,
      errorCounts: {},
    })

    release.get('s-1')()
    release.get('s-2')()
    await Promise.all(pending)
    assert.deepEqual(followCalls, ['s-1', 's-2', 's-3', 's-4'])
    assert.equal(state.getDiagnostics().maxBootstrap, 2)
    assert.equal(state.getDiagnostics().bootstrapTotal, 4)
  } finally {
    state.dispose()
  }
})

test('background diagnostics are opt-in and contain only numeric counters', () => {
  const disabled = new MobileSessionSyncState()
  const enabled = new MobileSessionSyncState({ diagnostics: true })
  try {
    assert.equal(disabled.getDiagnostics(), undefined)
    assert.deepEqual(enabled.getDiagnostics(), {
      clientCount: 0,
      activeBootstrap: 0,
      maxBootstrap: 0,
      bootstrapTotal: 0,
      catalogCalls: 0,
      errorCounts: {},
    })
  } finally {
    disabled.dispose()
    enabled.dispose()
  }
})

test('cancelling a queued session read does not cancel the active read or another session', async () => {
  const state = new MobileSessionSyncState({ diagnostics: true })
  try {
    const first = await state.acquireBootstrap(undefined, 'same')
    const abort = new AbortController()
    const queued = state.acquireBootstrap(abort.signal, 'same')
    const rejected = assert.rejects(queued)
    const other = await state.acquireBootstrap(undefined, 'other')
    abort.abort()
    await rejected
    assert.equal(state.getDiagnostics().activeBootstrap, 2)
    let granted = false
    const next = state.acquireBootstrap(undefined, 'same').then(release => { granted = true; return release })
    other()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(granted, false)
    first()
    const release = await next
    release()
    assert.equal(state.getDiagnostics().activeBootstrap, 0)
  } finally { state.dispose() }
})

test('lazy detail reads use the same official subagent address', async () => {
  const pageCalls = []
  const context = {
    subagents: {
      remoteExportList: async () => ({ entries: [{ kind: 'child', id: 'child', mode: 'one-shot' }], parentAvailable: true }),
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1, 'tool/call', { callId: 'call-1', name: 'read', arguments: '{"secret":"hidden","path":"src/main.c"}' })], false),
      page: request => {
        pageCalls.push(request)
        return { records: [event(1, 'tool/call', { callId: 'call-1', name: 'read', arguments: '{"secret":"hidden","path":"src/main.c"}' })], hasMore: false }
      },
    },
  }
  const state = new MobileSessionSyncState({ maxInlineBytes: 1 })
  state.setAddressSource(context)
  try {
    const options = { maxEvents: 8, maxBytes: 64 * 1024, maxInlineBytes: 1, maxDetailChunkBytes: 1024, maxHistoryPages: 4 }
    const history = await readMobileV3History(context, { sessionId: 'child' }, state, options)
    assert.equal(history.ok, true)
    const ref = history.value.events[0].body.detailRef
    assert.ok(ref)
    state.details.clear()
    state.detailOrder.length = 0
    state.detailBytes = 0
    const details = await readMobileV3Details(state, { sessionId: 'child', ...ref }, { ...options, maxDetailChunkBytes: 1024 })
    assert.equal(details.ok, true)
    assert.equal(pageCalls[0].address.kind, 'subagent')
    assert.deepEqual(pageCalls[0].address, {
      kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot'
    })
    assert.doesNotMatch(details.value.text, /hidden/)
  } finally {
    state.dispose()
  }
})

test('unknown durable sequence is explicit and never silently converted to seq zero', () => {
  const state = new MobileSessionSyncState()
  assert.throws(() => convertMobileHistoryEntry({ event: { type: 'assistant/message', time: 1, data: {} } }, 's', state), /unknown-sequence/)
  state.updateWatermark('s', Number.MAX_SAFE_INTEGER + 1, 'mux')
  assert.equal(state.getWatermark('s'), undefined)
  state.dispose()
})

test('v3 snapshot uses explicit pending watermarks and excludes archived sessions', async () => {
  const state = new MobileSessionSyncState()
  let followed = 0
  const context = {
    sessionController: { list: async () => ({ items: [{ sessionId: 'cold', projections: { asOfSeq: 999 } }, { sessionId: 'archived' }] }), follow: () => { followed += 1; return followSnapshot(9, [], false) } },
    workspaceController: { follow: () => (async function * () { yield { type: 'baseline', value: { items: [], archivedSessionIds: ['archived'] } } })() },
  }
  const result = await readMobileV3Snapshot(context, state)
  assert.equal(result.ok, true); assert.equal(followed, 0)
  assert.deepEqual(result.value.sessions, [{ sessionId: 'cold', authoritative: false, unknown: true, pending: true }])
  assert.equal(Object.hasOwn(result.value.sessions[0], 'lastSeq'), false)
  state.dispose()
})

test('apply registers authenticated v3 and compatibility SSE route families without apiProxy', () => {
  const h = harness({ requestRejection: 401 })
  assert.deepEqual([...h.routes.keys()], [MOBILE_SESSION_V3_DESCRIBE_PATH, MOBILE_SESSION_V3_SNAPSHOT_PATH, MOBILE_SESSION_V3_DELTA_PATH, MOBILE_SESSION_V3_HISTORY_PATH, '/api/mobile/v3/events', '/api/mobile/v3/details', MOBILE_EVENTS_MUX_PATH, MOBILE_EVENTS_HOST_PATH])
  const response = new MockResponse()
  h.routes.get(MOBILE_SESSION_V3_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET' }), response)
  assert.equal(response.statusCode, 401); assert.equal(h.authRequests.length, 1)
  const forbidden = new MockResponse()
  h.routes.get(MOBILE_SESSION_V3_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET', remoteAddress: '192.0.2.4' }), forbidden)
  assert.equal(forbidden.statusCode, 403)
  h.dispose()
})

test('describe route advertises v3 limits and direct delta request uses controller faces', async () => {
  const h = harness({ config: { v3MaxEvents: 3, v3MaxBytes: 2048 }, sessionController: { follow: () => followSnapshot(2, [event(1), event(2)], false), page: () => ({ records: [], hasMore: false }) } })
  const describe = new MockResponse()
  await h.routes.get(MOBILE_SESSION_V3_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET' }), describe)
  const advertised = JSON.parse(describe.body); assert.equal(advertised.protocolVersion, MOBILE_SESSION_V3_PROTOCOL_VERSION); assert.equal(advertised.capability, MOBILE_SESSION_V3_CAPABILITY)
  assert.equal(advertised.limits.maxEvents, 3); assert.equal(advertised.limits.maxBytes, 2048)
  const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'mobile.v3.delta', payload: { sessionId: 's', afterSeq: 1 } })
  const response = new MockResponse()
  await h.routes.get(MOBILE_SESSION_V3_DELTA_PATH).handler(new MockRequest(body, { method: 'POST', headers: { 'content-type': 'application/json' } }), response)
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).rpcId, 'rpc-1'); assert.deepEqual(JSON.parse(response.body).result.events.map(e => e.seq), [2])
  h.dispose()
})

test('v3 history HTTP errors preserve safe catalog diagnostics and remove secret fields', async () => {
  const h = harness({
    subagents: {
      remoteExportList: async () => {
        const error = new Error('catalog backend leaked detail')
        error.code = 'subagent/catalog-diagnostic'
        error.details = { reason: 'corrupt', secret: 'do-not-send' }
        throw error
      },
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'parent' }] }),
      follow: () => followSnapshot(1, [event(1)], false),
      page: () => ({ records: [], hasMore: false }),
    },
  })
  try {
    const request = new MockRequest(JSON.stringify({ type: 'client-request', rpcId: 'history-rpc', payload: { sessionId: 'child' } }), {
      method: 'POST', headers: { 'content-type': 'application/json' },
    })
    const response = new MockResponse()
    await h.routes.get(MOBILE_SESSION_V3_HISTORY_PATH).handler(request, response)
    const body = JSON.parse(response.body)
    assert.equal(response.statusCode, 400)
    assert.deepEqual(body.result.error, {
      code: 'subagent/catalog-diagnostic',
      message: 'session unavailable',
      details: { reason: 'corrupt' },
    })
    assert.doesNotMatch(response.body, /do-not-send|catalog backend leaked detail/)
  } finally {
    h.dispose()
  }
})

test('interaction bridge snapshot and realtime frames map eventId identity exactly without history inference', async () => {
  let listener
  const interaction = {
    snapshot: () => [{ type: 'server-request', rpcId: 'q-1', method: 'question/requested', payload: { sessionId: 's', questions: [{ question: 'continue?' }] } }],
    subscribe: fn => { listener = fn; return () => { listener = undefined } },
  }
  const state = new MobileSessionSyncState()
  state.attachInteractions(interaction)
  assert.deepEqual(state.snapshot(), [{ type: 'server-request', rpcId: 'q-1', method: 'question/requested', payload: { sessionId: 's', questionRpcId: 'q-1', questions: [{ question: 'continue?' }] } }])
  const iterator = state.subscribe({ sessionId: 's' })[Symbol.asyncIterator]()
  const initial = await iterator.next(); assert.equal(initial.value.serverRequest.rpcId, 'q-1')
  listener({ type: 'server-request', rpcId: 'wire-random', method: 'question/resolved', payload: { sessionId: 's', questionRpcId: 'q-1' } })
  const resolved = await iterator.next(); assert.equal(resolved.value.serverRequest.payload.questionRpcId, 'q-1')
  assert.deepEqual(state.snapshot(), [])
  state.dispose()
})

test('real node HTTP SSE flushes an idle handshake and releases its subscriber on disconnect', async (t) => {
  const originalSubscribe = MobileSessionSyncState.prototype.subscribe
  let subscribeCalls = 0
  let activeSubscribers = 0
  let releasedSubscribers = 0
  MobileSessionSyncState.prototype.subscribe = function (...args) {
    subscribeCalls += 1
    const subscription = originalSubscribe.apply(this, args)
    const iterator = subscription[Symbol.asyncIterator]()
    let released = false
    const release = () => {
      if (!released) {
        released = true
        activeSubscribers -= 1
        releasedSubscribers += 1
      }
    }
    activeSubscribers += 1
    return {
      [Symbol.asyncIterator]() {
        return {
          next: (...nextArgs) => iterator.next(...nextArgs),
          return: async (...returnArgs) => {
            release()
            return iterator.return?.(...returnArgs) ?? { done: true, value: undefined }
          },
        }
      },
    }
  }
  t.after(() => { MobileSessionSyncState.prototype.subscribe = originalSubscribe })

  const h = harness({ sessionController: {}, workspaceController: {} })
  let handlerDone = false
  let handlerFailure
  const server = http.createServer((req, res) => {
    const route = h.routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).then(
      () => { handlerDone = true },
      (error) => {
        handlerFailure = error
        handlerDone = true
        if (!res.headersSent) res.writeHead(500)
        if (!res.writableEnded) res.end()
      },
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    h.dispose()
    await new Promise((resolve) => server.close(() => resolve()))
  })

  const port = server.address().port
  for (const path of [MOBILE_SESSION_V3_EVENTS_PATH, MOBILE_EVENTS_MUX_PATH, MOBILE_EVENTS_HOST_PATH]) {
    handlerDone = false
    handlerFailure = undefined
    const callsBefore = subscribeCalls
    const releasedBefore = releasedSubscribers
    const client = http.get({ host: '127.0.0.1', port, path })
    client.on('error', () => {})
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`idle SSE handshake timed out: ${path}`)), 1000)
      client.once('response', (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      client.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    response.resume()
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'] ?? '', /^text\/event-stream/)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(handlerFailure, undefined)
    assert.equal(handlerDone, false)
    assert.equal(subscribeCalls, callsBefore + 1)
    assert.equal(activeSubscribers, 1)

    client.destroy()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE disconnect did not release subscriber: ${path}`)), 1000)
      const check = () => {
        if (handlerDone && activeSubscribers === 0) {
          clearTimeout(timer)
          resolve()
        } else setTimeout(check, 5)
      }
      check()
    })
    assert.equal(handlerFailure, undefined)
    assert.equal(releasedSubscribers, releasedBefore + 1)
    assert.equal(subscribeCalls, callsBefore + 1)
  }
})

test('control baseline projects values under one authoritative asOfSeq', async () => {
  const state = new MobileSessionSyncState()
  const iterator = state.subscribe({ sessionId: 's', channel: 'mux' })[Symbol.asyncIterator]()
  try {
    state.ingestControlFrame({
      type: 'baseline',
      value: {
        queues: {},
        jobs: {},
        projections: {
          s: {
            asOfSeq: 42,
            values: {
              title: 'A title',
              sessionStats: { turns: 3 },
              running: true,
            },
          },
        },
      },
    })
    const first = await iterator.next()
    const second = await iterator.next()
    assert.equal(first.value.type, 'control/session-projection')
    assert.equal(first.value.sessionId, 's')
    assert.equal(first.value.body.key, 'title')
    assert.equal(first.value.body.seq, 42)
    assert.equal(first.value.body.value, 'A title')
    assert.equal(second.value.type, 'control/session-projection')
    assert.equal(second.value.body.key, 'sessionStats')
    assert.equal(second.value.body.seq, 42)
    assert.deepEqual(second.value.body.value, { turns: 3 })
  } finally {
    state.dispose()
  }
})

test('direct control projection keeps the local session/projection discriminator', async () => {
  const state = new MobileSessionSyncState()
  const iterator = state.subscribe({ sessionId: 's', channel: 'mux' })[Symbol.asyncIterator]()
  try {
    state.ingestControlFrame({ type: 'projection', sessionId: 's', key: 'title', value: 'updated', seq: 7 })
    const result = await Promise.race([
      iterator.next(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100)),
    ])
    assert.equal(result.timeout, undefined)
    assert.equal(result.value.type, 'control/session-projection')
    assert.equal(result.value.body.key, 'title')
    assert.equal(result.value.body.seq, 7)
    assert.equal(result.value.body.value, 'updated')
  } finally {
    state.dispose()
  }
})

test('workspace and api-session/status frames stay on events.host, while v3 keeps global errors', async () => {
  const state = new MobileSessionSyncState()
  const host = state.subscribe({ channel: 'host' })[Symbol.asyncIterator]()
  const v3 = state.subscribe({ channel: 'v3' })[Symbol.asyncIterator]()
  const mux = state.subscribe({ channel: 'mux' })[Symbol.asyncIterator]()
  try {
    state.emit({
      sessionId: '',
      time: 1,
      type: 'control/workspace-update',
      body: { type: 'upsert' },
      hostFrame: { type: 'upsert', workspaceId: 'w-1' },
    })
    state.emit({
      sessionId: 's',
      time: 2,
      type: 'control/session-status',
      body: { running: false },
      hostFrame: { type: 'api-session/status', sessionId: 's', running: false },
    })
    state.emit({ sessionId: '', time: 3, type: 'control/stream-error', body: { failureKind: 'test' } })

    const hostWorkspace = await host.next()
    const hostStatus = await host.next()
    assert.equal(hostWorkspace.value.hostFrame.type, 'upsert')
    assert.equal(hostStatus.value.hostFrame.type, 'api-session/status')
    assert.equal((await v3.next()).value.type, 'control/stream-error')
    assert.equal((await mux.next()).value.type, 'control/stream-error')

    const noV3HostFrame = await Promise.race([
      v3.next(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 50)),
    ])
    assert.equal(noV3HostFrame.timeout, true)
  } finally {
    state.dispose()
  }
})

test('official api-session/status is exposed as an events.host refresh signal', async () => {
  const h = harness()
  const request = new MockRequest('', { method: 'GET', url: MOBILE_EVENTS_HOST_PATH })
  const response = new MockResponse()
  const handlerPromise = h.routes.get(MOBILE_EVENTS_HOST_PATH).handler(request, response)
  try {
    await new Promise(resolve => setImmediate(resolve))
    h.emit('api-session/status', 's', false)
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1000
      const check = () => {
        if (response.chunks.length > 0) return resolve()
        if (Date.now() >= deadline) return reject(new Error('status host frame was not delivered'))
        setTimeout(check, 5)
      }
      check()
    })
    const frame = JSON.parse(response.chunks[0].replace(/^data: /, '').trim())
    assert.deepEqual(frame, {
      type: 'server-request',
      rpcId: 'mobile-host-stream',
      method: 'api-session/status',
      payload: { sessionId: 's', running: false },
    })
  } finally {
    request.emit('close')
    await handlerPromise
    h.dispose()
  }
})
test('surface metadata retains source identity including an explicitly empty source list', () => {
  const state = new MobileSessionSyncState()
  try {
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      for (const sources of [[], [1, 2]]) {
        const entry = event(9, type, {})
        entry.event.sourceEventSeqs = sources
        entry.event.surfaceOp = { op: 'replace', start: 1, end: 8 }
        const result = convertMobileHistoryEntry(entry, 's', state)
        assert.deepEqual(result.body.sourceEventSeqs, sources)
        assert.deepEqual(result.body.surfaceOp, entry.event.surfaceOp)
      }
    }
    const entry = event(9)
    entry.event.surfaceOp = 'append'
    assert.equal(convertMobileHistoryEntry(entry, 's', state).body.surfaceOp, 'append')
    assert.equal(Object.hasOwn(convertMobileHistoryEntry(event(9), 's', state).body ?? {}, 'sourceEventSeqs'), false)
  } finally { state.dispose() }
})

test('surface sources are never truncated or filtered into a different identity', () => {
  const state = new MobileSessionSyncState()
  try {
    const entry = event(5000)
    entry.event.sourceEventSeqs = Array.from({ length: 4500 }, (_, i) => i)
    assert.equal(convertMobileHistoryEntry(entry, 's', state).body.sourceEventSeqs.length, 4500)
    entry.event.sourceEventSeqs = [1, '2']
    assert.throws(() => convertMobileHistoryEntry(entry, 's', state), /unknown-source-sequence/)
  } finally { state.dispose() }
})
test('in-process session events reuse mux framing and release on abort', async () => {
  const module = await import('../packages/mobile-stream-compat-rc1/src/index.js')
  assert.equal(typeof module.createMobileSessionEvents, 'function')
  const state = new MobileSessionSyncState()
  const abort = new AbortController()
  const events = module.createMobileSessionEvents(state).subscribe({ sessionId: 's', signal: abort.signal })
  const pending = events.next()
  state.emit({ sessionId: 's', seq: 3, type: 'assistant/message', body: { message: { content: [] }, sourceEventSeqs: [1], surfaceOp: 'append' } })
  const frame = (await pending).value
  assert.equal(frame.method, 'session/event')
  assert.deepEqual(frame.payload.event.sourceEventSeqs, [1])
  const idle = events.next()
  abort.abort()
  assert.equal((await idle).done, true)
  state.dispose()
})
