
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, CODEX_ALIAS, inject } from '../packages/subscriptions-compat-rc1/src/index.js'

function harness({ descriptor = undefined, proto = undefined, config = {} } = {}) {
  const calls = []
  const llm = proto ? Object.create(proto) : {}
  const registerAdapter = function (providers, adapter) {
    calls.push({ providers, adapter })
    const handle = () => { calls.push({ disposed: true }) }
    handle.replace = next => { calls.push({ replaced: [...next] }) }
    return handle
  }
  if (!proto || descriptor) {
    Object.defineProperty(llm, 'registerAdapter', descriptor ?? {
      configurable: true, enumerable: false, writable: true, value: registerAdapter,
    })
  } else {
    proto.registerAdapter ??= registerAdapter
  }
  const effects = []
  const provided = []
  const injections = []
  const ctx = {
    llm,
    provide(name, value) { provided.push({ name, value }); return () => {} },
    inject(deps, callback) { injections.push({ deps, callback }); return { deps } },
    effect(effect) { const disposer = effect(); effects.push(disposer); return disposer },
  }
  return { calls, llm, ctx, effects, provided, injections, dispose: () => effects.splice(0).forEach(disposer => disposer?.()), config }
}

function adapterStub(log = []) {
  return {
    providerInfo(provider) { log.push(['providerInfo', provider]); return { id: provider, name: provider, extra: true } },
    providerRetryPolicy(provider) { log.push(['retry', provider]); return { provider } },
    imageRequestPricing(provider, model) { log.push(['pricing', provider, model]); return { provider, model } },
    async listModels(provider) { log.push(['list', provider]); return [{ id: provider + '-model' }] },
    async resolveModel(provider, model, signal) { log.push(['resolve', provider, model, signal]); return { provider, id: model, name: model, context: { contextWindow: 1 } } },
    async prepareCall(provider, generation, signal) {
      log.push(['prepare', provider, generation, signal])
      return { model: { provider, id: generation.model }, stream: options => ({ provider, generation, options }) }
    },
    stream(options) { log.push(['stream', options]); return options },
  }
}

test('captures codex registration once and appends an atomic alias', async () => {
  const log = []
  const h = harness({ config: { onCodexAdapter: (...args) => { log.push(['capture', ...args]) } } })
  const dispose = apply(h.ctx, h.config)
  const adapter = adapterStub(log)
  const handle = h.llm.registerAdapter(['codex'], adapter)
  assert.deepEqual(h.calls[0].providers, ['codex', CODEX_ALIAS])
  assert.notEqual(h.calls[0].adapter, adapter)
  assert.equal(log[0][0], 'capture')
  assert.equal(handle.replace instanceof Function, true)
  handle.replace(['codex'])
  assert.deepEqual(h.calls.at(-1), { replaced: ['codex', CODEX_ALIAS] })
  handle.replace(['grok'])
  assert.deepEqual(h.calls.at(-1), { replaced: ['grok'] })
  handle.replace([])
  assert.deepEqual(h.calls.at(-1), { replaced: [] })
  dispose()
})

test('installs the llm wrapper before publishing the readiness gate', () => {
  const h = harness()
  const dispose = apply(h.ctx)
  assert.deepEqual(inject, ['llm'])
  assert.deepEqual(h.provided.map(item => item.name), ['subscriptionsCompatReady'])
  assert.deepEqual(h.injections[0].deps, ['web', 'settings', 'loader'])
  const adapter = adapterStub()
  h.llm.registerAdapter(['codex'], adapter)
  assert.equal(h.calls[0].adapter !== adapter, true)
  dispose()
})

test('alias forwards seven methods, preserves signal/generation, and maps identities', async () => {
  const log = []
  const h = harness()
  const dispose = apply(h.ctx)
  const generation = { model: 'gpt-5.5', stream: 'original-stream' }
  const signal = new AbortController().signal
  h.llm.registerAdapter(['codex'], adapterStub(log))
  const alias = h.calls[0].adapter
  assert.deepEqual(alias.providerInfo(CODEX_ALIAS), { id: CODEX_ALIAS, name: 'codex', extra: true })
  assert.deepEqual(alias.providerRetryPolicy(CODEX_ALIAS), { provider: 'codex' })
  assert.deepEqual(alias.imageRequestPricing(CODEX_ALIAS, 'm'), { provider: 'codex', model: 'm' })
  assert.deepEqual(await alias.listModels(CODEX_ALIAS), [])
  assert.deepEqual(await alias.resolveModel(CODEX_ALIAS, 'm', signal), { provider: CODEX_ALIAS, id: 'm', name: 'm', context: { contextWindow: 1 } })
  const prepared = await alias.prepareCall(CODEX_ALIAS, generation, signal)
  assert.deepEqual(prepared.model, { provider: CODEX_ALIAS, id: generation.model })
  assert.deepEqual(log.find(row => row[0] === 'prepare'), ['prepare', 'codex', generation, signal])
  assert.deepEqual(prepared.stream({ provider: CODEX_ALIAS, model: generation.model }), { provider: 'codex', generation, options: { provider: 'codex', model: generation.model } })
  assert.deepEqual(alias.stream({ provider: CODEX_ALIAS, model: generation.model, signal }), { provider: 'codex', model: generation.model, signal })
  assert.deepEqual(generation, { model: 'gpt-5.5', stream: 'original-stream' })
  dispose()
})

test('non-codex default registration is untouched', () => {
  const h = harness()
  const original = h.llm.registerAdapter
  const dispose = apply(h.ctx)
  const adapter = adapterStub()
  h.llm.registerAdapter(['openai'], adapter)
  assert.equal(h.calls[0].providers[0], 'openai')
  assert.equal(h.calls[0].adapter, adapter)
  assert.equal(h.llm.registerAdapter, h.llm.registerAdapter)
  dispose()
  assert.equal(h.llm.registerAdapter, original)
})

test('only the exact codex route is captured and incomplete adapters fail closed', () => {
  const h = harness()
  const dispose = apply(h.ctx)
  const adapter = adapterStub()
  h.llm.registerAdapter(['codex-compatible'], adapter)
  assert.deepEqual(h.calls[0].providers, ['codex-compatible'])
  assert.equal(h.calls[0].adapter, adapter)
  assert.throws(() => h.llm.registerAdapter(['codex'], { stream() {} }), /missing providerInfo\(\)/)
  dispose()
})

test('dispose restores exact own descriptor and does not clobber a later wrapper', () => {
  const original = function () {}
  const descriptor = { configurable: true, enumerable: false, writable: false, value: original }
  const h = harness({ descriptor })
  const dispose = apply(h.ctx)
  const installed = Object.getOwnPropertyDescriptor(h.llm, 'registerAdapter')
  assert.equal(installed.enumerable, descriptor.enumerable)
  assert.equal(installed.writable, descriptor.writable)
  const later = function () {}
  Object.defineProperty(h.llm, 'registerAdapter', { ...descriptor, value: later })
  dispose()
  assert.equal(Object.getOwnPropertyDescriptor(h.llm, 'registerAdapter').value, later)

  const protoOriginal = function () {}
  const p = harness({ proto: { registerAdapter: protoOriginal } })
  const pDispose = apply(p.ctx)
  assert.equal(Object.hasOwn(p.llm, 'registerAdapter'), true)
  pDispose()
  assert.equal(Object.hasOwn(p.llm, 'registerAdapter'), false)
  assert.equal(p.llm.registerAdapter, protoOriginal)
})

test('adapter failures propagate and keep caller signal', async () => {
  const h = harness()
  const dispose = apply(h.ctx)
  const error = new Error('prepare failed')
  const adapter = adapterStub()
  adapter.prepareCall = async () => { throw error }
  h.llm.registerAdapter(['codex'], adapter)
  await assert.rejects(h.calls[0].adapter.prepareCall(CODEX_ALIAS, { model: 'm' }), cause => cause === error)
  dispose()
})
