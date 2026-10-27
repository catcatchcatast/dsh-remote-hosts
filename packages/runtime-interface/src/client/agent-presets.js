// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                         
                                                                                                                                                 
import { sessionModelHost } from './model-catalog.js'

const HERO = 'conversation.hero.agentPreset'
const refusal = code => ({ ok: false, error: { code, message: 'Agent preset choices changed; choose again', details: {} } })

/** Adapt public registered chip faces, preserving the official controller and renderer.
 * The synchronous face scope captures its RPC before await; it is never held across await.
 * Automatic official stage application also goes through the selection guard. */
export function bindAgentPresetTargets({ slots, sessions, rpc, bridge, on, onRemote }) {
  if (!bridge) return () => {}
  if (typeof slots?.entries !== 'function' || typeof slots?.register !== 'function' || typeof slots?.subscribe !== 'function' || typeof rpc?.call !== 'function') throw Error('AGENT_PRESET_INTERFACE_INCOMPATIBLE')
  const original = rpc.call, descriptor = Object.getOwnPropertyDescriptor(rpc, 'call')
  const seats = new Map(), stops = []
  let active = true, scoped, origin, shadow, owner, installing = false, epoch = 0
  const target = seat => seat.sessionId === undefined ? bridge.getSelectedHost() ?? 'local' : sessionModelHost(seat.sessionId)
  const current = seat => !seat.disposed && (seat.sessionId === undefined || (sessions.binding(seat.sessionId) === seat.binding && (sessions.list.getSnapshot().byId[seat.sessionId]?.retainedBy?.mainView ?? 0) > 0))
  const stamp = seat => `${epoch}:${seat.generation}:${target(seat)}:${seat.sessionId ?? ''}:${current(seat)}`
  const inScope = (seat, fn) => { const before = scoped; try { scoped = seat; return fn() } finally { scoped = before } }
  const readTarget = (hostId, signal) => original.call(rpc, '/api', 'agentPresets/list', { args: {}, __hostId: hostId }, signal)
  const refresh = seat => { if (active && seat) seat.face.load().catch(() => {}) }
  const validResponse = response => response?.ok === true && Array.isArray(response.value?.presets)

  const call = function(channel, method, payload, signal) {
    if (!active || channel !== '/api') return original.call(this, channel, method, payload, signal)
    const seat = scoped ?? (method === 'agentPresets/select' ? seats.get(payload?.args?.agentId) : undefined)
    if (method === 'agentPresets/list' && seat) {
      const hostId = target(seat), ticket = stamp(seat)
      return Promise.resolve(readTarget(hostId, signal)).then(response => {
        if (!active || ticket !== stamp(seat)) return refusal('agent-preset/target-changed')
        if (validResponse(response)) seat.roster = response.value.presets
        return response
      })
    }
    if (method !== 'agentPresets/select') return original.call(this, channel, method, payload, signal)
    const hostId = sessionModelHost(payload?.args?.agentId), id = payload?.args?.agentPreset
    const staged = origin; origin = undefined
    return (async () => {
      if ((seat && (target(seat) !== hostId || !current(seat))) || (staged?.id === id && staged.hostId !== hostId)) {
        refresh(seat); return refusal('agent-preset/target-changed')
      }
      // The authoritative official select keeps first-turn locking and commits once.
      const result = await original.call(rpc, channel, method, { ...payload, __hostId: hostId }, signal)
      if (result?.ok === false && ['agent-preset/not-found', 'agent-preset/invalid'].includes(result.error?.code)) refresh(seat)
      return result
    })()
  }
  Object.defineProperty(rpc, 'call', { configurable: true, writable: true, value: call })

  const wrap = (entry, sessionId) => {
    const official = entry.inject(sessionId), store = official?.hooks?.agentPresetSeat
    if (!store || typeof official.load !== 'function' || typeof official.select !== 'function') throw Error('AGENT_PRESET_FACE_INCOMPATIBLE')
    const existing = seats.get(sessionId)
    if (existing?.store === store) return existing.face
    const seat = { sessionId, store, roster: [], selecting: false, loaded: false, generation: 0,
      binding: sessionId === undefined ? undefined : sessions.binding(sessionId) }
    const face = { ...official,
      async load() {
        if (!active) return
        seat.loaded = true
        const ticket = stamp(seat)
        await inScope(seat, () => official.load())
        if (!active || ticket !== stamp(seat)) return
        // A staged choice belongs to its original Host; do not display it as the
        // effective default of another Host while waiting for a new draft.
        if (origin && origin.hostId !== target(seat) && store.getSnapshot().current === origin.id) {
          store.set({ ...store.getSnapshot(), current: seat.roster.find(row => row.isDefault)?.id ?? '' })
        }
      },
      async select(id) {
        if (!active || seat.selecting || store.getSnapshot().busy) return
        seat.selecting = true
        const hostId = target(seat)
        try {
          if (!current(seat)) return refusal('agent-preset/target-changed').error.message
          origin = { hostId, id }
          const result = await inScope(seat, () => official.select(id))
          if (sessionId !== undefined && origin?.hostId === hostId && origin.id === id) origin = undefined
          return result
        } finally { seat.selecting = false }
      },
    }
    seat.face = face; seats.set(sessionId, seat)
    if (sessionId !== undefined) sessions.binding(sessionId)?.ctx?.effect?.(() => () => {
      seat.disposed = true; seat.generation++
      if (seats.get(sessionId) === seat) seats.delete(sessionId)
    }, 'runtime-interface: preset binding lifetime')
    return face
  }
  const install = () => {
    if (!active || installing) return
    const entry = slots.entries(HERO).find(item => item !== shadow?.entry && (item.options.priority ?? 0) === 0 && typeof item.inject === 'function')
    if (entry === owner) return
    installing = true
    try {
      // Slot replacement ends every old face, even while its Session is retained.
      for (const seat of seats.values()) { seat.disposed = true; seat.generation++ }
      shadow?.dispose(); shadow = undefined; seats.clear(); owner = entry
      if (entry) {
        const dispose = slots.register({ name: HERO, priority: -1, locale: entry.locale, inject: sessionId => wrap(entry, sessionId) }, entry.component)
        shadow = { dispose, entry: slots.entriesOfSlot(HERO)[0] }
      }
    } finally { installing = false }
  }
  stops.push(slots.subscribe(HERO, install))
  stops.push(bridge.onSelectedHost(() => {
    // Existing official loadGeneration invalidates older asynchronous replies.
    for (const seat of seats.values()) if (seat.sessionId === undefined) {
      seat.generation++; if (seat.loaded) refresh(seat)
    }
  }))
  // Official settings/reset refreshes call their controllers directly. Run the
  // public face refresh after that synchronous fanout, regardless of hook order,
  // so the official loadGeneration makes its unbound page reads obsolete.
  const refreshAfterOfficial = () => queueMicrotask(() => {
    if (active) for (const seat of seats.values()) if (seat.loaded) refresh(seat)
  })
  if (typeof on === 'function') stops.push(on('connection/reset', () => {
    epoch++; refreshAfterOfficial()
  }))
  if (typeof onRemote === 'function') stops.push(onRemote('settings/document-updated', namespace => {
    if (namespace === 'agent-preset-registry') refreshAfterOfficial()
  }))
  install()
  return () => {
    if (!active) return
    active = false; epoch++
    for (const stop of stops) stop?.()
    shadow?.dispose(); seats.clear(); origin = undefined
    if (rpc.call === call) {
      if (descriptor) Object.defineProperty(rpc, 'call', descriptor)
      else delete rpc.call
    }
  }
}
