import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createConnection } from 'node:net'
import { lazyCarrier } from './lazy-carrier.js'

export const name = 'rc1-host-carriers'
export const inject = ['webServer', 'connection']

export function validateTarget(target) {
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target.id ?? '') || target.id === 'local') throw new Error('HOST_ID_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.alias ?? '')) throw new Error('HOST_ALIAS_INVALID')
  if (typeof target.configFile !== 'string' || !target.configFile) throw new Error('SSH_CONFIG_REQUIRED')
  for (const port of [target.localPort, target.remotePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HOST_PORT_INVALID')
  if (![undefined, 'none', 'systemd-user'].includes(target.launch)) throw new Error('HOST_LAUNCH_INVALID')
  return target
}

function sshArgs(target) {
  return ['-T', '-F', target.configFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10']
}

/** Never expose helper stdout/stderr to diagnostic exceptions. */
async function capture(target, command, signal) {
  const child = spawn('ssh', [...sshArgs(target), target.alias, command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0
    const abort = () => child.kill()
    const timer = setTimeout(abort, 15000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) child.kill(); else output += chunk.toString('utf8') })
    child.stderr.resume()
    child.once('error', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('SSH_HELPER_UNAVAILABLE')) })
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0 || bytes > 4096) reject(new Error('SSH_HELPER_UNAVAILABLE'))
      else resolve(output)
    })
  })
}

export function bootstrapCommand(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HOST_PORT_INVALID')
  return `node -e "process.stdout.write(JSON.stringify(require(require('node:path').join(require('node:os').homedir(),'.dsh-mobile','read-bootstrap.cjs')).readBootstrap(${port})))"`
}

async function socketReady(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = ready => { socket.destroy(); resolve(ready) }
    socket.setTimeout(300)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export async function connectSshCarrier(target, lifetime, createCarrier, WebSocket) {
  validateTarget(target)
  lifetime.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([lifetime, controller.signal])
  const child = spawn('ssh', [...sshArgs(target), '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${target.localPort}:127.0.0.1:${target.remotePort}`, target.alias], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.resume()
  let ended = false
  const closed = new Promise(resolve => {
    const end = () => { ended = true; controller.abort(); resolve() }
    child.once('error', end); child.once('close', end)
  })
  const close = () => { controller.abort(); if (!ended) child.kill() }
  lifetime.addEventListener('abort', close, { once: true })
  closed.then(() => lifetime.removeEventListener('abort', close))
  let stage = 'FORWARD'
  try {
    const deadline = Date.now() + 15000
    while (!ended && !await socketReady(target.localPort)) {
      if (Date.now() >= deadline) throw new Error('SSH_FORWARD_TIMEOUT')
      await delay(100, undefined, { signal })
    }
    signal.throwIfAborted()
    stage = 'BOOTSTRAP_READ'
    let material
    try { material = await capture(target, bootstrapCommand(target.remotePort), signal) }
    catch (error) {
      signal.throwIfAborted()
      if (target.launch !== 'systemd-user') throw error
      // systemd is the sole owner. Missing/failed services cannot fall back to detached SSH children.
      await capture(target, 'systemctl --user start dsh-web.service', signal)
      material = await capture(target, bootstrapCommand(target.remotePort), signal)
    }
    stage = 'BOOTSTRAP_VALIDATE'
    const record = JSON.parse(material)
    if (record.version !== 1 || record.port !== target.remotePort) throw new Error('HOST_BOOTSTRAP_INVALID')
    const source = new URL(record.authenticatedRootUrl)
    if (source.hostname !== '127.0.0.1' || source.port !== String(target.remotePort) || source.pathname !== '/' || source.username || source.password || source.hash || [...source.searchParams.keys()].join() !== 'token') throw new Error('HOST_BOOTSTRAP_INVALID')
    const origin = `http://127.0.0.1:${target.localPort}`
    const entry = new URL('/', origin); entry.search = source.search
    stage = 'AUTHENTICATION'
    const carrier = await createCarrier(origin, entry.href, WebSocket, signal)
    return { carrier, closed, close }
  } catch {
    close()
    if (lifetime.aborted) lifetime.throwIfAborted()
    throw new Error(`HOST_CONNECTION_FAILED_${stage}`)
  }
}

export async function apply(ctx, config = {}) {
  const [{ createCarrier }, { default: WebSocket }] = await Promise.all([
    import('dsh-mobile-interactions-compat-rc1/carrier'), import('ws'),
  ])
  const targets = config.targets ?? []
  const ids = new Set(['local']), ports = new Set([ctx.webServer.port])
  for (const target of targets) {
    validateTarget(target)
    if (ids.has(target.id) || ports.has(target.localPort)) throw new Error('DUPLICATE_HOST_TARGET')
    ids.add(target.id); ports.add(target.localPort)
  }
  const lifetime = new AbortController()
  const perHost = new Map()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const localCarrier = lazyCarrier(async signal => ({
    carrier: await createCarrier(origin, ctx.connection.authenticatedUrl(origin + '/'), WebSocket, signal), close() {},
  }), lifetime.signal)
  localCarrier.label = 'Local'
  perHost.set('local', localCarrier)
  for (const target of targets) {
    const carrier = lazyCarrier(signal => connectSshCarrier(target, signal, createCarrier, WebSocket), lifetime.signal)
    carrier.label = target.label
    perHost.set(target.id, carrier)
  }
  ctx.provide('perHost', perHost)
  ctx.effect(() => () => lifetime.abort(), 'rc1-host-carriers: close owned transports')
}
