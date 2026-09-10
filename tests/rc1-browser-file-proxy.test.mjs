import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createFileProxyHandler, fileProxyBootstrap, FILE_PROXY_PREFIX } from '../packages/browser-host-hub-rc1/src/file-proxy.js'
import { encodeCompositeId, decodeCompositeId } from '../packages/browser-host-hub-rc1/src/index.js'


test('file proxy authenticates, rejects malformed identity, and streams to the owning Host', async () => {
  const calls = []
  const hosts = new Map(['a', 'b'].map(host => [host, { raw: async (route, init) => {
    const bytes = []
    if (init.body) for await (const chunk of init.body) bytes.push(chunk)
    calls.push({ host, route, session: init.headers['x-session-id'], range: init.headers.range, data: Buffer.concat(bytes).toString() })
    return new Response('target-result', { status: 206, headers: { 'content-range': 'bytes 0-12/13', 'set-cookie': 'must-not-forward' } })
  } }]))
  const server = createServer(createFileProxyHandler({ requestRejection: req => req.headers.authorization === 'test' ? undefined : 401 }, hosts, decodeCompositeId))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}${FILE_PROXY_PREFIX}/api/upload/v2/transfers/test`
  try {
    let reply = await fetch(url); assert.equal(reply.status, 401); await reply.body?.cancel()
    reply = await fetch(url, { headers: { authorization: 'test', 'x-session-id': 'rh1.bad' } }); assert.equal(reply.status, 400); await reply.body?.cancel()
    assert.equal(calls.length, 0)
    reply = await fetch(url, { method: 'PATCH', headers: { authorization: 'test', 'x-session-id': encodeCompositeId('b', 'same-session'), range: 'bytes=0-12' }, body: 'test-data' })
    assert.equal(reply.status, 206)
    assert.equal(reply.headers.get('set-cookie'), null)
    assert.equal(await reply.text(), 'target-result')
    assert.deepEqual(calls, [{ host: 'b', route: '/api/upload/v2/transfers/test', session: 'same-session', range: 'bytes=0-12', data: 'test-data' }])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('file proxy routes the exact sidebar Files API by JSON session identity', async () => {
  const calls = []
  const hosts = new Map([['ubuntu', { raw: async (route, init) => {
    const body = init.body === undefined ? '' : Buffer.from(await new Response(init.body).arrayBuffer()).toString('utf8')
    calls.push({ route, method: init.method, session: init.headers['x-session-id'], body })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  } }]])
  const server = createServer(createFileProxyHandler({ requestRejection: () => undefined }, hosts, decodeCompositeId))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}${FILE_PROXY_PREFIX}`
  const sessionId = encodeCompositeId('ubuntu', 'raw-session')
  try {
    let reply = await fetch(`${base}/sidebar/api/fs.tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd: '/home/operator/project', path: '/home/operator/project' }),
    })
    assert.equal(reply.status, 200)
    await reply.arrayBuffer()
    assert.deepEqual(calls, [{
      route: '/sidebar/api/fs.tree',
      method: 'POST',
      session: 'raw-session',
      body: '{"sessionId":"raw-session","cwd":"/home/operator/project","path":"/home/operator/project"}',
    }])

    reply = await fetch(`${base}/sidebar/api/git.status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(reply.status, 404)
    await reply.arrayBuffer()
    assert.equal(calls.length, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('file proxy routes sidebar upload and download query identities and rejects conflicts', async () => {
  const calls = []
  const hosts = new Map([['ubuntu', { raw: async (route, init) => {
    const body = init.body === undefined ? '' : Buffer.from(await new Response(init.body).arrayBuffer()).toString('utf8')
    calls.push({ route, method: init.method, session: init.headers['x-session-id'], body })
    return new Response('file-result', { status: 200 })
  } }]])
  const server = createServer(createFileProxyHandler({ requestRejection: () => undefined }, hosts, decodeCompositeId))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}${FILE_PROXY_PREFIX}`
  const sessionId = encodeCompositeId('ubuntu', 'raw-session')
  try {
    let reply = await fetch(`${base}/sidebar/upload?sessionId=${encodeURIComponent(sessionId)}&part=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'upload-body',
    })
    assert.equal(reply.status, 200)
    await reply.arrayBuffer()
    reply = await fetch(`${base}/sidebar/file?sessionId=${encodeURIComponent(sessionId)}&path=%2Ftmp%2Ffile`, {
      headers: { range: 'bytes=0-3' },
    })
    assert.equal(reply.status, 200)
    await reply.arrayBuffer()
    assert.deepEqual(calls, [
      { route: '/sidebar/upload?sessionId=raw-session&part=1', method: 'POST', session: 'raw-session', body: 'upload-body' },
      { route: '/sidebar/file?sessionId=raw-session&path=%2Ftmp%2Ffile', method: 'GET', session: 'raw-session', body: '' },
    ])

    reply = await fetch(`${base}/sidebar/api/fs.tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': encodeCompositeId('ubuntu', 'different') },
      body: JSON.stringify({ sessionId, cwd: '/home/operator/project' }),
    })
    assert.equal(reply.status, 400)
    await reply.arrayBuffer()
    assert.equal(calls.length, 2)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('file proxy bootstrap routes string JSON sidebar fetches but leaves global settings local', async () => {
  const calls = []
  const original = async (input, init) => {
    calls.push({ input: input instanceof URL ? input.toString() : input, init })
    return new Response('{}', { status: 200 })
  }
  const sandbox = { fetch: original, location: new URL('http://browser.test/'), Request, Headers, URL }
  const vm = await import('node:vm')
  vm.runInNewContext(fileProxyBootstrap(), sandbox)
  const sessionId = encodeCompositeId('ubuntu', 'raw-session')

  await sandbox.fetch('/sidebar/api/fs.tree', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, cwd: '/home/operator/project' }),
  })
  await sandbox.fetch('/sidebar/api/settings', {
    method: 'POST',
    body: JSON.stringify({ sessionId, key: 'theme' }),
  })
  await sandbox.fetch(`/sidebar/upload?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: 'data' })

  assert.equal(calls[0].input, `http://browser.test${FILE_PROXY_PREFIX}/sidebar/api/fs.tree`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId, cwd: '/home/operator/project' })
  assert.equal(calls[1].input, '/sidebar/api/settings')
  assert.equal(calls[2].input, `http://browser.test${FILE_PROXY_PREFIX}/sidebar/upload?sessionId=${encodeURIComponent(sessionId)}`)
})

test('sidebar Request inspection preserves a native local body and routes a composite body', async () => {
  const calls=[]
  const sandbox={location:new URL('http://browser.test/'),Request,Headers,URL,fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);calls.push({url:request.url,body:await request.json()});return new Response('{}')}}
  const vm=await import('node:vm');vm.runInNewContext(fileProxyBootstrap(),sandbox)
  for(const sessionId of ['raw-local',encodeCompositeId('ubuntu','remote')])await sandbox.fetch(new Request('http://browser.test/sidebar/api/fs.tree',{method:'POST',body:JSON.stringify({sessionId,cwd:'/home/test'})}))
  assert.equal(calls[0].url,'http://browser.test/sidebar/api/fs.tree')
  assert.equal(calls[0].body.sessionId,'raw-local')
  assert.equal(calls[1].url,`http://browser.test${FILE_PROXY_PREFIX}/sidebar/api/fs.tree`)
  assert.equal(calls[1].body.cwd,'/home/test')
})
