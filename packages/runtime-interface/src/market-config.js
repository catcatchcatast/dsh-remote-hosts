// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
import z from '@deepseek-ai/schemastery'

const volatileWrite = Symbol.for('cosmokit.volatile.write')
const field = z.boolean().default(undefined).description('允许市场重启当前进程；未配置时沿用原有进程管理规则')
export const MarketConfig = z.object({ allowRestart: typeof field.volatile === 'function' ? field.volatile() : field })
const invalid = () => new TypeError('market configuration is invalid')
function unwrap(value) {
  if (value && typeof value === 'object' && volatileWrite in value) {
    if (typeof value.get !== 'function') throw invalid()
    return value.get()
  }
  return value
}
function source(input) {
  const value = unwrap(input) ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value
}
function allowRestart(input) {
  try {
    const value = unwrap(source(input).allowRestart)
    if (value !== undefined && typeof value !== 'boolean') throw invalid()
    return value
  } catch { throw invalid() }
}
/** Preserve every unrelated composed field, including opaque build configuration. */
export function resolveMarketBootConfig(input) {
  try { return { ...source(input), allowRestart: allowRestart(input) } } catch { throw invalid() }
}
let namespaceState
export function marketSettingsNamespaceState() { return namespaceState }
const LegacyMarketSettings = z.object({ allowRestart: z.boolean().default(true) })
/** The interface owns both native settings bindings; business receives no service or context. */
export function createMarketConfigPort(ctx, input) {
  const config = resolveMarketBootConfig(input)
  return Object.freeze({
    config,
    bindRestart(resolved, initialAllowed) {
      if (typeof initialAllowed !== 'boolean') throw invalid()
      ctx.inject(['settings'], scope => {
        if (typeof scope.settings.register === 'function') {
          const entry = { allowRestart: initialAllowed }
          const settings = scope.settings.register('dsh-market', LegacyMarketSettings, { base: entry })
          namespaceState = 'registered'
          let read = () => settings.get()
          const apply = () => { resolved.allowRestart = allowRestart(read()) }
          scope.effect(() => () => { read = () => entry; apply() })
          apply()
          scope.effect(() => settings.watch(apply))
          return
        }
        namespaceState = 'registered'
        scope.effect(() => {
          const previous = Object.getOwnPropertyDescriptor(resolved, 'allowRestart')
          Object.defineProperty(resolved, 'allowRestart', { configurable: true, enumerable: true, get: () => allowRestart(input) })
          return () => previous ? Object.defineProperty(resolved, 'allowRestart', previous) : delete resolved.allowRestart
        }, 'runtime-interface: native market restart configuration')
      })
    },
  })
}
