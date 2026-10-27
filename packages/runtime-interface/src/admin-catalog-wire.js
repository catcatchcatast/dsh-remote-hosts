// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                               
                                                                                                                                                                   
import z from 'zod'
import { createRequire } from 'node:module'
import { isWebRuntimeVersion } from './web-020.js'
const require = createRequire(import.meta.url)
// Exact read-only contracts of the 0.2 process catalog and plugin configuration directory.
export const ADMIN_CATALOG_ENDPOINTS = Object.freeze(['permissionPresets/catalog', 'pluginManager/listBundles', 'pluginManager/listPlugins'])
const endpoints = new Set(ADMIN_CATALOG_ENDPOINTS)
const text = z.string()
const label = z.union([text, z.object({ en: text }).catchall(text)])
const meta = z.object({ title: label.optional(), description: label.optional(), icon: text.optional(), error: text.optional() })
const readOnlyReason = z.enum(['management-required', 'unaddressable'])
const error = z.object({
  code: z.enum(['management-required', 'unaddressable', 'unknown-plugin', 'invalid-spec', 'ambiguous-install', 'not-bundle', 'not-removable', 'stop-profile', 'bundle-in-use', 'stale-approval', 'incompatible-version', 'operation-error']),
  diagnostic: text.optional(), incompatible: z.array(z.object({ name: text, version: text, runtimeVersion: text, peers: z.record(text, text) })).optional(),
})
const option = z.object({ value: text, name: text, description: text.optional() })
const plugin = z.object({ entryId: text, moduleName: text, meta: meta.optional(), enabled: z.boolean(), fiberPhase: z.enum(['failed', 'pending', 'active', 'loading', 'unloading']).nullable() })
const schemas = {
  'permissionPresets/catalog': z.object({ options: z.array(option), defaultOptions: z.array(option), defaultPreset: text }),
  'pluginManager/listBundles': z.array(z.object({
    name: text, version: text.optional(), meta: meta.optional(), description: text.optional(), enabled: z.boolean(), installed: z.boolean(), optional: z.boolean(), removable: z.boolean(),
    readOnlyReason: readOnlyReason.optional(), error: error.optional(), rows: z.array(z.object({ rowId: text, moduleName: text, meta: meta.optional(), entryId: text.optional() })), overrides: z.array(text),
  })),
  'pluginManager/listPlugins': z.array(z.union([plugin.extend({ patchId: text, readOnlyReason: z.never().optional() }), plugin.extend({ patchId: z.never().optional(), readOnlyReason })])),
}
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function fail(code = 'runtime-interface/protocol-error') { throw Object.assign(new Error('Administrative catalog is unavailable'), { code }) }
export function adminCatalogRequest(endpoint, payload, version) {
  if (!endpoints.has(endpoint)) return payload
  if (!isWebRuntimeVersion(version)) fail('runtime-interface/capability-unavailable')
  const parsed = z.object({ args: z.object({}).strict() }).strict().safeParse(payload)
  if (!parsed.success) fail()
  return freeze(parsed.data)
}
// 新版目录的新增字段由官方公开校验保真；旧Host保持原0.2.0边界。
function resultSchema(endpoint, version) {
  if (!isWebRuntimeVersion(version)) fail('runtime-interface/capability-unavailable')
  if (version === '0.2.0-rc.2') return schemas[endpoint]
  const name = endpoint === 'permissionPresets/catalog'
    ? '@deepseek-ai/dsh-permission-presets' : '@deepseek-ai/dsh-plugin-manager'
  try {
    if (require(`${name}/package.json`).version !== version) fail('runtime-interface/capability-unavailable')
    const descriptor = require(`${name}/typert`).TYPERT.invocations
      .find(item => `${item.namespace}/${item.method}` === endpoint)
    if (typeof descriptor?.result?.create !== 'function') fail('runtime-interface/capability-unavailable')
    return descriptor.result.create()
  } catch { fail('runtime-interface/capability-unavailable') }
}
export function adminCatalogResult(endpoint, value, version = '0.2.0-rc.2') {
  if (!endpoints.has(endpoint)) return value
  if (value?.ok === false) return freeze({ ok: false, error: { code: 'runtime-interface/catalog-unavailable', message: 'Administrative catalog is unavailable' } })
  if (value?.ok !== true) fail()
  const parsed = resultSchema(endpoint, version).safeParse(value.value)
  if (!parsed.success) fail()
  return freeze({ ok: true, value: parsed.data })
}
