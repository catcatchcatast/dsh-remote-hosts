import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURRENT_RUNTIME_VERSION,
  HISTORY_EPOCH_CAPABILITY,
  HISTORY_EPOCH_HEADER,
  LEGACY_HISTORY_EPOCH,
  LEGACY_RUNTIME_VERSION,
  assertHistoryEpoch,
  canonicalToBrowserWire,
  createManagementRpcIngress,
  createHistoryEpoch,
  createRuntimeInterface,
  normalizeRuntimeInterfaceConfig,
  readExpectedHistoryEpoch,
  upstreamToCanonicalWire,
  wrapHostCarrier,
} from '../packages/runtime-interface/src/index.js'

function services() {
  return {
    sessionController: { list: () => ({ items: [] }), follow() {}, page() {} },
    workspaceController: { follow() {} },
    connection: { requestRejection: () => undefined, authenticatedUrl: value => value },
    subagents: { remoteExportList: () => ({ entries: [], parentAvailable: true }) },
  }
}

test('runtime interface binds official controllers behind narrow frozen ports', () => {
  const runtime = createRuntimeInterface(services())
  assert.equal(runtime.session.list().items.length, 0)
  assert.equal(runtime.session.sessionController, undefined)
  assert.equal(runtime.upstreamVersion, LEGACY_RUNTIME_VERSION)
  assert.deepEqual(runtime.describe().historyEpoch, LEGACY_HISTORY_EPOCH)
})

test('local bootstrap endpoint keeps both official contracts on the authenticated loopback origin', () => {
  for (const upstreamVersion of [LEGACY_RUNTIME_VERSION, CURRENT_RUNTIME_VERSION]) {
    const calls = []
    const runtime = createRuntimeInterface({
      ...services(),
      connection: {
        requestRejection: () => undefined,
        authenticatedUrl: value => { calls.push(value); return `${value}?token=opaque` },
      },
      webServer: { host: '127.0.0.1', port: 3182 },
      upstreamVersion,
      ...(upstreamVersion === CURRENT_RUNTIME_VERSION ? { historyEpoch: 'dataset-generation-3' } : {}),
    })
    const endpoint = runtime.localBootstrapEndpoint()
    assert.deepEqual(endpoint, { port: 3182, authenticatedRootUrl: 'http://127.0.0.1:3182/?token=opaque' })
    assert.equal(Object.isFrozen(endpoint), true)
    assert.deepEqual(calls, ['http://127.0.0.1:3182/'])
    assert.throws(() => runtime.localBootstrapEndpoint({ port: 1 }), error => error.code === 'runtime-interface/bootstrap-params-invalid')
  }
})

test('local bootstrap endpoint rejects non-loopback, invalid port, and off-origin authentication', () => {
  for (const host of ['0.0.0.0', '::1', undefined]) {
    const runtime = createRuntimeInterface({ ...services(), webServer: { host, port: 3182 } })
    assert.throws(() => runtime.localBootstrapEndpoint(), error => error.code === 'runtime-interface/bootstrap-loopback-required')
  }
  for (const port of [0, -1, 65536, Number.NaN, '3182']) {
    const runtime = createRuntimeInterface({ ...services(), webServer: { host: '127.0.0.1', port } })
    assert.throws(() => runtime.localBootstrapEndpoint(), error => error.code === 'runtime-interface/bootstrap-port-invalid')
  }
  const runtime = createRuntimeInterface({
    ...services(),
    connection: { requestRejection: () => undefined, authenticatedUrl: () => 'http://untrusted.invalid:3182/?token=opaque' },
    webServer: { host: '127.0.0.1', port: 3182 },
  })
  assert.throws(() => runtime.localBootstrapEndpoint(), error => error.code === 'runtime-interface/bootstrap-url-invalid')
})

test('epoch continuations require one matching header or body value', () => {
  assert.equal(readExpectedHistoryEpoch({ operation: 'snapshot', payload: {} }), undefined)
  assert.throws(() => readExpectedHistoryEpoch({ operation: 'delta', payload: { afterSeq: 3 } }), error => error.code === 'history-epoch-required')
  assert.equal(readExpectedHistoryEpoch({ operation: 'delta', headers: { [HISTORY_EPOCH_HEADER]: 'dataset-1' }, payload: { afterSeq: 3 } }), 'dataset-1')
  assert.throws(() => readExpectedHistoryEpoch({ operation: 'delta', headers: { [HISTORY_EPOCH_HEADER]: 'dataset-1' }, payload: { afterSeq: 3, historyEpoch: 'dataset-2' } }), error => error.code === 'history-epoch-invalid')
  assert.deepEqual(assertHistoryEpoch('dataset-1', 'dataset-1', { required: true }), { historyEpoch: 'dataset-1', historyEpochMode: 'epoch' })
  assert.throws(() => assertHistoryEpoch('old', 'new', { required: true }), error => error.code === 'history-epoch-mismatch' && error.details.baselineRequired === true)
  assert.equal(createHistoryEpoch({ datasetId: 'host-history', sequenceFormatGeneration: 3, generation: 7 }), createHistoryEpoch({ datasetId: 'host-history', sequenceFormatGeneration: 3, generation: 7 }))
  assert.throws(() => readExpectedHistoryEpoch({ operation: 'stream-resume', payload: { sinceSeq: 3 } }), error => error.code === 'history-epoch-required')
})

test('new official contract advertises epoch capability and rejects a missing epoch', () => {
  const runtime = createRuntimeInterface({ ...services(), upstreamVersion: CURRENT_RUNTIME_VERSION, historyEpoch: 'dataset-generation-3' })
  assert.ok(runtime.describe().capabilities.includes(HISTORY_EPOCH_CAPABILITY))
  assert.equal(runtime.describe().historyEpoch, 'dataset-generation-3')
  assert.throws(() => createRuntimeInterface({ ...services(), upstreamVersion: CURRENT_RUNTIME_VERSION }).describe(), error => error.code === 'history-epoch-unavailable')
})

test('carrier maps replacement boundaries through canonical source sequence', async () => {
  const requests = []
  const wrapped = wrapHostCarrier({
    hostId: 'ubuntu', upstreamVersion: LEGACY_RUNTIME_VERSION,
    carrier: {
      async call(endpoint, payload) { requests.push({ endpoint, payload }); return { type: 'event', seq: 8, time: 80, data: {}, surfaceOp: { op: 'replace', start: 2, end: 7 } } },
      async *open() { yield { type: 'event', seq: 9, time: 90, data: {}, surfaceOp: { op: 'replace', start: 3, end: 8 } } },
    },
  })
  const result = await wrapped.call('session/follow', { args: {} })
  assert.deepEqual(requests[0].payload, { args: {} })
  assert.equal(result.sourceSeq, 8)
  assert.deepEqual(result.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 7 })
  const frames = []
  for await (const frame of wrapped.open('session/follow', { args: {} })) frames.push(frame)
  assert.equal(frames[0].sourceSeq, 9)
  assert.equal(canonicalToBrowserWire(result, CURRENT_RUNTIME_VERSION).sourceSeq, undefined)
  assert.deepEqual(canonicalToBrowserWire(result, LEGACY_RUNTIME_VERSION).surfaceOp, { op: 'replace', start: 2, end: 7 })
  assert.deepEqual(canonicalToBrowserWire(upstreamToCanonicalWire({ type: 'event', seq: 4, time: 40, data: {}, surfaceOp: { op: 'replace', start: 1, end: 2 } }), LEGACY_RUNTIME_VERSION).surfaceOp, { op: 'replace', start: 1, end: 2 })
})

test('business session port returns canonical records and bundle config binds a persistent epoch', async () => {
  const runtime = createRuntimeInterface({
    ...services(),
    sessionController: {
      follow: async function * () {
        yield {
          type: 'snapshot',
          header: { version: 1, id: 's', createdAt: 1, seedLength: 2 },
          cursor: 2,
          records: [{ type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 1, time: 10, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['x'] } } }],
          hasMore: false,
          projections: { asOfSeq: 2, values: {} },
        }
      },
    },
  })
  const source = runtime.session.follow({ address: { kind: 'session', sessionId: 's' } })
  const snapshot = (await source.next()).value
  assert.equal(snapshot.header.seedLength, undefined)
  assert.deepEqual(snapshot.header.seed, { isSeeded: true, inheritedEventCount: 2 })
  assert.equal(snapshot.records[0].event.type, 'legacy/assistant-chunk')
  assert.equal(snapshot.records[0].event.sourceSeq, 1)
  assert.equal(canonicalToBrowserWire(snapshot, LEGACY_RUNTIME_VERSION).header.isSeeded, undefined)
  assert.equal(canonicalToBrowserWire(snapshot, LEGACY_RUNTIME_VERSION).header.seedLength, 2)
  assert.deepEqual(normalizeRuntimeInterfaceConfig({
    upstreamVersion: CURRENT_RUNTIME_VERSION,
    historyEpoch: { datasetId: 'dataset', sequenceFormatGeneration: 4, generation: 2 },
  }).historyEpoch, { datasetId: 'dataset', sequenceFormatGeneration: 4, generation: 2 })
  assert.throws(() => normalizeRuntimeInterfaceConfig({ upstreamVersion: CURRENT_RUNTIME_VERSION }), error => error.code === 'history-epoch-unavailable')
})

test('legacy packed rows become current-valid ignorable events and embed an exact assistant stream', () => {
  const wire = upstreamToCanonicalWire({
    records: [
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 2, time: 100, data: { turn: 1, step: 1, index: 0, dt: [4], texts: ['hel', 'lo'] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 4, time: 110, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [] } }, sourceEventSeqs: [2, 3], surfaceOp: 'append' } },
    ],
  }, { hostId: 'ubuntu', upstreamVersion: LEGACY_RUNTIME_VERSION, endpoint: 'session/page' })
  assert.equal(wire.records.length, 3)
  assert.equal(wire.records[0].event.sourceSeq, 2)
  assert.equal(wire.records[0].event.type, 'legacy/assistant-chunk')
  assert.deepEqual(wire.records[2].event.data.stream.map(item => [item.time, item.chunk.text]), [[100, 'hel'], [104, 'lo']])
  const browser = canonicalToBrowserWire(wire)
  assert.equal(browser.records[0].event.sourceSeq, undefined)
  assert.equal(browser.records[2].event.sourceEventSeqs, undefined)
  assert.deepEqual(browser.records[2].event.surfaceOp, 'append')
  const oldBrowser = canonicalToBrowserWire(wire, LEGACY_RUNTIME_VERSION)
  assert.deepEqual(oldBrowser.records[2].event.sourceEventSeqs, [2, 3])
  assert.equal(oldBrowser.records[2].event.streamSourceSeqs, undefined)
  assert.equal(oldBrowser.records[2].event.streamDerived, undefined)
  assert.equal(oldBrowser.records[2].event.data.stream, undefined)
  assert.equal(browser.records[2].event.streamSourceSeqs, undefined)
})

test('management ingress validates its envelope then invokes supplied business dispatch', async () => {
  const calls = []
  const ingress = createManagementRpcIngress({ dispatch: request => { calls.push(request); return { accepted: true } } })
  assert.deepEqual(await ingress({ method: 'hosts.retry', params: { hostId: 'ubuntu' } }), { accepted: true })
  assert.deepEqual(calls[0].params, { hostId: 'ubuntu' })
  await assert.rejects(ingress({ method: 'bad method', params: {} }), error => error.code === 'runtime-interface/invalid-method')
})
