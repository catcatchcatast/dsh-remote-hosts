// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                             
                                                                                                                                                         

import { createHash, randomUUID } from 'node:crypto'

const PROTOCOL_VERSION = 1
const DEFAULT_MAX_RESOLVED = 512
const MAX_WAIT_MS = 10_000

const CODE = Object.freeze({
  invalidEvent: 'invalid_event',
  invalidInteraction: 'invalid_interaction',
  invalidRead: 'invalid_read',
  invalidResponse: 'invalid_response',
  invalidSender: 'invalid_sender',
  invalidState: 'invalid_state',
  ownerMismatch: 'owner_mismatch',
  runtimeEpochMismatch: 'runtime_epoch_mismatch',
  readCancelled: 'read_cancelled',
  interactionNotPending: 'interaction_not_pending',
  interactionUnavailable: 'interaction_unavailable',
  interactionNotConfirmed: 'interaction_not_confirmed',
  interactionResolved: 'interaction_resolved',
  responseInFlight: 'response_in_flight',
  responseNotConfirmed: 'response_not_confirmed',
  outcomeConflict: 'outcome_conflict',
  overloaded: 'overloaded',
  protocolFault: 'protocol_fault',
})

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const isBoundedInteger = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const reject = code => ({ accepted: false, code, reason: code })
const accept = extra => ({ accepted: true, ...(extra ?? {}) })

function stateError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * Produce a deterministic JSON representation without invoking user supplied
 * toJSON methods. It is used for payload equality and the pending-byte bound.
 */
function canonicalJson(value, stack = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined
  if (typeof value !== 'object') return undefined
  if (stack.has(value)) return undefined
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      const items = []
      for (const item of value) {
        const encoded = canonicalJson(item, stack)
        if (encoded === undefined) return undefined
        items.push(encoded)
      }
      return `[${items.join(',')}]`
    }
    const fields = []
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalJson(value[key], stack)
      if (encoded === undefined) return undefined
      fields.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${fields.join(',')}}`
  } finally {
    stack.delete(value)
  }
}

function copyJson(value) {
  const encoded = canonicalJson(value)
  if (encoded === undefined) throw stateError(CODE.invalidState)
  return JSON.parse(encoded)
}

function interactionKey(interaction) {
  try {
    return canonicalJson({
      id: interaction.id,
      sessionId: interaction.sessionId,
      kind: interaction.kind,
      request: interaction.request,
    })
  } catch {
    return undefined
  }
}

function outcomeKey(outcome) {
  if (!isRecord(outcome) || outcome.kind !== 'result' || !hasOwn(outcome, 'value')) return undefined
  try {
    const encoded = canonicalJson(outcome)
    return encoded === undefined ? undefined : createHash('sha256').update(encoded).digest('hex')
  } catch { return undefined }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Process-local business state for questions and approvals, with optional operator budgets.
 *
 * The module deliberately knows neither a transport client id nor an upstream
 * frame shape. A connection generation is represented only by `confirmed`:
 * disconnect retires confirmation, ready restores availability, and a current
 * generation pending replay confirms one matching interaction.
 */
export class HostInteractionState {
  #runtimeEpoch
  #ownerInstanceId
  #maxPending
  #maxBytes
  #maxResolved
  #pending = new Map()
  #resolved = new Map()
  #resolvedOrder = []
  #inFlight = new Map()
  #readers = new Set()
  #pendingBytes = 0
  #revision = 0
  #available = false
  #fault
  #generation = 0

  constructor(options = {}) {
    if (!isRecord(options) || !hasOwn(options, 'runtimeEpoch') || options.runtimeEpoch === undefined || options.runtimeEpoch === null) {
      throw stateError(CODE.invalidState)
    }
    const maxPending = options.maxPending ?? Infinity
    const maxBytes = options.maxBytes ?? Infinity
    const maxResolved = options.maxResolved ?? DEFAULT_MAX_RESOLVED
    if ((options.maxPending != null && !Number.isSafeInteger(maxPending)) || maxPending < 1
      || (options.maxBytes != null && !Number.isSafeInteger(maxBytes)) || maxBytes < 1
      || !Number.isSafeInteger(maxResolved) || maxResolved < 1) throw stateError(CODE.invalidState)

    this.#runtimeEpoch = options.runtimeEpoch
    this.#ownerInstanceId = options.ownerId === undefined ? randomUUID() : options.ownerId
    if (!isNonEmptyString(this.#ownerInstanceId)) throw stateError(CODE.invalidState)
    this.#maxPending = maxPending
    this.#maxBytes = maxBytes
    this.#maxResolved = maxResolved
  }

  snapshot() {
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeEpoch: this.#runtimeEpoch,
      ownerInstanceId: this.#ownerInstanceId,
      revision: this.#revision,
      available: this.#available,
      pending: [...this.#pending.values()].map(entry => ({
        id: entry.id,
        sessionId: entry.sessionId,
        kind: entry.kind,
        request: copyJson(entry.request),
        confirmed: entry.confirmed,
      })),
      resolved: this.#resolvedOrder
        .map(id => this.#resolved.get(id))
        .filter(Boolean)
        .map(entry => ({ id: entry.id, reason: entry.reason })),
    }
    if (this.#fault !== undefined) result.fault = this.#fault
    return result
  }

  accept(event) {
    if (!isRecord(event) || typeof event.type !== 'string') return reject(CODE.invalidEvent)
    if (event.type === 'ready') return this.#ready()
    if (event.type === 'pending') return this.#pendingEvent(event.interaction)
    if (event.type === 'resolved') return this.#resolvedEvent(event)
    return reject(CODE.invalidEvent)
  }

  disconnected() {
    let changed = this.#available
    this.#available = false
    for (const entry of this.#pending.values()) {
      if (entry.confirmed) changed = true
      entry.confirmed = false
    }
    if (changed) this.#touch()
    return accept()
  }

  async read(options = {}, signal) {
    if (!isRecord(options)) return reject(CODE.invalidRead)
    // A peer may retain an owner id from before a process-local state rebuild.
    // Return the current full snapshot immediately so it can adopt the new
    // owner; treating this as an error would strand the reconnect handshake.
    if (options.ownerInstanceId !== undefined && options.ownerInstanceId !== this.#ownerInstanceId) return this.snapshot()
    const afterRevision = options.afterRevision
    if (afterRevision !== undefined && !isBoundedInteger(afterRevision)) return reject(CODE.invalidRead)
    const waitMs = options.waitMs === undefined ? MAX_WAIT_MS : options.waitMs
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) return reject(CODE.invalidRead)
    if (signal?.aborted === true) return reject(CODE.readCancelled)
    if (afterRevision === undefined || this.#revision !== afterRevision || waitMs === 0) return this.snapshot()

    return new Promise(resolve => {
      const reader = {
        afterRevision,
        resolve,
        timer: undefined,
        signal,
        onAbort: undefined,
      }
      reader.onAbort = () => this.#finishReader(reader, reject(CODE.readCancelled))
      this.#readers.add(reader)
      signal?.addEventListener?.('abort', reader.onAbort, { once: true })
      reader.timer = setTimeout(() => this.#finishReader(reader, this.snapshot()), waitMs)
      if (this.#revision !== afterRevision) this.#finishReader(reader, this.snapshot())
    })
  }

  async respond(input, send, signal) {
    if (!isRecord(input) || input.ownerInstanceId !== this.#ownerInstanceId) return reject(CODE.ownerMismatch)
    if (!isRecord(input) || !hasOwn(input, 'runtimeEpoch') || !Object.is(input.runtimeEpoch, this.#runtimeEpoch)
      || !isNonEmptyString(input.interactionId)) {
      return reject(!isRecord(input) || !hasOwn(input, 'runtimeEpoch') || !Object.is(input?.runtimeEpoch, this.#runtimeEpoch)
        ? CODE.runtimeEpochMismatch : CODE.invalidResponse)
    }
    const key = outcomeKey(input.outcome)
    if (key === undefined) return reject(CODE.invalidResponse)

    const id = input.interactionId
    const receipt = this.#resolved.get(id)
    if (receipt !== undefined) {
      if (receipt.outcomeKey !== undefined && receipt.outcomeKey === key) {
        return { accepted: true, receipt: { id: receipt.id, reason: receipt.reason } }
      }
      return reject(receipt.outcomeKey === undefined ? CODE.interactionResolved : CODE.outcomeConflict)
    }
    if (this.#fault !== undefined) return reject(this.#fault)
    const entry = this.#pending.get(id)
    if (entry === undefined) return reject(CODE.interactionNotPending)
    if (!this.#available) return reject(CODE.interactionUnavailable)
    if (!entry.confirmed) return reject(CODE.interactionNotConfirmed)
    if (this.#inFlight.has(id)) return reject(CODE.responseInFlight)
    if (typeof send !== 'function') return reject(CODE.invalidSender)
    if (signal?.aborted === true) return reject(CODE.responseNotConfirmed)

    const payload = copyJson(input.outcome)
    const attemptGeneration = this.#generation
    this.#inFlight.set(id, { entry, key })
    try {
      const reply = await send(id, payload, signal)
      if (reply === false || (isRecord(reply) && (reply.ok === false || reply.accepted === false))) throw stateError(CODE.responseNotConfirmed)
      if (this.#pending.get(id) === entry) {
        this.#pending.delete(id)
        this.#pendingBytes = Math.max(0, this.#pendingBytes - entry.bytes)
        this.#storeReceipt(id, 'resolved', key)
        this.#touch()
      }
      const finalReceipt = this.#resolved.get(id)
      if (finalReceipt !== undefined) {
        if (finalReceipt.reason !== 'resolved') return reject(CODE.responseNotConfirmed)
        // The explicit core terminal event may arrive before the RPC receipt.
        // Attach only the digest after a confirmed send; never retain answers.
        finalReceipt.outcomeKey ??= key
        return { accepted: true, receipt: { id: finalReceipt.id, reason: finalReceipt.reason } }
      }
      return reject(CODE.responseNotConfirmed)
    } catch {
      // Once send began, failure may mean the core accepted the answer but
      // its receipt was lost. Require a fresh authoritative replay before any
      // new attempt, even if a caller repeats the same answer immediately.
      if (this.#generation === attemptGeneration && this.#pending.get(id) === entry && entry.confirmed) {
        entry.confirmed = false
        this.#touch()
      }
      return reject(CODE.responseNotConfirmed)
    } finally {
      this.#inFlight.delete(id)
    }
  }

  #ready() {
    if (this.#fault !== undefined) return reject(this.#fault)
    this.#generation += 1
    let changed = !this.#available
    this.#available = true
    for (const entry of this.#pending.values()) {
      if (entry.confirmed) changed = true
      entry.confirmed = false
    }
    if (changed) this.#touch()
    return accept()
  }

  #pendingEvent(interaction) {
    if (!isRecord(interaction) || !isNonEmptyString(interaction.id) || !isNonEmptyString(interaction.sessionId)
      || !['question', 'approval'].includes(interaction.kind) || !hasOwn(interaction, 'request')) return reject(CODE.invalidInteraction)
    if (this.#fault !== undefined) return reject(this.#fault)
    const key = interactionKey(interaction)
    if (key === undefined) return reject(CODE.invalidInteraction)
    const existing = this.#pending.get(interaction.id)
    if (existing !== undefined) {
      if (existing.key !== key) {
        this.#setFault(CODE.protocolFault)
        return reject(CODE.protocolFault)
      }
      // A replay only re-confirms the stable business identity. Adapter code
      // owns any transport rebinding; this operation has no outward event.
      if (this.#available && !existing.confirmed) {
        existing.confirmed = true
        this.#touch()
      }
      return accept()
    }
    if (this.#resolved.has(interaction.id)) return reject(CODE.interactionResolved)
    const bytes = byteLength(key)
    if (this.#pending.size >= this.#maxPending || this.#pendingBytes + bytes > this.#maxBytes) {
      this.#setFault(CODE.overloaded)
      return reject(CODE.overloaded)
    }
    let request
    try { request = copyJson(interaction.request) } catch { return reject(CODE.invalidInteraction) }
    this.#pending.set(interaction.id, {
      id: interaction.id,
      sessionId: interaction.sessionId,
      kind: interaction.kind,
      request,
      key,
      bytes,
      confirmed: this.#available && this.#generation > 0,
    })
    this.#pendingBytes += bytes
    this.#touch()
    return accept()
  }

  #resolvedEvent(event) {
    if (!isNonEmptyString(event.id) || !['resolved', 'cancelled'].includes(event.reason)) return reject(CODE.invalidEvent)
    const existingReceipt = this.#resolved.get(event.id)
    if (existingReceipt !== undefined) return accept()
    const entry = this.#pending.get(event.id)
    if (entry !== undefined) {
      this.#pending.delete(event.id)
      this.#pendingBytes = Math.max(0, this.#pendingBytes - entry.bytes)
    }
    this.#storeReceipt(event.id, event.reason)
    this.#touch()
    return accept()
  }

  #storeReceipt(id, reason, key) {
    if (this.#resolved.has(id)) return this.#resolved.get(id)
    const receipt = { id, reason, ...(key === undefined ? {} : { outcomeKey: key }) }
    this.#resolved.set(id, receipt)
    this.#resolvedOrder.push(id)
    while (this.#resolvedOrder.length > this.#maxResolved) {
      const oldest = this.#resolvedOrder.shift()
      if (oldest !== id) this.#resolved.delete(oldest)
    }
    return receipt
  }

  #setFault(code) {
    if (this.#fault !== undefined) return
    this.#fault = code
    this.#available = false
    for (const entry of this.#pending.values()) entry.confirmed = false
    this.#touch()
  }

  #touch() {
    this.#revision += 1
    this.#notifyReaders()
  }

  #notifyReaders() {
    for (const reader of [...this.#readers]) {
      if (reader.afterRevision !== this.#revision) this.#finishReader(reader, this.snapshot())
    }
  }

  #finishReader(reader, result) {
    if (!this.#readers.delete(reader)) return
    if (reader.timer !== undefined) clearTimeout(reader.timer)
    reader.signal?.removeEventListener?.('abort', reader.onAbort)
    reader.resolve(result)
  }
}

export default HostInteractionState
