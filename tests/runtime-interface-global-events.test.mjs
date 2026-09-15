import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalToBrowserWire,
  canonicalToMobileHistoryEvent,
  createRuntimeInterface,
  CURRENT_RUNTIME_VERSION,
  LEGACY_RUNTIME_VERSION,
  upstreamToCanonicalWire,
} from '../packages/runtime-interface/src/index.js'
import { MobileSessionSyncState } from '../packages/mobile-stream-compat-rc1/src/index.js'

const legacyRequestHeader = {
  type: 'request/header',
  seq: 3,
  time: 30,
  data: {
    header: {
      config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      adapterDefaults: { reasoningEffort: true },
      system: 'private system prompt',
      tools: [{ name: 'private-tool' }],
    },
    reason: 'model-selection',
  },
}

for (const version of [LEGACY_RUNTIME_VERSION, CURRENT_RUNTIME_VERSION]) {
  test(`global ${version} events keep official objects inside the boundary`, () => {
    const listeners = new Map()
    const runtime = createRuntimeInterface({ sessionController: {}, workspaceController: {}, connection: {}, subagents: {}, upstreamVersion: version })
    const source = runtime.bindEventSource({ on(name, callback, options) {
      assert.deepEqual(options, { global: true })
      listeners.set(name, callback)
      return () => listeners.delete(name)
    } })
    let received
    const dispose = source.on('session/event', (...args) => { received = args }, { global: true })
    const session = { id: 's', ctx: { secret: 'private' }, snapshotEvents() { throw Error('must not read on live event') } }
    listeners.get('session/event')(session, { type: 'model/selection', seq: 8, data: { model: 'fixture' } })
    assert.deepEqual(received[0], { sessionId: 's' })
    assert.equal(received[1].type, 'model/selection')
    assert.equal(received[1].sourceSeq, 8)
    assert.equal(JSON.stringify(received).includes('private'), false)
    dispose(); assert.equal(listeners.size, 0)
  })
}

test('created packed live suffix is expanded inside the interface without exposing a Session method', () => {
  let callback, value
  const runtime = createRuntimeInterface({ sessionController: {}, workspaceController: {}, connection: {}, subagents: {} })
  runtime.bindEventSource({ on(_name, listener) { callback = listener; return () => {} } })
    .on('session/created', dto => { value = dto }, { global: true })
  callback({ id: 's', firstLiveSeq: 7, snapshotEvents(first) {
    assert.equal(first, 7)
    return [{ type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 7, time: 10, data: { turn: 1, step: 1, index: 0, dt: [2], texts: ['a', 'b'] } } }]
  } })
  assert.deepEqual(Object.keys(value).sort(), ['events', 'firstLiveSeq', 'sessionId'])
  assert.deepEqual(value.events.map(event => event.seq), [7, 8])
  assert.deepEqual(value.events.map(event => event.type), ['legacy/assistant-chunk', 'legacy/assistant-chunk'])
})

test('legacy request/header history becomes a mobile metadata event while browser bypass stays lossless', () => {
  const canonical = upstreamToCanonicalWire({ records: [{ type: 'event', event: legacyRequestHeader }] }, {
    upstreamVersion: LEGACY_RUNTIME_VERSION,
    endpoint: 'session/page',
  })
  const opaque = canonical.records[0].event
  assert.equal(opaque.type, 'legacy/request-header')
  const mobile = canonicalToMobileHistoryEvent(opaque)
  assert.equal(mobile.type, 'request/header')
  assert.deepEqual(mobile.data.header.config, legacyRequestHeader.data.header.config)
  assert.deepEqual(mobile.data.header.adapterDefaults, legacyRequestHeader.data.header.adapterDefaults)
  assert.equal(mobile.data.reason, 'model-selection')
  assert.equal(Object.hasOwn(mobile.data.header, 'system'), false)
  assert.equal(Object.hasOwn(mobile.data.header, 'tools'), false)

  const browser = canonicalToBrowserWire(opaque, LEGACY_RUNTIME_VERSION)
  assert.equal(browser.type, 'request/header')
  assert.equal(browser.data.header.system, 'private system prompt')
  assert.deepEqual(browser.data.header.tools, [{ name: 'private-tool' }])
})

test('legacy global request/header reaches the single bridge as mobile metadata without a per-session follow', () => {
  const listeners = new Map()
  let followCalls = 0
  const runtime = createRuntimeInterface({
    sessionController: { follow() { followCalls += 1 } },
    workspaceController: {},
    connection: {},
    subagents: {},
    upstreamVersion: LEGACY_RUNTIME_VERSION,
  })
  const source = runtime.bindEventSource({ on(name, listener, options) {
    assert.deepEqual(options, { global: true })
    listeners.set(name, listener)
    return () => listeners.delete(name)
  } })
  const state = new MobileSessionSyncState()
  assert.equal(state.installGlobalSessionBridge(source), true)
  try {
    listeners.get('session/event')({ id: 's' }, legacyRequestHeader)
    const [received] = state.cachedEvents('s')
    assert.equal(received.type, 'request/header')
    assert.deepEqual(received.body.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    assert.deepEqual(received.body.adapterDefaults, { reasoningEffort: true })
    assert.equal(received.body.reason, 'model-selection')
    assert.equal(followCalls, 0)
  } finally {
    state.dispose()
  }
})

test('current runtime request/header remains unchanged through the mobile boundary', () => {
  const current = upstreamToCanonicalWire({ records: [{ type: 'event', event: legacyRequestHeader }] }, {
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    endpoint: 'session/page',
  }).records[0].event
  assert.equal(current.type, 'request/header')
  assert.equal(canonicalToMobileHistoryEvent(current), current)
  assert.equal(current.data.header.system, 'private system prompt')
})
