
import { installSearch } from './search.js'

export const name = 'subscriptions-compat-rc1'
export const inject = ['llm']
export const CODEX_ALIAS = 'openai-codex'

const PUBLIC_METHODS = Object.freeze([
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
])

const isCodexProvider = provider => provider === 'codex'
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function mapProvider(value, alias, target) {
  return value === alias ? target : value
}

function mapProviderInOptions(options, alias, target) {
  if (!options || typeof options !== 'object' || options.provider !== alias) return options
  return { ...options, provider: target }
}

function restoreIdentity(value, alias) {
  if (!value || typeof value !== 'object') return value
  return { ...value, provider: alias }
}

function restoreProviderInfo(value, alias) {
  if (!value || typeof value !== 'object') return value
  return { ...value, id: alias }
}

function createAliasAdapter(adapter, targetProvider, alias = CODEX_ALIAS) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
    throw new TypeError('codex adapter must be an object')
  }
  for (const method of PUBLIC_METHODS) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`codex adapter is missing ${method}()`)
  }
  const wrapper = Object.create(Object.getPrototypeOf(adapter) ?? Object.prototype)
  for (const method of PUBLIC_METHODS) {
    Object.defineProperty(wrapper, method, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function (...args) {
        if (method === 'stream') {
          return adapter.stream.call(adapter, mapProviderInOptions(args[0], alias, targetProvider))
        }

        const provider = mapProvider(args[0], alias, targetProvider)
        if (method === 'listModels' && args[0] === alias) return Promise.resolve([])
        const result = adapter[method].call(adapter, provider, ...args.slice(1))
        if (args[0] !== alias || !['providerInfo', 'resolveModel', 'prepareCall'].includes(method)) return result
        if (method === 'providerInfo') return restoreProviderInfo(result, alias)
        if (method === 'resolveModel') return Promise.resolve(result).then(value => restoreIdentity(value, alias))
        return Promise.resolve(result).then(value => {
          if (!value || typeof value !== 'object') return value
          return {
            ...value,
            model: restoreIdentity(value.model, alias),
            ...typeof value.stream !== 'function' ? {} : {
              stream: options => value.stream.call(value, mapProviderInOptions(options, alias, targetProvider)),
            },
          }
        })
      },
    })
  }
  return wrapper
}

function augmentedProviders(providers, alias = CODEX_ALIAS) {
  const list = Array.isArray(providers) ? [...providers] : []
  if (list.length === 0 || list.includes(alias) || !list.some(isCodexProvider)) return list
  return [...list, alias]
}

function wrapRegistrationHandle(handle, callbackDispose, alias = CODEX_ALIAS) {
  if (typeof handle !== 'function') return handle
  let callbackReleased = false
  const wrapped = function (...args) {
    const result = handle(...args)
    if (!callbackReleased) {
      callbackReleased = true
      callbackDispose?.()
    }
    return result
  }
  const replace = handle.replace
  if (typeof replace === 'function') {
    wrapped.replace = providers => {
      const next = Array.isArray(providers) ? [...providers] : []
      return replace.call(handle, next.length === 0 ? next : augmentedProviders(next, alias))
    }
  }
  return wrapped
}

function installRegisterAdapter(llm, onCodexAdapter) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(llm, 'registerAdapter')
  const original = llm.registerAdapter
  if (typeof original !== 'function') throw new TypeError('llm.registerAdapter must be a function')

  const wrapper = function (providers, adapter, ...rest) {
    const list = Array.isArray(providers) ? [...providers] : providers
    const targetProvider = Array.isArray(list) ? list.find(isCodexProvider) : undefined
    if (targetProvider === undefined || targetProvider === CODEX_ALIAS) {
      return original.call(this, providers, adapter, ...rest)
    }
    const aliasAdapter = createAliasAdapter(adapter, targetProvider)
    const handle = original.call(this, augmentedProviders(list), aliasAdapter, ...rest)
    const callbackDispose = typeof onCodexAdapter === 'function'
      ? onCodexAdapter(adapter, targetProvider, aliasAdapter)
      : undefined
    return wrapRegistrationHandle(handle, callbackDispose)
  }

  const installedDescriptor = ownDescriptor && hasOwn(ownDescriptor, 'value')
    ? { ...ownDescriptor, value: wrapper }
    : { configurable: true, enumerable: true, writable: true, value: wrapper }
  Object.defineProperty(llm, 'registerAdapter', installedDescriptor)

  return () => {
    const current = Object.getOwnPropertyDescriptor(llm, 'registerAdapter')
    if (!current || current.value !== wrapper) return
    if (ownDescriptor) Object.defineProperty(llm, 'registerAdapter', ownDescriptor)
    else delete llm.registerAdapter
  }
}

export function apply(ctx, config = {}) {
  return ctx.effect(
    () => {
      let currentAdapter
      const onCodexAdapter = (adapter, provider, aliasAdapter) => {
        currentAdapter = adapter
        const externalDispose = typeof config.onCodexAdapter === 'function'
          ? config.onCodexAdapter(adapter, provider, aliasAdapter)
          : undefined
        return () => {
          if (currentAdapter === adapter) currentAdapter = undefined
          externalDispose?.()
        }
      }
      const dispose = installRegisterAdapter(ctx.llm, onCodexAdapter)
      try {
        ctx.provide('subscriptionsCompatReady', {})
        ctx.inject(['web', 'settings', 'loader'], searchCtx => {
          try {
            installSearch(searchCtx, () => currentAdapter)
          } catch (error) {
            dispose()
            throw error
          }
        })
      } catch (error) {
        dispose()
        throw error
      }
      return dispose
    },
    'subscriptions-compat-rc1: Codex provider alias',
  )
}

export { createAliasAdapter, augmentedProviders }
