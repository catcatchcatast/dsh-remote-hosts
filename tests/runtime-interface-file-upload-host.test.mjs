// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
// 原混合上传测试保留Host五用例；原UI适配器已由原生实现替代，原件见归档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {apply as applyFileUploadHost} from '../packages/file-upload-compat-rc1/src/index.js'
import {createCarrier} from '../packages/runtime-interface/src/http-carrier.js'
import {createFileUploadHostBinding,createFileUploadHostBoundary,FileUploadConfig} from '../packages/runtime-interface/src/file-upload-host.js'
test('host adapter keeps tool, filesystem, observations, authenticated routes, and session projections inside the interface', async () => {
  const seen = { registration: undefined, observation: undefined, route: undefined, prompt: undefined }
  const signal = new AbortController().signal
  const officialTarget = { displayPath: '/workspace/report.pdf', targetKey: 'fs-target-1' }
  const officialAgent = { officialAgent: true }
  const uploadReceipt = { receiptId: 'receipt-1', file: { attachmentId: 'attachment-1', name: 'report.pdf', bytes: 17 } }
  const ctx = {
    fs: {
      async resolve(path, options) { seen.resolve = { path, options }; return officialTarget },
      async stat(target, receivedSignal) { seen.stat = { target, receivedSignal }; return { type: 'file', size: 3, version: 'v7' } },
      async readBytes(target, receivedSignal, maxBytes) { seen.read = { target, receivedSignal, maxBytes }; return Uint8Array.of(1, 2, 3) },
    },
    tools: { register(definition) { seen.registration = definition; return () => {} } },
    systemPrompt: { section(value) { seen.prompt = value; return () => {} } },
    webServer: { register(route) { seen.route = route; return () => {} } },
    connection: { requestRejection(request) { return request.rejected ? 403 : undefined } },
    sessions: {
      get(id) { return id === 's1' ? { header: { cwd: '/workspace' } } : undefined },
      list() { return [{ header: { cwd: '/workspace' } }, { header: {} }] },
    },
    credentials: { async resolve(reference) { seen.credentialRef = reference; return { value: 'secret-value' } } },
    attachments: { imageLimits: { maxImageBytes: 900, mediaTypes: ['image/png'] } },
    llm: { async resolveModelInfo(provider, model) { seen.model = { provider, model }; return { inputModalities: ['text', 'image'] } } },
    agents: { get() { return officialAgent } },
    agentDefaultModel: { currentSelection() { return { provider: 'default-provider', model: 'default-model' } } },
    sessionPersistence: { async list() { return [{ header: { id: 'cold-1', cwd: '/cold-session' } }, { id: 'cold-2', cwd: '/ignored' }] } },
    fileUploads: {
      async upload(agent, request, receivedSignal) { seen.officialUpload = { agent, request, receivedSignal }; return uploadReceipt },
      async uploadStream(request) { seen.streamUpload = request; return uploadReceipt },
      resolve(agent, receiptId) { seen.receiptLookup = { agent, receiptId }; return uploadReceipt.file },
      bindPrompt(agent, receiptIds, requestId) {
        seen.promptBinding = { agent, receiptIds, requestId }
        return { commit() { seen.bindingCommitted = true }, dispose() { seen.bindingDisposed = true } }
      },
      retirePrompt(agent, requestId) { seen.retiredPrompt = { agent, requestId } },
      registerAgentResolver(resolve) { seen.agentResolver = resolve; return () => {} },
    },
    get(name) {
      return ({ llm: this.llm, agents: this.agents, agentDefaultModel: this.agentDefaultModel, attachments: this.attachments, sessionPersistence: this.sessionPersistence, fileUploads: this.fileUploads })[name]
    },
    emit(type, target, observation, execution) { seen.observation = { type, target, observation, execution } },
    effect(setup) { return setup() },
    on(event, handler) { seen.dispose = { event, handler }; return () => {} },
  }
  const installation = createFileUploadHostBoundary(ctx).createInstallation()
  const boundary = installation.port
  const registered = boundary.tools.register({
    name: 'read_document',
    description: 'Read a file',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } } },
    async execute(args, execution) {
      const file = await execution.fs.resolve(args.file_path, { cwd: execution.cwd, signal: execution.signal })
      const stat = await execution.fs.stat(file, execution.signal)
      const bytes = await execution.fs.readBytes(file, execution.signal, 8)
      execution.fs.observe(file, { kind: 'present', revision: stat.revision }, execution)
      return { path: file.path, size: stat.size, byteLength: bytes.byteLength, sessionId: execution.sessionId }
    },
  })
  assert.equal(registered, undefined, 'unregister callbacks stay inside the installation scope')
  const officialExecution = {
    signal,
    agent: { session: { id: 's1', header: { cwd: '/workspace' } } },
  }
  const result = await seen.registration.execute({ file_path: 'report.pdf' }, officialExecution)
  assert.deepEqual(result, { path: '/workspace/report.pdf', size: 3, byteLength: 3, sessionId: 's1' })
  assert.deepEqual(seen.resolve, { path: 'report.pdf', options: { cwd: '/workspace', signal } })
  assert.equal(seen.stat.target, officialTarget)
  assert.equal(seen.read.maxBytes, 8)
  assert.deepEqual(seen.observation, {
    type: 'fs/observed', target: officialTarget, observation: { kind: 'present', version: 'v7' },
    execution: officialExecution,
  })
  assert.equal(boundary.sessions.cwd('s1'), '/workspace')
  assert.deepEqual(boundary.sessions.liveCwds(), ['/workspace'])
  assert.deepEqual(await boundary.sessions.persistedCwds(), ['/cold-session', '/ignored'])
  assert.equal(await boundary.sessions.persistedCwd('cold-1'), '/cold-session')
  assert.deepEqual(await boundary.imageCapabilities('s1'), {
    modelAcceptsImages: true,
    imageLimits: { maxImageBytes: 900, mediaTypes: ['image/png'] },
  })
  assert.equal(await boundary.resolveCredential('OPENAI_API_KEY'), 'secret-value')
  assert.equal(seen.credentialRef, 'OPENAI_API_KEY')
  assert.equal(boundary.fileUploads.available, true)
  assert.deepEqual(await boundary.fileUploads.upload('s1', { data: 'YWJj', name: 'report.pdf' }, signal), uploadReceipt)
  assert.deepEqual(seen.officialUpload, { agent: officialAgent, request: { data: 'YWJj', name: 'report.pdf' }, receivedSignal: signal })
  const chunks = (async function* () { yield Uint8Array.of(1, 2) })()
  assert.deepEqual(await boundary.fileUploads.uploadStream({ sessionId: 's1', data: chunks, signal }), uploadReceipt)
  assert.equal(seen.streamUpload.sessionId, 's1')
  assert.equal(seen.streamUpload.data, chunks)
  assert.deepEqual(await boundary.fileUploads.resolve('s1', 'receipt-1'), uploadReceipt.file)
  assert.deepEqual(seen.receiptLookup, { agent: officialAgent, receiptId: 'receipt-1' })
  const binding = await boundary.fileUploads.bindPrompt('s1', ['receipt-1'], 'request-1')
  assert.deepEqual(seen.promptBinding, { agent: officialAgent, receiptIds: ['receipt-1'], requestId: 'request-1' })
  binding.commit()
  binding.dispose()
  assert.equal(seen.bindingCommitted, true)
  assert.equal(seen.bindingDisposed, true)
  assert.equal(await boundary.fileUploads.retirePrompt('s1', 'request-1'), true)
  assert.deepEqual(seen.retiredPrompt, { agent: officialAgent, requestId: 'request-1' })
  boundary.fileUploads.registerAgentResolver(async id => { seen.resolvedSessionId = id })
  assert.equal(await seen.agentResolver('cold-session'), officialAgent)
  assert.equal(seen.resolvedSessionId, 'cold-session')
  boundary.systemPrompt.register({ name: 'tool:read-document', order: 110, text: 'Use the document reader.' })
  assert.equal(seen.prompt.name, 'tool:read-document')
  boundary.routes.registerPrefix('/api/upload/v2/', async (_request, response) => response.end('ok'))
  assert.equal(seen.route.path, '/api/upload/v2/')
  const response = {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
  await seen.route.handler({ rejected: true }, response)
  assert.deepEqual({ status: response.status, body: response.body }, { status: 403, body: 'forbidden' })
  assert.equal(FileUploadConfig.dict.uploadMaxBytes.meta.default, 1024 * 1024 * 1024)
  installation.release()
})

test('optional official host upload service can bind and unload independently', () => {
  const binding = createFileUploadHostBinding({})
  const installation = binding.port.createInstallation()
  assert.equal(installation.port.fileUploads.available, false)
  binding.bindFileUploads({ upload() {}, uploadStream() {} })
  assert.equal(installation.port.fileUploads.available, true)
  binding.bindFileUploads(undefined)
  assert.equal(installation.port.fileUploads.available, false)
  installation.release()
})

test('Host upload installation releases routes, tool, prompt, and sweeper before a clean reload', () => {
  const active = { tools: new Set(), prompts: new Set(), routes: new Map() }
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const timers = new Set()
  let interfaceEffectCalls = 0
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args)
    timers.add(timer)
    return timer
  }
  globalThis.clearInterval = timer => {
    timers.delete(timer)
    return originalClearInterval(timer)
  }
  const config = {
    uploadMaxBytes: 1024, allowedExtensions: [], uploadTtlMs: 60_000, sweepIntervalMs: 60_000,
    maxConcurrentUploads: 1, inlineTextLimit: 16, previewTextLimit: 16, maxFileBytes: 1024,
    readLimit: 20, sheetRowLimit: 20, maxSheets: 1, cacheEntries: 1, cacheMaxBytes: 1024,
    markitdownBin: '__dsh-no-markitdown__', markitdownTimeoutMs: 100, visionEndpoint: '',
    visionModel: '', visionApiKeyEnv: 'OPENAI_API_KEY', visionMaxBytes: 1024, uploadDir: '/tmp/dsh-file-upload-lifecycle',
  }
  const createBinding = failPath => {
    const services = {
      tools: { register(value) { active.tools.add(value.name); return () => active.tools.delete(value.name) } },
      systemPrompt: { section(value) { active.prompts.add(value.name); return () => active.prompts.delete(value.name) } },
      webServer: { register(route) {
        if (route.path === failPath) throw new Error('ROUTE_REGISTRATION_FAILED')
        if (active.routes.has(route.path)) throw new Error(`DUPLICATE_ROUTE:${route.path}`)
        active.routes.set(route.path, route)
        return () => active.routes.delete(route.path)
      } },
      connection: { requestRejection() { return undefined } },
      fs: {}, sessions: { get() { return undefined }, list() { return [] } },
      credentials: {}, attachments: {}, llm: {}, agents: {}, agentDefaultModel: {}, sessionPersistence: { async list() { return [] } },
    }
    return createFileUploadHostBinding({
      ...services,
      get(name) { return services[name] },
      emit() {},
      effect() { interfaceEffectCalls++; throw new Error('interface-owned lifecycle must not register plugin resources') },
      on() { interfaceEffectCalls++; throw new Error('interface-owned lifecycle must not register plugin resources') },
    })
  }
  const apply = binding => {
    const cleanups = []
    applyFileUploadHost({
      fileUploadInterface: binding.port,
      effect(setup) {
        const cleanup = setup()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
    }, config)
    return () => { for (const cleanup of cleanups.reverse()) cleanup() }
  }
  const counts = () => ({ tools: active.tools.size, prompts: active.prompts.size, routes: active.routes.size, sweepers: timers.size })
  try {
    const host = createBinding()
    const firstRelease = apply(host)
    assert.deepEqual(counts(), { tools: 1, prompts: 1, routes: 2, sweepers: 1 })
    firstRelease()
    assert.deepEqual(counts(), { tools: 0, prompts: 0, routes: 0, sweepers: 0 })
    const secondRelease = apply(host)
    assert.deepEqual(counts(), { tools: 1, prompts: 1, routes: 2, sweepers: 1 })
    secondRelease()
    assert.deepEqual(counts(), { tools: 0, prompts: 0, routes: 0, sweepers: 0 })
    assert.equal(interfaceEffectCalls, 0)

    const failing = createBinding('/api/file-browser/v1')
    assert.throws(() => apply(failing), /ROUTE_REGISTRATION_FAILED/)
    assert.deepEqual(counts(), { tools: 0, prompts: 0, routes: 0, sweepers: 0 })
    assert.equal(interfaceEffectCalls, 0)
  } finally {
    for (const timer of timers) originalClearInterval(timer)
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test('compat package retains its Cordis identity and stable configuration export', async () => {
  const plugin = await import('../packages/file-upload-compat-rc1/src/index.js')
  assert.equal(plugin.name, 'dsh-file-upload')
  assert.deepEqual(plugin.inject, ['fileUploadInterface'])
  assert.equal(plugin.Config.dict.uploadMaxBytes.meta.default, 1024 * 1024 * 1024)
})

test('remote carrier forwards the official upload route only as a same-origin POST', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: new URL(input), init })
    if (calls.length === 1) return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'sid=carrier; Path=/' } })
    return new Response('accepted', { status: 200 })
  }
  try {
    const carrier = await createCarrier('http://127.0.0.1:3080', 'http://127.0.0.1:3080/?token=secret', undefined, new AbortController().signal)
    const response = await carrier.raw('/api/session/uploadFileBinary?sessionId=s1', {
      method: 'POST', body: Uint8Array.of(1), headers: { 'content-type': 'application/octet-stream', authorization: 'not-forwarded' },
    })
    assert.equal(response.status, 200)
    assert.equal(calls[1].url.pathname, '/api/session/uploadFileBinary')
    assert.equal(calls[1].init.headers.get('cookie'), 'sid=carrier')
    assert.equal(calls[1].init.headers.has('authorization'), false)
    await assert.rejects(() => carrier.raw('/api/session/uploadFileBinary', { method: 'GET' }), { message: 'CARRIER_METHOD_INVALID' })
    await assert.rejects(() => carrier.raw('/api/session/uploadFileBinary', { method: 'POST', headers: { 'content-type': 'text/plain' } }), { message: 'CARRIER_CONTENT_TYPE_INVALID' })
    await assert.rejects(() => carrier.raw('/api/session/uploadFileBinary/extra', { method: 'POST' }), { message: 'CARRIER_ROUTE_INVALID' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
