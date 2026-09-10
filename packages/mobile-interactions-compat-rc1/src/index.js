import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createCarrier } from './carrier.js'

export const name = 'mobile-interactions-compat-rc1'
export const inject = ['webServer', 'connection']
const message = (method, payload, rpcId = randomUUID()) => ({ type: 'server-request', rpcId, method, payload })

export class InteractionBridge {
  #pending = new Map()
  #listeners = new Set()
  #clientId
  #send
  #inFlight = new Set()
  status() { return { connected: Boolean(this.#clientId), pendingCount: this.#pending.size, respondingCount: this.#inFlight.size } }
  snapshot() { return [...this.#pending.values()].map(item => item.wire) }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  #emit(frame) { for (const listener of this.#listeners) listener(frame) }
  attach(send) { this.disconnect(); this.#send = send }
  accept(frame) {
    if (frame.type === 'ready') { this.#clientId = frame.clientId; return }
    if (frame.type === 'cancel') { this.#resolve(frame.eventId, 'cancelled'); return }
    if (frame.type !== 'waterfall' || !['approval/request', 'user-questions/request'].includes(frame.event)) return
    if (!this.#clientId || typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string') throw new Error('INTERACTION_FRAME_INVALID')
    if (this.#pending.has(frame.eventId)) return
    const sessionId = frame.agentId
    const approval = frame.event === 'approval/request'
    const payload = approval
      ? { sessionId, approvalId: frame.eventId, toolName: frame.request.toolName, ...(frame.request.callId ? { callId: frame.request.callId } : {}), ...(frame.request.reason ? { reason: frame.request.reason } : {}) }
      : { sessionId, questions: frame.request.questions }
    const wire = message(approval ? 'approval/requested' : 'question/requested', payload, frame.eventId)
    this.#pending.set(frame.eventId, { wire, approval, sessionId })
    this.#emit(wire)
  }
  #resolve(id, outcome) {
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    this.#emit(message(entry.approval ? 'approval/resolved' : 'question/resolved', entry.approval
      ? { sessionId: entry.sessionId, approvalId: id, outcome }
      : { sessionId: entry.sessionId, questionRpcId: id }))
  }
  disconnect() {
    this.#clientId = undefined
    this.#send = undefined
    // Withdraw stale actionable UI. Reconnect receives the official pending replay.
    for (const id of [...this.#pending.keys()]) this.#resolve(id, 'unavailable')
  }
  async respond(body) {
    const id = body?.rpcId
    const entry = this.#pending.get(id)
    if (!entry || !this.#clientId || !this.#send) return { accepted: false, reason: 'interaction_not_pending' }
    if (this.#inFlight.has(id)) return { accepted: false, reason: 'response_in_flight' }
    if (body.type !== 'client-response' || body.result?.ok !== true || body.result.value?.sessionId !== entry.sessionId) return { accepted: false, reason: 'invalid_response' }
    const value = body.result.value
    if (entry.approval && (value.approvalId !== id || !['allowed-once', 'rejected'].includes(value.outcome))) return { accepted: false, reason: 'invalid_response' }
    if (!entry.approval && !Array.isArray(value.answer?.answers)) return { accepted: false, reason: 'invalid_response' }
    const clientId = this.#clientId
    this.#inFlight.add(id)
    try {
      await this.#send({ clientId, eventId: id, outcome: { kind: 'result', value: entry.approval ? value.outcome : value.answer } })
      this.#resolve(id, entry.approval ? value.outcome : 'resolved')
      return { accepted: true }
    } catch {
      return { accepted: false, reason: 'response_not_confirmed' }
    } finally { this.#inFlight.delete(id) }
  }
}

export function apply(ctx) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('INTERACTIONS_REQUIRE_LOOPBACK')
  return ctx.effect(() => {
    const bridge = new InteractionBridge()
    const lifetime = new AbortController()
    ctx.provide('mobileInteractions', bridge)
    const unregister = ctx.webServer.register({ kind: 'exact', path: '/api/respond', handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection === 401 || rejection === 403 ? rejection : 503); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413); res.end(); return } chunks.push(chunk) }
        const result = await bridge.respond(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result))
      } catch { if (!res.headersSent) res.writeHead(400); res.end() }
    } })
    const run = async () => {
      const { default: WebSocket } = await import('ws')
      let lastFailure
      while (!lifetime.signal.aborted) {
        try {
          const origin = `http://127.0.0.1:${ctx.webServer.port}`
          const carrier = await createCarrier(origin, ctx.connection.authenticatedUrl(origin + '/'), WebSocket, lifetime.signal)
          bridge.attach(payload => carrier.result(payload))
          for await (const frame of carrier.events()) {
            bridge.accept(frame)
            if (frame.type === 'ready' && lastFailure) {
              console.info('DSH_MOBILE_INTERACTIONS_RECOVERED')
              lastFailure = undefined
            }
          }
        } catch (error) {
          bridge.disconnect()
          const reason = /^CARRIER_[A-Z_0-9]+$/.test(error?.message ?? '') ? error.message : 'CARRIER_UNAVAILABLE'
          if (!lifetime.signal.aborted && reason !== lastFailure) {
            console.warn(`DSH_MOBILE_INTERACTIONS_UNAVAILABLE ${reason}`)
            lastFailure = reason
          }
          if (!lifetime.signal.aborted) await delay(1000, undefined, { signal: lifetime.signal })
        }
      }
    }
    run().catch(() => bridge.disconnect())
    return () => { lifetime.abort(); bridge.disconnect(); unregister() }
  }, 'mobile-interactions-compat-rc1: authoritative pending interactions')
}
