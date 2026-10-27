// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
                                                                                                                                             
/** Official 0.2 Web representations terminate at this boundary. */
export const WEB_020_RUNTIME_VERSION = '0.2.0-rc.2'
export const WEB_021_RUNTIME_VERSION = '0.2.1-rc.2'
export const isWebRuntimeVersion = version => version === WEB_020_RUNTIME_VERSION || version === WEB_021_RUNTIME_VERSION
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw Object.assign(new Error(message), { code: 'runtime-interface/invalid-stream' }) }

export function toolResultMessage(message, targetV4) {
  if (!record(message)) return message
  if (message.role === 'tool') {
    if (typeof message.id !== 'string' || !message.id || typeof message.toolCallId !== 'string' || !Array.isArray(message.content) || !message.toolCallId || message.source?.kind !== 'tool' || message.source.callId !== message.toolCallId
      || message.content.some(block => block?.type === 'tool-result') || (message.isError !== undefined && typeof message.isError !== 'boolean')) invalid('Invalid V4 tool result')
    if (targetV4) return message
    const { toolCallId, content, isError, ...rest } = message
    const resultExtensions = {}
    for (const key of Object.keys(rest)) {
      if (key.startsWith('plugin:result:')) { resultExtensions[key.slice('plugin:result:'.length)] = rest[key]; delete rest[key] }
      else if (key.startsWith('plugin:message:')) { if (['id', 'source', 'role', 'content'].includes(key.slice('plugin:message:'.length))) invalid('V4 extension shadows message identity'); const value = rest[key]; delete rest[key]; rest[key.slice('plugin:message:'.length)] = value }
    }
    return { ...rest, role: 'user', content: [{ ...resultExtensions, type: 'tool-result', toolCallId, content, ...(isError === undefined ? {} : { isError }) }] }
  }
  if (!targetV4) return message
  const wrapper = message.content?.[0]
  if (typeof message.id !== 'string' || !message.id || typeof wrapper?.toolCallId !== 'string' || message.role !== 'user' || message.content?.length !== 1 || wrapper?.type !== 'tool-result'
    || !Array.isArray(wrapper.content) || !wrapper.toolCallId || message.source?.kind !== 'tool' || message.source.callId !== wrapper.toolCallId
    || wrapper.content.some(block => block?.type === 'tool-result') || (wrapper.isError !== undefined && typeof wrapper.isError !== 'boolean')) invalid('Invalid V3 tool result')
  const extensions = (value, fields, owner) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)).map(([key, value]) => [`plugin:${owner}:${key}`, value]))
  return { id: message.id, source: message.source, role: 'tool', toolCallId: wrapper.toolCallId, content: wrapper.content,
    ...(wrapper.isError === undefined ? {} : { isError: wrapper.isError }),
    ...extensions(message, ['id', 'source', 'role', 'content'], 'message'),
    ...extensions(wrapper, ['type', 'toolCallId', 'content', 'isError'], 'result') }
}

export function toolResultEvent(event, targetV4) {
  if (event?.type !== 'tool/result') return event
  const message = toolResultMessage(event.data?.message, targetV4)
  if (event.data?.error !== undefined && (message?.isError ?? message?.content?.[0]?.isError) !== true) invalid('Tool error metadata requires an error result')
  return { ...event, data: { ...event.data, message } }
}

export function inboxQueue(inbox) {
  if (!record(inbox) || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) invalid('Invalid inbox projection')
  return ['next-turn', 'next-step'].flatMap(target => inbox[target].map(message => ({ id: message.id, target, message })))
}
function queueInbox(items) {
  return { 'next-turn': items.filter(item => item.target !== 'next-step').map(item => item.message),
    'next-step': items.filter(item => item.target === 'next-step').map(item => item.message) }
}
export function canonicalControl(frame) {
  if (frame?.type === 'projection' && frame.key === 'inbox') {
    return { type: 'queue', sessionId: frame.sessionId, items: inboxQueue(frame.value), seq: frame.seq }
  }
  if (frame?.type !== 'baseline') return frame
  if (!record(frame.value?.projections) && !record(frame.value?.queues)) invalid('Invalid control baseline')
  const queues = { ...frame.value.queues }
  for (const [sessionId, block] of Object.entries(frame.value.projections ?? {})) {
    if (block.values?.inbox !== undefined) {
      const oldRows = new Map((queues[sessionId] ?? []).map(item => [item.id, item]))
      queues[sessionId] = inboxQueue(block.values.inbox).map(item => ({ ...oldRows.get(item.id), ...item }))
    }
  }
  return { ...frame, value: { ...frame.value, queues, jobs: frame.value.jobs ?? {} } }
}
export function browserControl(frame, targetV4 = true) {
  if (targetV4 && frame?.type === 'baseline' && (record(frame.value?.projections) || record(frame.value?.queues))) {
    const projections = { ...frame.value?.projections }
    for (const [sessionId, items] of Object.entries(frame.value?.queues ?? {})) {
      // A present authoritative block owns both its values and absent capabilities.
      if (projections[sessionId] !== undefined) continue
      const block = projections[sessionId] ?? { asOfSeq: -1, values: {} }
      if (block.values?.inbox === undefined) projections[sessionId] = { ...block, values: { ...block.values, inbox: queueInbox(items) } }
    }
    return { ...frame, value: targetV4 ? { projections } : { ...frame.value, projections } }
  }
  if (frame?.type === 'queue') {
    // Old 0.1.5 emits an authoritative sequenced inbox projection followed by
    // this unsequenced compatibility notification. Never mint a durable seq.
    if (!targetV4 && frame.sourceSeq === undefined) {
      const { seq: _seq, ...legacyQueue } = frame
      return legacyQueue
    }
    if (frame.seq === undefined) return targetV4 ? undefined : frame
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || Object.is(frame.seq, -0)) invalid('Invalid inbox projection sequence')
    return { type: 'projection', sessionId: frame.sessionId, key: 'inbox', value: queueInbox(frame.items), seq: frame.seq }
  }
  if (targetV4 && frame?.type === 'jobs') return undefined // supplied by job/list, not SessionManager
  return frame
}

/** Maintain the opaque projection block from a stable queue update. */
export function applyControlQueue(state, frame) {
  const block = state.projections[frame.sessionId] ?? { asOfSeq: -1, values: {} }
  // Keep full authoritative messages when the old compatibility echo arrives.
  if (frame.seq === undefined && block.values.inbox !== undefined) return state
  return { ...state, queues: { ...state.queues, [frame.sessionId]: frame.items },
    ...(frame.seq === undefined ? {} : { projections: { ...state.projections,
      [frame.sessionId]: { ...block, asOfSeq: Math.max(block.asOfSeq, frame.seq),
        values: { ...block.values, inbox: queueInbox(frame.items) } } } }) }
}

/** Host identity mapping of newly touched official DTOs lives beside their codec. */
export function scopeProjection(block, hostId, codec) {
  if (!record(block?.values?.inbox)) return block
  const inbox = block.values.inbox
  const map = messages => messages.map(message => ({ ...message, id: codec.encodeCompositeId(hostId, message.id) }))
  return { ...block, values: { ...block.values, inbox: { 'next-turn': map(inbox['next-turn']), 'next-step': map(inbox['next-step']) } } }
}
export function scopeJobFrame(frame, hostId, codec) {
  const map = job => ({ ...job, id: codec.encodeCompositeId(hostId, job.id),
    ...(typeof job.owner === 'string' ? { owner: codec.encodeCompositeId(hostId, job.owner) } : {}) })
  if (Array.isArray(frame?.jobs)) return { ...frame, jobs: frame.jobs.map(map) }
  if (record(frame?.job)) return { ...frame, job: map(frame.job) }
  return frame
}

export function createJobStreamEncoder(endpoint, encodeFrame = value => value) {
  let opened = false, settled = false, next
  return { push(frame) {
    if (endpoint === 'job/list') {
      if (frame?.type !== 'rows' || !Array.isArray(frame.jobs)) invalid('Invalid job roster')
    } else {
      if (settled) invalid('Job output arrived after status')
      if (!opened) {
        if (frame?.type !== 'opened' || !record(frame.job) || !Number.isSafeInteger(frame.from) || frame.from < 0) invalid('Invalid job output anchor')
        next = frame.from
      } else if (frame?.type === 'output') {
        if (!Array.isArray(frame.chunks) || !Number.isSafeInteger(frame.next) || frame.next < next) invalid('Invalid job output cursor')
        next = frame.next
      } else if (frame?.type === 'status' && record(frame.job) && ['completed', 'killed', 'failed'].includes(frame.job.status)) settled = true
      else invalid('Invalid job output frame')
    }
    opened = true
    return [encodeFrame(frame)]
  }, end() { if (endpoint === 'job/follow' && !settled) invalid('Job output ended before terminal status') }, close() {}, isOpening(frame) { return endpoint === 'job/list' ? frame?.type === 'rows' : frame?.type === 'opened' } }
}

/** Old hosts have only the control projection; do not issue invented job RPCs. */
export async function readLegacyProjections(carrier, request, signal) {
  for await (const frame of carrier.open('session/control', { args: {} }, signal)) {
    if (frame?.type !== 'baseline' || !record(frame.value?.projections)) invalid('Invalid legacy control baseline')
    const block = frame.value.projections[request.sessionId]
    if (block === undefined) return null
    // The projection is authoritative. Legacy queue rows omit role/source and
    // collapse placement, so they cannot supply a missing inbox capability.
    return block
  }
  invalid('Legacy control ended before baseline')
}
export async function* legacyJobRows(carrier, request, signal) {
  for await (const frame of carrier.open('session/control', { args: {} }, signal)) {
    if (frame?.type === 'baseline') yield { type: 'rows', jobs: (frame.value.jobs?.[request.sessionId] ?? []).map(legacyJobView) }
    else if (frame?.type === 'jobs' && frame.sessionId === request.sessionId) yield { type: 'rows', jobs: frame.jobs.map(legacyJobView) }
  }
}

/** Roster-only hosts expose no bytes through the independent observation port.
 * Zero describes this compatibility view; it does not assert the producer wrote
 * no output. Follow/kill remain capability-unavailable and status is preserved.
 */
function legacyJobView(job) { return { ...job, output: { total: 0, earliest: 0 } } }
