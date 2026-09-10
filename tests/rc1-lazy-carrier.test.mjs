import test from 'node:test'
import assert from 'node:assert/strict'
import { lazyCarrier } from '../packages/rc1-host-carriers/src/lazy-carrier.js'

test('cancelled caller stops waiting without cancelling the shared Host connection', async () => {
  const lifetime = new AbortController(), request = new AbortController()
  let release, calls = 0
  const carrier = lazyCarrier(() => new Promise(resolve => { release = resolve }), lifetime.signal)
  const cancelled = carrier.call('session/list', {}, request.signal)
  const remaining = carrier.call('session/list', {})
  const reason = new Error('caller-cancelled')
  request.abort(reason)
  const result = await Promise.race([
    cancelled.then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 30)),
  ])
  release({ close() {}, carrier: { call: async () => { calls++; return 'ready' } } })
  await cancelled.catch(() => {})
  assert.equal(await remaining, 'ready')
  lifetime.abort()
  assert.equal(result, reason)
  assert.equal(calls, 1)
})

test('concurrent callers share one connection but never replay a failed operation', async () => {
  let connected = 0, calls = 0, closed = 0
  const lifetime = new AbortController()
  const carrier = lazyCarrier(async () => {
    connected++
    return { close: () => closed++, carrier: { call: async () => { calls++; throw new Error('uncertain') } } }
  }, lifetime.signal)
  await Promise.all(Array.from({ length: 20 }, () => assert.rejects(carrier.call('session/prompt', {}), /uncertain/)))
  assert.equal(connected, 1); assert.equal(calls, 20); assert.equal(closed, 0)
  lifetime.abort(); assert.equal(closed, 1)
})

test('disconnect during establishment closes late connection instead of resurrecting it', async () => {
  const lifetime = new AbortController()
  let release, closed = 0
  const carrier = lazyCarrier(() => new Promise(resolve => { release = resolve }), lifetime.signal)
  const result = carrier.call('session/list', {})
  await Promise.resolve()
  lifetime.abort()
  release({ close: () => closed++, carrier: { call: () => assert.fail('late call') } })
  await assert.rejects(result, /CLOSED/)
  assert.equal(closed, 1)
})

test('a slow Host does not serialize another Host connection', async () => {
  const lifetime = new AbortController()
  let release
  const slow = lazyCarrier(() => new Promise(resolve => { release = resolve }), lifetime.signal)
  const fast = lazyCarrier(async () => ({ close() {}, carrier: { call: async () => 'ready' } }), lifetime.signal)
  const pending = slow.call('session/list', {})
  assert.equal(await fast.call('session/list', {}), 'ready')
  release({ close() {}, carrier: { call: async () => 'slow' } })
  assert.equal(await pending, 'slow')
  lifetime.abort()
})

test('expired authentication invalidates only future calls without replaying the failed one', async () => {
  let connects = 0, calls = 0, closes = 0
  const lifetime = new AbortController()
  const carrier = lazyCarrier(async () => {
    const generation = ++connects
    return { close: () => closes++, carrier: { call: async () => {
      calls++
      if (generation === 1) throw new Error('CARRIER_RESULT_HTTP_401')
      return 'ok'
    } } }
  }, lifetime.signal)
  await assert.rejects(carrier.call('session/prompt', {}), /401/)
  assert.equal(calls, 1); assert.equal(closes, 1)
  assert.equal(await carrier.call('session/list', {}), 'ok')
  assert.equal(connects, 2)
  lifetime.abort()
})

test('stream ended invalidates the lazy carrier without replaying a failed write', async () => {
  let connects = 0, calls = 0, closes = 0
  const lifetime = new AbortController()
  const carrier = lazyCarrier(async () => {
    const generation = ++connects
    return { close: () => closes++, carrier: {
      call: async () => {
        calls++
        if (generation === 1) throw new Error('CARRIER_STREAM_ENDED')
        return 'ok'
      },
      async *open() {
        if (generation === 1) throw new Error('CARRIER_STREAM_ENDED')
        yield 'ready'
      }
    } }
  }, lifetime.signal)
  await assert.rejects(carrier.call('session/prompt', {}), /CARRIER_STREAM_ENDED/)
  assert.equal(calls, 1)
  assert.equal(closes, 1)
  assert.equal(await carrier.call('session/list', {}), 'ok')
  assert.equal(connects, 2)
  const stream = carrier.open('session/follow', {}, lifetime.signal)
  assert.equal((await stream.next()).value, 'ready')
  lifetime.abort()
})

test('lazy carrier reports offline, connecting, and connected without status reads dialing', async () => {
  const lifetime = new AbortController()
  let release
  let connects = 0
  const carrier = lazyCarrier(() => {
    connects++
    return new Promise(resolve => { release = resolve })
  }, lifetime.signal)
  assert.equal(carrier.getState(), 'offline')
  const pending = carrier.call('session/list', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(carrier.getState(), 'connecting')
  assert.equal(connects, 1)
  release({ close() {}, carrier: { call: async () => 'connected' } })
  assert.equal(await pending, 'connected')
  assert.equal(carrier.getState(), 'connected')
  lifetime.abort()
  assert.equal(carrier.getState(), 'offline')
})
