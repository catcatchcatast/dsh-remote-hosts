import test from 'node:test'
import assert from 'node:assert/strict'
import { createCarrier } from '../packages/mobile-interactions-compat-rc1/src/carrier.js'

test('raw file transport preserves streaming body, offset and range without accepting client credentials', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init })
    return calls.length === 1 ? new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'test-session=server-secret; HttpOnly' } }) : new Response('ok')
  })
  const lifetime = new AbortController()
  const carrier = await createCarrier('http://127.0.0.1:3081', 'http://127.0.0.1:3081/?token=test', null, lifetime.signal)
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close() } })
  await carrier.raw('/api/upload/v2/transfers/u', { method: 'PATCH', body, headers: {
    Cookie: 'attacker=1', Authorization: 'do-not-forward', 'X-Session-ID': 'raw-session', 'Upload-Offset': '4', Range: 'bytes=4-5',
  } })
  assert.equal(calls[1].init.body, body)
  assert.equal(calls[1].init.duplex, 'half')
  assert.equal(calls[1].init.headers.get('cookie'), 'test-session=server-secret')
  assert.equal(calls[1].init.headers.has('authorization'), false)
  assert.equal(calls[1].init.headers.get('upload-offset'), '4')
  assert.equal(calls[1].init.headers.get('range'), 'bytes=4-5')
  assert.equal(calls[1].init.headers.get('x-session-id'), 'raw-session')
  await assert.rejects(carrier.raw('https://example.invalid/api/upload/v2/transfers'), /ROUTE_INVALID/)
  await assert.rejects(carrier.raw('/api/upload/v2/../../settings'), /ROUTE_INVALID/)
  await assert.rejects(carrier.raw('/api/session/prompt'), /ROUTE_INVALID/)
  assert.equal(calls.length, 2)
  lifetime.abort()
})
