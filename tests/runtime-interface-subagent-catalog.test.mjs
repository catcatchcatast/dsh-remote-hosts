import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeInterface, LEGACY_RUNTIME_VERSION, CURRENT_RUNTIME_VERSION, upstreamToCanonicalWire, canonicalToBrowserWire, canonicalToMobileHistoryEvent } from '../packages/runtime-interface/src/index.js'
import { MobileSessionSyncState, createMobileSessionEvents, readMobileV3History, convertMobileHistoryEntry } from '../packages/mobile-stream-compat-rc1/src/index.js'

const event = { type: 'subagent/catalog', seq: 37, time: 1000,
  data: { version: 0, childId: 'child-id', childCreatedAt: 999, mode: 'one-shot', label: 'Nested routing' } }
const expected = { agentId: 'child-id', childSessionId: 'child-id', name: 'Nested routing', status: 'created' }

for (const upstreamVersion of [LEGACY_RUNTIME_VERSION, CURRENT_RUNTIME_VERSION]) {
  test(`${upstreamVersion} catalog has distinct parent/child identity in snapshot, shared delta conversion and live mux`, async () => {
    const listeners = new Map()
    const runtime = createRuntimeInterface({ upstreamVersion, hostId: 'host-a',
      historyEpoch: { datasetId: 'fixture', sequenceFormatGeneration: 3, generation: 1 },
      sessionController: { async *follow() { yield { type: 'snapshot', cursor: 37, header: { id: 'parent-id' }, records: [{ type: 'event', event }], hasMore: false, assistantStream: { revision: 0 } } }, page() { throw Error('unneeded page') } },
      workspaceController: {}, connection: {}, subagents: {} })
    const state = new MobileSessionSyncState()
    const source = runtime.bindEventSource({ on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) } })
    state.installGlobalSessionBridge(source, {})
    try {
      const history = await readMobileV3History({ session: runtime.session, subagents: runtime.subagents }, { sessionId: 'parent-id' }, state)
      assert.equal(history.ok, true)
      assert.deepEqual(history.value.events[0].body, expected)
      assert.equal(history.value.events[0].sessionId, 'parent-id')
      assert.equal(history.value.events[0].sourceSeq, 37)
      const converted = convertMobileHistoryEntry({ event: upstreamToCanonicalWire(event, { upstreamVersion }) }, 'parent-id', state)
      assert.deepEqual(converted.body, expected)
      const iterator = createMobileSessionEvents(state).subscribe()[Symbol.asyncIterator]()
      const pending = iterator.next()
      listeners.get('session/event')({ id: 'parent-id' }, { ...event, seq: 38 })
      const frame = (await pending).value
      assert.equal(frame.method, 'session/event')
      assert.equal(frame.payload.sessionId, 'parent-id')
      assert.equal(frame.payload.event.type, 'subagent/update')
      assert.deepEqual(frame.payload.event.data, expected)
      await iterator.return()
    } finally { state.dispose() }
  })
  test(`${upstreamVersion} browser catalog is untouched by Android projection`, () => {
    const canonical = upstreamToCanonicalWire(event, { upstreamVersion })
    assert.deepEqual(canonicalToMobileHistoryEvent(canonical).data, expected)
    const browser = canonicalToBrowserWire(canonical, upstreamVersion)
    assert.equal(browser.type, event.type)
    assert.deepEqual(browser.data, event.data)
    assert.deepEqual(event.data, { version: 0, childId: 'child-id', childCreatedAt: 999, mode: 'one-shot', label: 'Nested routing' })
  })
}
test('malformed/unknown catalog cannot fabricate a child identity or completion', () => {
  for (const data of [{ version: 1, childId: 'other' }, { version: 0, childId: '' }, { version: 0, childId: 'bad\0id' }]) {
    const mapped = canonicalToMobileHistoryEvent({ ...event, data })
    assert.deepEqual(mapped.data, { status: 'unavailable' })
  }
  const old = { type: 'subagent/update', seq: 2, data: { agentId: 'old', status: 'completed' } }
  assert.equal(canonicalToMobileHistoryEvent(old), old)
})
