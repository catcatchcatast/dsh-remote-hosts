import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { CURRENT_RUNTIME_VERSION, createRuntimeInterface } from '../packages/runtime-interface/src/index.js'
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SOURCE_SHA256,
  applyPatch,
  patchImportCoreSource,
  patchImportsSource,
  patchIndexSource,
  patchPersistenceConsumerSource,
  sha256,
} from '../compatibility-patches/dsh-chat-import/apply.mjs'

const sourceRoot = resolve(process.env.DSH_CHAT_IMPORT_SOURCE
  ?? './node_modules/dsh-chat-import')
const currentUpstreamRoot = resolve(process.env.DSH_CURRENT_RUNTIME_NODE_MODULES
  ?? './node_modules')

async function source(relative) {
  return readFile(join(sourceRoot, relative), 'utf8')
}

test('allowlist matches the read-only 0.11.0 candidate and patches every import boundary', { skip: !existsSync(sourceRoot) }, async () => {
  for (const relative of Object.keys(SOURCE_SHA256)) {
    assert.equal(sha256(await source(relative)), SOURCE_SHA256[relative], relative)
  }
  const index = patchIndexSource(await source('index.mjs'))
  const imports = patchImportsSource(await source('lib/imports.mjs'))
  const core = patchImportCoreSource(await source('lib/import-core.mjs'))
  assert.match(index, /const inject = \['runtimeInterface', 'fs', 'tools'\]/)
  assert.doesNotMatch(index, /const inject = \['sessionPersistence'/)
  assert.match(imports, /ctx\.runtimeInterface\?\.sessionPersistence/)
  assert.match(imports, /persistence\.inspect\(dshId\)/)
  assert.doesNotMatch(imports, /ctx\.get\(['"]sessionPersistence['"]\)/)
  assert.doesNotMatch(imports, /info\.events/)
  assert.match(core, /ctx\.runtimeInterface\.sessionPersistence\.create\(meta, events\)/)
  assert.match(core, /ctx\.runtimeInterface\.sessionPersistence\.append\(/)
  assert.doesNotMatch(core, /ctx\.sessionPersistence\.(create|append)/)
  for (const relative of Object.keys(SOURCE_SHA256).filter(item => item.startsWith('lib/') && !['lib/imports.mjs', 'lib/import-core.mjs'].includes(item))) {
    const patched = patchPersistenceConsumerSource(await source(relative), relative)
    assert.doesNotMatch(patched, /ctx\.get\(['"]sessionPersistence['"]\)/, relative)
    assert.doesNotMatch(patched, /ctx\.sessionPersistence\b/, relative)
  }
})

test('applyPatch gates package identity and source hashes, then writes an idempotent target patch', { skip: !existsSync(sourceRoot) }, async () => {
  await assert.rejects(applyPatch({ sourceRoot, targetRoot: sourceRoot }), /SOURCE_TARGET_MUST_DIFFER/)
  const targetRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-target-'))
  try {
    await mkdir(join(targetRoot, 'lib'), { recursive: true })
    await cp(join(sourceRoot, 'package.json'), join(targetRoot, 'package.json'))
    for (const relative of Object.keys(SOURCE_SHA256)) await cp(join(sourceRoot, relative), join(targetRoot, relative))
    const result = await applyPatch({ sourceRoot, targetRoot })
    assert.equal(result.package, PACKAGE_NAME)
    assert.equal(result.version, PACKAGE_VERSION)
    for (const relative of Object.keys(SOURCE_SHA256)) {
      assert.equal(result.sourceHashes[relative], SOURCE_SHA256[relative])
      assert.equal(result.targetHashes[relative], SOURCE_SHA256[relative])
      assert.notEqual(result.patchedHashes[relative], SOURCE_SHA256[relative])
      const patched = await readFile(join(targetRoot, relative), 'utf8')
      assert.match(patched, //)
      assert.doesNotMatch(patched, /ctx\.get\(['"]sessionPersistence['"]\)/, relative)
      assert.doesNotMatch(patched, /ctx\.sessionPersistence\b/, relative)
    }
    await assert.rejects(applyPatch({ sourceRoot, targetRoot }), /anchor count 0|target SHA-256/)

    const manifest = JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8'))
    manifest.name = 'wrong-package'
    await writeFile(join(targetRoot, 'package.json'), JSON.stringify(manifest), 'utf8')
    await assert.rejects(applyPatch({ sourceRoot, targetRoot }), /unexpected package identity/)
  } finally {
    await rm(targetRoot, { recursive: true, force: true })
  }
})

test('patched import-core performs a synthetic current-runtime incremental import end to end', { skip: !existsSync(sourceRoot) }, async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-e2e-'))
  const registryDir = await mkdtemp(join(tmpdir(), 'dsh-chat-import-registry-'))
  try {
    await cp(sourceRoot, targetRoot, { recursive: true })
    await applyPatch({ sourceRoot, targetRoot })
    const { importTranscript } = await import(`${pathToFileURL(join(targetRoot, 'lib/import-core.mjs')).href}?e2e=${Date.now()}-${Math.random()}`)

    const logs = new Map()
    const makeHandle = (id, access) => ({
      access,
      async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
        const events = logs.get(id) ?? []
        return { eventState: 'owned', events: events.slice(offset, offset + length) }
      },
      async append(events) {
        const current = logs.get(id) ?? []
        assert.deepEqual(events.map(item => item.seq), events.map((_, index) => current.length + index))
        logs.set(id, current.concat(events))
      },
      async flush() {},
      async close() {},
    })
    const persistence = {
      async create(meta) {
        if (logs.has(meta.id)) throw Object.assign(new Error(`session "${meta.id}" already exists`), { code: 'session/already-exists' })
        logs.set(meta.id, [])
        return makeHandle(meta.id, 'write')
      },
      async open(id, access) {
        if (!logs.has(id)) throw Object.assign(new Error(`session "${id}" not found`), { code: 'session/not-found' })
        return makeHandle(id, access)
      },
      async stat(id) {
        return logs.has(id) ? { header: { id, version: 0 }, revision: `r-${logs.get(id).length}`, eventCount: 0 } : undefined
      },
      async list() {
        return [...logs.keys()].map(id => ({ header: { id, version: 0 }, revision: `r-${logs.get(id).length}` }))
      },
    }
    const runtimeInterface = createRuntimeInterface({
      upstreamVersion: CURRENT_RUNTIME_VERSION,
      sessionPersistence: persistence,
      sessionController: { list: () => ({ items: [] }), follow() {}, page() {} },
      workspaceController: { follow() {} },
      connection: { requestRejection: () => undefined, authenticatedUrl: value => value },
      subagents: { remoteExportList: () => ({ entries: [], parentAvailable: true }) },
    })
    let raw = 'synthetic-one'
    const target = { displayPath: 'D:/synthetic/history.jsonl' }
    const ctx = {
      runtimeInterface,
      fs: {
        processPath: value => value.displayPath,
        stat: async () => ({ version: raw, size: raw.length, mtimeMs: raw.length }),
        readText: async () => raw,
      },
      get(name) {
        if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
        return undefined
      },
    }
    const convert = (_value, { sourcePath }) => {
      const turns = raw === 'synthetic-one' ? [{ prompt: 'one' }] : [{ prompt: 'one' }, { prompt: 'two' }]
      const events = turns.flatMap((_, index) => [
        { type: 'turn/start', seq: index * 2, time: 1, data: { turn: index + 1 } },
        { type: 'turn/end', seq: index * 2 + 1, time: 1, data: { turn: index + 1 } },
      ])
      return {
        meta: { id: 'import-synthetic', version: 0, createdAt: 1 },
        turns,
        events,
        messages: turns.length,
        toolCalls: 0,
        skipped: 0,
        sourcePath,
      }
    }

    const first = await importTranscript(ctx, target, {}, convert, { registryDir, sourceLabel: 'synthetic', importFormat: 'synthetic' })
    assert.equal(first.status, 'imported')
    assert.deepEqual(logs.get('import-synthetic').map(item => item.seq), [0, 1, 2])

    raw = 'synthetic-two'
    const second = await importTranscript(ctx, target, {}, convert, { registryDir, sourceLabel: 'synthetic', importFormat: 'synthetic' })
    assert.equal(second.status, 'appended')
    assert.equal(second.appendedEvents, 2)
    assert.deepEqual(logs.get('import-synthetic').map(item => item.seq), [0, 1, 2, 3, 4])
  } finally {
    await rm(targetRoot, { recursive: true, force: true })
    await rm(registryDir, { recursive: true, force: true })
  }
})

test('patched incremental import writes through the real current JSONL provider', {
  skip: !existsSync(sourceRoot) || !existsSync(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')),
}, async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-real-e2e-'))
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-real-storage-'))
  const registryDir = await mkdtemp(join(tmpdir(), 'dsh-chat-import-real-registry-'))
  try {
    await cp(sourceRoot, targetRoot, { recursive: true })
    await applyPatch({ sourceRoot, targetRoot })
    const { importTranscript } = await import(`${pathToFileURL(join(targetRoot, 'lib/import-core.mjs')).href}?real=${Date.now()}-${Math.random()}`)
    const { Context } = await import(pathToFileURL(join(currentUpstreamRoot, '@deepseek-ai/cordis/lib/index.js')).href)
    const { default: JsonlSessionPersistence } = await import(pathToFileURL(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href)
    const persistence = new JsonlSessionPersistence(new Context(), { root: storageRoot })
    const runtimeInterface = createRuntimeInterface({
      upstreamVersion: CURRENT_RUNTIME_VERSION,
      historyEpoch: 'synthetic-real-provider',
      sessionPersistence: persistence,
      sessionController: { list: () => ({ items: [] }), follow() {}, page() {} },
      workspaceController: { follow() {} },
      connection: { requestRejection: () => undefined, authenticatedUrl: value => value },
      subagents: { remoteExportList: () => ({ entries: [], parentAvailable: true }) },
    })
    let raw = 'synthetic-one'
    const target = { displayPath: 'D:/synthetic/real-provider-history.jsonl' }
    const ctx = {
      runtimeInterface,
      fs: {
        processPath: value => value.displayPath,
        stat: async () => ({ version: raw, size: raw.length, mtimeMs: raw.length }),
        readText: async () => raw,
      },
      get(name) {
        if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
        return undefined
      },
    }
    const convert = (_value, { sourcePath }) => {
      const turns = raw === 'synthetic-one' ? [{ prompt: 'one' }] : [{ prompt: 'one' }, { prompt: 'two' }]
      const events = turns.flatMap((_, index) => [
        { type: 'turn/start', seq: index * 2, time: 1, data: { turn: index + 1 } },
        { type: 'turn/end', seq: index * 2 + 1, time: 1, data: { turn: index + 1, reason: { kind: 'completed' } } },
      ])
      return { meta: { id: 'real-provider-import', version: 0, createdAt: 1 }, turns, events, messages: turns.length, toolCalls: 0, skipped: 0, sourcePath }
    }

    const first = await importTranscript(ctx, target, {}, convert, { registryDir, sourceLabel: 'synthetic', importFormat: 'synthetic' })
    assert.equal(first.status, 'imported')
    raw = 'synthetic-two'
    const second = await importTranscript(ctx, target, {}, convert, { registryDir, sourceLabel: 'synthetic', importFormat: 'synthetic' })
    assert.equal(second.status, 'appended')
    assert.equal(second.appendedEvents, 2)
    assert.deepEqual(await runtimeInterface.sessionPersistence.inspect('real-provider-import'), {
      exists: true,
      readable: true,
      eventCount: 5,
      legacySourcePath: null,
    })
  } finally {
    await rm(targetRoot, { recursive: true, force: true })
    await rm(storageRoot, { recursive: true, force: true })
    await rm(registryDir, { recursive: true, force: true })
  }
})

test('real candidate converter survives current official query and history page roundtrip', {
  skip: !existsSync(sourceRoot)
    || !existsSync(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'))
    || !existsSync(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-query/lib/index.js'))
    || !existsSync(join(currentUpstreamRoot, '@deepseek-ai/dsh-api-session-controller/lib/index.js')),
}, async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-public-roundtrip-'))
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-import-public-storage-'))
  const registryDir = await mkdtemp(join(tmpdir(), 'dsh-chat-import-public-registry-'))
  const moduleUrl = path => pathToFileURL(path).href
  try {
    await cp(sourceRoot, targetRoot, { recursive: true })
    await applyPatch({ sourceRoot, targetRoot })
    const importCore = await import(`${moduleUrl(join(targetRoot, 'lib/import-core.mjs'))}?public=${Date.now()}-${Math.random()}`)
    const { verifySession } = await import(`${moduleUrl(join(targetRoot, 'lib/verify.mjs'))}?public=${Date.now()}-${Math.random()}`)
    const { convertGeminiJson } = await import(`${moduleUrl(join(targetRoot, 'lib/convert/gemini.mjs'))}?public=${Date.now()}-${Math.random()}`)
    const { Context } = await import(moduleUrl(join(currentUpstreamRoot, '@deepseek-ai/cordis/lib/index.js')))
    const { Session } = await import(moduleUrl(join(currentUpstreamRoot, '@deepseek-ai/dsh-session/lib/index.js')))
    const { SessionQueryEngine } = await import(moduleUrl(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-query/lib/index.js')))
    const { SessionController } = await import(moduleUrl(join(currentUpstreamRoot, '@deepseek-ai/dsh-api-session-controller/lib/index.js')))
    const { default: JsonlSessionPersistence } = await import(moduleUrl(join(currentUpstreamRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')))

    const persistence = new JsonlSessionPersistence(new Context(), { root: storageRoot })
    const runtimeInterface = createRuntimeInterface({
      upstreamVersion: CURRENT_RUNTIME_VERSION,
      historyEpoch: 'synthetic-public-roundtrip',
      sessionPersistence: persistence,
      sessionController: { list: () => ({ items: [] }), follow() {}, page() {} },
      workspaceController: { follow() {} },
      connection: { requestRejection: () => undefined, authenticatedUrl: value => value },
      subagents: { remoteExportList: () => ({ entries: [], parentAvailable: true }) },
    })
    const target = { displayPath: 'D:/synthetic/gemini-history.json' }
    const firstRaw = JSON.stringify({
      sessionId: 'gemini-public-roundtrip',
      startTime: '2026-09-11T00:00:00.000Z',
      directories: ['D:/synthetic/gemini-project'],
      messages: [
        { type: 'user', content: [{ text: 'What is 2+2?' }] },
        { type: 'gemini', model: 'gemini-synthetic', content: '4', toolCalls: [{
          id: 'call-1', name: 'calculator', args: { expression: '2+2' }, status: 'success',
          result: [{ functionResponse: { response: { output: '4' } } }],
        }] },
      ],
    })
    const secondRaw = JSON.stringify({
      sessionId: 'gemini-public-roundtrip',
      startTime: '2026-09-11T00:00:00.000Z',
      directories: ['D:/synthetic/gemini-project'],
      messages: [
        { type: 'user', content: [{ text: 'What is 2+2?' }] },
        { type: 'gemini', model: 'gemini-synthetic', content: '4', toolCalls: [{
          id: 'call-1', name: 'calculator', args: { expression: '2+2' }, status: 'success',
          result: [{ functionResponse: { response: { output: '4' } } }],
        }] },
        { type: 'user', content: [{ text: 'Say it again.' }] },
        { type: 'gemini', model: 'gemini-synthetic', content: 'It is 4.', thoughts: [{ subject: 'Recall', description: 'Use the prior result.' }] },
      ],
    })
    let raw = firstRaw
    const ctx = {
      runtimeInterface,
      fs: {
        processPath: value => value.displayPath,
        stat: async () => ({ version: String(raw.length), size: raw.length, mtimeMs: raw.length }),
        readText: async () => raw,
      },
      get(name) {
        if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
        return undefined
      },
    }
    const convert = (value, args) => convertGeminiJson(value, args)
    const first = await importCore.importTranscript(ctx, target, {}, convert, {
      registryDir,
      sourceLabel: 'Gemini CLI',
      importFormat: 'gemini',
    })
    assert.equal(first.status, 'imported')
    assert.equal(first.sessionId, 'import-gemini-public-roundtrip')

    raw = secondRaw
    const second = await importCore.importTranscript(ctx, target, {}, convert, {
      registryDir,
      sourceLabel: 'Gemini CLI',
      importFormat: 'gemini',
    })
    assert.equal(second.status, 'appended')
    assert.ok(second.appendedEvents > 0)

    const readBack = await runtimeInterface.sessionPersistence.readFrom(first.sessionId, 0)
    assert.equal(readBack.meta.version, 3)
    assert.equal(readBack.meta.id, first.sessionId)
    assert.equal(readBack.meta.cwd, 'D:/synthetic/gemini-project')
    assert.ok(readBack.events.some(item => item.type === 'tool/call' && item.data.callId === 'call-1'))
    const toolResult = readBack.events.find(item => item.type === 'tool/result')
    assert.deepEqual(toolResult.data.message.source, { kind: 'tool', callId: 'call-1' })
    assert.deepEqual(toolResult.data.message.content[0].content, [{ type: 'text', text: '4' }])
    assert.deepEqual(toolResult.sourceEventSeqs, [readBack.events.find(item => item.type === 'tool/call').seq])
    assert.ok(readBack.events.filter(item => item.type === 'assistant/message').every(item => Array.isArray(item.data.stream)))
    const verified = await verifySession(ctx, { sessionId: first.sessionId })
    assert.equal(verified.ok, true)
    assert.equal(verified.eventCount, readBack.events.length)
    assert.equal(verified.turns, 2)
    const restored = Session.fromRestore(first.sessionId, readBack.events, readBack.meta, readBack.inheritedEventCount ?? 0, 'detached')
    const projectedMessages = restored.deriveMessages()
    assert.ok(projectedMessages.some(message => message.role === 'user' && message.content?.[0]?.text === 'What is 2+2?'))
    assert.ok(projectedMessages.some(message => message.role === 'assistant' && message.content?.[0]?.text === '4'))
    assert.ok(projectedMessages.some(message => message.role === 'assistant' && message.content?.[0]?.text === 'It is 4.'))
    assert.ok(projectedMessages.some(message => message.role === 'user' && message.content?.[0]?.type === 'tool-result'
      && message.content[0].toolCallId === 'call-1' && message.content[0].content?.[0]?.text === '4'))

    const queryContext = new Context()
    const sessions = {
      get() { return undefined },
      list() { return [] },
      prepare(id, options) {
        return Session.fromRestore(id, options.seed, options.meta, options.inheritedEventCount, options.eventState)
      },
    }
    queryContext.provide('sessions', sessions)
    queryContext.provide('sessionPersistence', persistence)
    const query = new SessionQueryEngine(queryContext)
    const observed = await query.observeSession(first.sessionId, { projectionMode: 'none' })
    try {
      assert.equal(observed.header.id, first.sessionId)
      assert.equal(observed.header.version, 3)
      assert.equal(observed.header.cwd, 'D:/synthetic/gemini-project')
      assert.equal(observed.events.length, readBack.events.length)
      assert.deepEqual(observed.events.map(item => item.seq), readBack.events.map(item => item.seq))
    } finally {
      await observed[Symbol.asyncDispose]?.()
    }
    const logical = await query.readSession(first.sessionId)
    assert.equal(logical.session.id, first.sessionId)
    assert.equal(logical.session.cwd, 'D:/synthetic/gemini-project')
    assert.equal(logical.events.length, readBack.events.length)

    const fakeControllerContext = {
      reflect: { provide() {} },
      typert: { lookups: { configure() {} }, contexts: { configureHost() {} } },
      sessions,
      sessionQuery: query,
      sessionProjections: { register() {}, stateOf() {}, snapshot() {}, onChanged() { return () => {} } },
      fileUploads: { registerAgentResolver() {} },
      attachments: { imageLimits: {} },
      agents: { get() {}, isOwnedBy() { return false } },
      agentDefaultModel: { currentSelection() { return { provider: 'synthetic', model: 'synthetic' } } },
      workspaceRegistry: { get() {}, list() { return [] } },
      llm: {},
      logger: { warn() {}, error() {} },
      connection: { fetch: { register() {} } },
      on() { return () => {} },
      effect() { return () => {} },
      plugin() { return {} },
      inject() { return {} },
      emit() {},
      get() { return undefined },
    }
    const controller = new SessionController(fakeControllerContext, { nativeOpen: false }, { openPath() {}, revealPath() {} })
    const page = await controller.page({
      address: { kind: 'session', sessionId: first.sessionId },
      throughSeq: readBack.events.at(-1).seq,
      maxMessages: 100,
    }, new AbortController().signal)
    assert.equal(page.hasMore, false)
    const pageEvents = page.records.filter(record => record.type === 'event').map(record => record.event)
    assert.deepEqual(pageEvents.map(item => item.seq), readBack.events.map(item => item.seq))
    assert.ok(pageEvents.some(item => item.type === 'user/message' && item.data.content?.[0]?.text === 'What is 2+2?'))
    assert.ok(pageEvents.some(item => item.type === 'user/message' && item.data.content?.[0]?.text === 'Say it again.'))
    const pageAssistant = pageEvents.filter(item => item.type === 'assistant/message')
    assert.deepEqual(pageAssistant.map(item => item.data.message.content[0].text), ['4', 'It is 4.'])
    const pageToolResult = pageEvents.find(item => item.type === 'tool/result')
    assert.equal(pageToolResult.data.message.source.callId, 'call-1')
    assert.equal(pageToolResult.data.message.content[0].content[0].text, '4')
    assert.deepEqual(pageToolResult.sourceEventSeqs, [pageEvents.find(item => item.type === 'tool/call').seq])
  } finally {
    await rm(targetRoot, { recursive: true, force: true })
    await rm(storageRoot, { recursive: true, force: true })
    await rm(registryDir, { recursive: true, force: true })
  }
})
