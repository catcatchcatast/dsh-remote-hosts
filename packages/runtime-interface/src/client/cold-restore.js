// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                       
                                                                                                                                               
                                                                                                                                               
                                                                                                                                               
/** Own one cold list consumption and its ordered public completion in this page. */
export function bindColdRestoreSelection(scope, bridge) {
  if (typeof bridge?.bindColdRestoreReader !== 'function') return () => {}
  let disposed = false
  let completedRead
  let captured
  const release = read => { for (const stop of read?.stops ?? []) stop(); if (captured === read) captured = undefined }
  const unbind = bridge.bindColdRestoreReader(() => {
    const sessions = scope.get('sessions')
    const selection = scope.get('uiWorkspace')?.selection
    const generation = scope.get('connection')?.generation
    const value = selection?.getSnapshot?.()
    // An old bridge retains the original hint without enabling target-only IO.
    if (typeof sessions?.refresh !== 'function' || typeof selection?.subscribe !== 'function' || typeof generation?.subscribe !== 'function') return value
    const current = generation.getSnapshot()
    if (disposed || current === undefined || typeof value?.sessionId !== 'string' || !value.sessionId) return undefined
    const controller = new AbortController()
    const read = { sessions, sessionId: value.sessionId, generation, current, controller, stops: [], accepted: false, consumed: false }
    captured = read
    read.stops.push(selection.subscribe(() => {
      if (!read.accepted && selection.getSnapshot()?.sessionId !== read.sessionId) controller.abort()
    }))
    read.stops.push(generation.subscribe(() => { if (generation.getSnapshot() !== current) controller.abort() }))
    return Object.defineProperty({ sessionId: read.sessionId }, 'signal', { value: controller.signal })
  }, (value, phase) => {
    const read = captured
    if (!read || disposed) return
    if (read.consumed) {
      if (read.accepted && phase === 'complete' && value?.result?.ok === true && !read.controller.signal.aborted && read.generation.getSnapshot() === read.current) completedRead = read
      return
    }
    read.consumed = true
    read.accepted = phase === 'target'
    if (phase === 'complete' && value?.result?.ok === true && !read.controller.signal.aborted && read.generation.getSnapshot() === read.current) completedRead = read
    if (phase !== 'target' && phase !== 'failed') { release(read); return }
    // This call joins the actual first official list promise. Only after that
    // consumer's finally cleared its single flight can a new public refresh run.
    let first
    try { first = read.sessions.refresh() } catch { release(read); return }
    const complete = () => {
      if (disposed || read.generation.getSnapshot() !== read.current) return
      return read.sessions.refresh()
    }
    void Promise.resolve(first).then(complete, complete).then(() => release(read), () => release(read))
  })
  const dispose = () => { disposed = true; completedRead = undefined; captured?.controller.abort(); release(captured); unbind() }
  // Only the actual same-generation complete response envelope can certify this read.
  return Object.assign(dispose, { completeBaselineAccepted: () => !disposed && completedRead !== undefined && !completedRead.controller.signal.aborted && completedRead.generation.getSnapshot() === completedRead.current })
}
