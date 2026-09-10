import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import {
  BROWSER_BFF_API_PREFIX,
  BROWSER_BOOTSTRAP_PATH,
  BrowserHostHub,
  HOST_RPC_ALLOWLIST,
  HOST_SELECTOR,
  HostRpcNotAllowedError,
  SessionFollowBootstrapError,
  SelectedHostRequiredError,
  apply,
  createBrowserBootstrapScript,
  decodeCompositeId,
  decodeSyntheticEventId,
  encodeCompositeId,
  encodeSyntheticEventId,
  handleBffRequest,
  installTransportHook,
  registerBff,
  registerBrowserBootstrap
} from '../packages/browser-host-hub-rc1/src/index.js'

const waitForAbort = signal => new Promise(resolve => {
  if (signal?.aborted) return resolve()
  signal?.addEventListener('abort', resolve, { once: true })
})

function framesOf(frames, { signal, throwAfter = false, linger = true } = {}) {
  return (async function* () {
    for (const frame of frames) {
      if (signal?.aborted) return
      yield frame
    }
    if (throwAfter) throw new Error('simulated Host disconnect')
    if (linger) await waitForAbort(signal)
  })()
}

function carrierFor(id, handlers = {}, streams = {}) {
  const calls = []
  let opens = 0
  return {
    calls,
    get opens() { return opens },
    async call(endpoint, payload, signal) {
      calls.push({ endpoint, payload, signal })
      const handler = handlers[endpoint]
      if (handler === undefined) return { ok: true, value: { host: id } }
      return typeof handler === 'function' ? handler(payload, signal) : handler
    },
    open(endpoint, payload, signal) {
      opens++
      const stream = streams[endpoint]
      if (stream === undefined) throw new Error(`no stream ${endpoint}`)
      return typeof stream === 'function' ? stream({ endpoint, payload, signal, opens }) : stream
    }
  }
}

async function collectUntil(iterator, predicate, limit = 24) {
  const values = []
  for (let i = 0; i < limit; i++) {
    const next = await iterator.next()
    if (next.done) break
    values.push(next.value)
    if (predicate(next.value, values)) return values
  }
  throw new Error(`stream did not produce expected frame; got ${JSON.stringify(values)}`)
}

function controllableFrames(ready) {
  const queued = []
  let pendingResolve
  let pendingCleanup
  const push = frame => {
    if (pendingResolve === undefined) {
      queued.push(frame)
      return
    }
    const resolve = pendingResolve
    pendingResolve = undefined
    pendingCleanup?.()
    pendingCleanup = undefined
    resolve(frame)
  }
  const stream = ({ signal }) => (async function* () {
    yield ready
    while (!signal?.aborted) {
      const frame = queued.length > 0 ? queued.shift() : await new Promise(resolve => {
        if (signal?.aborted) return resolve(undefined)
        const onAbort = () => {
          if (pendingResolve !== resolve) return
          pendingResolve = undefined
          pendingCleanup = undefined
          resolve(undefined)
        }
        pendingResolve = resolve
        pendingCleanup = () => signal?.removeEventListener('abort', onAbort)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (frame === undefined || signal?.aborted) return
      yield frame
    }
  })()
  return { push, stream }
}

test('workspace follow aggregates Hosts and maps only documented identity fields', async () => {
  const alpha = carrierFor('alpha', {}, {
    'workspace/follow': ({ signal }) => framesOf([
      { type: 'baseline', value: { items: [{ workspaceId: 'w-a', path: '/a', title: 'A', sessionIds: ['s-a'], createdAt: '1', updatedAt: '1' }], archivedSessionIds: ['s-old-a'] } },
      { type: 'upsert', workspace: { workspaceId: 'w-a2', path: '/a2', title: 'A2', sessionIds: [], createdAt: '2', updatedAt: '2', opaque: { id: 'do-not-touch' } } }
    ], { signal })
  })
  const beta = carrierFor('beta', {}, {
    'workspace/follow': ({ signal }) => framesOf([
      { type: 'baseline', value: { items: [{ workspaceId: 'w-b', path: '/b', title: 'B', sessionIds: ['s-b'], createdAt: '1', updatedAt: '1' }], archivedSessionIds: ['s-old-b'] } }
    ], { signal })
  })
  const hub = new BrowserHostHub({ perHost: new Map([['alpha', alpha], ['beta', beta]]), initialBaselineTimeoutMs: 20 })
  const stream = hub.openStream('workspace/follow', { args: {} })
  const values = await collectUntil(stream, frame => frame.type === 'upsert')
  const baseline = values.find(frame => frame.type === 'baseline')
  assert.deepEqual(baseline.value.items.map(item => item.workspaceId), [encodeCompositeId('alpha', 'w-a'), encodeCompositeId('beta', 'w-b')])
  assert.deepEqual(baseline.value.items.flatMap(item => item.sessionIds), [encodeCompositeId('alpha', 's-a'), encodeCompositeId('beta', 's-b')])
  assert.deepEqual(baseline.value.archivedSessionIds, [encodeCompositeId('alpha', 's-old-a'), encodeCompositeId('beta', 's-old-b')])
  const upsert = values.find(frame => frame.type === 'upsert')
  assert.equal(upsert.workspace.workspaceId, encodeCompositeId('alpha', 'w-a2'))
  assert.deepEqual(upsert.workspace.opaque, { id: 'do-not-touch' })
  await stream.return()
})

test('control baseline namespaces session, queue and job identities while leaving projection/content opaque', async () => {
  const rawProjection = { asOfSeq: 4, values: { custom: { sessionId: 'opaque', content: [{ id: 'opaque' }] } } }
  const queueItem = { id: 'message-1', rpcId: 'request-1', placement: 'queued', message: { id: 'message-1', content: [{ type: 'text', text: 'x', nested: { id: 'opaque' } }] } }
  const job = { id: 'job-1', kind: 'tool', label: 'Tool', status: 'running', startedAt: 1 }
  const alpha = carrierFor('alpha', {}, {
    'session/control': ({ signal }) => framesOf([{ type: 'baseline', value: { queues: { 's-a': [queueItem] }, jobs: { 's-a': [job] }, projections: { 's-a': rawProjection } } }, { type: 'projection', sessionId: 's-a', key: 'custom', value: rawProjection.values.custom, seq: 5 }], { signal })
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, initialBaselineTimeoutMs: 10 })
  const stream = hub.openStream('session/control', { args: {} })
  const values = await collectUntil(stream, frame => frame.type === 'projection')
  const baseline = values.find(frame => frame.type === 'baseline').value
  const sid = encodeCompositeId('alpha', 's-a')
  assert.deepEqual(Object.keys(baseline.queues), [sid])
  assert.equal(baseline.queues[sid][0].id, encodeCompositeId('alpha', 'message-1'))
  assert.equal(baseline.queues[sid][0].rpcId, 'request-1')
  assert.equal(baseline.queues[sid][0].message.id, encodeCompositeId('alpha', 'message-1'))
  assert.deepEqual(baseline.queues[sid][0].message.content, queueItem.message.content)
  assert.equal(baseline.jobs[sid][0].id, encodeCompositeId('alpha', 'job-1'))
  assert.deepEqual(baseline.projections[sid], rawProjection)
  assert.deepEqual(values.at(-1).value, rawProjection.values.custom)
  await stream.return()
})

test('one Host reconnect produces deltas, never a second browser generation baseline', async () => {
  let alphaOpen = 0
  const alpha = carrierFor('alpha', {}, {
    'workspace/follow': ({ signal }) => {
      alphaOpen++
      return alphaOpen === 1
        ? framesOf([{ type: 'baseline', value: { items: [{ workspaceId: 'w-a1', sessionIds: [] }], archivedSessionIds: [] } }], { signal, throwAfter: true, linger: false })
        : framesOf([{ type: 'baseline', value: { items: [{ workspaceId: 'w-a2', sessionIds: [] }], archivedSessionIds: [] } }], { signal })
    }
  })
  const beta = carrierFor('beta', {}, {
    'workspace/follow': ({ signal }) => framesOf([{ type: 'baseline', value: { items: [{ workspaceId: 'w-b', sessionIds: [] }], archivedSessionIds: [] } }], { signal })
  })
  const hub = new BrowserHostHub({ perHost: new Map([['alpha', alpha], ['beta', beta]]), retryDelayMs: 0, initialBaselineTimeoutMs: 30 })
  const stream = hub.openStream('workspace/follow', { args: {} })
  const first = await stream.next()
  assert.equal(first.value.type, 'baseline')
  const firstIds = first.value.value.items.map(item => item.workspaceId)
  assert.ok(firstIds.includes(encodeCompositeId('alpha', 'w-a1')))
  assert.ok(firstIds.includes(encodeCompositeId('beta', 'w-b')))
  const second = await collectUntil(stream, frame => frame.type === 'archived' || frame.type === 'baseline', 32)
  assert.equal(second.some(frame => frame.type === 'baseline'), false)
  assert.ok(second.some(frame => frame.type === 'upsert' && frame.workspace.workspaceId === encodeCompositeId('alpha', 'w-a2')))
  assert.ok(second.some(frame => frame.type === 'remove' && frame.workspaceId === encodeCompositeId('alpha', 'w-a1')))
  assert.deepEqual(second.find(frame => frame.type === 'order').workspaceIds, [encodeCompositeId('alpha', 'w-a2'), encodeCompositeId('beta', 'w-b')])
  assert.ok(alpha.opens >= 2)
  await stream.return()
})

test('late control Host publishes its queue jobs and projections as legal deltas', async () => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const alpha = carrierFor('alpha', {}, {
    'session/control': ({ signal }) => framesOf([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }], { signal })
  })
  const beta = carrierFor('beta', {}, {
    'session/control': async function* ({ signal }) {
      await ready
      yield* framesOf([{ type: 'baseline', value: { queues: { s: [{ id: 'q' }] }, jobs: { s: [] }, projections: { s: { asOfSeq: 7, values: { title: 'fresh' } } } } }], { signal })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha, beta }, initialBaselineTimeoutMs: 0 })
  const stream = hub.openStream('session/control', { args: {} })
  assert.equal((await stream.next()).value.type, 'baseline')
  release()
  const updates = await collectUntil(stream, frame => frame.type === 'projection' || frame.type === 'baseline')
  assert.equal(updates.some(frame => frame.type === 'baseline'), false)
  assert.deepEqual(updates.map(frame => frame.type), ['queue', 'jobs', 'projection'])
  assert.deepEqual(updates.at(-1), { type: 'projection', sessionId: encodeCompositeId('beta', 's'), key: 'title', value: 'fresh', seq: 7 })
  await stream.return()
})

test('queue deltas preserve raw request correlation while keeping session and message identities Host-scoped', async () => {
  const makeHost = hostId => carrierFor(hostId, {}, {
    'session/control': ({ signal }) => framesOf([
      { type: 'baseline', value: { queues: { 'shared-session': [{ id: 'baseline-message', rpcId: 'baseline-request', message: { id: 'baseline-message' } }] }, jobs: {}, projections: {} } },
      { type: 'queue', sessionId: 'shared-session', items: [{ id: 'delta-message', rpcId: 'delta-request', message: { id: 'delta-message' } }] }
    ], { signal })
  })
  const hub = new BrowserHostHub({ perHost: { alpha: makeHost('alpha'), beta: makeHost('beta') }, initialBaselineTimeoutMs: 20 })
  const stream = hub.openStream('session/control', { args: {} })
  const values = await collectUntil(stream, (frame, all) => all.filter(item => item.type === 'queue').length === 2)
  const deltas = values.filter(frame => frame.type === 'queue')
  assert.deepEqual(deltas.map(frame => frame.sessionId).sort(), [encodeCompositeId('alpha', 'shared-session'), encodeCompositeId('beta', 'shared-session')])
  for (const delta of deltas) {
    assert.equal(delta.items[0].rpcId, 'delta-request')
    assert.equal(delta.items[0].id, encodeCompositeId(decodeCompositeId(delta.sessionId).hostId, 'delta-message'))
    assert.equal(delta.items[0].message.id, encodeCompositeId(decodeCompositeId(delta.sessionId).hostId, 'delta-message'))
  }
  await stream.return()
})

test('a late Host preserves live workspace changes and the other Hosts archive sets', async () => {
  let updateAlpha, releaseBeta
  const alphaReady = new Promise(resolve => { updateAlpha = resolve })
  const betaReady = new Promise(resolve => { releaseBeta = resolve })
  const alpha = carrierFor('alpha', {}, {
    'workspace/follow': async function* ({ signal }) {
      yield { type: 'baseline', value: { items: [{ workspaceId: 'old', sessionIds: [] }], archivedSessionIds: [] } }
      await alphaReady
      yield { type: 'upsert', workspace: { workspaceId: 'new', sessionIds: [] } }
      yield { type: 'remove', workspaceId: 'old' }
      yield { type: 'archived', archivedSessionIds: ['s-a'] }
      await waitForAbort(signal)
    }
  })
  const beta = carrierFor('beta', {}, {
    'workspace/follow': async function* ({ signal }) {
      await betaReady
      yield* framesOf([{ type: 'baseline', value: { items: [{ workspaceId: 'b', sessionIds: [] }], archivedSessionIds: ['s-b'] } }], { signal })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha, beta }, initialBaselineTimeoutMs: 0 })
  const stream = hub.openStream('workspace/follow', { args: {} })
  assert.equal((await stream.next()).value.type, 'baseline')
  updateAlpha()
  await collectUntil(stream, frame => frame.type === 'archived')
  releaseBeta()
  const updates = await collectUntil(stream, frame => frame.type === 'archived')
  assert.equal(updates.some(frame => frame.type === 'baseline'), false)
  assert.deepEqual(updates.find(frame => frame.type === 'order').workspaceIds, [encodeCompositeId('alpha', 'new'), encodeCompositeId('beta', 'b')])
  assert.deepEqual(updates.at(-1).archivedSessionIds, [encodeCompositeId('alpha', 's-a'), encodeCompositeId('beta', 's-b')])
  await stream.return()
})

test('projection removal starts a new browser generation instead of fabricating a clear value', async () => {
  let reconnect, generation = 0
  const nextGeneration = new Promise(resolve => { reconnect = resolve })
  const alpha = carrierFor('alpha', {}, {
    'session/control': async function* ({ signal }) {
      generation++
      if (generation === 1) {
        yield { type: 'baseline', value: { queues: {}, jobs: {}, projections: { s: { asOfSeq: 5, values: { question: { pending: true } } } } } }
        await nextGeneration
        throw new Error('generation ended')
      }
      yield* framesOf([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }], { signal })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, retryDelayMs: 0 })
  const stream = hub.openStream('session/control', { args: {} })
  assert.equal((await stream.next()).value.type, 'baseline')
  reconnect()
  assert.equal((await stream.next()).done, true)
  assert.equal(generation, 2)
})

test('an unavailable Host does not block the first healthy aggregate baseline', async () => {
  const alpha = carrierFor('alpha', {}, {
    'workspace/follow': ({ signal }) => framesOf([{ type: 'baseline', value: { items: [{ workspaceId: 'w-a', sessionIds: [] }], archivedSessionIds: [] } }], { signal })
  })
  const beta = carrierFor('beta', {}, {
    'workspace/follow': () => { throw new Error('beta is offline') }
  })
  const hub = new BrowserHostHub({ perHost: { alpha, beta }, retryDelayMs: 1, initialBaselineTimeoutMs: 10 })
  const stream = hub.openStream('workspace/follow', { args: {} })
  const baseline = await stream.next()
  assert.equal(baseline.value.type, 'baseline')
  assert.deepEqual(baseline.value.value.items.map(item => item.workspaceId), [encodeCompositeId('alpha', 'w-a')])
  await stream.return()
})

test('$events exposes one synthetic ready/clientId and routes result by Host + original client/event id', async () => {
  const request = { toolName: 'opaque-tool', data: { id: 'leave-unchanged' } }
  const alpha = carrierFor('alpha', { '$events/result': { ok: true, value: { accepted: true } } }, {
    '$events': ({ signal }) => framesOf([
      { type: 'ready', clientId: 'client-alpha', host: { home: '/alpha' } },
      { type: 'waterfall', event: 'approval/request', eventId: 'event-1', agentId: 'session-a', request }
    ], { signal })
  })
  const beta = carrierFor('beta', {}, {
    '$events': ({ signal }) => framesOf([{ type: 'ready', clientId: 'client-beta', host: { home: '/beta' } }, { type: 'emit', event: 'api-session/status', args: ['opaque'] }], { signal })
  })
  const hub = new BrowserHostHub({ perHost: new Map([['alpha', alpha], ['beta', beta]]), home: '/hub' })
  const stream = hub.openStream('$events', { args: {} })
  const values = await collectUntil(stream, frame => frame.type === 'waterfall' && frame.agentId === encodeCompositeId('alpha', 'session-a'))
  const ready = values.find(frame => frame.type === 'ready')
  const waterfall = values.find(frame => frame.type === 'waterfall')
  assert.equal(values.filter(frame => frame.type === 'ready').length, 1)
  assert.equal(ready.host.home, '/hub')
  assert.deepEqual(waterfall.request, request)
  const decoded = decodeSyntheticEventId(waterfall.eventId)
  assert.deepEqual(decoded, { hostId: 'alpha', clientId: 'client-alpha', eventId: 'event-1' })
  const result = await hub.call('$events/result', { args: { clientId: ready.clientId, eventId: waterfall.eventId, outcome: { kind: 'result', value: { answer: 'ok' } } } })
  assert.deepEqual(result, { ok: true, value: { accepted: true } })
  assert.equal(alpha.calls.at(-1).endpoint, '$events/result')
  assert.deepEqual(alpha.calls.at(-1).payload, { args: { clientId: 'client-alpha', eventId: 'event-1', outcome: { kind: 'result', value: { answer: 'ok' } } } })
  assert.equal(beta.calls.length, 0)
  await stream.return()
})

test('$events maps known session identity events per Host and preserves opaque payloads', async () => {
  const rawId = 'session-same'
  const expected = {
    alpha: {
      running: true,
      parentSessionId: 'parent-alpha',
      error: { code: 'alpha-error', detail: { opaque: true } },
      activity: { kind: 'alpha-activity', detail: { opaque: true } }
    },
    beta: {
      running: false,
      parentSessionId: 'parent-beta',
      error: { code: 'beta-error', detail: { opaque: true } },
      activity: { kind: 'beta-activity', detail: { opaque: true } }
    }
  }
  const unknown = {
    alpha: { untouched: { sessionId: 'opaque-alpha' } },
    beta: { untouched: { sessionId: 'opaque-beta' } }
  }
  const eventsFor = (hostId, clientId) => {
    const values = expected[hostId]
    return [
      { type: 'ready', clientId, host: { home: `/${hostId}` } },
      { type: 'emit', event: 'api-session/status', args: [rawId, values.running] },
      { type: 'emit', event: 'api-session/added', args: [{ sessionId: rawId, parentSessionId: values.parentSessionId, updatedAt: 7, running: values.running, marker: { hostId } }] },
      { type: 'emit', event: 'api-session/removed', args: [rawId] },
      { type: 'emit', event: 'api-session/error', args: [rawId, values.error] },
      { type: 'emit', event: 'api-session/activity', args: [rawId, values.activity] },
      { type: 'emit', event: 'opaque/event', args: [unknown[hostId]] }
    ]
  }
  const alpha = carrierFor('alpha', {}, {
    '$events': ({ signal }) => framesOf(eventsFor('alpha', 'client-alpha'), { signal })
  })
  const beta = carrierFor('beta', {}, {
    '$events': ({ signal }) => framesOf(eventsFor('beta', 'client-beta'), { signal })
  })
  const hub = new BrowserHostHub({ perHost: new Map([['alpha', alpha], ['beta', beta]]) })
  const stream = hub.openStream('$events', { args: {} })
  const values = await collectUntil(stream, (_, frames) => frames.filter(frame => frame.type === 'emit' && frame.event.startsWith('api-session/')).length === 10 && frames.filter(frame => frame.type === 'emit' && frame.event === 'opaque/event').length === 2)
  await stream.return()

  for (const hostId of ['alpha', 'beta']) {
    const hostFrames = values.filter(frame => {
      if (frame.type !== 'emit') return false
      const first = frame.event === 'api-session/added' ? frame.args[0]?.sessionId : frame.args[0]
      return typeof first === 'string' && decodeCompositeId(first).hostId === hostId
    })
    assert.equal(hostFrames.length, 5)
    const status = hostFrames.find(frame => frame.event === 'api-session/status')
    assert.deepEqual(status.args, [encodeCompositeId(hostId, rawId), expected[hostId].running])
    const added = hostFrames.find(frame => frame.event === 'api-session/added')
    assert.deepEqual(added.args[0], {
      sessionId: encodeCompositeId(hostId, rawId),
      parentSessionId: encodeCompositeId(hostId, expected[hostId].parentSessionId),
      updatedAt: 7,
      running: expected[hostId].running,
      marker: { hostId }
    })
    assert.deepEqual(hostFrames.find(frame => frame.event === 'api-session/removed').args, [encodeCompositeId(hostId, rawId)])
    const error = hostFrames.find(frame => frame.event === 'api-session/error')
    assert.equal(error.args[0], encodeCompositeId(hostId, rawId))
    assert.strictEqual(error.args[1], expected[hostId].error)
    const activity = hostFrames.find(frame => frame.event === 'api-session/activity')
    assert.equal(activity.args[0], encodeCompositeId(hostId, rawId))
    assert.strictEqual(activity.args[1], expected[hostId].activity)
    const opaque = values.find(frame => frame.type === 'emit' && frame.event === 'opaque/event' && frame.args[0] === unknown[hostId])
    assert.ok(opaque)
  }
})

test('$events strips the browser Host selector before opening the official Host stream', async () => {
  let openedPayload
  const local = carrierFor('local', {}, {
    '$events': ({ payload, signal }) => {
      openedPayload = payload
      return framesOf([{ type: 'ready', clientId: 'client-local', host: { home: '/local' } }], { signal })
    }
  })
  const hub = new BrowserHostHub({ perHost: { local } })
  const stream = hub.openStream('$events', { __hostId: 'local', args: {} })
  const ready = await stream.next()
  assert.equal(ready.value.type, 'ready')
  assert.deepEqual(openedPayload, { args: {} })
  await stream.return()
})

test('session follow/page decode composite request IDs and preserve all record payloads', async () => {
  const records = [{ seq: 1, type: 'assistant/message', data: { sessionId: 'raw-inside-data', content: [{ id: 'opaque' }] } }]
  const projections = { asOfSeq: 1, values: { custom: { content: [{ id: 'opaque' }] } } }
  const alpha = carrierFor('alpha', {
    'session/page': { ok: true, value: { records, hasMore: false } }
  }, {
    'session/follow': ({ payload, signal }) => {
      assert.equal(payload.args.request.address.sessionId, 'session-a')
      return framesOf([{ type: 'snapshot', header: { id: 'session-a', parentSession: 'parent-a', cwd: '/a' }, cursor: 1, records, hasMore: false, projections }], { signal })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha' })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') }, maxMessages: 1 } } })
  const snapshot = (await stream.next()).value
  assert.equal(snapshot.header.id, encodeCompositeId('alpha', 'session-a'))
  assert.equal(snapshot.header.parentSession, encodeCompositeId('alpha', 'parent-a'))
  assert.strictEqual(snapshot.records, records)
  assert.strictEqual(snapshot.projections, projections)
  await stream.return()
  const page = await hub.call('session/page', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') }, throughSeq: 1 } } })
  assert.strictEqual(page.value.records, records)
  assert.deepEqual(alpha.calls.at(-1).payload.args.request.address, { kind: 'session', sessionId: 'session-a' })
})

test('session follow fails once when the carrier throws before its first snapshot', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': () => {
      opens++
      throw new Error('transport unavailable')
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 0 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => {
    assert.ok(error instanceof SessionFollowBootstrapError)
    assert.equal(error.code, 'browser-host-hub-rc1/session-follow-bootstrap-failed')
    assert.equal(error.details.reason, 'carrier-failed')
    return true
  })
  assert.equal(opens, 1)
})

test('session follow fails once when the first carrier frame is not a snapshot', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': ({ signal }) => {
      opens++
      return framesOf([{ type: 'delta', seq: 1 }], { signal, linger: false })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 0 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => {
    assert.ok(error instanceof SessionFollowBootstrapError)
    assert.equal(error.details.reason, 'invalid-first-frame')
    return true
  })
  assert.equal(opens, 1)
})

test('session follow ends after a valid snapshot when the carrier reaches EOF', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': ({ signal }) => {
      opens++
      return framesOf([{ type: 'snapshot', header: { id: 'session-a' }, cursor: 1 }], { signal, linger: false })
    }
  })
  const beta = carrierFor('beta')
  const hub = new BrowserHostHub({ perHost: { alpha, beta }, selectedHost: 'alpha', retryDelayMs: 0 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  assert.equal((await stream.next()).value.cursor, 1)
  assert.equal((await stream.next()).done, true)
  assert.equal(opens, 1)
  assert.deepEqual((await hub.call('host/describe', { __hostId: 'beta', args: {} })).value, { host: 'beta' })
})

test('session follow ends after a valid snapshot when the carrier errors', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': ({ signal }) => {
      opens++
      return framesOf([{ type: 'snapshot', header: { id: 'session-a' }, cursor: 1 }], { signal, throwAfter: true, linger: false })
    }
  })
  const beta = carrierFor('beta')
  const hub = new BrowserHostHub({ perHost: { alpha, beta }, selectedHost: 'alpha', retryDelayMs: 0 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  assert.equal((await stream.next()).value.cursor, 1)
  assert.equal((await stream.next()).done, true)
  assert.equal(opens, 1)
  assert.deepEqual((await hub.call('host/describe', { __hostId: 'beta', args: {} })).value, { host: 'beta' })
})

test('session follow retries a transient bootstrap failure before yielding one snapshot', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': ({ signal }) => {
      opens++
      if (opens === 1) throw new Error('CARRIER_DISCONNECTED')
      return framesOf([{ type: 'snapshot', header: { id: 'session-a' }, cursor: 1 }], { signal, linger: false })
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 1, maxRetryDelayMs: 2, sessionBootstrapTimeoutMs: 100 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  assert.equal((await stream.next()).value.cursor, 1)
  assert.equal((await stream.next()).done, true)
  assert.equal(opens, 2)
})

test('session follow fails fast on a permanent bootstrap business error', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': () => {
      opens++
      throw new Error('CARRIER_RESULT_HTTP_500')
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 1, sessionBootstrapTimeoutMs: 100 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => error instanceof SessionFollowBootstrapError && error.details.reason === 'carrier-failed')
  assert.equal(opens, 1)
})

test('session follow bounds transient bootstrap retries and releases the request', async () => {
  let opens = 0
  const signals = []
  const alpha = carrierFor('alpha', {}, {
    'session/follow': ({ signal }) => {
      opens++
      signals.push(signal)
      throw new Error('CARRIER_STREAM_ENDED')
    }
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 2, maxRetryDelayMs: 4, sessionBootstrapTimeoutMs: 20 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => error instanceof SessionFollowBootstrapError && error.details.reason === 'carrier-failed')
  assert.ok(opens > 1)
  assert.equal(signals.at(-1).aborted, true)
})

test('session follow timeout aborts a carrier open waiting for signal', async () => {
  let opens = 0
  let openSignal
  const alpha = {
    call: async () => ({ ok: true, value: {} }),
    open: (endpoint, payload, signal) => {
      opens++
      openSignal = signal
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CARRIER_DISCONNECTED')), { once: true }))
    }
  }
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', sessionBootstrapTimeoutMs: 20 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => error instanceof SessionFollowBootstrapError && error.details.reason === 'carrier-failed')
  assert.equal(opens, 1)
  assert.equal(openSignal.aborted, true)
})

test('session follow timeout aborts a carrier waiting for its first frame', async () => {
  let opens = 0
  let streamSignal
  const alpha = {
    call: async () => ({ ok: true, value: {} }),
    async *open(endpoint, payload, signal) {
      opens++
      streamSignal = signal
      await waitForAbort(signal)
    }
  }
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', sessionBootstrapTimeoutMs: 20 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } })
  await assert.rejects(stream.next(), error => error instanceof SessionFollowBootstrapError && error.details.reason === 'carrier-failed')
  assert.equal(opens, 1)
  assert.equal(streamSignal.aborted, true)
})

test('session follow abort cancels transient bootstrap retries without lingering opens', async () => {
  let opens = 0
  const alpha = carrierFor('alpha', {}, {
    'session/follow': () => {
      opens++
      throw new Error('CARRIER_DISCONNECTED')
    }
  })
  const request = new AbortController()
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', retryDelayMs: 5, maxRetryDelayMs: 10, sessionBootstrapTimeoutMs: 500 })
  const stream = hub.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('alpha', 'session-a') } } } }, request.signal)
  const pending = stream.next()
  await new Promise(resolve => setTimeout(resolve, 8))
  request.abort()
  assert.equal((await pending).done, true)
  const opensAfterAbort = opens
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(opens, opensAfterAbort)
})

test('selected Host state is per browser instance and no-ID catalog/directory calls require selection', async () => {
  const alpha = carrierFor('alpha', {
    'host/describe': { ok: true, value: { name: 'alpha' } },
    'session/modelCatalog': { ok: true, value: { default: { provider: 'a', model: 'm' } } },
    'directoryPicker/list': { ok: true, value: { path: '/alpha', entries: [] } },
    'directoryPicker/createDirectory': { ok: true, value: { path: '/alpha/new' } },
    'workspace/create': { ok: true, value: { workspace: { workspaceId: 'workspace-a', path: '/alpha' } } },
  })
  const beta = carrierFor('beta', { 'host/describe': { ok: true, value: { name: 'beta' } } })
  const first = new BrowserHostHub({ perHost: { alpha, beta } })
  const second = new BrowserHostHub({ perHost: { alpha, beta } })
  const withoutSelection = await first.call('host/describe', { args: {} })
  assert.equal(withoutSelection.ok, false)
  assert.equal(withoutSelection.error.code, 'browser-host-hub-rc1/selected-host-required')
  const missing = await first.call('session/modelCatalog', { args: {} })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'browser-host-hub-rc1/selected-host-required')
  first.setSelectedHost('alpha')
  second.setSelectedHost('beta')
  assert.deepEqual((await first.call('host/describe', { args: {} })).value, { name: 'alpha' })
  assert.deepEqual((await second.call('host/describe', { args: {} })).value, { name: 'beta' })
  assert.deepEqual((await first.call('session/modelCatalog', { args: {} })).value.default, { provider: 'a', model: 'm' })
  const listing = await first.call('directoryPicker/list', { [HOST_SELECTOR]: 'alpha', args: { path: '/alpha' } })
  assert.deepEqual(listing.value, { path: '/alpha', entries: [] })
  assert.deepEqual(alpha.calls.at(-1).payload, { args: { path: '/alpha' } })
  const created = await first.call('directoryPicker/createDirectory', { [HOST_SELECTOR]: 'alpha', args: { path: '/alpha', name: 'new' } })
  assert.deepEqual(created.value, { path: '/alpha/new' })
  assert.deepEqual(alpha.calls.at(-1).payload, { args: { path: '/alpha', name: 'new' } })
  const workspace = await first.call('workspace/create', { [HOST_SELECTOR]: 'alpha', args: { path: '/alpha' } })
  assert.equal(workspace.value.workspace.workspaceId, encodeCompositeId('alpha', 'workspace-a'))
  assert.deepEqual(alpha.calls.at(-1).payload, { args: { path: '/alpha' } })
  await assert.rejects(first.call('not/an/endpoint', { args: {} }), HostRpcNotAllowedError)
  await assert.rejects(first.call('workspace/follow', { args: {} }), /stream-only/)
})

test('transport hook emits official response envelopes and rejects arbitrary proxy URLs', async () => {
  const alpha = carrierFor('alpha', { 'session/list': { ok: true, value: { items: [{ sessionId: 's-a', updatedAt: 1, running: false, blank: true }] } } })
  const hub = new BrowserHostHub({ perHost: { alpha }, baseUrl: 'https://browser.test/' })
  const target = {}
  const restore = installTransportHook(hub, target)
  const response = await target.__DSH_TRANSPORT__.fetch('https://browser.test/api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { args: {} } })
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { items: [{ sessionId: encodeCompositeId('alpha', 's-a'), updatedAt: 1, running: false, blank: true }] } }
  })
  const urlResponse = await target.__DSH_TRANSPORT__.fetch(new URL('https://browser.test/api/session/list'), {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-url', method: 'session/list', payload: { args: { _request: {} } } })
  })
  assert.equal(urlResponse.status, 200)
  const rejected = await target.__DSH_TRANSPORT__.fetch('https://evil.test/api/session/list', { method: 'POST', body: '{}' })
  assert.equal(rejected.status, 403)
  const wrongMethod = await target.__DSH_TRANSPORT__.fetch('https://browser.test/api/session/list')
  assert.equal(wrongMethod.status, 405)
  const businessFailure = await new BrowserHostHub({ perHost: { alpha }, baseUrl: 'https://browser.test/' }).fetch('https://browser.test/api/session/modelCatalog', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'session/modelCatalog', payload: { args: {} } })
  })
  assert.equal((await businessFailure.json()).result.error.message.includes('selected Host'), true)
  restore()
  assert.equal(target.__DSH_TRANSPORT__, undefined)
})

test('mixed composite identities fail closed instead of crossing Hosts', async () => {
  const alpha = carrierFor('alpha')
  const beta = carrierFor('beta')
  const hub = new BrowserHostHub({ perHost: { alpha, beta } })
  const payload = { args: { request: { workspaceId: encodeCompositeId('alpha', 'w-a'), beforeWorkspaceId: encodeCompositeId('beta', 'w-b') } } }
  const result = await hub.call('workspace/rename', payload)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser-host-hub-rc1/cross-host-identity')
  assert.equal(alpha.calls.length, 0)
  assert.equal(beta.calls.length, 0)
})

test('a default local selector yields to a single Ubuntu resource identity', async () => {
  const local = carrierFor('local')
  const ubuntu = carrierFor('ubuntu', {
    'session/page': { ok: true, value: { host: 'ubuntu' } }
  })
  const hub = new BrowserHostHub({ perHost: { local, ubuntu } })
  const result = await hub.call('session/page', {
    __hostId: 'local',
    args: { request: { address: { kind: 'session', sessionId: encodeCompositeId('ubuntu', 'session-1') } } }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { host: 'ubuntu' })
  assert.equal(local.calls.length, 0)
  assert.deepEqual(ubuntu.calls.at(-1).payload, { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } })
})

test('a selector cannot hide references belonging to multiple Hosts', async () => {
  const alpha = carrierFor('alpha')
  const beta = carrierFor('beta')
  const hub = new BrowserHostHub({ perHost: { alpha, beta } })
  const result = await hub.call('workspace/rename', {
    __hostId: 'local',
    args: { request: { workspaceId: encodeCompositeId('alpha', 'w-a'), beforeWorkspaceId: encodeCompositeId('beta', 'w-b') } }
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser-host-hub-rc1/cross-host-identity')
  assert.equal(alpha.calls.length, 0)
  assert.equal(beta.calls.length, 0)
})

test('rh1 codec remains canonical and reversible for synthetic event IDs', () => {
  const encoded = encodeCompositeId('主机', '原始/id')
  assert.deepEqual(decodeCompositeId(encoded), { hostId: '主机', rawId: '原始/id' })
  const event = encodeSyntheticEventId('alpha', 'client', 'event')
  assert.deepEqual(decodeSyntheticEventId(event), { hostId: 'alpha', clientId: 'client', eventId: 'event' })
  assert.throws(() => decodeCompositeId(`${encoded}x`))
})

test('forwards the official named session/list wire parameter and maps only session identities', async () => {
  const alpha = carrierFor('alpha', {
    'session/list': ({ args }) => ({ ok: true, value: { items: [{ sessionId: 'session-a', parentSessionId: 'parent-a', updatedAt: 1, running: false, blank: false }], marker: 'opaque' } })
  })
  const beta = carrierFor('beta', {
    'session/list': { ok: true, value: { items: [{ sessionId: 'session-b', updatedAt: 2, running: true, blank: false }] } }
  })
  const hub = new BrowserHostHub({ perHost: { alpha, beta } })
  const request = { cursor: 'official-cursor' }
  const result = await hub.call('session/list', { args: { _request: request } })
  assert.equal(result.ok, true)
  assert.deepEqual(alpha.calls[0].payload, { args: { _request: request } })
  assert.deepEqual(result.value.items.map(item => item.sessionId), [encodeCompositeId('alpha', 'session-a'), encodeCompositeId('beta', 'session-b')])
  assert.equal(result.value.items[0].parentSessionId, encodeCompositeId('alpha', 'parent-a'))
})

test('session/list keeps each Host last successful snapshot across transient partial failures', async () => {
  let localAvailable = true
  let localVersion = 1
  const local = carrierFor('local', {
    'session/list': () => localAvailable
      ? { ok: true, value: { items: [{ sessionId: `local-${localVersion}`, updatedAt: localVersion, running: false, blank: false }] } }
      : { ok: false, error: { code: 'transport/unavailable', message: 'temporary local failure' } }
  })
  const ubuntu = carrierFor('ubuntu', {
    'session/list': { ok: true, value: { items: [{ sessionId: 'ubuntu-1', updatedAt: 1, running: false, blank: false }] } }
  })
  const hub = new BrowserHostHub({ perHost: { local, ubuntu } })
  const payload = { args: { _request: {} } }

  const initial = await hub.call('session/list', payload)
  localAvailable = false
  const partialFailure = await hub.call('session/list', payload)
  localAvailable = true
  localVersion = 2
  const recovered = await hub.call('session/list', payload)

  assert.deepEqual(initial.value.items.map(item => item.sessionId), [
    encodeCompositeId('local', 'local-1'),
    encodeCompositeId('ubuntu', 'ubuntu-1'),
  ])
  assert.deepEqual(partialFailure.value.items.map(item => item.sessionId), [
    encodeCompositeId('local', 'local-1'),
    encodeCompositeId('ubuntu', 'ubuntu-1'),
  ])
  assert.deepEqual(recovered.value.items.map(item => item.sessionId), [
    encodeCompositeId('local', 'local-2'),
    encodeCompositeId('ubuntu', 'ubuntu-1'),
  ])
})

test('session/list returns a healthy Host without waiting indefinitely for another Host', async () => {
  const local = carrierFor('local', {
    'session/list': { ok: true, value: { items: [{ sessionId: 'local-fast', updatedAt: 1, running: false, blank: false }] } }
  })
  const ubuntu = carrierFor('ubuntu', {
    'session/list': (_payload, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'transport/timeout', message: 'timeout' } }), { once: true })
    })
  })
  const hub = new BrowserHostHub({ perHost: { local, ubuntu }, aggregateHostTimeoutMs: 20 })

  const startedAt = Date.now()
  const result = await hub.call('session/list', { args: { _request: {} } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.items.map(item => item.sessionId), [encodeCompositeId('local', 'local-fast')])
  assert.ok(Date.now() - startedAt < 200)
})

test('session/list refreshes a stale snapshot after the fast response deadline', async () => {
  let call = 0
  const local = carrierFor('local', {
    'session/list': async () => {
      call++
      if (call === 1) return { ok: true, value: { items: [{ sessionId: 'before-rename', updatedAt: 1, running: false, blank: false }] } }
      if (call === 2) {
        await new Promise(resolve => setTimeout(resolve, 40))
        return { ok: true, value: { items: [{ sessionId: 'after-rename', updatedAt: 2, running: false, blank: false }] } }
      }
      return { ok: false, error: { code: 'transport/unavailable', message: 'temporary failure' } }
    }
  })
  const hub = new BrowserHostHub({ perHost: { local }, aggregateHostTimeoutMs: 10 })
  const payload = { args: { _request: {} } }

  const initial = await hub.call('session/list', payload)
  const fastStale = await hub.call('session/list', payload)
  await new Promise(resolve => setTimeout(resolve, 60))
  const afterBackgroundRefresh = await hub.call('session/list', payload)

  assert.deepEqual(initial.value.items.map(item => item.sessionId), [encodeCompositeId('local', 'before-rename')])
  assert.deepEqual(fastStale.value.items.map(item => item.sessionId), [encodeCompositeId('local', 'before-rename')])
  assert.deepEqual(afterBackgroundRefresh.value.items.map(item => item.sessionId), [encodeCompositeId('local', 'after-rename')])
})

test('maps finite Terra RPC identity fields without traversing opaque request or result data', async () => {
  for (const endpoint of [
    'subagents/interruptByParent', 'subagents/list', 'subagents/prompt',
    'goals/clear', 'goals/complete', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume',
    'messageFeedback/delete', 'messageFeedback/list', 'messageFeedback/put',
    'commands/execute', 'commands/list', 'fileReferences/list', 'skills/list',
    'settings/describe', 'llm/listProviders', 'pluginInventory/list'
  ]) assert.ok(HOST_RPC_ALLOWLIST.includes(endpoint), endpoint)
  const alpha = carrierFor('alpha', {
    'subagents/list': { ok: true, value: { entries: [{ id: 'child-a', status: 'running', projection: { sessionId: 'opaque' } }], parentAvailable: true } },
    'messageFeedback/list': { ok: true, value: { items: [{ messageId: 'message-a', rating: 'positive' }] } },
    'skills/list': { ok: true, value: { skills: [{ name: 'opaque-skill', description: 'opaque' }] } },
    'settings/describe': { ok: true, value: { settings: [{ id: 'opaque-setting' }] } },
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha' })
  const parentId = encodeCompositeId('alpha', 'parent-a')
  const childId = encodeCompositeId('alpha', 'child-a')
  const listed = await hub.call('subagents/list', { args: { parentSessionId: parentId } })
  assert.equal(alpha.calls.at(-1).payload.args.parentSessionId, 'parent-a')
  assert.equal(listed.value.entries[0].id, childId)
  assert.equal(listed.value.entries[0].projection.sessionId, 'opaque')
  await hub.call('subagents/interruptByParent', { args: { parentSessionId: parentId, childSessionId: childId, mode: 'continuable' } })
  assert.deepEqual(alpha.calls.at(-1).payload.args, { parentSessionId: 'parent-a', childSessionId: 'child-a', mode: 'continuable' })
  await hub.call('subagents/prompt', { args: { request: { parentSessionId: parentId, childSessionId: childId, content: { sessionId: 'opaque' } } } })
  assert.deepEqual(alpha.calls.at(-1).payload.args.request, { parentSessionId: 'parent-a', childSessionId: 'child-a', content: { sessionId: 'opaque' } })
  const feedbackSession = encodeCompositeId('alpha', 'session-a')
  const feedback = await hub.call('messageFeedback/list', { args: { request: { sessionId: feedbackSession, messageId: 'message-a' } } })
  assert.deepEqual(alpha.calls.at(-1).payload.args.request, { sessionId: 'session-a', messageId: 'message-a' })
  assert.equal(feedback.value.items[0].messageId, 'message-a')
  await hub.call('skills/list', { args: { request: { sessionId: feedbackSession } } })
  assert.equal(alpha.calls.at(-1).payload.args.request.sessionId, 'session-a')
  await hub.call('commands/list', { args: { agentId: feedbackSession } })
  assert.equal(alpha.calls.at(-1).payload.args.agentId, 'session-a')
})

test('routes dynamic Cordis inventory and inspect manifest through the selected Host', async () => {
  const local = carrierFor('local', {
    'dynamicCordisRunner/inventory': {
      ok: true,
      value: [{
        pluginId: 'plugin-local',
        agentId: 'session-local',
        packages: [{ packageId: 'package-local', name: 'Local', purpose: 'local', hasHostHalf: true, hasClientHalf: true }],
        activeRun: { pluginRunId: 'run-local', packageId: 'package-local' }
      }]
    },
    'dynamicCordisRunner/syncInspectManifest': { ok: true, value: null }
  })
  const ubuntu = carrierFor('ubuntu', {
    'dynamicCordisRunner/inventory': {
      ok: true,
      value: [{
        pluginId: 'plugin-ubuntu',
        agentId: 'session-ubuntu',
        packages: [{ packageId: 'package-ubuntu', name: 'Ubuntu', purpose: 'ubuntu', hasHostHalf: true, hasClientHalf: false }]
      }]
    },
    'dynamicCordisRunner/syncInspectManifest': { ok: true, value: null }
  })
  const withoutSelection = new BrowserHostHub({ perHost: { local, ubuntu } })
  const rejected = await withoutSelection.call('dynamicCordisRunner/inventory', { args: {} })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'browser-host-hub-rc1/selected-host-required')
  assert.equal(local.calls.length, 0)
  assert.equal(ubuntu.calls.length, 0)
  const hub = new BrowserHostHub({ perHost: { local, ubuntu }, selectedHost: 'local' })

  const localInventory = await hub.call('dynamicCordisRunner/inventory', { args: {} })
  assert.deepEqual(localInventory.value[0], {
    pluginId: 'plugin-local',
    agentId: encodeCompositeId('local', 'session-local'),
    packages: [{ packageId: 'package-local', name: 'Local', purpose: 'local', hasHostHalf: true, hasClientHalf: true }],
    activeRun: { pluginRunId: 'run-local', packageId: 'package-local' }
  })
  assert.deepEqual(local.calls.at(-1).payload, { args: {} })
  assert.equal(ubuntu.calls.length, 0)

  hub.setSelectedHost('ubuntu')
  const providers = [{ id: 'provider', description: 'Provider', methods: [] }]
  const synced = await hub.call('dynamicCordisRunner/syncInspectManifest', { args: { providers } })
  assert.deepEqual(synced, { ok: true, value: null })
  assert.deepEqual(ubuntu.calls.at(-1).payload, { args: { providers } })
  assert.equal(local.calls.length, 1)

  const ubuntuInventory = await hub.call('dynamicCordisRunner/inventory', { args: {} })
  assert.equal(ubuntuInventory.value[0].agentId, encodeCompositeId('ubuntu', 'session-ubuntu'))
  assert.equal(local.calls.length, 1)
})

test('a browser selector is request-scoped and stripped before the official carrier', async () => {
  const alpha = carrierFor('alpha', { 'session/modelCatalog': { ok: true, value: { host: 'alpha' } } })
  const beta = carrierFor('beta', { 'session/modelCatalog': { ok: true, value: { host: 'beta' } } })
  const first = new BrowserHostHub({ perHost: { alpha, beta } })
  const second = new BrowserHostHub({ perHost: { alpha, beta } })
  const firstResult = await first.call('session/modelCatalog', { [HOST_SELECTOR]: 'alpha', args: {} })
  const secondResult = await second.call('session/modelCatalog', { [HOST_SELECTOR]: 'beta', args: {} })
  assert.equal(firstResult.value.host, 'alpha')
  assert.equal(secondResult.value.host, 'beta')
  assert.deepEqual(alpha.calls.at(-1).payload, { args: {} })
  assert.deepEqual(beta.calls.at(-1).payload, { args: {} })
  assert.equal(first.getSelectedHost(), undefined)
  assert.equal(second.getSelectedHost(), undefined)
})

function fakeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
    write(chunk) { this.body += chunk },
    end(chunk = '') { this.body += chunk; this.writableEnded = true }
  }
}

class BootstrapSocket {
  static OPEN = 1
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    BootstrapSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}) })
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value) { this.sent.push(JSON.parse(String(value))) }
  close() { this.readyState = 3; this.emit('close', {}) }
  receive(value) { this.emit('message', { data: JSON.stringify(value) }) }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
}

test('BFF registers auth-gated exact routes and emits the official response envelope', async () => {
  const registered = []
  const upgrades = []
  let authCalls = 0
  const ctx = {
    webServer: {
      register(route) { registered.push(route); return () => { route.removed = true } },
      registerUpgrade(route) { upgrades.push(route); return () => { route.removed = true } },
    },
    connection: { requestRejection() { authCalls++; return undefined } }
  }
  const alpha = carrierFor('alpha', { 'session/list': { ok: true, value: { items: [{ sessionId: 's-a', updatedAt: 1, running: false, blank: true }] } } })
  const hub = new BrowserHostHub({ perHost: { alpha } })
  const dispose = registerBff(ctx, hub, { perHost: { alpha: { carrier: alpha, label: 'Alpha Host', token: 'must-not-leak' } } })
  assert.equal(registered.length, HOST_RPC_ALLOWLIST.length + 1)
  assert.equal(upgrades.length, 1)
  const route = registered.find(item => item.path === `${BROWSER_BFF_API_PREFIX}/session/list`)
  assert.ok(route)
  assert.equal(registered.some(item => item.path === '/api/session/list'), false)
  assert.equal(registered.some(item => item.path === '/api/host.describe'), false)
  const response = fakeResponse()
  await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { args: { _request: {} } } }) }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { items: [{ sessionId: encodeCompositeId('alpha', 's-a'), updatedAt: 1, running: false, blank: true }] } }
  })
  assert.equal(authCalls, 1)
  const malformed = fakeResponse()
  await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, malformed)
  assert.equal(malformed.status, 400)
  const scriptRoute = registered.find(item => item.path === BROWSER_BOOTSTRAP_PATH)
  const scriptResponse = fakeResponse()
  await scriptRoute.handler({ method: 'GET', headers: {} }, scriptResponse)
  assert.equal(scriptResponse.status, 200)
  assert.match(scriptResponse.body, /__DSH_TRANSPORT__/)
  assert.match(scriptResponse.body, /Alpha Host/)
  assert.doesNotMatch(scriptResponse.body, /must-not-leak/)
  assert.doesNotMatch(scriptResponse.body, /dsh-browser-host-selector/)
  dispose()
  assert.ok(registered.every(routeEntry => routeEntry.removed === true))
  assert.ok(upgrades.every(routeEntry => routeEntry.removed === true))
})

test('BFF stream route writes SSE frames and aborts on the browser response close', async () => {
  class CloseableResponse extends EventEmitter {
    constructor() { super(); this.headersSent = false; this.writableEnded = false; this.body = ''; this.status = undefined }
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true }
    write(chunk) { this.body += chunk; queueMicrotask(() => this.emit('close')) }
    end(chunk = '') { this.body += chunk; this.writableEnded = true }
  }
  const ctx = { connection: { requestRejection: () => undefined } }
  const alpha = carrierFor('alpha', {}, {
    'workspace/follow': ({ signal }) => framesOf([{ type: 'baseline', value: { items: [], archivedSessionIds: [] } }], { signal })
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, retryDelayMs: 0 })
  const response = new CloseableResponse()
  await handleBffRequest(ctx, hub, 'workspace/follow', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-stream', method: 'workspace/follow', payload: { args: {} } })
  }, response)
  assert.equal(response.status, 200)
  assert.match(response.headers['Content-Type'], /^text\/event-stream/)
  assert.match(response.body, /data: \{"type":"baseline"/)
  assert.equal(response.writableEnded, true)
})

test('apply keeps Node global transport untouched and injects browser bootstrap before official boot', () => {
  const registered = []
  const injections = []
  const original = globalThis.__DSH_TRANSPORT__
  const ctx = {
    webServer: {
      register(route) { registered.push(route); return () => {} },
      registerUpgrade(route) { registered.push(route); return () => {} },
    },
    connection: { requestRejection: () => undefined },
    perHost: { alpha: carrierFor('alpha') },
    on(event, listener, options) { injections.push({ event, listener, options }); return () => {} },
    effect(register) { return register() }
  }
  const hub = apply(ctx)
  assert.ok(hub instanceof BrowserHostHub)
  assert.equal(globalThis.__DSH_TRANSPORT__, original)
  assert.equal(injections.length, 1)
  const table = [{ kind: 'script', placement: 'head', text: 'official' }]
  injections[0].listener(table)
  assert.equal(table[0].kind, 'script-src')
  assert.equal(table[0].src, BROWSER_BOOTSTRAP_PATH)
  assert.equal(injections[0].options.prepend, true)
  assert.equal(registered.some(route => route.path === BROWSER_BOOTSTRAP_PATH), true)
})

test('bootstrap script provides page-local selection and decorates only same-origin client requests', async () => {
  const calls = []
  BootstrapSocket.instances = []
  const sandbox = {
    location: { href: 'https://browser.test/', origin: 'https://browser.test' },
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    WebSocket: BootstrapSocket,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return { ok: true, status: 200 }
    }
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(createBrowserBootstrapScript(), sandbox)
  assert.equal(sandbox.__DSH_BROWSER_HOST_HUB__.getSelectedHost(), 'local')
  sandbox.__DSH_BROWSER_HOST_HUB__.setSelectedHost('beta')
  await sandbox.__DSH_TRANSPORT__.fetch('/api/session/modelCatalog', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc', method: 'session/modelCatalog', payload: { args: {} } })
  })
  assert.equal(new URL(String(calls[0].input), sandbox.location.href).pathname, `${BROWSER_BFF_API_PREFIX}/session/modelCatalog`)
  const message = JSON.parse(calls[0].init.body)
  assert.equal(message.payload[HOST_SELECTOR], 'beta')
  await sandbox.__DSH_TRANSPORT__.fetch(new URL('https://browser.test/api/session/modelCatalog'), {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-url', method: 'session/modelCatalog', payload: { args: {} } })
  })
  assert.equal(new URL(String(calls[1].input), sandbox.location.href).pathname, `${BROWSER_BFF_API_PREFIX}/session/modelCatalog`)
  assert.equal(JSON.parse(calls[1].init.body).payload[HOST_SELECTOR], 'beta')
  const events = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const firstEventPromise = events.next()
  await new Promise(resolve => setImmediate(resolve))
  const streamSocket = BootstrapSocket.instances[0]
  const streamOpen = streamSocket.sent.find(frame => frame.type === 'open')
  streamSocket.receive({ type: 'item', streamId: streamOpen.streamId, value: { type: 'ready' } })
  const firstEvent = await firstEventPromise
  assert.equal(new URL(String(streamSocket.url), sandbox.location.href).pathname, `${BROWSER_BFF_API_PREFIX}/streams`)
  assert.equal(firstEvent.done, false)
  assert.equal(firstEvent.value.type, 'ready')
  await events.return()
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('https://evil.test/api/session/modelCatalog', { method: 'POST', body: '{}' }), /origin is not allowed/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/api/not-allowlisted', { method: 'POST', body: '{}' }), /not allowlisted/)
})

test('bootstrap directly forwards known subscription channels without Host decoration', async () => {
  const calls = []
  const sandbox = {
    location: { href: 'https://browser.test/', origin: 'https://browser.test' },
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    WebSocket: BootstrapSocket,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return { ok: true, status: 200 }
    }
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(createBrowserBootstrapScript(), sandbox)
  sandbox.__DSH_BROWSER_HOST_HUB__.setSelectedHost('beta')
  const requests = [
    ['/codex-subscription/status', 'status'],
    ['/codex-subscription/usage', 'usage'],
    ['/codex-subscription/preferences/status', 'preferences/status'],
    ['/codex-subscription/preferences/models', 'preferences/models'],
    ['/subscriptions-auth/status', 'status'],
    ['/subscriptions-auth/preferences/models', 'preferences/models']
  ]
  for (const [path, method] of requests) {
    const body = JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}`, method, payload: { keep: 'local' } })
    const input = new URL(path, sandbox.location.href)
    const init = { method: 'POST', body }
    await sandbox.__DSH_TRANSPORT__.fetch(input, init)
    assert.strictEqual(calls.at(-1).input, input)
    assert.strictEqual(calls.at(-1).init, init)
    assert.equal(calls.at(-1).init.body, body)
    assert.equal(JSON.parse(calls.at(-1).init.body).payload[HOST_SELECTOR], undefined)
  }
  assert.equal(calls.length, requests.length)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('https://evil.test/codex-subscription/status', { method: 'POST', body: '{}' }), /origin is not allowed/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/codex-subscription-fake/status', { method: 'POST', body: '{}' }), /transport path is not allowed/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/subscriptions-auth-fake/status', { method: 'POST', body: '{}' }), /transport path is not allowed/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/api/not-allowlisted', { method: 'POST', body: '{}' }), /not allowlisted/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/codex-subscription/status', { method: 'GET', body: '{}' }), /requires POST/)
  assert.throws(() => sandbox.__DSH_TRANSPORT__.fetch('/subscriptions-auth/status', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'rpc', method: 'other', payload: {} }) }), /invalid subscription client-request envelope/)
})

test('bootstrap openStream stays live until its multiplexed stream reaches a terminal frame', async () => {
  BootstrapSocket.instances = []
  const sandbox = {
    location: { href: 'https://browser.test/', origin: 'https://browser.test' },
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    WebSocket: BootstrapSocket,
    fetch: async () => ({ ok: true, status: 200 })
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(createBrowserBootstrapScript(), sandbox)
  const events = sandbox.__DSH_TRANSPORT__.openStream('$events', { args: {} })
  const firstEventPromise = events.next()
  await new Promise(resolve => setImmediate(resolve))
  const socket = BootstrapSocket.instances[0]
  const open = socket.sent.find(frame => frame.type === 'open')
  socket.receive({ type: 'item', streamId: open.streamId, value: { type: 'ready' } })
  const firstEvent = await firstEventPromise
  assert.equal(firstEvent.value.type, 'ready')
  const secondEvent = events.next()
  let settled = false
  void secondEvent.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  socket.receive({ type: 'end', streamId: open.streamId })
  assert.equal((await secondEvent).done, true)
})

test('an open browser receives late local summaries without reload or a second list request', async () => {
  let release
  const local = carrierFor('local', {
    'session/list': () => new Promise(resolve => { release = resolve }),
  }, { '$events': ({ signal }) => framesOf([{ type: 'ready', clientId: 'local-events', host: { home: '/local' } }], { signal }) })
  const hub = new BrowserHostHub({ perHost: { local }, aggregateHostTimeoutMs: 5 })
  const abort = new AbortController()
  const stream = hub.openStream('$events', { args: {} }, abort.signal)
  await stream.next()
  const keepAlive = setTimeout(() => {}, 500)
  try {
    const early = await hub.call('session/list', { args: { _request: {} } })
    assert.equal(early.ok, false)
    const next = stream.next()
    release({ ok: true, value: { items: [{ sessionId: 'android', cwd: 'D:\\project', blank: false, updatedAt: 1 }] } })
    const event = await Promise.race([next, new Promise(resolve => setTimeout(() => resolve(null), 150))])
    assert.ok(event, 'background cache refresh must reach the already open browser')
    assert.equal(event.value.event, 'api-session/added')
    assert.equal(event.value.args[0].sessionId, encodeCompositeId('local', 'android'))
  } finally { clearTimeout(keepAlive); abort.abort(); await stream.return() }
})

test('late list summaries stay Host and session-mutation scoped', async () => {
  let releaseAlpha
  let releaseBeta
  const alphaEvents = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const betaEvents = controllableFrames({ type: 'ready', clientId: 'beta-events', host: { home: '/beta' } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { releaseAlpha = resolve })
  }, { '$events': alphaEvents.stream })
  const beta = carrierFor('beta', {
    'session/list': () => new Promise(resolve => { releaseBeta = resolve })
  }, { '$events': betaEvents.stream })
  let configured = { alpha }
  const hub = new BrowserHostHub({ perHost: () => configured, aggregateHostTimeoutMs: 5 })

  const alphaStream = hub.openStream('$events', { args: {} })
  await alphaStream.next()
  configured = { beta }
  const betaStream = hub.openStream('$events', { args: {} })
  await betaStream.next()
  configured = { alpha, beta }

  const listPromise = hub.call('session/list', { args: { _request: {} } })
  const early = await listPromise
  assert.equal(early.ok, false)

  const deliverAlphaEvent = async frame => {
    const next = alphaStream.next()
    alphaEvents.push(frame)
    const delivered = await next
    assert.equal(delivered.value.type, 'emit')
  }
  await deliverAlphaEvent({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 'renamed', title: 'new title', updatedAt: 2, running: false, blank: false }] })
  await deliverAlphaEvent({ type: 'emit', event: 'api-session/status', args: ['running-change', true] })
  await deliverAlphaEvent({ type: 'emit', event: 'api-session/removed', args: ['removed'] })

  releaseAlpha({ ok: true, value: { items: [
    { sessionId: 'renamed', title: 'old title', updatedAt: 1, running: false, blank: false },
    { sessionId: 'running-change', updatedAt: 1, running: false, blank: false },
    { sessionId: 'removed', updatedAt: 1, running: false, blank: false },
    { sessionId: 'alpha-keep', updatedAt: 1, running: false, blank: false }
  ] } })
  releaseBeta({ ok: true, value: { items: [{ sessionId: 'beta-keep', updatedAt: 1, running: false, blank: false }] } })

  const alphaLate = await alphaStream.next()
  const betaLate = await betaStream.next()
  assert.equal(alphaLate.value.event, 'api-session/added')
  assert.equal(alphaLate.value.args[0].sessionId, encodeCompositeId('alpha', 'alpha-keep'))
  assert.equal(betaLate.value.event, 'api-session/added')
  assert.equal(betaLate.value.args[0].sessionId, encodeCompositeId('beta', 'beta-keep'))
  await alphaStream.return()
  await betaStream.return()
})

test('inflight late list registers only the live replacement events generation', async () => {
  let release
  let endFirst
  let resolveSecondReady
  const secondReady = new Promise(resolve => { resolveSecondReady = resolve })
  const firstStream = ({ signal }) => (async function* () {
    yield { type: 'ready', clientId: 'alpha-events-1', host: { home: '/alpha' } }
    await new Promise(resolve => {
      endFirst = resolve
      signal?.addEventListener('abort', resolve, { once: true })
    })
  })()
  const secondEvents = controllableFrames({ type: 'ready', clientId: 'alpha-events-2', host: { home: '/alpha' } })
  const secondStream = ({ signal }) => (async function* () {
    resolveSecondReady()
    yield* secondEvents.stream({ signal })
  })()
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, { '$events': ({ opens, signal }) => opens === 1 ? firstStream({ signal }) : secondStream({ signal }) })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5, retryDelayMs: 0 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)

  endFirst()
  await secondReady
  await new Promise(resolve => setImmediate(resolve))
  release({ ok: true, value: { items: [{ sessionId: 'replacement-generation', updatedAt: 1, running: false, blank: false }] } })
  const received = await eventsStream.next()
  assert.equal(received.value.event, 'api-session/added')
  assert.equal(received.value.args[0].sessionId, encodeCompositeId('alpha', 'replacement-generation'))
  const next = eventsStream.next()
  secondEvents.push({ type: 'sentinel' })
  assert.equal((await next).value.type, 'sentinel')
  await eventsStream.return()
})

test('a queued late list frame is discarded after its events generation ends', async () => {
  let release
  let endFirst
  let resolveSecondReady
  const secondReady = new Promise(resolve => { resolveSecondReady = resolve })
  const firstStream = ({ signal }) => (async function* () {
    yield { type: 'ready', clientId: 'alpha-events-1', host: { home: '/alpha' } }
    await new Promise(resolve => {
      endFirst = resolve
      signal?.addEventListener('abort', resolve, { once: true })
    })
  })()
  const secondEvents = controllableFrames({ type: 'ready', clientId: 'alpha-events-2', host: { home: '/alpha' } })
  const secondStream = ({ signal }) => (async function* () {
    resolveSecondReady()
    yield* secondEvents.stream({ signal })
  })()
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, { '$events': ({ opens, signal }) => opens === 1 ? firstStream({ signal }) : secondStream({ signal }) })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5, retryDelayMs: 0 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)

  release({ ok: true, value: { items: [{ sessionId: 'stale-generation', updatedAt: 1, running: false, blank: false }] } })
  endFirst()
  await secondReady
  await new Promise(resolve => setImmediate(resolve))
  const next = eventsStream.next()
  secondEvents.push({ type: 'sentinel' })
  assert.equal((await next).value.type, 'sentinel')
  await eventsStream.return()
})

test('late list summaries yield to a newer session control projection', async () => {
  let release
  const events = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const control = controllableFrames({ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, {
    '$events': events.stream,
    'session/control': control.stream
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const controlStream = hub.openStream('session/control', { args: {} })
  await controlStream.next()

  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)
  const projection = controlStream.next()
  control.push({ type: 'projection', sessionId: 'renamed', key: 'title', value: 'new title', seq: 2 })
  assert.equal((await projection).value.type, 'projection')

  release({ ok: true, value: { items: [
    { sessionId: 'renamed', title: 'old title', updatedAt: 1, running: false, blank: false },
    { sessionId: 'still-current', updatedAt: 1, running: false, blank: false }
  ] } })
  const late = await eventsStream.next()
  assert.equal(late.value.event, 'api-session/added')
  assert.equal(late.value.args[0].sessionId, encodeCompositeId('alpha', 'still-current'))
  await controlStream.return()
  await eventsStream.return()
})

test('a session control baseline does not hide a late list summary', async () => {
  let release
  const events = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const control = controllableFrames({ type: 'baseline', value: {
    queues: {},
    jobs: {},
    projections: { existing: { asOfSeq: 2, values: { title: 'current' } } }
  } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, {
    '$events': events.stream,
    'session/control': control.stream
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)
  const controlStream = hub.openStream('session/control', { args: {} })
  const baseline = await controlStream.next()
  assert.equal(baseline.value.type, 'baseline')

  release({ ok: true, value: { items: [{ sessionId: 'existing', title: 'from-list', updatedAt: 1, running: false, blank: false }] } })
  const late = await eventsStream.next()
  assert.equal(late.value.event, 'api-session/added')
  assert.equal(late.value.args[0].sessionId, encodeCompositeId('alpha', 'existing'))
  await controlStream.return()
  await eventsStream.return()
})

test('an inflight late list registers a newly opened events window', async () => {
  let release
  const events = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, { '$events': events.stream })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5 })
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()

  release({ ok: true, value: { items: [{ sessionId: 'new-window', updatedAt: 1, running: false, blank: false }] } })
  const late = await eventsStream.next()
  assert.equal(late.value.event, 'api-session/added')
  assert.equal(late.value.args[0].sessionId, encodeCompositeId('alpha', 'new-window'))
  await eventsStream.return()
})

test('a new events window keeps the list request start version', async () => {
  let release
  const firstEvents = controllableFrames({ type: 'ready', clientId: 'alpha-events-1', host: { home: '/alpha' } })
  const secondEvents = controllableFrames({ type: 'ready', clientId: 'alpha-events-2', host: { home: '/alpha' } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, { '$events': ({ opens, signal }) => (opens === 1 ? firstEvents : secondEvents).stream({ signal }) })
  const hub = new BrowserHostHub({ perHost: { alpha }, aggregateHostTimeoutMs: 5 })
  const firstStream = hub.openStream('$events', { args: {} })
  await firstStream.next()
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)

  const mutation = firstStream.next()
  firstEvents.push({ type: 'emit', event: 'api-session/status', args: ['changed', true] })
  assert.equal((await mutation).value.event, 'api-session/status')
  const secondStream = hub.openStream('$events', { args: {} })
  await secondStream.next()
  release({ ok: true, value: { items: [{ sessionId: 'changed', updatedAt: 1, running: false, blank: false }] } })
  const next = secondStream.next()
  secondEvents.push({ type: 'sentinel' })
  assert.equal((await next).value.type, 'sentinel')
  await firstStream.return()
  await secondStream.return()
})

test('late list summaries never resurrect a Workspace-archived Session', async () => {
  let release
  const events = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const workspace = controllableFrames({ type: 'baseline', value: { items: [], archivedSessionIds: [] } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve }),
    'workspace/archiveSession': { ok: true, value: { archivedSessionIds: ['archived-by-stream', 'archived-by-call'] } }
  }, {
    '$events': events.stream,
    'workspace/follow': workspace.stream
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', aggregateHostTimeoutMs: 5 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const workspaceStream = hub.openStream('workspace/follow', { args: {} })
  await workspaceStream.next()

  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)
  const archived = workspaceStream.next()
  workspace.push({ type: 'archived', archivedSessionIds: ['archived-by-stream'] })
  assert.deepEqual((await archived).value.archivedSessionIds, [encodeCompositeId('alpha', 'archived-by-stream')])
  const archiveCall = await hub.call('workspace/archiveSession', { args: { request: { sessionId: encodeCompositeId('alpha', 'archived-by-call') } } })
  assert.equal(archiveCall.ok, true)

  release({ ok: true, value: { items: [
    { sessionId: 'archived-by-stream', updatedAt: 1, running: false, blank: false },
    { sessionId: 'archived-by-call', updatedAt: 1, running: false, blank: false },
    { sessionId: 'still-current', updatedAt: 1, running: false, blank: false }
  ] } })
  const late = await eventsStream.next()
  assert.equal(late.value.event, 'api-session/added')
  assert.equal(late.value.args[0].sessionId, encodeCompositeId('alpha', 'still-current'))
  await workspaceStream.return()
  await eventsStream.return()
})

test('an authoritative Workspace archive replacement allows late list recovery', async () => {
  let release
  const events = controllableFrames({ type: 'ready', clientId: 'alpha-events', host: { home: '/alpha' } })
  const workspace = controllableFrames({ type: 'baseline', value: { items: [], archivedSessionIds: ['unarchived'] } })
  const alpha = carrierFor('alpha', {
    'session/list': () => new Promise(resolve => { release = resolve })
  }, {
    '$events': events.stream,
    'workspace/follow': workspace.stream
  })
  const hub = new BrowserHostHub({ perHost: { alpha }, selectedHost: 'alpha', aggregateHostTimeoutMs: 5 })
  const eventsStream = hub.openStream('$events', { args: {} })
  await eventsStream.next()
  const workspaceStream = hub.openStream('workspace/follow', { args: {} })
  await workspaceStream.next()
  const early = await hub.call('session/list', { args: { _request: {} } })
  assert.equal(early.ok, false)

  const archiveUpdate = workspaceStream.next()
  workspace.push({ type: 'archived', archivedSessionIds: [] })
  assert.deepEqual((await archiveUpdate).value.archivedSessionIds, [])
  release({ ok: true, value: { items: [{ sessionId: 'unarchived', updatedAt: 1, running: false, blank: false }] } })
  const late = await eventsStream.next()
  assert.equal(late.value.event, 'api-session/added')
  assert.equal(late.value.args[0].sessionId, encodeCompositeId('alpha', 'unarchived'))
  await workspaceStream.return()
  await eventsStream.return()
})
