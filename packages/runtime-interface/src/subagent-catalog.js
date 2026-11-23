// Public change history: docs/PUBLIC-CHANGES.md
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

/** Preserve the stable direct-parent ports at the official 022 boundary. */
export function adaptSubagents022(service, session, ErrorType) {
  const native = name => typeof service?.[name] === 'function' ? service[name].bind(service) : undefined
  return {
    remoteExportList: native('remoteExportList'),
    prompt: native('prompt'),
    listChildren: native('listChildren') ?? async function(parentSessionId, signal) {
      const block = await session.projections({ sessionId: parentSessionId }, signal)
      if (block?.kind !== 'sequenced' || !Object.hasOwn(block.values, 'subagentCatalog')) {
        throw new ErrorType('SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE', 'Exact subagent catalog projection is unavailable')
      }
      return block.values.subagentCatalog
    },
    interruptByParent: native('interruptByParent') ?? function(childSessionId, parentSessionId, mode) {
      if (mode !== 'continuable' || [childSessionId, parentSessionId].some(id =>
        typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0'))) {
        throw new ErrorType('gateway/bad-request', 'Subagent interrupt address is invalid')
      }
      if (typeof service?.interruptByUser !== 'function') {
        throw new ErrorType('runtime-interface/capability-unavailable', 'Subagent interrupt is unavailable')
      }
      // Like the old primitive, check the live activation, not a catalog or a live parent.
      // No await separates this direct-parent check from the original user interrupt.
      const activation = service.manager?.resident.get(childSessionId)
      if (activation && activation.ancestors.at(-1) !== parentSessionId) {
        throw new ErrorType('subagent/unauthorized', 'subagent does not belong to this parent', { childSessionId })
      }
      return service.interruptByUser(childSessionId)
    },
  }
}
