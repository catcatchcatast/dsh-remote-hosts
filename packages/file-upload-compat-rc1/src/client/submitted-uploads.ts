// Public change history: docs/PUBLIC-CHANGES.md
export interface UploadDraftSnapshot {
  phase: string
  draftRev: number
  occurrences: ReadonlyArray<{ source: string; ref: string }>
}

/** Tracks upload references consumed by one composer submission. */
export class SubmittedUploadTracker {
  private submission: { draftRev: number; refs: readonly string[] } | undefined
  private readonly source: string

  constructor(source = 'dsh-file-upload') {
    this.source = source
  }

  update(snapshot: UploadDraftSnapshot): string[] {
    if (snapshot.phase === 'submitting') {
      if (this.submission === undefined) {
        this.submission = {
          draftRev: snapshot.draftRev,
          refs: Array.from(new Set(
            snapshot.occurrences
              .filter((occurrence) => occurrence.source === this.source)
              .map((occurrence) => occurrence.ref)
          ))
        }
      }
      return []
    }

    if (snapshot.phase !== 'plain' || this.submission === undefined) return []

    const submission = this.submission
    this.submission = undefined
    // The input machine advances draftRev only when an accepted submit clears
    // the draft. A failed submit returns to plain at the same revision so its
    // references remain available for retry.
    return snapshot.draftRev !== submission.draftRev ? [...submission.refs] : []
  }
}
