// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
// 将当前公开父目录读转换为既有移动目录，不激活Agent、不遍历后代树。
export function createSubagentCatalogReader(service, agentRegistry, ErrorType) {
  const unavailable = () => new ErrorType('runtime-interface/capability-unavailable', 'Subagent catalog is unavailable', { method: 'listChildren' })
  const corrupt = () => new ErrorType('subagent/catalog-diagnostic', 'Subagent catalog is unavailable', { reason: 'corrupt' })
  const cancelled = (signal, error) => {
    signal?.throwIfAborted()
    if (error?.code === 'CANCELLED' || error?.code === 'SESSION_QUERY_ABORTED' || error?.name === 'AbortError') throw error
  }
  return async (parentSessionId, signal) => {
    signal?.throwIfAborted()
    if (typeof parentSessionId !== 'string' || !parentSessionId || parentSessionId.length > 4096 || parentSessionId.includes('\0')) {
      throw new ErrorType('gateway/bad-request', 'Subagent parent identity is invalid')
    }
    if (typeof service?.listChildren !== 'function') throw unavailable()
    // 只由官方public方法授权并持有/释放父观察；不读官方内部ctx或私有数据。
    const children = await service.listChildren(parentSessionId, signal)
    signal?.throwIfAborted()
    if (!Array.isArray(children)) throw corrupt()
    const entries = []
    const seen = new Set()
    for (const child of children) {
      signal?.throwIfAborted()
      if (!child || typeof child.id !== 'string' || !child.id || child.id.length > 4096 || child.id.includes('\0') || seen.has(child.id)) throw corrupt()
      seen.add(child.id)
      if (child.mode !== 'one-shot' && child.mode !== 'continuable') {
        entries.push({ kind: 'diagnostic', id: child.id, reason: 'unsupported' })
        continue
      }
      if ((child.mode === 'continuable' && typeof child.label !== 'string') ||
        (child.label !== undefined && typeof child.label !== 'string')) throw corrupt()
      let nested
      try {
        nested = await service.listChildren(child.id, signal)
        signal?.throwIfAborted()
        if (!Array.isArray(nested)) throw corrupt()
      } catch (error) {
        cancelled(signal, error)
        // 公共能力缺失属于全局依赖问题，不能隔离成一个损坏child。
        if (String(error?.code ?? '').startsWith('SUBAGENT_CONTROL_')) throw unavailable()
        const reason = error?.code === 'SESSION_QUERY_CORRUPT_SESSION' || error?.code === 'SESSION_QUERY_SOURCE_CONFLICT' ||
          (error?.code === 'subagent/catalog-diagnostic' && error?.details?.reason === 'corrupt') ? 'corrupt' : 'unavailable'
        entries.push({ kind: 'diagnostic', id: child.id, reason })
        continue
      }
      entries.push({
        kind: 'child', id: child.id, mode: child.mode,
        ...(child.label === undefined ? {} : { label: child.label }),
        hasChildren: nested.length > 0,
      })
    }
    signal?.throwIfAborted()
    // 所有异步目录读结束后才取当前注册表；卸载/替换不沿用旧hint。
    const agents = typeof agentRegistry === 'function' ? agentRegistry() : agentRegistry
    return {
      entries: entries.map(entry => entry.kind === 'child'
        ? { ...entry, activity: agents?.get?.(entry.id)?.status === 'running' ? 'running' : 'inactive' }
        : entry),
      parentAvailable: agents?.get?.(parentSessionId) !== undefined,
    }
  }
}
