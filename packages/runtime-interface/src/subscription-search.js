// Public change history: docs/PUBLIC-CHANGES.md
import z from '@deepseek-ai/schemastery'

const aliases = new Set(['codex-subscription', 'codex-subscription-auto'])
const isCodex = provider => ['codex', 'openai-codex'].includes(provider)

export function installSearch(ctx, preferences = {}) {
  const settings = typeof ctx.settings.register === 'function' ? ctx.settings.register('codex-subscription', z.object({
    quickQuotaVisible: z.boolean().default(false),
    searchProvider: z.union(['auto', 'dsh', 'codex']).default('auto'),
  })) : { get: () => ({
    quickQuotaVisible: preferences.quickQuotaVisible?.get?.() ?? preferences.quickQuotaVisible ?? false,
    searchProvider: preferences.searchProvider?.get?.() ?? preferences.searchProvider ?? 'auto',
  }) }
  const current = () => ctx.get?.('agents')?.currentInitiator?.()?.session.requestContext?.()?.provider
  const webEntry = () => [...ctx.loader.entries()].find(entry => entry.options?.id === 'web')
  const configured = webEntry()?.options?.config?.searchProvider
  const originalSearchProvider = aliases.has(configured) ? undefined : configured
  // 每次调用创建只读选择视图；复用原注册表与官方默认策略，不改共享服务配置。
  const view = codex => Object.create(ctx.web, {
    config: { value: { ...ctx.web.config, searchProvider: { get: () => codex ? 'codex' : originalSearchProvider } } },
    searchProviders: { value: new Map([...ctx.web.searchProviders].filter(([id]) => !aliases.has(id))) },
  })
  for (const [id, forceCodex] of [['codex-subscription', true], ['codex-subscription-auto', false]]) {
    ctx.web.registerSearchProvider({
      id,
      available: () => !(forceCodex || isCodex(current())) || ctx.web.searchProviders.get('codex')?.available() === true,
      ready: provider => view(forceCodex || isCodex(provider ?? current())).searchReady(provider),
      search: async (request, signal) => {
        signal?.throwIfAborted()
        const pending = view(forceCodex || isCodex(request.llmProvider ?? current())).search(request, signal)
        let abort
        try {
          return signal ? await Promise.race([pending, new Promise((_, reject) => {
            abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })]) : await pending
        } finally { if (abort) signal.removeEventListener('abort', abort) }
      },
    })
  }
  ctx.effect(() => {
    let active = true
    const sync = () => {
      if (!active) return
      const selected = settings.get().searchProvider
      const searchProvider = selected === 'codex' ? 'codex-subscription' : selected === 'auto' ? 'codex-subscription-auto' : originalSearchProvider
      const entry = webEntry()
      if (!entry?.fiber?.update) throw new Error('Web search configuration is unavailable')
      // Loader options keep schema input; Fiber.config may contain resolved volatile values.
      const config = entry.options.config ?? entry.fiber.config ?? {}
      const currentSearchProvider = entry.fiber.config?.searchProvider
      if ((currentSearchProvider?.get?.() ?? currentSearchProvider) === searchProvider) return
      // Real Cordis Fiber.update returns void; older fixtures/ports may return a promise.
      Promise.resolve(entry.fiber.update({...config, searchProvider}, true)).catch(() => {
        ctx.logger?.warn?.('Could not restore Codex subscription search selection')
      })
    }
    sync()
    // Loader emits this event with the updated owner's Context as `this`.
    // Compare the opaque reference identity inside the interface; unrelated
    // plugin changes cannot update this subscription's route.
    const stop = typeof ctx.settings.register !== 'function' && preferences.searchProvider !== undefined
      ? ctx.on?.('loader/volatile-update', function () {
        if (this?.fiber?.config?.searchProvider === preferences.searchProvider) sync()
      }, { global: true }) : undefined
    return () => { active = false; stop?.() }
  }, 'subscriptions-compat: preserve existing search selection')
  const entry = webEntry()
  // 只在整个兼容插件卸载时恢复；Web自身重组不能重置正在使用的选择。
  return () => {
    const selected = entry?.fiber?.config?.searchProvider
    if (aliases.has(selected?.get?.() ?? selected)) {
      entry.fiber.update({ ...entry.options.config, searchProvider: originalSearchProvider }, true)
    }
  }
}
