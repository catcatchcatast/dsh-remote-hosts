// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
                                                                                                                                             
                                                                                                                                             
import { randomUUID } from 'node:crypto'
import { classifyStreamFailure } from './stream-failure.js'
                                                                                                                                                       
                                                                                                                                                         

const epochKey = Symbol.for('dsh.runtime-interface.interaction-process-epoch.v1')
// Module/plugin reload is not a core process restart.
export const interactionRuntimeEpoch = globalThis[epochKey] ??= randomUUID()
export const INTERACTION_READ = 'hostInteractions/v1/read'
export const INTERACTION_RESPOND = 'hostInteractions/v1/respond'
const kinds = new Map([['user-questions/request', 'question'], ['approval/request', 'approval']])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const error = code => Object.assign(new Error(code), { code })
const cloneJson = value => {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') throw error('INTERACTION_PAYLOAD_INVALID')
  return JSON.parse(text)
}

/** All official interaction vocabulary and delivery handles terminate here. */
export function createHostInteractionSource(gateway, { upstreamVersion, sendResult, peer } = {}) {
  const scoped = upstreamVersion === '0.2.1-rc.2'
  const current = scoped || upstreamVersion === '0.2.0-rc.2'
  if (scoped && (!peer || peer.principal?.kind !== 'owner' || peer.interactions !== 'answer' || !peer.signal)) return undefined
  const dispatch = current ? sendResult : gateway?.dispatchRpc?.bind(gateway)
  if (typeof gateway?.wireStream?.open !== 'function' || typeof dispatch !== 'function') return undefined
  let active
  return Object.freeze({
    runtimeEpoch: interactionRuntimeEpoch,
    async *open(signal) {
      const generation = { clientId: undefined, deliveries: new Map(), abort: new AbortController() }
      const streamSignal = AbortSignal.any([signal, generation.abort.signal])
      active = generation
      try {
        const source = current
          ? await gateway.wireStream.open('$events', { args: {} }, (async function* () {})(), scoped ? peer : undefined, streamSignal)
          : await gateway.wireStream.open('$events', { args: {} }, streamSignal)
        for await (const frame of source) {
          streamSignal.throwIfAborted()
          if (active !== generation) return
          if (frame?.type === 'ready') {
            if (!id(frame.clientId)) throw error('INTERACTION_SOURCE_INVALID')
            generation.clientId = frame.clientId
            yield { type: 'ready' }
          } else if (frame?.type === 'waterfall' && kinds.has(frame.event)) {
            if (!generation.clientId || !id(frame.eventId) || !id(frame.agentId) || !record(frame.request)) throw error('INTERACTION_SOURCE_INVALID')
            const request = cloneJson(frame.request)
            if (frame.event === 'user-questions/request' && !Array.isArray(request.questions)) throw error('INTERACTION_SOURCE_INVALID')
            generation.deliveries.set(frame.eventId, frame.event)
            yield { type: 'pending', interaction: { id: frame.eventId, sessionId: frame.agentId, kind: kinds.get(frame.event), request } }
          } else if (frame?.type === 'cancel' && generation.deliveries.delete(frame.eventId)) {
            yield { type: 'resolved', id: frame.eventId, reason: 'resolved' }
          }
        }
      } finally {
        if (active === generation) active = undefined
        generation.deliveries.clear()
      }
    },
    async respond(interactionId, outcome, signal) {
      signal?.throwIfAborted()
      const current = active
      if (!current?.clientId || !current.deliveries.has(interactionId)) throw error('INTERACTION_UNCONFIRMED')
      if (!record(outcome) || outcome.kind !== 'result') throw error('INTERACTION_OUTCOME_INVALID')
      if (current.deliveries.get(interactionId) === 'user-questions/request' && (!record(outcome.value) || !Array.isArray(outcome.value.answers))) throw error('INTERACTION_OUTCOME_INVALID')
      if (current.deliveries.get(interactionId) === 'approval/request' && !['allowed-once', 'rejected'].includes(outcome.value)) throw error('INTERACTION_OUTCOME_INVALID')
      const payload = { args: { clientId: current.clientId, eventId: interactionId, outcome: cloneJson(outcome) } }
      try {
        const result = await dispatch('$events/result', payload, signal, scoped ? peer : undefined)
        if (result?.ok !== true) throw error('INTERACTION_RESPONSE_UNCONFIRMED')
        // The official gateway need not echo cancel to the answering client.
        current.deliveries.delete(interactionId)
      } catch (cause) {
        // Read again to establish whether the core still owns this pending
        // interaction; never replay the answer after an ambiguous receipt.
        current.abort.abort()
        throw cause
      }
      return { accepted: true }
    },
  })
}

export function isCoreInteractionFrame(frame) { return frame?.type === 'waterfall' && kinds.has(frame.event) }

/** Browser compatibility is separate from the peer and core protocols. */
export function interactionToBrowserFrame(interaction, eventId, agentId) {
  if (!record(interaction) || !['question', 'approval'].includes(interaction.kind) || !record(interaction.request)) throw error('INTERACTION_PROTOCOL_INVALID')
  return { type: 'waterfall', event: interaction.kind === 'question' ? 'user-questions/request' : 'approval/request', eventId, agentId, request: interaction.request }
}

/** Decode official Browser outcomes before any interaction business processing. */
export function decodeBrowserInteractionResult(payload) {
  const args = payload?.args
  if (!record(args) || typeof args.clientId !== 'string' || typeof args.eventId !== 'string' || !record(args.outcome)) throw error('INTERACTION_BROWSER_RESULT_INVALID')
  const decision = { next: 'defer', result: 'answer', rejected: 'reject' }[args.outcome.kind]
  if (!['defer', 'answer', 'reject'].includes(decision)) throw error('INTERACTION_BROWSER_RESULT_INVALID')
  return { clientId: args.clientId, eventId: args.eventId, outcome: args.outcome, decision }
}

export function createInteractionPeerClient(carrier) {
  const call = async (endpoint, payload, signal) => {
    let result
    try { result = await carrier.call(endpoint, payload, signal) }
    catch (cause) {
      // The caller's cancellation is distinct from the carrier's own deadline
      // or retired connection. Only readers consume the recoverability flag.
      const classified = signal?.aborted !== true && cause?.name === 'TimeoutError'
        ? { code: 'transport/timeout' }
        : signal?.aborted !== true && cause?.name === 'AbortError'
          ? { code: 'transport/disconnected' } : cause
      const failure = classifyStreamFailure(classified, { source: 'carrier', stage: 'live', signal })
      throw Object.assign(error('INTERACTION_PEER_UNAVAILABLE'), { streamFailure: failure, recoverable: failure.recoverable })
    }
    if (result?.ok !== true) throw error(/^INTERACTION_[A-Z_]+$/.test(result?.error?.code ?? '') ? result.error.code : 'INTERACTION_PEER_UNAVAILABLE')
    return result.value
  }
  return Object.freeze({
    async read(query, signal) {
      const value = await call(INTERACTION_READ, query, signal)
      if (!record(value) || value.protocolVersion !== 1 || !id(value.runtimeEpoch) || !id(value.ownerInstanceId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.available !== 'boolean' || !Array.isArray(value.pending) || !Array.isArray(value.resolved) || value.resolved.length > 512) throw error('INTERACTION_PROTOCOL_INVALID')
      const seen = new Set()
      for (const item of value.pending) {
        if (!record(item) || !id(item.id) || !id(item.sessionId) || !['question', 'approval'].includes(item.kind) || !record(item.request) || typeof item.confirmed !== 'boolean' || seen.has(item.id)) throw error('INTERACTION_PROTOCOL_INVALID')
        seen.add(item.id)
      }
      for (const item of value.resolved) if (!record(item) || !id(item.id) || typeof item.reason !== 'string') throw error('INTERACTION_PROTOCOL_INVALID')
      return value
    },
    async respond(input, signal) {
      const result = await call(INTERACTION_RESPOND, input, signal)
      if (result?.accepted !== true) throw error('INTERACTION_RESPONSE_UNCONFIRMED')
      return result
    },
  })
}

/** Authenticated exact routes. HTTP envelopes do not escape into business state. */
export function registerHostInteractionProtocol({ webServer, connection, state, send }) {
  const removers = [INTERACTION_READ, INTERACTION_RESPOND].map(endpoint => webServer.register({
    kind: 'exact', path: `/api/${endpoint}`, handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const controller = new AbortController()
      const cancel = () => { if (!res.writableEnded) controller.abort() }
      res.on('close', cancel)
      let rpcId
      try {
        let size = 0
        const chunks = []
        for await (const chunk of req) {
          size += chunk.length
          if (endpoint === INTERACTION_READ && size > 1024 * 1024) { res.writeHead(413); res.end(); return }
          chunks.push(chunk)
        }
        const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!record(wire) || wire.type !== 'client-request' || !id(wire.rpcId) || wire.method !== endpoint || !record(wire.payload)) throw error('INTERACTION_REQUEST_INVALID')
        rpcId = wire.rpcId
        let value
        if (endpoint === INTERACTION_READ) {
          const { ownerInstanceId, afterRevision, waitMs = 0 } = wire.payload
          if (Object.keys(wire.payload).some(key => !['ownerInstanceId', 'afterRevision', 'waitMs'].includes(key)) || (ownerInstanceId !== undefined && !id(ownerInstanceId)) || (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw error('INTERACTION_REQUEST_INVALID')
          value = await state.read({ ownerInstanceId, afterRevision, waitMs }, controller.signal)
        } else {
          const { runtimeEpoch, ownerInstanceId, interactionId, outcome } = wire.payload
          if (Object.keys(wire.payload).some(key => !['runtimeEpoch', 'ownerInstanceId', 'interactionId', 'outcome'].includes(key)) || !id(runtimeEpoch) || !id(ownerInstanceId) || !id(interactionId) || !record(outcome) || outcome.kind !== 'result' || Object.keys(outcome).some(key => !['kind', 'value'].includes(key))) throw error('INTERACTION_REQUEST_INVALID')
          value = await state.respond({ runtimeEpoch, ownerInstanceId, interactionId, outcome }, send, controller.signal)
        }
        if (!controller.signal.aborted) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
        }
      } catch (cause) {
        if (!controller.signal.aborted && !res.headersSent) {
          if (rpcId === undefined) { res.writeHead(400); res.end() }
          else {
            const code = /^INTERACTION_[A-Z_]+$/.test(cause?.code ?? '') ? cause.code : 'INTERACTION_UNAVAILABLE'
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code, message: code } } }))
          }
        }
      } finally { res.off('close', cancel) }
    },
  }))
  return () => { for (const remove of removers) remove() }
}
