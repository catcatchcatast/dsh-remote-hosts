import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCatalog, apply } from '../packages/model-menu-filter/src/index.js'
const config = { onlyModels: { grok: ['grok-4.6'] }, excludeModels: ['gpt-5.5', 'gpt-5.3-codex-spark'] }
const reasoning = { efforts: [{ id: 'xhigh' }, { id: 'high' }] }
const catalog = { defaultSelection: { model: 'gpt-5.5' }, failures: [], groups: [
  { id: 'grok', models: [{ id: 'grok-4.5' }, { id: 'grok-4.6', reasoning }] },
  { id: 'openai-codex', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.3-codex-spark' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }] },
  { id: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] },
] }
test('filters exact menu entries without changing source, metadata or reasoning', () => {
  const before = JSON.stringify(catalog)
  const result = filterCatalog(catalog, config)
  assert.deepEqual(result.groups.map(g => g.models.map(m => m.id)), [['grok-4.6'], ['gpt-5.6-sol', 'gpt-6-astra'], ['deepseek-v4-pro']])
  assert.equal(result.groups[0].models[0].reasoning, reasoning)
  assert.equal(result.defaultSelection, catalog.defaultSelection)
  assert.equal(result.failures, catalog.failures)
  assert.equal(JSON.stringify(catalog), before)
})
test('no configuration keeps original catalog and empty groups are removed', () => {
  assert.equal(filterCatalog(catalog), catalog)
  assert.equal(filterCatalog(catalog, { onlyModels: { grok: [] } }).groups.some(g => g.id === 'grok'), false)
})
function install(controller) {
  let dispose
  apply({ sessionController: controller, effect: fn => { dispose = fn(); return dispose } }, config)
  return dispose
}
test('wrapper preserves receiver, arguments and prototype method on unload', async () => {
  const proto = { async modelCatalog(value) { assert.equal(this.marker, 7); assert.equal(value, 9); return catalog } }
  const controller = Object.assign(Object.create(proto), { marker: 7 })
  const dispose = install(controller)
  assert.equal((await controller.modelCatalog(9)).groups[0].models.length, 1)
  dispose()
  assert.equal(Object.hasOwn(controller, 'modelCatalog'), false)
  assert.equal(controller.modelCatalog, proto.modelCatalog)
})
test('restores own property descriptor and leaves later wrappers alone', () => {
  const controller = { modelCatalog: () => catalog }
  const descriptor = Object.getOwnPropertyDescriptor(controller, 'modelCatalog')
  install(controller)()
  assert.deepEqual(Object.getOwnPropertyDescriptor(controller, 'modelCatalog'), descriptor)
  const dispose = install(controller)
  const later = () => catalog
  controller.modelCatalog = later
  dispose()
  assert.equal(controller.modelCatalog, later)
})
test('upstream rejection propagates and selection routes are untouched', async () => {
  const failure = new Error('upstream failed')
  const selectModel = () => 'original'
  const controller = { modelCatalog: async () => { throw failure }, selectModel }
  const dispose = install(controller)
  await assert.rejects(controller.modelCatalog(), error => error === failure)
  assert.equal(controller.selectModel, selectModel)
  dispose()
})
