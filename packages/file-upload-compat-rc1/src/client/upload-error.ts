// Public change history: docs/PUBLIC-CHANGES.md
export interface UploadError {
  seq: number
  text: string
}

export interface UploadErrorStore {
  subscribe(listener: (next: UploadError | null) => void): () => void
  set(text: string): void
  clear(): void
}

export function createUploadErrorStore(): UploadErrorStore {
  let error: UploadError | null = null
  let seq = 0
  const listeners = new Set<(next: UploadError | null) => void>()
  const publish = (): void => {
    for (const listener of listeners) listener(error)
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(text) {
      error = { seq: ++seq, text }
      publish()
    },
    clear() {
      error = null
      publish()
    },
  }
}
