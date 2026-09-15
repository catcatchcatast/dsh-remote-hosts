import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURRENT_RUNTIME_VERSION,
  LEGACY_RUNTIME_VERSION,
  RuntimeInterfaceError,
  createRuntimeInterface,
} from '../packages/runtime-interface/src/index.js'

function runtime(options = {}) {
  return createRuntimeInterface({
    sessionController: { list: () => ({ items: [] }), follow() {}, page() {} },
    workspaceController: { follow() {} },
    connection: { requestRejection: () => undefined, authenticatedUrl: value => value },
    subagents: { remoteExportList: () => ({ entries: [], parentAvailable: true }) },
    ...options,
  })
}

function event(seq, type = 'turn/end', data = {}) {
  return { seq, type, data }
}

test('legacy persistence is presented as a frozen metadata and write port', async () => {
  const calls = []
  const service = {
    list: async () => [{ id: 'legacy-1', version: 0 }],
    inspect: async id => {
      calls.push(['inspect', id])
      return { meta: { id }, events: [
        event(0),
        event(1, 'session/imported', { sourcePath: 'D:/synthetic/source.jsonl' }),
      ] }
    },
    create: async meta => calls.push(['create', meta.id]),
    append: async (id, events) => calls.push(['append', id, events.map(item => item.seq)]),
  }
  const port = runtime({ upstreamVersion: LEGACY_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  assert.deepEqual(await port.listIds(), ['legacy-1'])
  const info = await port.inspect('legacy-1')
  assert.deepEqual(info, {
    exists: true,
    readable: true,
    eventCount: 2,
    legacySourcePath: 'D:/synthetic/source.jsonl',
  })
  assert.equal(Object.isFrozen(info), true)
  await port.create({ id: 'legacy-new', version: 0, createdAt: 1 }, [event(0)])
  assert.deepEqual(calls, [
    ['inspect', 'legacy-1'],
    ['create', 'legacy-new'],
    ['append', 'legacy-new', [0]],
  ])
  assert.equal(port.service, undefined)
})

test('legacy readFrom and list return detached allowlisted snapshots', async () => {
  const sourceHeader = {
    id: 'legacy-read',
    version: 0,
    createdAt: 1,
    cwd: 'D:/synthetic',
    sourceId: 'source-only',
    unsafeHandle: { close() { throw new Error('must not escape') } },
  }
  const sourceEvents = [event(0), event(1, 'session/imported', { sourcePath: 'D:/synthetic/source.jsonl' })]
  const service = {
    list: async () => [{ header: sourceHeader, revision: 'r1' }],
    readFrom: async (id, fromSeq) => ({ meta: sourceHeader, events: sourceEvents.slice(fromSeq), inheritedEventCount: 0 }),
  }
  const port = runtime({ upstreamVersion: LEGACY_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  const headers = await port.list()
  const snapshot = await port.readFrom('legacy-read', 1)
  assert.deepEqual(headers, [{ id: 'legacy-read', version: 0, createdAt: 1, cwd: 'D:/synthetic', sourceId: 'source-only' }])
  assert.deepEqual(snapshot, {
    meta: { id: 'legacy-read', version: 0, createdAt: 1, cwd: 'D:/synthetic', sourceId: 'source-only' },
    events: [sourceEvents[1]],
    inheritedEventCount: 0,
  })
  assert.equal(Object.isFrozen(headers), true)
  assert.equal(Object.isFrozen(headers[0]), true)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.events), true)
  assert.notStrictEqual(snapshot.meta, sourceHeader)
  assert.notStrictEqual(snapshot.events[0], sourceEvents[1])
  assert.equal(snapshot.meta.unsafeHandle, undefined)
})

test('the first import marker owns the legacy source path', async () => {
  const port = runtime({
    upstreamVersion: LEGACY_RUNTIME_VERSION,
    sessionPersistence: {
      inspect: async () => ({ events: [
        event(0, 'session/imported'),
        event(1, 'session/imported', { sourcePath: 'D:/synthetic/later.jsonl' }),
      ] }),
    },
  }).sessionPersistence
  assert.deepEqual(await port.inspect('first-marker'), {
    exists: true,
    readable: true,
    eventCount: 2,
    legacySourcePath: null,
  })
})

test('current persistence ignores best-effort stat count and reads exact bounded chunks', async () => {
  const calls = []
  const allEvents = [
    event(0),
    event(1, 'session/imported', { sourcePath: 'D:/synthetic/current.jsonl' }),
    ...Array.from({ length: 256 }, (_, index) => event(index + 2)),
  ]
  const service = {
    stat: async id => ({ header: { id, version: 0 }, revision: 'r1', eventCount: 1 }),
    open: async (id, access) => {
      calls.push(['open', id, access])
      return {
        async read(offset, length) {
          calls.push(['read', offset, length])
          return { eventState: 'shared-frozen', events: allEvents.slice(offset, offset + length) }
        },
        async close() { calls.push(['close', id]) },
      }
    },
    list: async () => [{ header: { id: 'current-1' }, revision: 'r1' }],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  assert.deepEqual(await port.listIds(), ['current-1'])
  const info = await port.inspect('current-1')
  assert.deepEqual(info, {
    exists: true,
    readable: true,
    eventCount: 258,
    legacySourcePath: 'D:/synthetic/current.jsonl',
  })
  assert.deepEqual(calls, [
    ['open', 'current-1', 'read'],
    ['read', 0, 256],
    ['read', 256, 256],
    ['read', 258, 256],
    ['close', 'current-1'],
  ])
})

test('current create and append use one owned handle each and preserve order', async () => {
  const calls = []
  const records = new Map()
  const headers = []
  const makeHandle = (id, access) => ({
    async append(events) {
      calls.push(['append', id, access, events.map(item => item.seq)])
      const current = records.get(id) ?? []
      records.set(id, current.concat(events))
    },
    async flush() { calls.push(['flush', id, access]) },
    async close() { calls.push(['close', id, access]) },
  })
  const service = {
    async create(meta) {
      calls.push(['create', meta.id])
      headers.push(meta)
      records.set(meta.id, [])
      return makeHandle(meta.id, 'write')
    },
    async open(id, access) {
      calls.push(['open', id, access])
      return makeHandle(id, access)
    },
    stat: async id => records.has(id) ? { header: { id }, revision: 'r' } : undefined,
    list: async () => [...records.keys()].map(id => ({ header: { id }, revision: 'r' })),
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  await port.create({ id: 'ordered', version: 0, createdAt: 1, sourceId: 'source-only' }, [event(0), event(1)])
  await Promise.all([
    port.append('ordered', [event(2)]),
    port.append('ordered', [event(3)]),
  ])
  assert.deepEqual(headers, [{ id: 'ordered', version: 3, createdAt: 1, isSeeded: false }])
  assert.deepEqual(records.get('ordered').map(item => item.seq), [0, 1, 2, 3])
  assert.deepEqual(calls, [
    ['create', 'ordered'],
    ['append', 'ordered', 'write', [0, 1]],
    ['flush', 'ordered', 'write'],
    ['close', 'ordered', 'write'],
    ['open', 'ordered', 'write'],
    ['append', 'ordered', 'write', [2]],
    ['flush', 'ordered', 'write'],
    ['close', 'ordered', 'write'],
    ['open', 'ordered', 'write'],
    ['append', 'ordered', 'write', [3]],
    ['flush', 'ordered', 'write'],
    ['close', 'ordered', 'write'],
  ])
})

test('current readFrom uses bounded detached chunks and closes its read handle', async () => {
  const calls = []
  const sourceHeader = { id: 'current-read', version: 3, createdAt: 1, cwd: 'D:/synthetic', isSeeded: false }
  const sourceEvents = Array.from({ length: 3 }, (_, seq) => event(seq))
  const service = {
    async open(id, access) {
      calls.push(['open', id, access])
      return {
        header: sourceHeader,
        inheritedEventCount: 1,
        async read(offset, length) {
          calls.push(['read', offset, length])
          return { eventState: 'shared-frozen', events: sourceEvents.slice(offset, offset + length) }
        },
        async close() { calls.push(['close', id]) },
      }
    },
    stat: async () => ({ header: sourceHeader, revision: 'r1' }),
    list: async () => [{ header: sourceHeader, revision: 'r1' }],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  const snapshot = await port.readFrom('current-read', 1)
  assert.deepEqual(snapshot, {
    meta: sourceHeader,
    events: [sourceEvents[1], sourceEvents[2]],
    inheritedEventCount: 1,
  })
  assert.deepEqual(calls, [
    ['open', 'current-read', 'read'],
    ['read', 1, 256],
    ['read', 3, 256],
    ['close', 'current-read'],
  ])
  assert.notStrictEqual(snapshot.meta, sourceHeader)
  assert.notStrictEqual(snapshot.events[0], sourceEvents[1])
})

test('current detached reads close the handle when a later chunk fails', async () => {
  let closeCalls = 0
  const service = {
    stat: async () => ({ header: { id: 'read-failure', version: 3, createdAt: 1 }, revision: 'r1' }),
    list: async () => [],
    open: async () => ({
      header: { id: 'read-failure', version: 3, createdAt: 1 },
      async read() { throw new Error('synthetic detached read failure') },
      async close() { closeCalls++ },
    }),
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  await assert.rejects(port.readFrom('read-failure'), /synthetic detached read failure/)
  assert.equal(closeCalls, 1)
})

test('current writer supplies a lossless empty stream for legacy assistant messages', async () => {
  const records = []
  const oldAssistant = {
    type: 'assistant/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'imported answer' }],
        source: { kind: 'model', provider: 'synthetic', model: 'synthetic-model' },
      },
    },
  }
  const currentAssistant = {
    ...oldAssistant,
    seq: 1,
    data: { ...oldAssistant.data, stream: [{ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'kept' } }] },
  }
  const service = {
    async create() {
      return {
        async append(events) { records.push(...events) },
        async flush() {},
        async close() {},
      }
    },
    stat: async () => undefined,
    open: async () => { throw new Error('append handle must not be opened during create') },
    list: async () => [],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  await port.create({ id: 'legacy-assistant', version: 0, createdAt: 1 }, [oldAssistant, currentAssistant])
  assert.equal(oldAssistant.data.stream, undefined)
  assert.deepEqual(records[0].data.stream, [])
  assert.deepEqual(records[0].data.message.content, oldAssistant.data.message.content)
  assert.equal(records[0].surfaceOp, 'append')
  assert.strictEqual(records[1], currentAssistant)
})

test('read handles close in finally and write failures become non-replayable', async () => {
  let closeCalls = 0
  let appendCalls = 0
  const service = {
    stat: async id => ({ header: { id }, revision: 'r' }),
    open: async (_id, access) => access === 'read'
      ? {
          async read() { throw new Error('synthetic read failure') },
          async close() { closeCalls++ },
        }
      : {
          async append() { appendCalls++; throw new Error('synthetic uncertain failure') },
          async flush() { throw new Error('flush must not run') },
          async close() { closeCalls++ },
        },
    list: async () => [],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  assert.deepEqual(await port.inspect('broken'), {
    exists: true,
    readable: false,
    eventCount: null,
    legacySourcePath: null,
  })
  await assert.rejects(port.append('broken', [event(0)]), error => error.code === 'runtime-interface/write-outcome-unknown')
  await assert.rejects(port.append('broken', [event(0)]), error => error.code === 'runtime-interface/write-outcome-unknown')
  assert.equal(closeCalls, 2)
  assert.equal(appendCalls, 1)
})

test('duplicate creation remains a known admission error', async () => {
  const duplicate = Object.assign(new Error('session "same" already exists in this backend'), { code: 'session/already-exists' })
  const service = {
    stat: async () => undefined,
    open: async () => { throw duplicate },
    create: async () => { throw duplicate },
    list: async () => [],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  await assert.rejects(port.create({ id: 'same', version: 0, createdAt: 1 }, [event(0)]), error => error === duplicate)
  assert.equal(duplicate instanceof RuntimeInterfaceError, false)
})

test('unknown current create outcomes are fenced from replay', async () => {
  let createCalls = 0
  const service = {
    stat: async () => undefined,
    create: async () => {
      createCalls++
      throw new Error('synthetic storage timeout after admission')
    },
    open: async () => { throw new Error('open must not run') },
    list: async () => [],
  }
  const port = runtime({ upstreamVersion: CURRENT_RUNTIME_VERSION, sessionPersistence: service }).sessionPersistence
  await assert.rejects(port.create({ id: 'uncertain-create', version: 0, createdAt: 1 }, [event(0)]), error => error.code === 'runtime-interface/write-outcome-unknown')
  await assert.rejects(port.create({ id: 'uncertain-create', version: 0, createdAt: 1 }, [event(0)]), error => error.code === 'runtime-interface/write-outcome-unknown')
  assert.equal(createCalls, 1)
})
