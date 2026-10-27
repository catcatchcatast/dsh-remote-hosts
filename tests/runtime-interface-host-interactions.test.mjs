// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                           
                                                                                                                                             
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { decodeBrowserInteractionResult, createHostInteractionSource, createInteractionPeerClient, registerHostInteractionProtocol, INTERACTION_READ, INTERACTION_RESPOND } from '../packages/runtime-interface/src/host-interactions.js'
import { HostInteractionState } from '../packages/mobile-interactions-compat-rc1/src/host-interaction-state.js'
import { BrowserHostHub, encodeCompositeId } from '../packages/browser-host-hub-rc1/src/index.js'
import { InteractionView } from '../packages/browser-host-hub-rc1/src/interaction-view.js'
                                                                                                                                                       

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const untilAbort = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
const item = id => ({ id, kind: 'question', sessionId: 's1', request: { questions: [{ id: 'q1', question: 'Choose', options: [] }] } })
const pending = id => ({ type: 'pending', interaction: item(id) })
const answer = { kind: 'result', value: { answers: [{ questionId: 'q1', text: 'answer' }] } }

test('interface classifies browser receipts without treating a decline as a business answer', () => {
  for (const [kind, decision] of [['next', 'defer'], ['result', 'answer'], ['rejected', 'reject']]) {
    const outcome = { kind, value: 'example' }
    assert.deepEqual(decodeBrowserInteractionResult({ args: { clientId: 'c', eventId: 'e', outcome } }), { clientId: 'c', eventId: 'e', outcome, decision })
  }
  for (const args of [undefined, [], { clientId: 'c', eventId: 'e', outcome: {} }, { clientId: 'c', eventId: 'e', outcome: { kind: 'constructor' } }]) {
    assert.throws(() => decodeBrowserInteractionResult({ args }), { code: 'INTERACTION_BROWSER_RESULT_INVALID' })
  }
})

test('unhandled presentation retries with capped backoff and preserves identity', () => {
  let now = 0
  const state = new HostInteractionState({ runtimeEpoch: 'epoch', ownerId: 'owner' })
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  const view = new InteractionView({ hostId: 'ubuntu', codec: { encodeCompositeId }, mappings: new Map(), now: () => now })
  const first = view.accept(state.snapshot())[0]
  assert.deepEqual(view.accept(state.snapshot()), []) // Still displayed: no repeated card.
  for (let retry = 0; retry < 3; retry++) {
    assert.equal(view.defer(first.eventId).phase, 'interaction_deferred')
    assert.equal(view.defer(first.eventId), undefined) // Duplicate receipt cannot consume budget.
    now += 1000 * 2 ** retry - 1
    assert.deepEqual(view.accept(state.snapshot()), [])
    now++
    assert.deepEqual(view.accept(state.snapshot()), [first])
  }
  assert.equal(view.defer(first.eventId).phase, 'interaction_deferred')
  now += 7999
  assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(view.defer(first.eventId), undefined)
  now++
  assert.deepEqual(view.accept(state.snapshot()), [first])
  assert.equal(view.defer(first.eventId).phase, 'interaction_deferred')
  assert.equal(state.snapshot().pending.length, 1) // Presentation deferral never cancels the business question.
})

test('declined cards are not retried while unconfirmed or after authoritative removal', () => {
  let now = 0
  const state = new HostInteractionState({ runtimeEpoch: 'epoch', ownerId: 'owner' })
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  const view = new InteractionView({ hostId: 'ubuntu', codec: { encodeCompositeId }, mappings: new Map(), now: () => now })
  const first = view.accept(state.snapshot())[0]
  view.defer(first.eventId); now = 1000
  state.disconnected()
  assert.deepEqual(view.accept(state.snapshot()), [])
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  assert.deepEqual(view.accept(state.snapshot()), [first])
  view.defer(first.eventId)
  state.accept({ type: 'resolved', id: 'one', reason: 'resolved' })
  assert.deepEqual(view.accept(state.snapshot()), [{ type: 'cancel', eventId: first.eventId }])
  now = 100000
  assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(view.defer(first.eventId), undefined)
})

test('Hub restores only the declining browser without restarting or replaying writes', { timeout: 5000 }, async () => {
  const state = new HostInteractionState({ runtimeEpoch: 'epoch', ownerId: 'owner' })
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  let opens = 0, writes = 0
  const events = []
  const carrier = {
    async call(endpoint) {
      if (endpoint === INTERACTION_READ) { await pause(10); return { ok: true, value: state.snapshot() } }
      writes++; throw new Error('No write expected')
    },
    async *open(endpoint, payload, signal) {
      assert.equal(endpoint, '$events')
      yield { type: 'ready', clientId: `core-${++opens}`, host: { home: '/example' } }
      await untilAbort(signal)
    },
  }
  const hub = new BrowserHostHub({ perHost: { ubuntu: carrier }, runtimeInterface: {
    wrapHostCarrier: input => input.carrier, encodeBrowser: value => value,
    diagnostics: { record: row => events.push(row) },
  } })
  // Supply the stable carrier face; ordinary official results are not used by this fixture.
  carrier.runtimeInterfaceCarrier = true
  carrier.interactions = { read: async () => (await carrier.call(INTERACTION_READ)).value, respond: async () => { writes++; return { accepted: true } } }
  const a = new AbortController(), b = new AbortController()
  const x = hub.openStream('$events', { args: {} }, a.signal), y = hub.openStream('$events', { args: {} }, b.signal)
  try {
    const ready = (await x.next()).value; await y.next()
    const first = (await x.next()).value, other = (await y.next()).value
    assert.equal(first.eventId, other.eventId)
    const otherNext = y.next()
    const receipt = await hub.call('$events/result', { args: { clientId: ready.clientId, eventId: first.eventId, outcome: { kind: 'next' } } })
    assert.equal(receipt.ok, true)
    const retry = await Promise.race([x.next(), pause(2000).then(() => { throw new Error('Declined question was not redelivered') })])
    assert.deepEqual(retry.value, first)
    const marker = Symbol()
    assert.equal(await Promise.race([otherNext, pause(30).then(() => marker)]), marker)
    assert.equal(opens, 2)
    assert.equal(writes, 0)
    assert.equal(state.snapshot().pending.length, 1)
    assert.equal(events.filter(row => row.phase === 'interaction_deferred').length, 1)
    assert.deepEqual(events.filter(row => row.phase === 'interaction_delivery' && row.hostId === 'ubuntu').map(row => row.count).sort(), [1, 1, 2])
    const accepted = await hub.call('$events/result', { args: { clientId: ready.clientId, eventId: first.eventId, outcome: answer } })
    assert.equal(accepted.ok, true)
    await hub.call('$events/result', { args: { clientId: ready.clientId, eventId: first.eventId, outcome: { kind: 'next' } } })
    const afterAnswer = x.next()
    assert.equal(await Promise.race([afterAnswer, pause(30).then(() => marker)]), marker)
    assert.equal(writes, 1) // Only this explicit answer; no recovery replay.
    assert.equal(events.filter(row => row.phase === 'interaction_deferred').length, 1)
    assert.equal(events.filter(row => row.phase === 'interaction_answer').length, 1)
  } finally { a.abort(); b.abort(); await Promise.allSettled([x.return(), y.return()]) }
})

test('core source privately rebinds the same interaction across delivery generations', async () => {
  let generation = 0
  const calls = []
  const source = createHostInteractionSource({
    wireStream: { async *open(endpoint, payload, signal) {
      assert.equal(endpoint, '$events')
      assert.deepEqual(payload, { args: {} })
      const clientId = `client-${++generation}`
      yield { type: 'ready', clientId }
      yield { type: 'waterfall', event: 'user-questions/request', eventId: 'stable', agentId: 's1', request: item('stable').request }
      await untilAbort(signal)
    } },
    async dispatchRpc(endpoint, payload) { calls.push({ endpoint, payload }); return { ok: true } },
  })
  const first = new AbortController(), second = new AbortController()
  const old = source.open(first.signal)
  assert.deepEqual((await old.next()).value, { type: 'ready' })
  const initial = (await old.next()).value
  assert.equal(initial.interaction.id, 'stable')
  assert.equal(JSON.stringify(initial).includes('client-'), false)
  first.abort(); await old.return()
  await assert.rejects(() => source.respond('stable', answer), /INTERACTION_UNCONFIRMED/)
  const fresh = source.open(second.signal)
  await fresh.next(); assert.deepEqual((await fresh.next()).value, initial)
  await source.respond('stable', answer, second.signal)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.args.clientId, 'client-2')
  await assert.rejects(() => source.respond('stable', answer, second.signal), /INTERACTION_UNCONFIRMED/)
  assert.equal(calls.length, 1)
  second.abort(); await fresh.return()
})

test('peer snapshots preserve card identity and only explicit or continuous-owner removal cancels', () => {
  const state = new HostInteractionState({ runtimeEpoch: 'epoch', ownerId: 'owner' })
  const mappings = new Map()
  const view = new InteractionView({ hostId: 'ubuntu', codec: { encodeCompositeId }, mappings })
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  const original = view.accept(state.snapshot())
  assert.equal(original.length, 1)
  const key = original[0].eventId
  assert.equal(mappings.get(key).confirmed, true)
  state.disconnected(); assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(mappings.get(key).confirmed, false)
  state.accept({ type: 'ready' }); assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(mappings.get(key).confirmed, false)
  state.accept(pending('one')); assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(mappings.get(key).confirmed, true)
  view.unavailable()
  assert.deepEqual(view.accept(state.snapshot()), [])
  assert.equal(mappings.get(key).confirmed, true)
  state.accept({ type: 'resolved', id: 'one', reason: 'resolved' })
  assert.deepEqual(view.accept(state.snapshot()), [{ type: 'cancel', eventId: key }])
  assert.equal(mappings.size, 0)
})

test('owner replacement cannot declare prior questions cancelled; core restart can', () => {
  const mappings = new Map()
  const view = new InteractionView({ hostId: 'local', codec: { encodeCompositeId }, mappings })
  const state = new HostInteractionState({ runtimeEpoch: 'epoch-a', ownerId: 'owner-a' })
  state.accept({ type: 'ready' }); state.accept(pending('one'))
  const old = view.accept(state.snapshot())[0]
  const replacement = new HostInteractionState({ runtimeEpoch: 'epoch-a', ownerId: 'owner-b' })
  replacement.accept({ type: 'ready' })
  assert.deepEqual(view.accept(replacement.snapshot()), [])
  assert.equal(mappings.get(old.eventId).confirmed, false)
  // A later empty snapshot of the new owner still cannot prove an old owner's absence.
  replacement.accept(pending('two'))
  assert.equal(view.accept(replacement.snapshot()).some(frame => frame.type === 'cancel'), false)
  replacement.accept(pending('one'))
  assert.deepEqual(view.accept(replacement.snapshot()), [])
  assert.equal(mappings.get(old.eventId).confirmed, true)
  const restarted = new HostInteractionState({ runtimeEpoch: 'epoch-b' })
  restarted.accept({ type: 'ready' })
  assert.equal(view.accept(restarted.snapshot()).filter(frame => frame.type === 'cancel').length, 2)
})

test('authenticated peer routes reject unauthorized and malformed requests before business dispatch', async () => {
  const routes = new Map()
  let reads = 0, writes = 0
  const state = { async read() { reads++; return { revision: 0 } }, async respond() { writes++; return { accepted: true } } }
  const dispose = registerHostInteractionProtocol({ webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    connection: { requestRejection(req) { return req.denied } }, state, send() {} })
  const invoke = async ({ denied, method = 'POST', endpoint = INTERACTION_READ, payload = {}, bytes } = {}) => {
    const res = new EventEmitter()
    Object.assign(res, { status: 0, writableEnded: false, headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true }, end(text) { this.body = text; this.writableEnded = true } })
    const req = { denied, method, async *[Symbol.asyncIterator]() { yield Buffer.from(bytes ?? JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload })) } }
    await routes.get(`/api/${endpoint}`)(req, res)
    return res
  }
  assert.equal((await invoke({ denied: 401 })).status, 401)
  assert.equal((await invoke({ denied: 403 })).status, 403)
  assert.equal((await invoke({ method: 'GET' })).status, 405)
  assert.equal((await invoke({ bytes: '{}' })).status, 400)
  const invalid = await invoke({ payload: { waitMs: 10001 } })
  assert.equal(JSON.parse(invalid.body).result.ok, false)
  assert.equal(reads + writes, 0)
  assert.equal((await invoke()).status, 200)
  assert.equal(reads, 1)
  dispose(); assert.equal(routes.size, 0)
})

test('peer boundary rejects invalid snapshots and explicit failed submissions', async () => {
  const peer = createInteractionPeerClient({ async call(endpoint) {
    return { ok: true, value: endpoint === INTERACTION_RESPOND ? { accepted: false, code: 'interaction_not_pending' } : {} }
  } })
  await assert.rejects(() => peer.read({}), /INTERACTION_PROTOCOL_INVALID/)
  await assert.rejects(() => peer.respond({ runtimeEpoch: 'epoch', interactionId: 'gone', outcome: answer }), /INTERACTION_/)
})

test('two browser views share peer interaction, retain draft identity through unrelated core stream recovery, and resolve together', { timeout: 5000 }, async () => {
  const state = new HostInteractionState({ runtimeEpoch: 'epoch', ownerId: 'owner' })
  state.accept({ type: 'ready' }); state.accept(pending('question'))
  let streamOpens = 0, writes = 0
  let releaseFirst
  const firstEnd = new Promise(resolve => { releaseFirst = resolve })
  const carrier = {
    async call(endpoint, payload, signal) {
      if (endpoint === INTERACTION_READ) return { ok: true, value: await state.read(payload, signal) }
      if (endpoint === INTERACTION_RESPOND) return { ok: true, value: await state.respond(payload, async () => { writes++; return { accepted: true } }, signal) }
      throw new Error('unexpected ordinary RPC')
    },
    async *open(endpoint, payload, signal) {
      assert.equal(endpoint, '$events')
      const n = ++streamOpens
      yield { type: 'ready', clientId: `core-${n}`, host: { home: '/example' } }
      // Must not duplicate the peer-owned question through the legacy path.
      yield { type: 'waterfall', event: 'user-questions/request', eventId: 'question', agentId: 's1', request: item('question').request }
      if (n === 1) await Promise.race([firstEnd, untilAbort(signal)])
      else await untilAbort(signal)
    },
  }
  const hub = new BrowserHostHub({ perHost: { ubuntu: carrier }, retryDelayMs: 5 })
  const a = new AbortController(), b = new AbortController()
  const x = hub.openStream('$events', { args: {} }, a.signal), y = hub.openStream('$events', { args: {} }, b.signal)
  try {
    const xa = (await x.next()).value, ya = (await y.next()).value
    assert.equal(xa.type, 'ready'); assert.equal(ya.type, 'ready')
    const xq = (await x.next()).value, yq = (await y.next()).value
    assert.equal(xq.eventId, yq.eventId)
    const nextX = x.next(), nextY = y.next()
    releaseFirst()
    await pause(40)
    const sentinel = Symbol()
    assert.equal(await Promise.race([nextX, pause(30).then(() => sentinel)]), sentinel)
    assert.ok(streamOpens >= 3)
    const result = await hub.call('$events/result', { args: { clientId: xa.clientId, eventId: xq.eventId, outcome: answer } })
    assert.equal(result.ok, true)
    assert.equal(writes, 1)
    assert.deepEqual((await nextX).value, { type: 'cancel', eventId: xq.eventId })
    assert.deepEqual((await nextY).value, { type: 'cancel', eventId: yq.eventId })
  } finally { a.abort(); b.abort(); await Promise.allSettled([x.return(), y.return()]) }
})


test('identical core identities on two hosts remain isolated during answer and epoch changes', () => {
  const mappings = new Map()
  const local = new InteractionView({ hostId: 'local', codec: { encodeCompositeId }, mappings })
  const remote = new InteractionView({ hostId: 'ubuntu', codec: { encodeCompositeId }, mappings })
  const a = new HostInteractionState({ runtimeEpoch: 'same', ownerId: 'same-owner' })
  const b = new HostInteractionState({ runtimeEpoch: 'same', ownerId: 'same-owner' })
  for (const state of [a, b]) { state.accept({ type: 'ready' }); state.accept(pending('same-question')) }
  const la = local.accept(a.snapshot())[0], rb = remote.accept(b.snapshot())[0]
  assert.notEqual(la.eventId, rb.eventId)
  assert.notEqual(la.agentId, rb.agentId)
  a.accept({ type: 'resolved', id: 'same-question', reason: 'resolved' })
  assert.deepEqual(local.accept(a.snapshot()), [{ type: 'cancel', eventId: la.eventId }])
  assert.deepEqual(remote.accept(b.snapshot()), [])
  assert.equal(mappings.size, 1)
  assert.equal(mappings.get(rb.eventId).hostId, 'ubuntu')
})


test('peer read distinguishes its own cancellation from carrier deadline or retired connection', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    let calls = 0
    const peer = createInteractionPeerClient({ async call() { calls++; throw new DOMException('fixed test', name) } })
    await assert.rejects(peer.read({}, new AbortController().signal), error => error.recoverable === true)
    assert.equal(calls, 1)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(peer.read({}, cancelled.signal), error => error.recoverable === false)
    assert.equal(calls, 2)
  }
  const denied = createInteractionPeerClient({ async call() { throw new Error('CARRIER_RESULT_HTTP_401') } })
  await assert.rejects(denied.read({}), error => error.recoverable === false)
})


test('an old confirmed browser mapping cannot submit to a replacement owner', async () => {
  const mappings = new Map()
  const view = new InteractionView({ hostId: 'local', codec: { encodeCompositeId }, mappings })
  const first = new HostInteractionState({ runtimeEpoch: 'same-process', ownerId: 'old' })
  first.accept({ type: 'ready' }); first.accept(pending('q'))
  const frame = view.accept(first.snapshot())[0]
  const row = mappings.get(frame.eventId)
  const replacement = new HostInteractionState({ runtimeEpoch: 'same-process', ownerId: 'new' })
  replacement.accept({ type: 'ready' }); replacement.accept(pending('q'))
  let calls = 0
  const input = () => ({ runtimeEpoch: row.runtimeEpoch, ownerInstanceId: row.ownerInstanceId, interactionId: row.interactionId, outcome: answer })
  assert.equal(row.confirmed, true)
  assert.equal((await replacement.respond(input(), async () => { calls++ })).code, 'owner_mismatch')
  assert.equal(calls, 0)
  assert.deepEqual(view.accept(replacement.snapshot()), [])
  assert.equal((await replacement.respond(input(), async () => { calls++ })).accepted, true)
  assert.equal(calls, 1)
})

test('ambiguous core acknowledgement retires only its read generation to permit authoritative replay', async () => {
  let opens = 0, sends = 0
  const source = createHostInteractionSource({
    wireStream: { async *open(endpoint, payload, signal) {
      const generation = ++opens
      yield { type: 'ready', clientId: `client-${generation}` }
      yield { type: 'waterfall', event: 'user-questions/request', eventId: 'q', agentId: 's1', request: item('q').request }
      await untilAbort(signal)
    } },
    async dispatchRpc() { sends++; throw new Error('ambiguous fixed fixture') },
  })
  const lifetime = new AbortController()
  const first = source.open(lifetime.signal)
  await first.next(); await first.next()
  const ended = first.next()
  await assert.rejects(source.respond('q', answer), /ambiguous/)
  assert.equal((await ended).done, true)
  assert.equal(lifetime.signal.aborted, false)
  assert.equal(sends, 1)
  await assert.rejects(source.respond('q', answer), /INTERACTION_UNCONFIRMED/)
  const second = source.open(lifetime.signal)
  await second.next()
  await assert.rejects(source.respond('q', answer), /INTERACTION_UNCONFIRMED/)
  assert.equal((await second.next()).value.interaction.id, 'q')
  assert.equal(opens, 2); assert.equal(sends, 1)
  lifetime.abort(); await second.return()
})
