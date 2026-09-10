import test from 'node:test'
import assert from 'node:assert/strict'
import { InteractionBridge } from '../packages/mobile-interactions-compat-rc1/src/index.js'

const question = (id = 'q1') => ({ type: 'waterfall', event: 'user-questions/request', eventId: id, agentId: 'session', request: { questions: [{ id: 'choice', question: 'Question?', options: [{ label: 'Yes' }] }] } })
const response = (id = 'q1') => ({ type: 'client-response', rpcId: id, result: { ok: true, value: { sessionId: 'session', answer: { answers: [{ id: 'choice', selected: ['Yes'] }] } } } })
function ready(bridge, send = async () => {}) { bridge.attach(send); bridge.accept({ type: 'ready', clientId: 'client1' }) }

test('desktop cancellation withdraws only the matching question round', () => {
  const b = new InteractionBridge(); const events = []; b.subscribe(e => events.push(e)); ready(b)
  b.accept(question()); b.accept(question()); b.accept(question('q2'))
  assert.equal(events.length, 2)
  b.accept({ type: 'cancel', eventId: 'q1' })
  assert.equal(events.at(-1).payload.questionRpcId, 'q1')
  assert.deepEqual(b.snapshot().map(e => e.rpcId), ['q2'])
  b.disconnect()
  assert.equal(b.snapshot().length, 0)
  assert.equal(events.at(-1).payload.questionRpcId, 'q2')
})

test('response forwards official answer and confirms only after receipt; never duplicates', async () => {
  const b = new InteractionBridge(); const calls = []; let release
  ready(b, payload => { calls.push(payload); return new Promise(resolve => { release = resolve }) })
  b.accept(question())
  const sending = b.respond(response())
  assert.equal(b.snapshot().length, 1)
  assert.deepEqual(await b.respond(response()), { accepted: false, reason: 'response_in_flight' })
  release(); assert.deepEqual(await sending, { accepted: true })
  assert.deepEqual(calls[0], { clientId: 'client1', eventId: 'q1', outcome: { kind: 'result', value: response().result.value.answer } })
  assert.equal(b.snapshot().length, 0)
  assert.equal((await b.respond(response())).accepted, false)
  assert.equal(calls.length, 1)
})

test('identical IDs across Host bridges do not share pending state', async () => {
  const a = new InteractionBridge(); const b = new InteractionBridge(); ready(a); ready(b)
  a.accept(question()); b.accept(question())
  await a.respond(response())
  assert.equal(a.snapshot().length, 0); assert.equal(b.snapshot().length, 1)
})

test('failed receipt leaves action pending and cross-session response is rejected', async () => {
  const b = new InteractionBridge(); ready(b, async () => { throw new Error('disconnected') }); b.accept(question())
  assert.equal((await b.respond(response())).reason, 'response_not_confirmed')
  assert.equal(b.snapshot().length, 1)
  const wrong = response(); wrong.result.value.sessionId = 'another'
  assert.equal((await b.respond(wrong)).reason, 'invalid_response')
})

test('approval maps outcome rather than returning the legacy object to the model', async () => {
  const b = new InteractionBridge(); let received; ready(b, async p => { received = p })
  b.accept({ type: 'waterfall', event: 'approval/request', eventId: 'a', agentId: 'session', request: { toolName: 'bash', reason: 'test' } })
  assert.equal(b.snapshot()[0].payload.toolName, 'bash')
  assert.equal((await b.respond({ type: 'client-response', rpcId: 'a', result: { ok: true, value: { sessionId: 'session', approvalId: 'a', outcome: 'rejected' } } })).accepted, true)
  assert.equal(received.outcome.value, 'rejected')
})
