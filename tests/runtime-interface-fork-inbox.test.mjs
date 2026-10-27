// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                               
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createForkInboxIsolationPort } from '../packages/runtime-interface/src/fork-inbox-isolation.js'
import { createSessionPersistencePort } from '../packages/runtime-interface/src/session-persistence.js'
import { apply } from '../packages/fork-inbox-guard/src/index.js'

const splice = (seq, ...ids) => ({ seq, type: 'agent/inbox/spliced', data: { inserted: ids.map(id => ({ id })) } })
function fixture({ version = '0.2.0-rc.2', restored = false, events = [splice(0, 'parent', 'reinsert'), { seq: 1, type: 'session/end-seed', data: { inherited: true } }, splice(2, 'reinsert', 'child')] } = {}) {
  let listener, closed = false, flushes = 0, reads = 0
  const removed = []
  const scope = { sessions: { async flush(value) { assert.equal(value, session); flushes++ } }, on(name, callback) { assert.equal(name, 'agent/created'); listener = callback } }
  const ctx = { inject(names, callback) { assert.deepEqual(names, ['agents', 'sessions']); callback(scope); return { dispose() { closed = true } } } }
  const session = { id: 'test-fork', inheritedEventCount: 1, firstLiveSeq: version === '0.2.0-rc.2' ? 3 : 1, firstLifecycleSeq: restored ? 3 : 1, header: { isSeeded: true, parentSession: 'parent-session' } }
  const agent = { session, inbox: { nextTurn: [{ id: 'parent' }, { id: 'reinsert' }, { id: 'child' }], nextStep: [{ id: 'parent-step' }], remove(id) { removed.push(id); return true } } }
  const port = createForkInboxIsolationPort(ctx, { upstreamVersion: version, persistence: { async readFrom(id) { assert.equal(id, session.id); reads++; return { events } } } })
  return { port, session, agent, removed, emit: () => listener({ agent }), stats: () => ({ closed, flushes, reads }) }
}

test('new fork isolation crosses the new firstLiveSeq without deleting child reinsertion', async () => {
  const h = fixture()
  let dispose
  apply({ runtimeInterface: { forkInboxIsolation: h.port }, effect(fn) { dispose = fn() } })
  await h.emit()
  await h.emit()
  assert.deepEqual(h.removed, ['parent'])
  assert.deepEqual(h.stats(), { closed: false, flushes: 1, reads: 1 })
  dispose()
  await h.emit()
  assert.equal(h.stats().closed, true)
})

test('published Web Session lifecycle and persistence read contract isolate a fresh seeded fork', async () => {
  const root = process.env.DSH_OFFICIAL_021_ROOT || process.env.DSH_WEB020_RUNTIME
  const actualVersion = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-session/package.json'), 'utf8')).version
  assert.ok(['0.2.0-rc.2', '0.2.1-rc.2'].includes(actualVersion))
  assert.ok(root, 'published runtime path is required')
  const { Session } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href)
  const events = [ { ...splice(0, 'parent'), time: 1 }, { seq: 1, time: 2, type: 'session/end-seed', data: { inherited: true } } ]
  const session = Session.create('test-fork', events, { version: 4, id: 'test-fork', createdAt: 1, isSeeded: true, parentSession: 'parent-session' }, 1)
  assert.equal(session.firstLiveSeq, 2)
  assert.equal(session.firstLifecycleSeq, 1)
  let listener, closed = 0
  const removed = []
  const persistence = createSessionPersistencePort({ service: { stat() {}, async open(id, access) {
    assert.equal(id, session.id); assert.equal(access, 'read')
    return { header: session.header, inheritedEventCount: 1, async read(offset, size) { return { events: events.slice(offset, offset + size) } }, async close() { closed++ } }
  } } })
  const scope = { sessions: { async flush(value) { assert.equal(value, session) } }, on(_, callback) { listener = callback } }
  const ctx = { inject(_, callback) { callback(scope); return { dispose() {} } } }
  const port = createForkInboxIsolationPort(ctx, { upstreamVersion: actualVersion, persistence })
  port.install(({ inheritedMessageIds }) => [...inheritedMessageIds])
  await listener({ agent: { session, inbox: { nextTurn: [{ id: 'parent' }], nextStep: [], remove(id) { removed.push(id); return true } } } })
  assert.deepEqual(removed, ['parent'])
  assert.equal(closed, 1)
})

test('restoring a seeded child does not remove its own pending messages', async () => {
  const h = fixture({ restored: true })
  h.port.install(() => { assert.fail('restore must not invoke isolation policy') })
  await h.emit()
  assert.deepEqual(h.stats(), { closed: false, flushes: 0, reads: 0 })
})

test('legacy fresh fork uses its original boundary contract', async () => {
  const h = fixture({ version: '0.1.5-rc.2' })
  h.port.install(({ inheritedMessageIds }) => [...inheritedMessageIds])
  await h.emit()
  assert.deepEqual(h.removed, ['parent'])
})

test('invalid seed or a started child turn refuses publication before input removal', async () => {
  for (const events of [[splice(0, 'parent'), splice(1, 'child')], [splice(0, 'parent'), { seq: 1, type: 'session/end-seed', data: { inherited: true } }, { seq: 2, type: 'turn/start', data: {} }]]) {
    const h = fixture({ events })
    h.port.install(({ inheritedMessageIds }) => [...inheritedMessageIds])
    await assert.rejects(h.emit(), /invalid inherited seed boundary|published after first child turn/)
    assert.deepEqual(h.removed, [])
  }
})

test('policy cannot remove an unrelated live message', async () => {
  const h = fixture()
  h.port.install(facts => { assert.deepEqual(Object.keys(facts), ['inheritedMessageIds']); return ['child'] })
  await assert.rejects(h.emit(), /unrelated message/)
  assert.deepEqual(h.removed, [])
})

test('removal failure is surfaced and teardown during an awaited read prevents late removal', async () => {
  const h = fixture()
  h.agent.inbox.remove = () => false
  h.port.install(({ inheritedMessageIds }) => [...inheritedMessageIds])
  await assert.rejects(h.emit(), /removal failed/)
  const late = fixture()
  const dispose = late.port.install(({ inheritedMessageIds }) => [...inheritedMessageIds])
  const pending = late.emit()
  dispose()
  await pending
  assert.deepEqual(late.removed, [])
})
