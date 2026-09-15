/**
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createRuntimeInterface } from '../packages/runtime-interface/src/index.js'
import {
  Config,
  MOBILE_SESSION_DELTA_PATH,
  MOBILE_SESSION_SYNC_DESCRIBE_PATH,
  MOBILE_SESSION_SYNC_PROTOCOL_VERSION,
  MOBILE_SESSION_SYNC_SNAPSHOT_PATH,
  apply,
  readSessionDelta,
  readSessionSyncSnapshot,
} from '../packages/mobile-session-sync-rc1/src/index.js'

function testRuntime({ sessionController = {}, workspaceController = {}, requestRejection, authRequests } = {}) {
  return createRuntimeInterface({
    sessionController,
    workspaceController,
    connection: {
      requestRejection(request) {
        authRequests?.push(request)
        return requestRejection
      },
    },
    subagents: {},
  })
}

function sessionPort(sessionController) {
  return testRuntime({ sessionController }).session
}

function event(seq, type = 'assistant/message', data = { marker: seq }) {
  return { type: 'event', event: { seq, time: seq * 10, type, data } }
}

function chunks(type, seq, time, data) {
  return { type: 'chunks', event: { type: `chunkrow/${type}-chunks`, seq, time, data } }
}

function followSnapshot(cursor, records, hasMore = false, projections = { asOfSeq: cursor, values: {} }) {
  return (async function * snapshot() {
    yield { type: 'snapshot', header: { id: 's-1' }, cursor, records, hasMore, projections }
  })()
}

test('rc1 delta expands official chunk rows, preserves sparse seq, and pins page cursor', async () => {
  const pageCalls = []
  const controller = {
    follow(request, signal) {
      assert.equal(request.address.kind, 'session')
      assert.equal(request.address.sessionId, 'sparse')
      assert.ok(signal)
      return followSnapshot(31, [
        chunks('text', 26, 100, {
          turn: 1, step: 2, index: 0, dt: [4], texts: ['hello ', 'world'],
        }),
        chunks('reasoning', 28, 110, {
          turn: 1, step: 2, index: 1, dt: [3], texts: ['think ', 'more'],
        }),
        chunks('tool-call', 30, 120, {
          turn: 1, step: 2, index: 2, id: 'call-1', name: 'lookup', dt: [2], args: ['{', '"x":1}'],
        }),
      ], true)
    },
    page(request, signal) {
      pageCalls.push({ request, signal })
      return { records: [event(10), event(20)], hasMore: false }
    },
  }

  const result = await readSessionDelta(sessionPort(controller), { sessionId: 'sparse', afterSeq: 20 })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(entry => entry.event.seq), [26, 27, 28, 29, 30, 31])
  assert.deepEqual(result.value.events.map(entry => entry.event.time), [100, 104, 110, 113, 120, 122])
  assert.equal(result.value.events[0].event.data.chunk.type, 'text-delta')
  assert.equal(result.value.events[2].event.data.chunk.type, 'reasoning-delta')
  assert.deepEqual(result.value.events[5].event.data.chunk, {
    type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: '"x":1}',
  })
  assert.equal(result.value.lastSeq, 31)
  assert.equal(result.value.caughtUp, true)
  assert.equal(pageCalls.length, 1)
  assert.equal(pageCalls[0].request.throughSeq, 31)
  assert.equal(pageCalls[0].request.beforeSeq, 26)
  assert.notEqual(pageCalls[0].request.beforeSeq, 25)
})

test('rc1 delta sorts out-of-order records and idempotently removes duplicate seq values', async () => {
  const pageCalls = []
  const controller = {
    follow(_request, signal) {
      assert.ok(signal)
      return followSnapshot(9, [event(9), event(6), event(9)], true)
    },
    page(request) {
      pageCalls.push(request)
      return { records: [event(5), event(4)], hasMore: false }
    },
  }
  const result = await readSessionDelta(sessionPort(controller), { sessionId: 's-1', afterSeq: 5 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(entry => entry.event.seq), [6, 9])
  assert.equal(pageCalls[0].beforeSeq, 6)
})

test('conflicting duplicate records request a baseline rather than choosing one payload', async () => {
  const controller = {
    follow() {
      return followSnapshot(9, [event(9, 'assistant/message', { marker: 'a' }), event(6), event(9, 'assistant/message', { marker: 'b' })], true)
    },
    page() {
      return { records: [event(5)], hasMore: false }
    },
  }
  const result = await readSessionDelta(sessionPort(controller), { sessionId: 's-1', afterSeq: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.value.baselineRequired, true)
  assert.equal(result.value.baselineReason, 'duplicate-sequence-conflict')
  assert.deepEqual(result.value.events, [])
})

test('unsupported records and a truncated opening page produce explicit baseline recovery', async () => {
  const unsupported = await readSessionDelta(sessionPort({
    follow: () => followSnapshot(4, [{ type: 'future-record', payload: 'not understood' }]),
    page: () => { throw new Error('page must not run') },
  }), { sessionId: 's-1', afterSeq: -1 })
  assert.equal(unsupported.ok, true)
  assert.equal(unsupported.value.baselineRequired, true)
  assert.equal(unsupported.value.baselineReason, 'unsupported-record')

  const truncated = await readSessionDelta(sessionPort({
    follow: () => followSnapshot(10, [event(8)], false),
    page: () => { throw new Error('page must not run') },
  }), { sessionId: 's-1', afterSeq: 5 })
  assert.equal(truncated.ok, true)
  assert.equal(truncated.value.baselineRequired, true)
  assert.equal(truncated.value.baselineReason, 'truncated-snapshot-page')
})

test('an empty page that claims more history and an unextendable cursor never drop events', async () => {
  const result = await readSessionDelta(sessionPort({
    follow: () => followSnapshot(10, [event(8), event(10)], true),
    page: () => ({ records: [], hasMore: true }),
  }), { sessionId: 's-1', afterSeq: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.value.baselineRequired, true)
  assert.equal(result.value.baselineReason, 'truncated-history-page')
})

test('a final sparse page with hasMore=false is complete even when its seq is above afterSeq', async () => {
  const result = await readSessionDelta(sessionPort({
    follow: () => followSnapshot(10, [event(8), event(10)], true),
    page: () => ({ records: [event(7)], hasMore: false }),
  }), { sessionId: 's-1', afterSeq: 5 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.events.map(entry => entry.event.seq), [7, 8, 10])
  assert.equal(result.value.baselineRequired, undefined)
})

test('official opening pages beginning at seq zero or one are complete for afterSeq=-1', async () => {
  for (const firstSeq of [0, 1]) {
    const cursor = firstSeq + 2
    const result = await readSessionDelta(sessionPort({
      follow: () => followSnapshot(cursor, [event(firstSeq), event(firstSeq + 1), event(cursor)], false),
      page: () => { throw new Error('page must not run') },
    }), { sessionId: `origin-${firstSeq}`, afterSeq: -1 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.events.map(entry => entry.event.seq), [firstSeq, firstSeq + 1, cursor])
    assert.equal(result.value.lastSeq, cursor)
    assert.equal(result.value.caughtUp, true)
    assert.equal(result.value.baselineRequired, undefined)
  }
})

test('an afterSeq ahead of the authoritative follow cursor requests a clean baseline', async () => {
  const result = await readSessionDelta(sessionPort({
    follow: () => followSnapshot(20, [event(20)], false, { asOfSeq: 20, values: { secret: 'old' } }),
    page: () => { throw new Error('page must not run') },
  }), { sessionId: 's-1', afterSeq: 100 })
  assert.equal(result.ok, true)
  assert.equal(result.value.baselineRequired, true)
  assert.equal(result.value.baselineReason, 'cursor-regressed')
  assert.equal(result.value.acknowledgedSeq, 100)
  assert.equal(result.value.throughSeq, 100)
  assert.equal(result.value.lastSeq, 20)
  assert.equal(result.value.caughtUp, false)
  assert.equal(Object.hasOwn(result.value, 'projections'), false)
})

test('controller cancellation aborts an in-flight page without returning a partial suffix', async () => {
  let pageStarted
  const started = new Promise(resolve => { pageStarted = resolve })
  const abort = new AbortController()
  const controller = {
    follow: () => followSnapshot(10, [event(10)], true),
    page: () => {
      pageStarted()
      return new Promise(() => {})
    },
  }
  const pending = readSessionDelta(sessionPort(controller), { sessionId: 's-1', afterSeq: 1 }, undefined, abort.signal)
  await started
  abort.abort(new Error('caller cancelled'))
  await assert.rejects(pending, /cancelled/)
})

test('composite rh1 session IDs are rejected before touching the controller', async () => {
  let followed = false
  await assert.rejects(
    readSessionDelta(sessionPort({
      follow: () => { followed = true; return followSnapshot(0, []) },
      page: () => ({ records: [], hasMore: false }),
    }), { sessionId: 'rh1.aGVsbG8.c2Vzc2lvbg', afterSeq: -1 }),
    /rh1 remote composite id/,
  )
  assert.equal(followed, false)
})

test('snapshot uses workspace baseline archive filtering and a follow cursor for cold sessions', async () => {
  const follows = []
  const sessionController = {
    list(request, signal) {
      assert.deepEqual(request, {})
      assert.ok(signal)
      return {
        items: [
          { sessionId: 'projected', projections: { asOfSeq: 9, values: {} } },
          { sessionId: 'cold' },
          { sessionId: 'archived', projections: { asOfSeq: 30, values: {} } },
        ],
      }
    },
    follow(request, signal) {
      follows.push({ request, signal })
      return followSnapshot(17, [event(17)], false)
    },
  }
  const workspaceController = {
    follow(signal) {
      assert.ok(signal)
      return (async function * baseline() {
        yield { type: 'baseline', value: { items: [], archivedSessionIds: ['archived'] } }
      })()
    },
  }

  const runtime = testRuntime({ sessionController, workspaceController })
  const result = await readSessionSyncSnapshot(runtime.session, runtime.workspace)
  assert.equal(result.ok, true)
  assert.equal(result.value.protocolVersion, MOBILE_SESSION_SYNC_PROTOCOL_VERSION)
  assert.deepEqual(result.value.sessions, [
    { sessionId: 'projected', lastSeq: 9 },
    { sessionId: 'cold', lastSeq: 17 },
  ])
  assert.equal(follows.length, 1)
  assert.equal(follows[0].request.address.sessionId, 'cold')
  assert.equal(follows[0].request.maxMessages, 1)
})

test('snapshot rejects a remote composite id instead of publishing it as a local session', async () => {
  await assert.rejects(
    readSessionSyncSnapshot(...(() => {
      const runtime = testRuntime({
        sessionController: {
        list: async () => ({ items: [{ sessionId: 'rh1.aA.bA' }] }),
        follow: () => followSnapshot(1, []),
        },
        workspaceController: { follow: () => (async function * () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        })() },
      })
      return [runtime.session, runtime.workspace]
    })()),
    /rh1 remote composite id/,
  )
})

class MockRequest extends EventEmitter {
  constructor(body, { method = 'GET', remoteAddress = '127.0.0.1', headers = {} } = {}) {
    super()
    this.method = method
    this.headers = headers
    this.socket = { remoteAddress }
    this.remoteAddress = remoteAddress
    this.complete = true
    this.body = Buffer.from(body)
    this.resumed = false
  }

  async *[Symbol.asyncIterator]() {
    if (this.body.byteLength > 0) yield this.body
  }

  resume() {
    this.resumed = true
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.headersSent = false
    this.writableEnded = false
    this.statusCode = undefined
    this.headers = undefined
    this.body = ''
  }

  writeHead(status, headers) {
    this.headersSent = true
    this.statusCode = status
    this.headers = headers
  }

  end(body = '') {
    this.body = String(body)
    this.writableEnded = true
  }
}

function routeHarness({ sessionController = {}, workspaceController = {}, requestRejection = undefined, config = {} } = {}) {
  const routes = new Map()
  const authRequests = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    runtimeInterface: testRuntime({ sessionController, workspaceController, requestRejection, authRequests }),
    effect(callback) {
      return callback()
    },
  }
  const dispose = apply(ctx, config)
  return { routes, authRequests, dispose }
}

test('routes keep exact paths, loopback fence, and rc1 connection authentication', async () => {
  const harness = routeHarness({ requestRejection: 401 })
  assert.deepEqual([...harness.routes.keys()], [
    MOBILE_SESSION_DELTA_PATH,
    MOBILE_SESSION_SYNC_DESCRIBE_PATH,
    MOBILE_SESSION_SYNC_SNAPSHOT_PATH,
  ])
  const unauthenticated = new MockResponse()
  await harness.routes.get(MOBILE_SESSION_SYNC_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET' }), unauthenticated)
  assert.equal(unauthenticated.statusCode, 401)
  assert.equal(harness.authRequests.length, 1)

  const forbidden = new MockResponse()
  await harness.routes.get(MOBILE_SESSION_SYNC_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET', remoteAddress: '192.0.2.4' }), forbidden)
  assert.equal(forbidden.statusCode, 403)

  harness.dispose()
})

test('authenticated describe and delta routes use bounded JSON and controller faces', async () => {
  const sessionController = {
    follow: (_request, signal) => {
      assert.ok(signal)
      return followSnapshot(2, [event(1), event(2)], false)
    },
    page: () => ({ records: [], hasMore: false }),
  }
  const harness = routeHarness({ sessionController })
  const describe = new MockResponse()
  await harness.routes.get(MOBILE_SESSION_SYNC_DESCRIBE_PATH).handler(new MockRequest('', { method: 'GET' }), describe)
  assert.equal(describe.statusCode, 200)
  assert.equal(JSON.parse(describe.body).protocolVersion, MOBILE_SESSION_SYNC_PROTOCOL_VERSION)

  const payload = JSON.stringify({
    type: 'client-request', rpcId: 'rpc-1', method: 'mobile.sessionDelta',
    payload: { sessionId: 's-1', afterSeq: 1 },
  })
  const response = new MockResponse()
  await harness.routes.get(MOBILE_SESSION_DELTA_PATH).handler(new MockRequest(payload, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
  }), response)
  const envelope = JSON.parse(response.body)
  assert.equal(response.statusCode, 200)
  assert.equal(envelope.rpcId, 'rpc-1')
  assert.deepEqual(envelope.result.value.events.map(entry => entry.event.seq), [2])

  const wrongType = new MockResponse()
  await harness.routes.get(MOBILE_SESSION_DELTA_PATH).handler(new MockRequest(payload, {
    method: 'POST', headers: { 'content-type': 'text/plain' },
  }), wrongType)
  assert.equal(wrongType.statusCode, 415)
  harness.dispose()
})

test('HTTP request body bound returns 413 and timeout returns 408 without exposing controller errors', async () => {
  const largeHarness = routeHarness({ config: { maxRequestBytes: 1024 } })
  const tooLarge = new MockResponse()
  await largeHarness.routes.get(MOBILE_SESSION_DELTA_PATH).handler(new MockRequest('{}', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '2048' },
  }), tooLarge)
  assert.equal(tooLarge.statusCode, 413)
  largeHarness.dispose()

  const timeoutHarness = routeHarness({
    config: { requestTimeoutMs: 10 },
    sessionController: {
      follow: () => (async function * hanging() { await new Promise(() => {}) })(),
      page: () => ({ records: [], hasMore: false }),
    },
  })
  const payload = JSON.stringify({
    type: 'client-request', rpcId: 'rpc-timeout', method: 'mobile.sessionDelta',
    payload: { sessionId: 's-1', afterSeq: -1 },
  })
  const timedOut = new MockResponse()
  await timeoutHarness.routes.get(MOBILE_SESSION_DELTA_PATH).handler(new MockRequest(payload, {
    method: 'POST', headers: { 'content-type': 'application/json' },
  }), timedOut)
  assert.equal(timedOut.statusCode, 408)
  timeoutHarness.dispose()

  const failureHarness = routeHarness({
    sessionController: {
      follow: () => { throw Object.assign(new Error('C:\\private\\session\\secret prompt'), { code: 'gateway/internal', details: { path: 'C:\\private' } }) },
      page: () => ({ records: [], hasMore: false }),
    },
  })
  const failurePayload = JSON.stringify({
    type: 'client-request', rpcId: 'rpc-failure', method: 'mobile.sessionDelta',
    payload: { sessionId: 's-1', afterSeq: -1 },
  })
  const failed = new MockResponse()
  await failureHarness.routes.get(MOBILE_SESSION_DELTA_PATH).handler(new MockRequest(failurePayload, {
    method: 'POST', headers: { 'content-type': 'application/json' },
  }), failed)
  assert.equal(failed.statusCode, 200)
  const failureEnvelope = JSON.parse(failed.body)
  assert.equal(failureEnvelope.result.ok, false)
  assert.equal(failureEnvelope.result.error.code, 'gateway/internal')
  assert.equal(failureEnvelope.result.error.message, 'session sync unavailable')
  assert.doesNotMatch(failed.body, /private|secret prompt/)
  failureHarness.dispose()
})

test('Config exposes the standard schema contract and rejects out-of-bound values', () => {
  const valid = Config['~standard'].validate({ maxEvents: 4 })
  assert.equal(valid.issues, undefined)
  assert.equal(valid.value.maxEvents, 4)
  const invalid = Config['~standard'].validate({ maxEvents: 0 })
  assert.ok(Array.isArray(invalid.issues))
})
