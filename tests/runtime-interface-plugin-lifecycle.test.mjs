// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                               
                                                                                                                                   
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import * as boundary from '../packages/runtime-interface/src/index.js'
                                                                                                                                                 
import * as business from '../packages/subscriptions-compat-rc1/src/index.js'
import { createCodexSearchProvider } from '../packages/subscriptions-compat-rc1/src/codex-search.js'




test('real Cordis sibling bindings and namespace teardown cancel cold search import without late effects', async () => {
  assert.ok(process.env.DSH_WEB020_RUNTIME)
  const { Context } = await import(pathToFileURL(join(process.env.DSH_WEB020_RUNTIME, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
  const { SettingsForms } = await import(pathToFileURL(join(process.env.DSH_WEB020_RUNTIME, 'node_modules/@deepseek-ai/dsh-settings/lib/index.js')).href)
  assert.equal(SettingsForms.prototype.register, undefined, 'the new service removed legacy namespace registration')
  for (const settleSearch of [false, true, 'native']) {
    const ctx = new Context()
    let original, registrations = 0, settingsCalls = 0
    const provider = ctx.plugin(c => {
      const services = {
        typertGateway: {}, webServer: { port: 0 }, sessionController: {}, workspaceController: {}, jobController: {}, appExit: () => {}, connection: {}, subagents: {}, commands: {}, goals: {}, agentPresets: {}, sessionPersistence: {},
        agents: { list: async () => [{}] }, agentDefaultModel: { currentSelection: async () => ({ provider: 'fixture', model: 'm' }) },
        directoryPickerController: { list: async () => ({ entries: ['ok'] }) }, llm: { registerAdapter() { return () => {} } },
        web: { registerSearchProvider() { registrations++; return () => {} } },
        settings: settleSearch === 'native' ? Object.create(SettingsForms.prototype) : { register() { settingsCalls++; return { get: () => ({ searchProvider: 'auto' }) } } },
        loader: { entries: () => [{ options: { id: 'web', config: { searchProvider: 'codex-subscription-auto' } }, fiber: { config: { searchProvider: 'codex-subscription-auto' }, update: async () => {} } }] },
      }
      original = services.llm.registerAdapter
      for (const [key, value] of Object.entries(services)) c.provide(key, value)
    })
    await provider
    const owner = ctx.plugin({ ...boundary, inject: [...boundary.inject, 'jobController', 'appExit'] }, { historyEpoch: { datasetId: 'fixture', sequenceFormatGeneration: 4, generation: 1 } })
    await owner
    assert.equal(owner.state, 2, 'the actual async plugin entry must activate without an Invalid effect')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const runtime = ctx.get('runtimeInterface')
    assert.deepEqual(await runtime.mobileHost.listDirectory('/fixture'), { entries: ['ok'] })
    assert.equal(await runtime.mobileHost.attachedCount(), 1)
    assert.deepEqual(await runtime.mobileHost.defaultSelection(), { provider: 'fixture', model: 'm' })
    const mounted = ctx.plugin(business)
    await mounted
    const fibers = () => [...ctx.registry.values()].flatMap(r => [...r.fibers])
    const installation = fibers().find(f => f.parent.fiber === owner.ctx.fiber && Object.keys(f.inject).length === 1 && Object.hasOwn(f.inject, 'llm'))
    assert.ok(installation)
    await installation.await()
    const search = fibers().find(f => f.parent.fiber === installation.ctx.fiber && Object.hasOwn(f.inject, 'web'))
    assert.ok(search)
    if (settleSearch) await search.await()
    else assert.equal(search.state, 1, 'first iteration must cover a cold search import')
    assert.ok(ctx.get('subscriptionsCompatReady'))
    await mounted.dispose()
    await installation.await(); await search.await()
    assert.equal(installation.state, 4); assert.equal(search.state, 4)
    assert.equal(ctx.get('subscriptionsCompatReady'), undefined)
    assert.equal(ctx.get('llm').registerAdapter, original)
    assert.equal(registrations, settleSearch ? 2 : 0)
    assert.equal(settingsCalls, settleSearch === true ? 1 : 0)
    await ctx.fiber.dispose()
  }
})

test('native search selection uses void Fiber.update and only reacts to its owning volatile reference', async () => {
  const { installSearch } = await import('../packages/runtime-interface/src/subscription-search.js')
  const root = process.env.DSH_WEB020_RUNTIME
  assert.ok(root)
  const { Context } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
  const { createVolatile, updateVolatile } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/cosmokit/lib/index.js')).href)
  const ctx = new Context()
  const web = ctx.plugin(c => {}, { searchProvider: 'deepseek-official' })
  await web
  const reference = createVolatile('auto')
  const services = { settings: {}, web: { registerSearchProvider() { return () => {} } }, loader: { entries: () => [{ options: { id: 'web', config: { searchProvider: 'deepseek-official' } }, fiber: web }] } }
  const owner = ctx.plugin(c => { installSearch(c.extend(services), () => undefined, createCodexSearchProvider, { searchProvider: reference }) }, { searchProvider: reference })
  await owner
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await web.await() }
  await settle()
  assert.equal(web.config.searchProvider, 'codex-subscription-auto')
  updateVolatile(reference, createVolatile('codex'))
  ctx.emit(owner.ctx, 'loader/volatile-update', [['searchProvider']])
  await settle()
  assert.equal(web.config.searchProvider, 'codex-subscription')
  updateVolatile(reference, createVolatile('dsh'))
  const unrelated = ctx.plugin(c => {}, { searchProvider: createVolatile('auto') })
  await unrelated
  ctx.emit(unrelated.ctx, 'loader/volatile-update', [['searchProvider']])
  await settle()
  assert.equal(web.config.searchProvider, 'codex-subscription')
  ctx.emit(owner.ctx, 'loader/volatile-update', [['searchProvider']])
  await settle()
  assert.equal(web.config.searchProvider, 'deepseek-official')
  await owner.dispose()
  updateVolatile(reference, createVolatile('codex'))
  ctx.emit(owner.ctx, 'loader/volatile-update', [['searchProvider']])
  await settle()
  assert.equal(web.config.searchProvider, 'deepseek-official')
  await ctx.fiber.dispose()
})
