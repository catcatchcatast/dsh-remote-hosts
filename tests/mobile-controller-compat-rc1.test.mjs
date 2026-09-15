/**
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createRuntimeInterface, upstreamToCanonicalWire } from 'dsh-runtime-interface'
import {
  MOBILE_CONTROLLER_COMPAT_METHODS,
  MOBILE_CONTROLLER_COMPAT_PATHS,
  apply,
  decodeHistoryRecords,
  mapHistoryRecords,
  readSessionHistory,
  readWorkspaceList,
} from '../packages/mobile-controller-compat-rc1/src/index.js'

class MockRequest extends EventEmitter {
  constructor(body, options = {}) {
    super()
    this.body = body
    this.method = options.method ?? 'POST'
    this.headers = options.headers ?? { 'content-type': 'application/json' }
    this.complete = true
    this.remoteAddress = options.remoteAddress ?? '127.0.0.1'
  }

  async * [Symbol.asyncIterator]() {
    if (this.body !== undefined) yield Buffer.from(this.body)
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.headersSent = false
    this.writableEnded = false
    this.statusCode = undefined
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

function event(seq, data = { marker: seq }) {
  return { type: 'event', event: { type: 'user/message', seq, time: seq * 10, data } }
}

function snapshot(cursor, records, hasMore = false) {
  return (async function * follow() {
    yield {
      type: 'snapshot',
      header: { version: 1, id: 's-1', createdAt: 1 },
      cursor,
      records,
      hasMore,
      projections: { asOfSeq: cursor, values: {} },
    }
  })()
}

function baseline(value) {
  return (async function * follow() {
    yield { type: 'baseline', value }
  })()
}

function canonicalHistoryRecords(records) {
  return upstreamToCanonicalWire(
    { records },
    { upstreamVersion: '0.1.2-rc.1', endpoint: 'session/page' },
  ).records
}

function runtimeSessionPort(sessionController) {
  return createRuntimeInterface({
    sessionController,
    workspaceController: {},
    connection: {},
    subagents: {},
  }).session
}

function runtimeWorkspacePort(workspaceController) {
  return createRuntimeInterface({
    sessionController: {},
    workspaceController,
    connection: {},
    subagents: {},
  }).workspace
}

function routeHarness(overrides = {}) {
  const routes = new Map()
  const authRequests = []
  const calls = []
  const sessionController = overrides.sessionController ?? {
    list: async request => ({ items: [{ sessionId: 's-1', updatedAt: 1, running: false, blank: true, ...request }] }),
    create: async request => ({ sessionId: request.sessionId ?? 'created', agentPreset: request.agentPreset }),
    rename: async request => ({ title: request.title, seq: 3 }),
    search: async request => ({ items: [{ sessionId: 's-1', snippet: request.query }], hasMore: false }),
    fork: async () => ({ sessionId: 'forked' }),
    follow: request => request.maxMessages === 1 ? (async function * () {
      yield { type: 'snapshot', cursor: 2, records: [], hasMore: false, projections: { asOfSeq: 2, values: { modelSelection: { next: { provider: 'p', model: 'session-model' } } } } }
    })() : snapshot(2, [event(1), event(2)]),
    page: async () => ({ records: [event(0)], hasMore: false }),
    prompt: async request => { calls.push(['prompt', request]); return { accepted: true } },
    cancel: async () => ({ accepted: true }),
    modelCatalog: async () => ({
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }],
      failures: [],
    }),
    selectModel: async request => ({ selected: request }),
    updateQueue: async () => ({ accepted: true }),
    attachment: async () => ({ attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 }, data: 'AA==' }),
    inspect: async () => ({ projections: { values: { modelSelection: { next: { provider: 'p', model: 'session-model' } } } } }),
    resolveAgent: async () => ({ agent: { id: 's-1' } }),
  }
  const workspaceController = overrides.workspaceController ?? {
    follow: signal => { assert.ok(signal); return baseline({ items: [], archivedSessionIds: [] }) },
    create: async request => ({ workspace: { workspaceId: 'w-1', path: request.path }, created: true }),
    rename: async request => ({ workspace: { workspaceId: request.workspaceId, title: request.title } }),
    delete: async () => ({ deleted: true }),
    insertBefore: async () => ({ workspaceIds: ['w-1'] }),
    insertSessionBefore: async () => ({ workspace: { workspaceId: 'w-1' } }),
    archiveSession: async () => ({ archivedSessionIds: ['s-1'] }),
  }
  const connection = {
    requestRejection(req) { authRequests.push(req); return overrides.rejection },
    authenticatedUrl: value => value,
  }
  const subagents = { remoteExportList: async () => ({ entries: [], parentAvailable: false }) }
  const runtimeInterface = createRuntimeInterface({
    upstreamVersion: overrides.upstreamVersion,
    sessionController,
    workspaceController,
    connection,
    subagents,
    agentPresets: overrides.agentPresets,
    goals: overrides.goals,
  })
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(register) { return register() },
    runtimeInterface,
    directoryPickerController: {
      list: async path => ({ path: path ?? '/home', entries: [] }),
      createDirectory: async (path, name) => `${path}/${name}`,
    },
    agents: overrides.agents ?? { list: () => [{ id: 'a-1' }] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: overrides.agentPresets,
    hostCwd: 'C:\\workspace',
    host: 'not-used',
  }
  const guarded = new Proxy(ctx, { get(target, key) {
    if (!(key in target)) throw new Error(`cannot get property ${String(key)} without inject`)
    return target[key]
  } })
  const dispose = apply(guarded, overrides.config)
  return { ctx, routes, authRequests, calls, dispose }
}

async function request(route, method, payload, rpcId = 'rpc-1') {
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
  const req = new MockRequest(body, {
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  })
  const res = new MockResponse()
  await route.handler(req, res)
  return { req, res, envelope: res.body ? JSON.parse(res.body) : undefined }
}

test('official history rows expand without rewriting sequence and preserve views', () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 4, time: 40, data: { text: 'hi' } }, view: { marker: 'v' } },
    {
      type: 'chunks',
      event: {
        type: 'chunkrow/text-chunks',
        seq: 5,
        time: 50,
        data: { turn: 1, step: 2, index: 0, dt: [3], texts: ['a', 'b'] },
      },
    },
  ]
  const canonicalRecords = canonicalHistoryRecords(records)
  const entries = mapHistoryRecords(canonicalRecords, { throughSeq: 6 })
  assert.deepEqual(entries.map(item => item.event.seq), [4, 5, 6])
  assert.deepEqual(entries.map(item => item.event.time), [40, 50, 53])
  assert.deepEqual(entries[0].view, { marker: 'v' })
  assert.equal(entries[1].event.data.chunk.type, 'text-delta')
  assert.deepEqual(decodeHistoryRecords(canonicalRecords, 6).map(item => item.event.seq), [4, 5, 6])
})

test('session.history pins follow cursor, pages beforeSeq, and closes the iterator', async () => {
  const calls = []
  let closed = false
  const controller = {
    follow(request, signal) {
      calls.push(['follow', request, signal])
      return {
        async next() {
          return { value: { type: 'snapshot', cursor: 12, records: [event(12)], hasMore: true, projections: { asOfSeq: 12, values: { x: 1 } } } }
        },
        async return() { closed = true; return { done: true } },
        [Symbol.asyncIterator]() { return this },
      }
    },
    page(request, signal) {
      calls.push(['page', request, signal])
      return { records: [event(4), { type: 'chunks', event: { type: 'chunkrow/reasoning-chunks', seq: 5, time: 50, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['r'] } } }], hasMore: false }
    },
  }
  const signal = new AbortController().signal
  const result = await readSessionHistory(runtimeSessionPort(controller), { sessionId: 's-1', beforeSeq: 8, maxMessages: 4 }, signal)
  assert.deepEqual(result.events.map(item => item.event.seq), [4, 5])
  assert.equal(result.hasMore, false)
  assert.deepEqual(result.projections.values, { x: 1 })
  assert.equal(calls[0][0], 'follow')
  assert.deepEqual(calls[0][1], { address: { kind: 'session', sessionId: 's-1' }, maxMessages: 4 })
  assert.deepEqual(calls[1][1], { address: { kind: 'session', sessionId: 's-1' }, throughSeq: 12, beforeSeq: 8, maxMessages: 4 })
  assert.equal(calls[0][2], signal)
  assert.equal(calls[1][2], signal)
  assert.equal(closed, true)
})

test('workspace.list adapts the official follow baseline and closes it', async () => {
  let closed = false
  const controller = {
    follow: signal => ({
      async next() { return { value: { type: 'baseline', value: { items: [{ workspaceId: 'w-1' }], archivedSessionIds: ['s-2'] } } } },
      async return() { closed = true },
      [Symbol.asyncIterator]() { return this },
    }),
  }
  const result = await readWorkspaceList(runtimeWorkspacePort(controller), new AbortController().signal)
  assert.deepEqual(result, { items: [{ workspaceId: 'w-1' }], archivedSessionIds: ['s-2'] })
  assert.equal(closed, true)
})

test('session.history adopts a rejected next after cancellation without unhandled rejection', async () => {
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
      readSessionHistory(runtimeSessionPort(controller), { sessionId: 's-1' }, abort.signal),
      error => error === cancellation,
    )
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.equal(closed, true)
})

test('apply registers only exact business paths and authenticates every request', async () => {
  const harness = routeHarness()
  assert.deepEqual([...harness.routes.keys()], MOBILE_CONTROLLER_COMPAT_PATHS)
  assert.deepEqual(MOBILE_CONTROLLER_COMPAT_PATHS, MOBILE_CONTROLLER_COMPAT_METHODS.map(method => `/api/${method}`))
  const host = await request(harness.routes.get('/api/host.describe'), 'host.describe', {})
  assert.equal(host.res.statusCode, 200)
  assert.equal(host.envelope.result.ok, true)
  assert.equal(host.envelope.result.value.cwd, process.cwd())
  assert.equal(host.envelope.result.value.attachedSessions, 1)
  assert.equal(harness.authRequests.length, 1)
  const denied = routeHarness({ rejection: 401 })
  const deniedResponse = new MockResponse()
  await denied.routes.get('/api/host.describe').handler(new MockRequest('{}'), deniedResponse)
  assert.equal(deniedResponse.statusCode, 401)
  assert.equal(denied.authRequests.length, 1)
})

test('host.describe reports the connected runtime through the interface for both supported versions', async () => {
  for (const upstreamVersion of ['0.1.2-rc.1', '0.1.5-rc.2']) {
    const harness = routeHarness({ upstreamVersion })
    const host = await request(harness.routes.get('/api/host.describe'), 'host.describe', {})
    assert.equal(host.res.statusCode, 200)
    assert.equal(host.envelope.result.ok, true)
    assert.equal(host.envelope.result.value.version, upstreamVersion)
    assert.equal(host.envelope.result.value.attachedSessions, 1)
  }
})

test('legacy payloads map to official controller calls, including prompt requestId', async () => {
  const calls = []
  const harness = routeHarness({
    sessionController: {
      prompt(request, signal) { calls.push(['prompt', request, signal]); return { accepted: true } },
      create(request) { calls.push(['create', request]); return { sessionId: 's-2' } },
      updateQueue(request) { calls.push(['queue', request]); return { accepted: true } },
    },
  })
  const prompt = await request(harness.routes.get('/api/session.prompt'), 'session.prompt', {
    sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }],
  }, 'android-rpc')
  assert.equal(prompt.envelope.result.value.accepted, true)
  assert.equal(calls[0][1].requestId, 'android-rpc')
  assert.equal(calls[0][1].content[0].text, 'hello')
  assert.ok(calls[0][2] instanceof AbortSignal)

  const created = await request(harness.routes.get('/api/session.create'), 'session.create', { cwd: 'C:\\tmp', sessionId: 's-2' })
  assert.equal(created.envelope.result.value.sessionId, 's-2')
  assert.deepEqual(calls[1][1], { cwd: 'C:\\tmp', sessionId: 's-2' })

  const queued = await request(harness.routes.get('/api/session.updateQueue'), 'session.updateQueue', {
    sessionId: 's-1', itemId: 'item-1', action: { kind: 'remove' },
  })
  assert.deepEqual(queued.envelope.result.value, { accepted: true })
  assert.deepEqual(calls[2][1], { sessionId: 's-1', itemId: 'item-1', action: { kind: 'remove' } })
})

test('models and agent presets preserve official data and mark missing document support', async () => {
  const selected = []
  const harness = routeHarness({
    agentPresets: {
      remoteExportList: async () => ({ presets: [{ id: 'default', trust: 'trusted', isDefault: true }], authorable: true }),
      select: async (agent, id) => { selected.push([agent, id]); return id },
    },
  })
  const models = await request(harness.routes.get('/api/session.models'), 'session.models', { sessionId: 's-1' })
  assert.equal(models.envelope.result.value.current.model, 'session-model')
  assert.equal(models.envelope.result.value.routable, true)
  const presets = await request(harness.routes.get('/api/agentPreset.list'), 'agentPreset.list', {})
  assert.equal(presets.envelope.result.value.authorable, true)
  assert.equal(presets.envelope.result.value.hasDocument, false)
  const selectedResponse = await request(harness.routes.get('/api/agentPreset.select'), 'agentPreset.select', {
    sessionId: 's-1', agentPreset: 'default',
  })
  assert.deepEqual(selectedResponse.envelope.result.value, { agentPreset: 'default' })
  assert.deepEqual(selected[0][1], 'default')
})

test('unsupported controller capabilities return a stable error without fabricating a value', async () => {
  const harness = routeHarness({ sessionController: { modelCatalog: async () => ({ groups: [] }) } })
  const result = await request(harness.routes.get('/api/session.cancel'), 'session.cancel', { sessionId: 's-1' })
  assert.equal(result.res.statusCode, 200)
  assert.equal(result.envelope.result.ok, false)
  assert.equal(result.envelope.result.error.code, 'gateway/capability-unavailable')

  const badHarness = routeHarness()
  const bad = await request(badHarness.routes.get('/api/session.history'), 'session.history', { sessionId: 's-1', beforeSeq: -1 })
  assert.equal(bad.envelope.result.ok, false)
  assert.equal(bad.envelope.result.error.code, 'gateway/bad-request')
  badHarness.dispose()
  harness.dispose()
})

test('directory operations use the official directory picker without path rewriting', async () => {
  const h = routeHarness()
  const listed = await request(h.routes.get('/api/host.listDirectory'), 'host.listDirectory', { path: '/home/test' })
  assert.equal(listed.envelope.result.value.path, '/home/test')
  const created = await request(h.routes.get('/api/host.createDirectory'), 'host.createDirectory', { path: '/home/test', name: '中文' })
  assert.equal(created.envelope.result.value.path, '/home/test/中文')
})
