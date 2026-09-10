
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import {
  BROWSER_STREAM_PATH,
  createBrowserBootstrapScript,
  registerStreamMux,
  serveStreamSocket,
} from '../packages/browser-host-hub-rc1/src/index.js'

const requireFromHub = createRequire(new URL('../packages/browser-host-hub-rc1/package.json', import.meta.url))
const { WebSocket: NodeWebSocket, WebSocketServer } = requireFromHub('ws')

const tick = () => new Promise(resolve => setImmediate(resolve))

class BrowserSocket {
  static instances = []
  static OPEN = 1

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    BrowserSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = BrowserSocket.OPEN
      this.emit('open', {})
    })
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value) { this.sent.push(JSON.parse(String(value))) }

  close() { this.emitClose(1000) }

  emitClose(code, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  receive(value) { this.emit('message', { data: JSON.stringify(value) }) }

  disconnect() {
    this.emitClose(1006)
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function bootstrap({ hosts = [], fetch = async () => ({ ok: true, status: 200 }) } = {}) {
  BrowserSocket.instances = []
  const sandbox = {
    AbortController,
    DOMException,
    Promise,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    WebSocket: BrowserSocket,
    console,
    crypto,
    fetch,
    location: { href: 'https://browser.test/', origin: 'https://browser.test' },
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(createBrowserBootstrapScript({ hosts }), sandbox)
  return sandbox
}

test('one page multiplexes streams, cancels one iterator, and never replays after a physical disconnect', async () => {
  const sandbox = bootstrap()
  const workspace = sandbox.__DSH_TRANSPORT__.openStream('workspace/follow', { args: {} })
  const events = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const workspaceFirst = workspace.next()
  const eventFirst = events.next()
  await tick()

  assert.equal(BrowserSocket.instances.length, 1)
  const firstSocket = BrowserSocket.instances[0]
  assert.equal(new URL(firstSocket.url).pathname, BROWSER_STREAM_PATH)
  const opens = firstSocket.sent.filter(frame => frame.type === 'open')
  assert.equal(opens.length, 2)
  assert.notEqual(opens[0].streamId, opens[1].streamId)

  firstSocket.receive({ type: 'item', streamId: opens[0].streamId, value: { type: 'baseline' } })
  firstSocket.receive({ type: 'item', streamId: opens[1].streamId, value: { type: 'ready' } })
  assert.equal((await workspaceFirst).value.type, 'baseline')
  assert.equal((await eventFirst).value.type, 'ready')

  await workspace.return()
  assert.equal(firstSocket.sent.some(frame => frame.type === 'cancel' && frame.streamId === opens[0].streamId), true)
  const eventPending = events.next()
  firstSocket.disconnect()
  await assert.rejects(eventPending, error => {
    assert.match(error.message, /disconnected/)
    assert.equal(error.dshRemoteStreamFailure?.kind, 'carrier')
    return true
  })

  const replacement = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const replacementFirst = replacement.next()
  await tick()
  assert.equal(BrowserSocket.instances.length, 2)
  const secondSocket = BrowserSocket.instances[1]
  const replacementOpen = secondSocket.sent.find(frame => frame.type === 'open')
  assert.notEqual(replacementOpen.streamId, opens[1].streamId)
  firstSocket.receive({ type: 'item', streamId: replacementOpen.streamId, value: { type: 'stale' } })
  secondSocket.receive({ type: 'item', streamId: replacementOpen.streamId, value: { type: 'fresh' } })
  assert.equal((await replacementFirst).value.type, 'fresh')
  await replacement.return()
})

test('a snapshot stream can reopen after a physical disconnect and start a new generation without stale frames', async () => {
  const sandbox = bootstrap()
  const first = sandbox.__DSH_TRANSPORT__.openStream('session/follow', { args: {} })
  const firstSnapshot = first.next()
  await tick()
  const firstSocket = BrowserSocket.instances[0]
  const firstOpen = firstSocket.sent.find(frame => frame.type === 'open')
  firstSocket.receive({ type: 'item', streamId: firstOpen.streamId, value: { type: 'snapshot', cursor: 7, records: [{ seq: 7 }] } })
  const firstValue = (await firstSnapshot).value
  assert.equal(firstValue.type, 'snapshot')
  assert.equal(firstValue.cursor, 7)
  assert.equal(firstValue.records[0].seq, 7)

  const failed = first.next()
  firstSocket.disconnect()
  await assert.rejects(failed, error => error.dshRemoteStreamFailure?.kind === 'carrier')

  const second = sandbox.__DSH_TRANSPORT__.openStream('session/follow', { args: {} })
  const secondSnapshot = second.next()
  await tick()
  const secondSocket = BrowserSocket.instances[1]
  const secondOpen = secondSocket.sent.find(frame => frame.type === 'open')
  assert.notEqual(secondOpen.streamId, firstOpen.streamId)
  firstSocket.receive({ type: 'item', streamId: secondOpen.streamId, value: { type: 'stale' } })
  secondSocket.receive({ type: 'item', streamId: secondOpen.streamId, value: { type: 'snapshot', cursor: 7, records: [{ seq: 7 }] } })
  const secondValue = (await secondSnapshot).value
  assert.equal(secondValue.type, 'snapshot')
  assert.equal(secondValue.cursor, 7)
  assert.equal(secondValue.records[0].seq, 7)
  const delta = second.next()
  secondSocket.receive({ type: 'item', streamId: secondOpen.streamId, value: { type: 'delta', cursor: 8, records: [{ seq: 8 }] } })
  const deltaValue = (await delta).value
  assert.equal(deltaValue.type, 'delta')
  assert.equal(deltaValue.cursor, 8)
  assert.equal(deltaValue.records[0].seq, 8)
  await first.return()
  await second.return()
})

test('a service-stop close (1001) reopens a snapshot stream as a new generation', async () => {
  const sandbox = bootstrap()
  const first = sandbox.__DSH_TRANSPORT__.openStream('session/follow', { args: {} })
  const firstSnapshot = first.next()
  await tick()
  const firstSocket = BrowserSocket.instances[0]
  const firstOpen = firstSocket.sent.find(frame => frame.type === 'open')
  firstSocket.receive({ type: 'item', streamId: firstOpen.streamId, value: { type: 'snapshot', cursor: 11, records: [{ seq: 11 }] } })
  assert.equal((await firstSnapshot).value.cursor, 11)

  const failed = first.next()
  firstSocket.emitClose(1001, 'service stopped')
  await assert.rejects(failed, error => error.dshRemoteStreamFailure?.kind === 'carrier')

  const second = sandbox.__DSH_TRANSPORT__.openStream('session/follow', { args: {} })
  const secondSnapshot = second.next()
  await tick()
  const secondSocket = BrowserSocket.instances[1]
  const secondOpen = secondSocket.sent.find(frame => frame.type === 'open')
  assert.notEqual(secondOpen.streamId, firstOpen.streamId)
  secondSocket.receive({ type: 'item', streamId: secondOpen.streamId, value: { type: 'snapshot', cursor: 11, records: [{ seq: 11 }] } })
  assert.equal((await secondSnapshot).value.cursor, 11)
  await first.return()
  await second.return()
})

test('a physical WebSocket failure before opening is classified as a carrier failure', async () => {
  const sandbox = bootstrap()
  const stream = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const pending = stream.next()
  const socket = BrowserSocket.instances[0]
  socket.emit('error', new Error('connect failed'))
  await assert.rejects(pending, error => error.dshRemoteStreamFailure?.kind === 'carrier')
  await stream.return()
})

test('protocol, policy, capacity, and clean close codes remain terminal', async () => {
  for (const code of [1000, 1002, 1003, 1008, 1009, 1011]) {
    const sandbox = bootstrap()
    const stream = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
    const pending = stream.next()
    await tick()
    const socket = BrowserSocket.instances[0]
    socket.emitClose(code)
    await assert.rejects(pending, error => {
      assert.match(error.message, /disconnected/)
      assert.equal(error.dshRemoteStreamFailure, undefined)
      return true
    })
    assert.equal(BrowserSocket.instances.length, 1)
    await stream.return()
  }
})

test('stream-shaped fetch uses the shared socket and returns the original SSE response shape', async () => {
  const nativeCalls = []
  const sandbox = bootstrap({ fetch: async (input, init) => {
    nativeCalls.push({ input, init })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const responsePromise = sandbox.__DSH_TRANSPORT__.fetch('/api/session/follow', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'stream-rpc', method: 'session/follow', payload: { args: {} } }),
  })
  await tick()
  const socket = BrowserSocket.instances[0]
  const open = socket.sent.find(frame => frame.type === 'open')
  const response = await responsePromise
  const textPromise = response.text()
  socket.receive({ type: 'item', streamId: open.streamId, value: { type: 'snapshot', value: { records: [] } } })
  socket.receive({ type: 'end', streamId: open.streamId })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(await textPromise, 'data: {"type":"snapshot","value":{"records":[]}}\n\n')
  assert.equal(nativeCalls.length, 0)

  await sandbox.__DSH_TRANSPORT__.fetch('/api/session/modelCatalog', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'unary-rpc', method: 'session/modelCatalog', payload: { args: {} } }),
  })
  assert.equal(nativeCalls.length, 1)
})

test('duplicate terminal and late item frames are idempotently ignored', async () => {
  const sandbox = bootstrap()
  const stream = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const firstPromise = stream.next()
  await tick()
  const socket = BrowserSocket.instances[0]
  const open = socket.sent.find(frame => frame.type === 'open')
  socket.receive({ type: 'item', streamId: open.streamId, value: { type: 'ready' } })
  socket.receive({ type: 'end', streamId: open.streamId })
  socket.receive({ type: 'end', streamId: open.streamId })
  socket.receive({ type: 'item', streamId: open.streamId, value: { type: 'late' } })
  assert.equal((await firstPromise).value.type, 'ready')
  const terminal = await stream.next()
  assert.equal(terminal.done, true)
  assert.equal(terminal.value, undefined)
})

test('authenticated bootstrap exposes only hostId and label from its embedded inventory', () => {
  const sandbox = bootstrap({ hosts: [
    { hostId: 'local', label: 'Local', state: 'online', token: 'secret' },
    { hostId: 'ubuntu', label: 'Ubuntu', state: 'offline', carrier: { token: 'secret' } },
  ] })
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__DSH_BROWSER_HOST_HUB__.getHosts())), [
    { hostId: 'local', label: 'Local' },
    { hostId: 'ubuntu', label: 'Ubuntu' },
  ])
  assert.doesNotMatch(createBrowserBootstrapScript({ hosts: [{ hostId: 'x', label: 'X', token: 'do-not-embed' }] }), /do-not-embed/)
})

class ServerSocket extends EventEmitter {
  constructor({ manual = false } = {}) {
    super()
    this.OPEN = 1
    this.readyState = 1
    this.manual = manual
    this.sent = []
    this.callbacks = []
  }

  send(value, callback) {
    this.sent.push(JSON.parse(String(value)))
    if (this.manual) this.callbacks.push(callback)
    else queueMicrotask(() => callback?.())
  }

  close(code, reason) { this.closed = { code, reason }; this.readyState = 3 }
  release() { this.callbacks.shift()?.() }
}

function trackedStream(values) {
  let index = 0
  const tracker = { returns: 0 }
  tracker.iterator = {
    async next() { return index < values.length ? { done: false, value: values[index++] } : new Promise(() => {}) },
    async return() { tracker.returns++; return { done: true } },
    [Symbol.asyncIterator]() { return this },
  }
  return tracker
}

test('server protocol is fair, cancellation is stream-scoped, and socket close releases every iterator', async () => {
  const alpha = trackedStream([{ source: 'alpha-1' }, { source: 'alpha-2' }])
  const beta = trackedStream([{ source: 'beta-1' }, { source: 'beta-2' }])
  const hub = { openStream(endpoint) { return endpoint === '$events' ? alpha.iterator : beta.iterator } }
  const socket = new ServerSocket({ manual: true })
  serveStreamSocket(socket, hub)
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: { args: {} } }), false)
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:2', endpoint: 'session/control', payload: { args: {} } }), false)
  await tick()
  assert.equal(socket.sent[0].value.source, 'alpha-1')
  socket.release()
  await tick()
  assert.equal(socket.sent[1].value.source, 'beta-1')
  socket.release()
  await tick()
  assert.equal(socket.sent[2].value.source, 'alpha-2')

  socket.emit('message', JSON.stringify({ type: 'cancel', streamId: 'page:1' }), false)
  await tick()
  assert.equal(alpha.returns, 1)
  assert.equal(beta.returns, 0)
  socket.emit('close')
  await tick()
  assert.equal(beta.returns, 1)
})

test('bounded sender terminates an overflowing stream without starving another stream', async () => {
  const noisy = trackedStream([
    { data: 'a'.repeat(80) }, { data: 'b'.repeat(80) }, { data: 'c'.repeat(80) },
  ])
  const small = trackedStream([{ data: 'small' }])
  const hub = { openStream(endpoint) { return endpoint === '$events' ? noisy.iterator : small.iterator } }
  const socket = new ServerSocket({ manual: true })
  serveStreamSocket(socket, hub, { maxFrameBytes: 512, maxStreamQueuedBytes: 360, maxSocketQueuedBytes: 800 })
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }), false)
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:2', endpoint: 'session/control', payload: {} }), false)
  await tick()
  for (let index = 0; index < 8; index++) { socket.release(); await tick() }
  assert.equal(socket.sent.some(frame => frame.type === 'error' && frame.streamId === 'page:1'), true)
  assert.equal(socket.sent.some(frame => frame.type === 'item' && frame.streamId === 'page:2'), true)
  assert.equal(noisy.returns, 1)
})

test('real ws success callback keeps the multiplexed socket open after an item frame', async () => {
  const server = createServer()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const stream = trackedStream([{ type: 'ready' }])
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, accepted => {
      serveStreamSocket(accepted, { openStream: () => stream.iterator })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.notEqual(address, null)
  const client = new NodeWebSocket(`ws://127.0.0.1:${address.port}${BROWSER_STREAM_PATH}`)
  try {
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    client.send(JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }))
    const [raw] = await new Promise((resolve, reject) => { client.once('message', (...args) => resolve(args)); client.once('error', reject) })
    assert.equal(JSON.parse(String(raw)).type, 'item')
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(client.readyState, NodeWebSocket.OPEN)
  } finally {
    if (client.readyState < NodeWebSocket.CLOSING) client.close()
    await new Promise(resolve => webSocketServer.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
})

test('socket-wide queue overflow counts the in-flight frame and releases every stream', async () => {
  const alpha = trackedStream([{ data: 'a'.repeat(80) }])
  const beta = trackedStream([{ data: 'b'.repeat(80) }])
  const socket = new ServerSocket({ manual: true })
  serveStreamSocket(socket, { openStream(endpoint) { return endpoint === '$events' ? alpha.iterator : beta.iterator } }, {
    maxFrameBytes: 512,
    maxStreamQueuedBytes: 1024,
    maxSocketQueuedBytes: 240,
  })
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }), false)
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:2', endpoint: 'session/control', payload: {} }), false)
  await tick()
  assert.equal(socket.closed.code, 1011)
  assert.equal(alpha.returns, 1)
  assert.equal(beta.returns, 1)
})

test('physical close continues releasing streams when one iterator return throws synchronously', async () => {
  let safeReturns = 0
  const pending = () => new Promise(() => {})
  const broken = { next: pending, return() { throw new Error('broken return') }, [Symbol.asyncIterator]() { return this } }
  const safe = { next: pending, return() { safeReturns++; return { done: true } }, [Symbol.asyncIterator]() { return this } }
  const socket = new ServerSocket()
  serveStreamSocket(socket, { openStream(endpoint) { return endpoint === '$events' ? broken : safe } })
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }), false)
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:2', endpoint: 'session/control', payload: {} }), false)
  await tick()
  socket.emit('close')
  await tick()
  assert.equal(safeReturns, 1)
})

test('a socket rejects reuse of a terminal stream id without retaining an unbounded seen-id set', async () => {
  const stream = trackedStream([])
  let opens = 0
  const socket = new ServerSocket()
  serveStreamSocket(socket, { openStream() { opens++; return stream.iterator } })
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }), false)
  socket.emit('message', JSON.stringify({ type: 'cancel', streamId: 'page:1' }), false)
  await tick()
  socket.emit('message', JSON.stringify({ type: 'open', streamId: 'page:1', endpoint: '$events', payload: {} }), false)
  assert.equal(socket.closed.code, 1008)
  assert.equal(opens, 1)
})

test('upgrade authenticates and enforces same origin before handing the socket to ws', async () => {
  let route
  let accepted = 0
  const protocolSocket = new ServerSocket()
  const webSocketServer = {
    handleUpgrade(_request, _socket, _head, accept) { accepted++; accept(protocolSocket) },
    close() {},
  }
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: { registerUpgrade(value) { route = value; return () => {} } },
  }
  const dispose = registerStreamMux(ctx, { openStream() { throw new Error('unused') } }, { webSocketServer })
  assert.equal(route.path, BROWSER_STREAM_PATH)

  const rejected = { destroyed: false, body: '', end(value) { this.body += value } }
  ctx.connection.requestRejection = () => 401
  await route.handler({ method: 'GET', headers: { host: 'browser.test', origin: 'https://browser.test' }, socket: { encrypted: true } }, rejected, new Uint8Array())
  assert.match(rejected.body, /^HTTP\/1\.1 401/)
  assert.equal(accepted, 0)

  const crossOrigin = { destroyed: false, body: '', end(value) { this.body += value } }
  ctx.connection.requestRejection = () => undefined
  await route.handler({ method: 'GET', headers: { host: 'browser.test', origin: 'https://evil.test' }, socket: { encrypted: true } }, crossOrigin, new Uint8Array())
  assert.match(crossOrigin.body, /^HTTP\/1\.1 403/)
  assert.equal(accepted, 0)

  await route.handler({ method: 'GET', headers: { host: 'browser.test', origin: 'https://browser.test' }, socket: { encrypted: true } }, { destroyed: false }, new Uint8Array())
  assert.equal(accepted, 1)
  dispose()
})
