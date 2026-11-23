// Public change history: docs/PUBLIC-CHANGES.md
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { BrowserHostHub, createBrowserBootstrapScript, encodeCompositeId } from '../packages/browser-host-hub-rc1/src/index.js'
import { wrapHostCarrier } from '../packages/runtime-interface/src/index.js'

const version = '0.2.2-rc.5'
const tick = () => new Promise(resolve => setImmediate(resolve))
const gates = () => Promise.withResolvers()
const list = items => ({ ok: true, value: { items: items.map(sessionId => ({ sessionId, blank: false })) } })
const end = Symbol('generation ended')
const ready = { type: 'ready', clientId: 'test-client', host: { home: '/test' } }

function channel() {
  let wake = gates()
  const queued = []
  return {
    push(frame) { queued.push(frame); wake.resolve() },
    async *read(signal) {
      const stop = () => wake.resolve()
      signal.addEventListener('abort', stop, { once: true })
      try {
        while (!signal.aborted) {
          if (!queued.length) { await wake.promise; wake = gates(); continue }
          const frame = queued.shift()
          if (frame === end) return
          yield frame
        }
      } finally { signal.removeEventListener('abort', stop) }
    },
  }
}
function fixture(id) {
  const events = [], controls = [], calls = []
  const carrier = wrapHostCarrier({ hostId: id, upstreamVersion: version, carrier: {
    async call(endpoint, _payload, signal) {
      if (endpoint !== 'session/list') {
        await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
        throw new Error('test ended')
      }
      const answer = gates()
      calls.push(answer)
      return answer.promise
    },
    async *open(endpoint, _payload, signal) {
      const stream = channel()
      if (endpoint === '$events') { events.push(stream); yield ready }
      else { assert.equal(endpoint, 'session/control'); controls.push(stream) }
      yield* stream.read(signal)
    },
  } })
  return { carrier, calls, events, controls }
}
async function waitFor(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw Error('fixture did not reach expected state')
    await tick()
  }
}
function setup(t, ids, options = {}) {
  const hosts = Object.fromEntries(ids.map(id => [id, fixture(id)]))
  const hub = new BrowserHostHub({ browserVersion: version, perHost: Object.fromEntries(
    Object.entries(hosts).map(([id, value]) => [id, value.carrier])),
    retryDelayMs: 1, aggregateHostTimeoutMs: 1000, ...options })
  const lives = []
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => {
    for (const life of lives) life.abort()
    for (const host of Object.values(hosts)) for (const call of host.calls) call.resolve(list([]))
    clearInterval(keepAlive)
  })
  const open = (endpoint, page) => {
    const life = new AbortController()
    lives.push(life)
    return { life, stream: hub.openStream(endpoint, { args: {}, __pageId: page, __directoryRefresh: true }, life.signal) }
  }
  const read = page => hub.call('session/list', { args: { _request: {} }, __pageId: page })
  return { hosts, open, read, hub }
}

test('one shared directory read survives another page leaving', async t => {
  const { hosts: { peer }, open, read } = setup(t, ['peer'])
  const a = open('$events', 'a'), b = open('$events', 'b')
  await a.stream.next(); await b.stream.next()
  const first = read('a'), healthy = read('b')
  await waitFor(() => peer.calls.length === 1)
  a.life.abort(); await a.stream.return()
  peer.calls[0].resolve(list(['kept']))
  assert.equal((await healthy).value.items[0].sessionId, encodeCompositeId('peer', 'kept'))
  assert.equal((await first).ok, false)
})

test('a host retiring after its response invalidates an aggregate still waiting on another host', async t => {
  const { hosts: { fast, slow }, open, read } = setup(t, ['fast', 'slow'])
  const { stream } = open('$events', 'page')
  await stream.next(); await waitFor(() => slow.events.length === 1)
  const old = read('page')
  await waitFor(() => fast.calls.length && slow.calls.length)
  fast.calls[0].resolve(list(['deleted-offline']))
  await tick()
  fast.events[0].push(end)
  await waitFor(() => fast.events.length === 2)
  slow.calls[0].resolve(list(['other']))
  assert.equal((await old).ok, false)
  assert.equal((await stream.next()).value.type, 'directory-refresh')
  const current = read('page')
  await waitFor(() => fast.calls.length === 2 && slow.calls.length === 2)
  fast.calls[1].resolve(list(['created-offline'])); slow.calls[1].resolve(list(['other']))
  assert.deepEqual((await current).value.items.map(x => x.sessionId), [encodeCompositeId('fast','created-offline'), encodeCompositeId('slow','other')])
})

test('omitted host delivers a single invalidation when its first full directory arrives late', async t => {
  const { hosts: { peer }, open, read } = setup(t, ['peer'], { aggregateHostTimeoutMs: 5 })
  const { stream } = open('$events', 'page')
  await stream.next()
  const early = await read('page')
  assert.equal(early.ok, false)
  peer.calls[0].resolve(list(['a', 'b', 'c']))
  assert.deepEqual((await stream.next()).value, { type: 'directory-refresh' })
  peer.events[0].push({ type:'emit', event:'barrier', args:[] })
  assert.equal((await stream.next()).value.event, 'barrier')
})

test('a full directory requested before event readiness is delivered only by HTTP', async t => {
  const { hosts: { peer }, open, read } = setup(t, ['peer'])
  const initial = read('page')
  await waitFor(() => peer.calls.length === 1)
  const { stream } = open('$events', 'page')
  await stream.next()
  peer.calls[0].resolve(list(['a','b']))
  assert.equal((await initial).value.items.length, 2)
  peer.events[0].push({ type:'emit', event:'barrier', args:[] })
  assert.equal((await stream.next()).value.event, 'barrier')
  assert.equal(peer.calls.length, 1)
})

test('live batch retains its sequence and scopes nested inbox and subagent identities', async t => {
  const { hosts: { peer }, open } = setup(t, ['peer'])
  const { stream } = open('session/control','page')
  const first = stream.next(); await waitFor(() => peer.controls.length)
  peer.controls[0].push({ type:'baseline', value:{ projections:{} } }); await first
  const changes = [{key:'title',val:'new'}, {key:'inbox',val:{'next-turn':[{id:'message'}],'next-step':[]}},
    {key:'subagentCatalog',val:[{id:'child'}]}]
  peer.controls[0].push({type:'projection',sessionId:'s',seq:13,changes})
  assert.deepEqual((await stream.next()).value, {type:'projection', sessionId:encodeCompositeId('peer','s'),seq:13,changes:[
    changes[0],{key:'inbox',val:{'next-turn':[{id:encodeCompositeId('peer','message')}],'next-step':[]}},
    {key:'subagentCatalog',val:[{id:encodeCompositeId('peer','child')}]}]})
})

test('sequence rewind retires the page event generation and the next control baseline owns the lower cut', async t => {
  const { hosts: { peer }, open } = setup(t, ['peer'])
  const events = open('$events','page'), ctrl = open('session/control','page')
  await events.stream.next()
  const baseline = seq => ({ type:'baseline',value:{projections:{s:{asOfSeq:seq,values:{title:String(seq)}}}} })
  const first = ctrl.stream.next();await waitFor(() => peer.controls.length)
  peer.controls[0].push(baseline(100));await first
  const next = ctrl.stream.next(), retired = events.stream.next()
  peer.controls[0].push(end);await waitFor(() => peer.controls.length === 2)
  peer.controls[1].push(baseline(10))
  assert.equal((await next).done, true);assert.equal((await retired).done, true)
  const revived = open('$events','page');assert.equal((await revived.stream.next()).value.type,'ready')
  const fresh = open('session/control','page').stream.next();await waitFor(() => peer.controls.length === 3)
  peer.controls[2].push(baseline(10))
  assert.deepEqual((await fresh).value.value.projections[encodeCompositeId('peer','s')],baseline(10).value.projections.s)
})


test('browser coalesces recovery behind an old SDK read and retains failed revisions for a later read', async () => {
  const wires = [], requests = []
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); wires.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send(raw) { const packet = JSON.parse(raw); if (packet.type === 'open') this.id = packet.streamId }
    close() {}
    item(value) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({streamId:this.id,type:'item',value})})) }
  }
  const sandbox = { location:{origin:'http://test.invalid',href:'http://test.invalid/'},console,URL,TextEncoder,TextDecoder,
    Uint8Array,WebSocket:Socket,AbortSignal,fetch(_path, init) {
      const result = gates()
      requests.push({payload:JSON.parse(init.body).payload, result})
      return result.promise
    } }
  sandbox.globalThis = sandbox
  vm.runInNewContext(createBrowserBootstrapScript(), sandbox)
  const transport = sandbox.__DSH_TRANSPORT__
  let flight
  const refresh = () => flight ??= transport.fetch('/api/session/list',{method:'POST',
    body:JSON.stringify({type:'client-request',rpcId:'r',method:'session/list',payload:{args:{_request:{}}}})})
    .then(r => r.json()).finally(() => { flight = undefined })
  const respond = (i, ok) => requests[i].result.resolve({headers:{get:()=>ok?'complete':null},json:async()=>({result:{ok}})})
  sandbox.__DSH_BROWSER_HOST_HUB__.bindColdRestoreReader(()=>undefined,()=>{},refresh)
  const signal = new AbortController()
  const events = transport.openStream('$events',{args:{}},signal.signal)
  const pending = events.next()
  await waitFor(() => wires[0]?.id)
  const emit = () => wires[0].item({type:'directory-refresh'})
  const old = refresh()
  emit();emit()
  assert.equal(requests.length,1)
  respond(0,true);await old;await waitFor(()=>requests.length===2)
  assert.equal(requests[1].payload.__coldRestore.orderedRefresh,'complete')
  emit()
  respond(1,true);await waitFor(()=>requests.length===3)
  respond(2,false);await tick()
  const later = refresh()
  assert.equal(requests[3].payload.__coldRestore.orderedRefresh,'complete')
  respond(3,true);await later
  const normal = refresh()
  assert.equal(requests[4].payload.__coldRestore,undefined)
  respond(4,true);await normal
  wires[0].item({type:'emit',event:'barrier',args:[]})
  assert.equal((await pending).value.event,'barrier')
  signal.abort();await events.return()
})


test('a directory omitted before the page opens its event stream is recovered on first readiness', async t => {
  const { hosts:{peer},open,read }=setup(t,['peer'],{aggregateHostTimeoutMs:5})
  assert.equal((await read('late-page')).ok,false)
  peer.calls[0].resolve(list(['late-session']))
  await tick()
  const {stream}=open('$events','late-page')
  assert.equal((await stream.next()).value.type,'ready')
  assert.equal((await stream.next()).value.type,'directory-refresh')
  const authoritative=read('late-page')
  await waitFor(()=>peer.calls.length===2)
  peer.calls[1].resolve(list(['late-session']))
  assert.equal((await authoritative).value.items[0].sessionId,encodeCompositeId('peer','late-session'))
})

test('a full recovery read expiring goes through the existing retry and can deliver a later successful read', async t => {
  const {hosts:{peer},open,read,hub}=setup(t,['peer'],{aggregateHostTimeoutMs:5,sessionListRefreshTimeoutMs:20})
  const {stream}=open('$events','timed')
  await stream.next()
  const expired=await hub.call('session/list',{args:{_request:{}},__pageId:'timed',__coldRestore:{orderedRefresh:'complete'}})
  assert.equal(expired.ok,false)
  await waitFor(()=>peer.calls.length>=2)
  peer.calls.at(-1).resolve(list(['back']))
  assert.equal((await stream.next()).value.type,'directory-refresh')
  const final=read('timed');await waitFor(()=>peer.calls.length>=3)
  peer.calls.at(-1).resolve(list(['back']))
  assert.equal((await final).value.items.length,1)
})

