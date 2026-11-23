// Public change history: docs/PUBLIC-CHANGES.md
// 只在连接参数变化时重建Host并释放旧生命周期链接。
// Public change history: docs/PUBLIC-CHANGES.md
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { normalizeRuntimeVersion, createInteractionPeerClient, classifyStreamFailure, markStreamFailure } from 'dsh-runtime-interface'
import { lazyCarrier } from './lazy-carrier.js'

export const name = 'rc1-host-carriers'
export const inject = ['webServer', 'runtimeInterface']
export const OFFICIAL_UPSTREAM_VERSION = '0.1.5-rc.2'
export const REMOTE_UPSTREAM_VERSION = '0.1.2-rc.1'

export function validateTarget(target) {
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target.id ?? '') || target.id === 'local') throw new Error('HOST_ID_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.alias ?? '')) throw new Error('HOST_ALIAS_INVALID')
  if (typeof target.configFile !== 'string' || !target.configFile) throw new Error('SSH_CONFIG_REQUIRED')
  for (const port of [target.localPort, target.remotePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HOST_PORT_INVALID')
  if (![undefined, 'desktop'].includes(target.runtime)) throw new Error('HOST_RUNTIME_INVALID')
  if (![undefined, 'none', 'systemd-user'].includes(target.launch)) throw new Error('HOST_LAUNCH_INVALID')
  return target
}

function sshArgs(target) {
  return ['-T', '-F', target.configFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10']
}

/** Never expose helper stdout/stderr to diagnostic exceptions. */
export const SYSTEMD_RESTART_COMMAND = 'systemctl --user restart dsh-web.service'

// 仅保旧配置比较/校验；传输实际版本必须来自该次已鉴权连接。
function configuredVersion(target) {
  return target?.upstreamVersion === undefined
    ? REMOTE_UPSTREAM_VERSION
    : normalizeRuntimeVersion(target.upstreamVersion)
}

/** Keep lifecycle and the legacy file proxy outside the runtime interface. */
function exposeCarrier({ hostId, carrier, label, version, raw, runtimeInterface }) {
  const wrapped = runtimeInterface.wrapHostCarrier({
    hostId,
    carrier,
    upstreamVersion: version,
    identity: { hostId },
  })
  return {
    ...wrapped,
    label,
    getState: carrier.getState?.bind(carrier),
    connect: carrier.connect?.bind(carrier),
    close: carrier.close?.bind(carrier),
    // file-proxy.js is the only existing raw transport consumer. Keep this
    // compatibility field on the carrier record while call/open stay wrapped.
    ...(typeof raw === 'function' ? { raw } : {}),
  }
}

async function capture(target, command, signal, timeoutMs = 15000) {
  signal.throwIfAborted()
  const child = spawn('ssh', [...sshArgs(target), target.alias, command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0, settled = false
    const finish = (error, kill = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (kill) child.kill()
      error ? reject(error) : resolve(output)
    }
    const abort = () => finish(signal.reason, true)
    const timer = setTimeout(() => finish(new Error('SSH_HELPER_UNAVAILABLE'), true), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { if (settled) return; bytes += chunk.length; if (bytes > 4096) finish(new Error('SSH_HELPER_UNAVAILABLE'), true); else output += chunk.toString('utf8') })
    child.stderr.resume()
    child.once('error', () => finish(new Error('SSH_HELPER_UNAVAILABLE')))
    child.once('close', code => finish(signal.aborted ? signal.reason : code !== 0 ? new Error('SSH_HELPER_UNAVAILABLE') : undefined))
    if (signal.aborted) abort()
  })
}

export function bootstrapCommand(port) {
  if (port !== 'desktop' && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('HOST_PORT_INVALID')
  return `node -e "process.stdout.write(JSON.stringify(require(require('node:path').join(require('node:os').homedir(),'.dsh-mobile','read-bootstrap.cjs')).readBootstrap(${port === 'desktop' ? "'desktop'" : port})))"`
}

function validateBootstrapRecord(record, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || record.version !== 1 || record.port !== port) throw new Error('HOST_BOOTSTRAP_INVALID')
  const source = new URL(record.authenticatedRootUrl)
  if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.port !== String(port) || source.pathname !== '/' || source.username || source.password || source.hash || [...source.searchParams.keys()].join() !== 'token' || !source.searchParams.get('token')) throw new Error('HOST_BOOTSTRAP_INVALID')
  return source
}

async function forwardPort() {
  const reservation = createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return port
}

function forwardReady(child, signal) {
  return new Promise((resolve, reject) => {
    let tail = ''
    const finish = error => {
      clearTimeout(timer)
      child.stderr.removeListener('data', data)
      child.removeListener('error', fail)
      child.removeListener('close', fail)
      signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const data = chunk => {
      const text = tail + chunk.toString('utf8')
      tail = text.slice(-256)
      // OpenSSH 8.9/10.0均在转发成功后进入client_loop，失败由ExitOnForwardFailure退出。
      if (text.includes('Entering interactive session.')) finish()
    }
    const fail = () => finish(new Error('SSH_FORWARD_UNAVAILABLE'))
    const abort = () => finish(new Error('CARRIER_DISCONNECTED'))
    const timer = setTimeout(() => finish(new Error('SSH_FORWARD_TIMEOUT')), 15000)
    child.stderr.on('data', data)
    child.once('error', fail)
    child.once('close', fail)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export async function connectSshCarrier(target, lifetime, createCarrier, WebSocket, { diagnostics } = {}) {
  validateTarget(target)
  lifetime.throwIfAborted()
  const entryId = randomUUID()
  const trace = (operation, metadata) => {
    try { diagnostics?.record({ phase: operation === 'ssh-error' ? 'carrier_error' : 'carrier_close', endpoint: 'host/describe', hostId: target.id, entryId, operation, ...metadata }) } catch { /* preserve lifecycle on diagnostic failure */ }
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([lifetime, controller.signal])
  let desktopMaterial
  if (target.runtime === 'desktop') {
    try {
      desktopMaterial = await capture(target, bootstrapCommand('desktop'), signal)
      const record = JSON.parse(desktopMaterial)
      validateBootstrapRecord(record, record.port)
      target = { ...target, remotePort: record.port }
    } catch {
      signal.throwIfAborted()
      throw new Error('HOST_CONNECTION_FAILED_BOOTSTRAP_READ')
    }
  }
  signal.throwIfAborted()
  const localPort = await forwardPort()
  signal.throwIfAborted()
  const child = spawn('ssh', [...sshArgs(target), '-v', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${localPort}:127.0.0.1:${target.remotePort}`, '-C', target.alias], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.resume()
  let ended = false, killIntent = false
  const closed = new Promise(resolve => {
    const end = (exitCode, exitSignal) => {
      ended = true
      trace('ssh-exit', { sshPid: child.pid, exitCode, exitSignal, killIntent, closeSource: 'child-exit' })
      controller.abort(); resolve()
    }
    child.once('error', error => {
      trace('ssh-error', { sshPid: child.pid, errorCode: error?.code, killIntent, closeSource: 'child-error' })
    })
    child.once('close', end)
  })
  const close = (closeSource = 'caller-close') => {
    if (ended || killIntent) return
    killIntent = true
    trace('ssh-close', { sshPid: child.pid, killIntent, closeSource })
    controller.abort(); child.kill()
  }
  const abort = () => close('host-lifetime')
  lifetime.addEventListener('abort', abort, { once: true })
  closed.then(() => lifetime.removeEventListener('abort', abort))
  let stage = 'FORWARD'
  try {
    await forwardReady(child, signal)
    signal.throwIfAborted()
    stage = 'BOOTSTRAP_READ'
    let material
    try { material = desktopMaterial ?? await capture(target, bootstrapCommand(target.remotePort), signal) }
    catch (error) {
      signal.throwIfAborted()
      if (target.launch !== 'systemd-user') throw error
      // systemd is the sole owner. Missing/failed services cannot fall back to detached SSH children.
      await capture(target, 'systemctl --user start dsh-web.service', signal)
      material = await capture(target, bootstrapCommand(target.remotePort), signal)
    }
    stage = 'BOOTSTRAP_VALIDATE'
    const record = JSON.parse(material)
    const source = validateBootstrapRecord(record, target.remotePort)
    const origin = `http://127.0.0.1:${localPort}`
    const entry = new URL('/', origin); entry.search = source.search
    stage = 'AUTHENTICATION'
    const carrier = await createCarrier(origin, entry.href, WebSocket, signal, { diagnostics, hostId: target.id, entryId })
    signal.throwIfAborted()
    const endpointChanged = target.runtime === 'desktop' ? async requestSignal => {
      const latest = JSON.parse(await capture(target, bootstrapCommand('desktop'), requestSignal))
      validateBootstrapRecord(latest, latest.port)
      // 同一进程热加载会更新别名实例号，不据此关闭仍然健康的读者。
      return latest.port !== record.port || (Number.isSafeInteger(latest.pid) && latest.pid > 0 && Number.isSafeInteger(record.pid) && record.pid > 0 && latest.pid !== record.pid)
    } : undefined
    return { carrier, closed, close, entryId, signal, localPort, remotePort: target.remotePort, ...(endpointChanged ? { endpointChanged } : {}) }
  } catch (error) {
    const failure = classifyStreamFailure(controller.signal.aborted && !lifetime.aborted
      ? { reason: 'transport-disconnected' } : error?.name === 'TimeoutError' ? { code: 'ETIMEDOUT' } : error)
    close('connect-failed')
    if (lifetime.aborted) lifetime.throwIfAborted()
    const wrapped = new Error(`HOST_CONNECTION_FAILED_${stage}`)
    throw failure.reason === 'unknown' ? wrapped : markStreamFailure(wrapped, failure)
  }
}

export function createRemoteHostControl({ seedTargets, createCarrier, WebSocket, perHost, localCarrier, lifetime, runtimeInterface }) {
  const seed = (seedTargets ?? []).map(target => validateTarget(target))
  const hostLife = new Map()
  const lastError = new Map()
  const helperOk = new Map()
  const resolvedPorts = new Map()
  let live = seed.map(target => ({ ...target, enabled: target.enabled !== false }))

  function sameConnection(before, after) {
    return before !== undefined
      && ['alias', 'configFile', 'localPort', 'remotePort', 'runtime'].every(key => before[key] === after[key])
      && (before.launch ?? 'none') === (after.launch ?? 'none')
      && configuredVersion(before) === configuredVersion(after)
  }

  function stop(id) {
    hostLife.get(id)?.abort()
    hostLife.delete(id)
    resolvedPorts.delete(id)
    const carrier = perHost.get(id)
    if (id !== 'local' && carrier) {
      carrier.close()
      perHost.delete(id)
    }
  }

  function attach(target) {
    if (target.enabled === false) return
    stop(target.id)
    const life = new AbortController()
    const linked = () => life.abort()
    if (lifetime.aborted) life.abort(lifetime.reason)
    else lifetime.addEventListener('abort', linked, { once: true, signal: life.signal })
    hostLife.set(target.id, life)
    configuredVersion(target)
    const lazy = lazyCarrier(async signal => {
      let entry
      try {
        entry = await connectSshCarrier(target, signal, createCarrier, WebSocket, { diagnostics: runtimeInterface.diagnostics })
        helperOk.set(target.id, true)
        resolvedPorts.set(target.id, { localPort: entry.localPort, remotePort: entry.remotePort })
        const version = await runtimeInterface.readHostRuntimeVersion(entry.carrier, signal)
        signal.throwIfAborted()
        const carrier = runtimeInterface.wrapHostCarrier({ hostId: target.id, carrier: entry.carrier,
          upstreamVersion: version ?? configuredVersion(target), versionConfirmed: version !== undefined,
          versionSignal: entry.signal,
          identity: { hostId: target.id } })
        lastError.delete(target.id)
        return { ...entry, carrier }
      } catch (error) {
        entry?.close('runtime-version-unavailable')
        lastError.set(target.id, error?.message)
        if (String(error?.message ?? '').includes('BOOTSTRAP_READ')) helperOk.set(target.id, false)
        throw error
      }
    }, life.signal, { diagnostics: runtimeInterface.diagnostics, hostId: target.id })
    const carrier = { ...lazy, hostId: target.id, label: target.label, signal: life.signal,
      runtimeInterfaceCarrier: true,
      get upstreamVersion() { return lazy.upstreamVersion },
      interactions: createInteractionPeerClient(lazy),
    }
    perHost.set(target.id, carrier)
  }

  for (const target of live) attach(target)

  return {
    getConfiguredTargets: () => seed,
    snapshot() {
      const remotes = {}
      for (const target of live) {
        const state = perHost.get(target.id)?.getState?.() ?? (target.enabled === false ? 'disabled' : 'offline')
        remotes[target.id] = {
          state,
          lastError: lastError.get(target.id) ?? null,
          helperReadable: helperOk.get(target.id) === true,
          localPort: resolvedPorts.get(target.id)?.localPort ?? null,
          ...(target.runtime === 'desktop' ? { remotePort: state === 'connected' ? resolvedPorts.get(target.id)?.remotePort ?? null : null } : {}),
        }
      }
      return {
        local: { state: localCarrier.getState(), lastError: lastError.get('local') ?? null },
        remotes,
      }
    },
    async hydrate(list) {
      const previous = new Map(live.map(target => [target.id, target]))
      live = list.map(target => ({ ...validateTarget(target), enabled: target.enabled !== false }))
      const keep = new Set(live.filter(target => target.enabled !== false).map(target => target.id))
      for (const id of [...perHost.keys()]) {
        if (id !== 'local' && !keep.has(id)) stop(id)
      }
      for (const target of live) {
        if (target.enabled === false) stop(target.id)
        else if (previous.get(target.id)?.enabled !== false && sameConnection(previous.get(target.id), target)) {
          const existing = perHost.get(target.id)
          if (existing) existing.label = target.label
        } else attach(target)
      }
    },
    async disconnect(id) {
      if (id === 'local') throw new Error('HOST_LOCAL_READONLY')
      if (!live.some(target => target.id === id)) throw new Error('HOST_NOT_FOUND')
      stop(id)
    },
    async retry(id, requestSignal) {
      if (id === 'local') throw new Error('HOST_LOCAL_READONLY')
      const target = live.find(item => item.id === id)
      if (!target || target.enabled === false) throw new Error('HOST_NOT_FOUND')
      requestSignal?.throwIfAborted()
      attach(target)
      await perHost.get(id).connect(requestSignal)
    },
    async restart(id, requestSignal) {
      if (id === 'local') throw new Error('HOST_LOCAL_READONLY')
      const target = live.find(item => item.id === id)
      if (!target) throw new Error('HOST_NOT_FOUND')
      if (target.launch !== 'systemd-user') throw new Error('RESTART_UNSUPPORTED')
      requestSignal?.throwIfAborted()
      stop(id)
      const signal = requestSignal ? AbortSignal.any([lifetime, requestSignal]) : lifetime
      try {
        await capture(target, SYSTEMD_RESTART_COMMAND, signal, 30000)
      } catch {
        attach(target)
        if (requestSignal?.aborted) requestSignal.throwIfAborted()
        throw new Error('RESTART_FAILED')
      }
      attach(target)
      await perHost.get(id).connect(requestSignal)
    },
  }
}

export async function apply(ctx, config = {}) {
  const [{ createCarrier }, { default: WebSocket }] = await Promise.all([
    import('dsh-mobile-interactions-compat-rc1/carrier'), import('ws'),
  ])
  const runtimeInterface = ctx.runtimeInterface
  if (!runtimeInterface || typeof runtimeInterface.wrapHostCarrier !== 'function' || !runtimeInterface.connection || typeof runtimeInterface.connection.authenticatedUrl !== 'function') throw new TypeError('runtimeInterface with connection/wrapHostCarrier is required')
  const localVersion = config.upstreamVersion === undefined
    ? runtimeInterface.upstreamVersion
    : normalizeRuntimeVersion(config.upstreamVersion)
  if (localVersion !== runtimeInterface.upstreamVersion) throw new Error('LOCAL_UPSTREAM_VERSION_MISMATCH')
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
  const localLazy = lazyCarrier(async signal => {
    const entryId = randomUUID()
    return { entryId, carrier: await createCarrier(origin, runtimeInterface.connection.authenticatedUrl(origin + '/'), WebSocket, signal, { diagnostics: runtimeInterface.diagnostics, hostId: 'local', entryId }), close() {} }
  }, lifetime.signal, { diagnostics: runtimeInterface.diagnostics, hostId: 'local' })
  const localCarrier = exposeCarrier({
    hostId: 'local',
    carrier: localLazy,
    label: 'Local',
    version: localVersion,
    raw: localLazy.raw.bind(localLazy),
    runtimeInterface,
  })
  perHost.set('local', localCarrier)
  ctx.provide('perHost', perHost)
  ctx.provide('remoteHostsControl', createRemoteHostControl({
    seedTargets: targets,
    createCarrier,
    WebSocket,
    perHost,
    localCarrier,
    lifetime: lifetime.signal,
    runtimeInterface,
  }))
  ctx.effect(() => () => lifetime.abort(), 'rc1-host-carriers: close owned transports')
}
