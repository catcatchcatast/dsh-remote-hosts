import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 64 * 1024 * 1024

export const name = 'dsh-project-panorama-adapter'
export const inject = ['sessions']

function pythonExecutable() {
  if (process.env.PROJECT_PANORAMA_PYTHON) return process.env.PROJECT_PANORAMA_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function topLevel(session) {
  const header = session?.header ?? {}
  const sessionId = String(session?.id ?? '')
  return Boolean(sessionId && header.cwd)
    && !sessionId.startsWith('rh1.')
    && !header.parentSession
    && header.origin !== 'subagent'
    && Number(header.delegationDepth ?? 0) === 0
}

export function captureCompleted(events) {
  const completed = []
  let active = null
  for (const event of events ?? []) {
    if (event.type === 'turn/start') active = { turn: event.data?.turn, events: [event] }
    else if (active) {
      active.events.push(event)
      if (event.type === 'turn/end' && event.data?.turn === active.turn) {
        completed.push(active)
        active = null
      }
    }
  }
  return { completed, active }
}

function safeWarn(ctx, category) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger('project-panorama') : null
  logger?.warn?.(`turn capture failed (${category})`)
}

export function createAdapter(ctx, options = {}) {
  const runtime = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'runtime', 'turn_envelope.py')
  const hostId = process.env.DSH_HOST_ID || hostname()
  const states = new Map()
  let serial = Promise.resolve()

  function enqueue(session, turn) {
    if (!topLevel(session) || !turn?.events?.length) return serial
    const envelope = {
      schemaVersion: 1,
      runtime: 'dsh',
      hostId,
      sessionId: String(session.id),
      turnId: String(turn.turn),
      projectRoot: String(session.header.cwd),
      parentSession: session.header.parentSession,
      origin: session.header.origin,
      delegationDepth: session.header.delegationDepth ?? 0,
      startSeq: turn.events[0].seq,
      endSeq: turn.events.at(-1).seq,
      events: turn.events,
      agentStatus: turn.agentStatus,
    }
    const encoded = Buffer.from(JSON.stringify(envelope))
    if (encoded.length > MAX_BYTES) {
      safeWarn(ctx, 'size')
      return serial
    }
    serial = serial.then(() => new Promise((resolve) => {
      const child = spawn(pythonExecutable(), [runtime, 'ingest'], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, PROJECT_PANORAMA_RUNTIME: 'dsh', PROJECT_PANORAMA_HOST_ID: hostId },
      })
      let errorBytes = 0
      child.stderr.on('data', (chunk) => { errorBytes += chunk.length })
      child.once('error', () => { safeWarn(ctx, 'spawn'); resolve() })
      child.once('exit', (code) => { if (code) safeWarn(ctx, `exit-${code}-${Math.min(errorBytes, 9999)}`); resolve() })
      child.stdin.end(encoded)
    })).catch(() => { safeWarn(ctx, 'queue') })
    return serial
  }

  function seed(session) {
    if (!topLevel(session)) return
    const parsed = captureCompleted(session.events)
    states.set(String(session.id), parsed.active)
    for (const turn of parsed.completed) enqueue(session, turn)
  }

  const disposers = []
  disposers.push(ctx.on('session/created', seed, { global: true }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (!topLevel(session)) return
    const key = String(session.id)
    if (event.type === 'turn/start') states.set(key, { turn: event.data?.turn, events: [event] })
    else {
      const active = states.get(key)
      if (!active) return
      active.events.push(event)
      if (event.type === 'turn/end' && event.data?.turn === active.turn) {
        states.delete(key)
        enqueue(session, active)
      }
    }
  }, { global: true }))
  disposers.push(ctx.on('session/flush', (session) => topLevel(session) ? serial : undefined, { global: true }))
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    const session = agent?.session
    const active = session ? states.get(String(session.id)) : null
    if (active && status) active.agentStatus = String(status)
  }, { global: true }))
  for (const session of ctx.sessions?.list?.() ?? []) seed(session)
  return () => { for (const dispose of disposers.reverse()) dispose?.(); states.clear() }
}

export function apply(ctx) {
  return createAdapter(ctx)
}

export default { name, inject, apply }
