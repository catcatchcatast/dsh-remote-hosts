// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
import { createCodexSearchProvider } from './codex-search.js'
import { SubscriptionsConfig } from 'dsh-runtime-interface'
export const name = 'subscriptions-compat-rc1'
export const inject = ['runtimeInterface']
export const Config = SubscriptionsConfig
export const CODEX_ALIAS = 'openai-codex'

// Registration, official service binding, credentials and generation identity
// remain inside the interface. The business package supplies only search policy.
export function apply(ctx, preferences = {}) {
  const port = ctx.runtimeInterface?.subscriptions
  if (typeof port?.install !== 'function') throw new TypeError('subscriptions interface is required')
  return ctx.effect(() => port.install({ createSearchProvider: createCodexSearchProvider, preferences }), 'subscriptions-compat-rc1: interface installation')
}
