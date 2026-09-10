import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { createCodexSearchProvider } from './codex-search.js'

// Pinned compatibility seam: use the target adapter's refresh manager, never a
// second manager or a copied credential store. Abort only this waiter, not a
// refresh shared with a model request.
export async function searchSession(getAdapter, signal) {
  signal?.throwIfAborted()
  const tokens = getAdapter()?.options?.tokens
  if (typeof tokens?.session !== 'function') throw new Error('Subscriptions 0.8.0 token manager is unavailable')
  let abort
  const pending = Promise.resolve().then(() => tokens.session())
  try {
    const session = signal ? await Promise.race([pending, new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })]) : await pending
    signal?.throwIfAborted()
    if (!session?.accessToken || !session?.accountId) throw new Error('Subscriptions Codex account is unavailable')
    return session
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

export function installSearch(ctx, getAdapter) {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('dsh-plugin-subscriptions/package.json')
  if (require(packagePath).version !== '0.8.0') throw new Error('Subscriptions search compatibility requires version 0.8.0')
  // Target's own proxy implementation and storage are shared, including its
  // private undici version. No process-wide dispatcher or independent OAuth.
  const http = import(pathToFileURL(join(dirname(packagePath), 'lib/http.js')).href)
  const settings = ctx.settings.register('codex-subscription', z.object({
    quickQuotaVisible: z.boolean().default(false),
    searchProvider: z.union(['auto', 'dsh', 'codex']).default('auto'),
  }))
  const current = () => ctx.get?.('agents')?.currentInitiator?.()
  const provider = createCodexSearchProvider({
    resolveCredentials: async ({signal}) => {
      const session = await searchSession(getAdapter, signal)
      return {auth:{auth:{apiKey:session.accessToken}},credential:{type:'oauth',accountId:session.accountId}}
    },
    fetch: async (url, options) => (await http).proxiedFetch(url, options),
    resolveModel: () => {
      const request = current()?.session.requestContext?.()
      return ['codex','openai-codex'].includes(request?.provider) ? request.model : undefined
    },
    resolveSessionId: () => current()?.session.id,
  })
  ctx.web.registerSearchProvider(provider)
  const webEntry = () => [...ctx.loader.entries()].find(entry => entry.options?.id === 'web')
  const dshProviderId = () => webEntry()?.options?.config?.searchProvider ?? 'deepseek-official'
  ctx.web.registerSearchProvider({
    id: 'codex-subscription-auto',
    available: () => true,
    async search(request, signal) {
      if (['codex','openai-codex'].includes(current()?.session.requestContext?.()?.provider)) return provider.search(request,signal)
      const fallback = ctx.web.searchProviders?.get(dshProviderId())
      if (!fallback || ['codex-subscription-auto','codex-subscription'].includes(fallback.id) || fallback.available() !== true) throw new WebError('DSH default search is unavailable','WEB_PROVIDER_UNAVAILABLE')
      return fallback.search(request,signal)
    },
  })
  ctx.effect(() => {
    const selected = settings.get().searchProvider
    const searchProvider = selected === 'codex' ? 'codex-subscription' : selected === 'auto' ? 'codex-subscription-auto' : dshProviderId()
    const entry = webEntry()
    if (!entry?.fiber?.update) throw new Error('Web search configuration is unavailable')
    const config = entry.fiber.config ?? entry.options.config ?? {}
    if (config.searchProvider !== searchProvider) {
      void entry.fiber.update({...config, searchProvider}, true).catch(() => {
        ctx.logger?.warn?.('Could not restore Codex subscription search selection')
      })
    }
  }, 'subscriptions-compat: preserve existing search selection')
}
