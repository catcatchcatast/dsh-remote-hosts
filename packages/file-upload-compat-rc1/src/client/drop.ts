// Public change history: docs/PUBLIC-CHANGES.md
export interface FileDragEventLike {
  dataTransfer?: { types: ArrayLike<string> } | null
  preventDefault(): void
  stopImmediatePropagation(): void
}

/** Claim a browser file drag before DSH's native image-only intake sees it. */
export function claimFileDrag(event: FileDragEventLike): boolean {
  const types = event.dataTransfer?.types
  if (types === undefined || types === null || !Array.from(types).includes('Files')) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  return true
}
