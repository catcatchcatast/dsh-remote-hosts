// Public change history: docs/PUBLIC-CHANGES.md
// Official connection readiness is interpreted here; consumers receive only a boolean source.
export function createSidebarHostsClient(registry, generation, sessionListReader, completeBaselineReader) {
  return Object.freeze({
    initialBaselineAccepted: sessionListReader ? Object.freeze({
      getSnapshot: () => completeBaselineReader?.() === true && sessionListReader()?.getSnapshot().phase === 'ready',
    }) : undefined,
    hostRegistry: registry ? Object.freeze({
      snapshot: () => registry.snapshot(),
      subscribe: listener => registry.subscribe(listener),
    }) : undefined,
    baselineReady: generation ? Object.freeze({
      getSnapshot: () => generation.getSnapshot() !== undefined,
      subscribe: listener => generation.subscribe(listener),
    }) : undefined,
  })
}
