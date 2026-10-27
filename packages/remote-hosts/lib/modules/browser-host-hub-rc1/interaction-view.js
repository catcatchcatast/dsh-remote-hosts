// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                           
                                                                                                                                             
import { interactionToBrowserFrame } from 'dsh-runtime-interface'
                                                                                                                                                       

/** A browser view of peer-owned interactions; no core delivery handles. */
export class InteractionView {
  #hostId
  #codec
  #mappings
  #pending = new Map()
  #epoch
  #owner
  #revision
  #now
  constructor({ hostId, codec, mappings, now = Date.now }) {
    this.#hostId = hostId
    this.#codec = codec
    this.#mappings = mappings
    this.#now = now
  }
  unavailable() { for (const row of this.#pending.values()) row.confirmed = false }
  /** An unhandled presentation retries on existing peer reads with capped backoff. */
  defer(eventId) {
    const row = this.#mappings.get(eventId)
    if (!row || row.hostId !== this.#hostId || row.retryAt !== undefined) return undefined
    row.retryAt = this.#now() + 1000 * 2 ** Math.min(3, row.count - 1)
    return { phase: 'interaction_deferred', hostId: this.#hostId, sessionId: row.sessionId, count: row.count }
  }
  accept(snapshot) {
    const output = []
    const remove = id => {
      const row = this.#pending.get(id)
      if (!row) return
      this.#pending.delete(id)
      this.#mappings.delete(row.browserId)
      output.push({ type: 'cancel', eventId: row.browserId })
    }
    if (this.#epoch !== undefined && this.#epoch !== snapshot.runtimeEpoch) {
      for (const id of [...this.#pending.keys()]) remove(id)
    }
    const sameOwner = this.#epoch === snapshot.runtimeEpoch && this.#owner === snapshot.ownerInstanceId
    if (sameOwner && snapshot.revision < this.#revision) throw Object.assign(new Error('INTERACTION_REVISION_INVALID'), { code: 'INTERACTION_REVISION_INVALID' })
    if (!sameOwner) this.unavailable()
    this.#epoch = snapshot.runtimeEpoch
    this.#owner = snapshot.ownerInstanceId
    this.#revision = snapshot.revision
    const present = new Set(snapshot.pending.map(item => item.id))
    // The owner retains unconfirmed entries across source loss. Only a
    // continuous same-owner snapshot or explicit tombstone proves absence.
    if (sameOwner && snapshot.available) {
      for (const id of [...this.#pending.keys()]) if (!present.has(id) && this.#pending.get(id).ownerInstanceId === snapshot.ownerInstanceId) remove(id)
    }
    for (const item of snapshot.resolved) remove(item.id)
    for (const item of snapshot.pending) {
      const fingerprint = JSON.stringify([item.kind, item.sessionId, item.request])
      const previous = this.#pending.get(item.id)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('INTERACTION_CONTENT_CHANGED'), { code: 'INTERACTION_CONTENT_CHANGED' })
        previous.ownerInstanceId = snapshot.ownerInstanceId
        previous.confirmed = snapshot.available && item.confirmed
        if (previous.confirmed && previous.retryAt <= this.#now()) {
          previous.retryAt = undefined
          previous.count++
          output.push(interactionToBrowserFrame(item, previous.browserId, this.#codec.encodeCompositeId(this.#hostId, item.sessionId)))
        }
        continue
      }
      const browserId = this.#codec.encodeCompositeId(this.#hostId, JSON.stringify(['interaction-v1', snapshot.runtimeEpoch, item.id]))
      const row = { interaction: true, hostId: this.#hostId, runtimeEpoch: snapshot.runtimeEpoch, interactionId: item.id,
        browserId, fingerprint, sessionId: item.sessionId, count: 1, defer: () => this.defer(browserId),
        ownerInstanceId: snapshot.ownerInstanceId, confirmed: snapshot.available && item.confirmed }
      this.#pending.set(item.id, row)
      this.#mappings.set(browserId, row)
      output.push(interactionToBrowserFrame(item, browserId, this.#codec.encodeCompositeId(this.#hostId, item.sessionId)))
    }
    if (!snapshot.available) this.unavailable()
    return output
  }
}
