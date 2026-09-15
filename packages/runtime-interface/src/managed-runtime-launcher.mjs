
import { appendFile, link, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, fork, spawn } from 'node:child_process'
import net from 'node:net'

export const MANAGED_RUNTIME_DESCRIPTOR_VERSION = 1
export const MANAGED_RUNTIME_LAUNCHER_VERSION = 1
export const BUNDLED_MANAGED_RUNTIME_LAUNCHER = fileURLToPath(import.meta.url)

const DESCRIPTOR_KEYS = new Set([
  'formatVersion', 'profileId', 'hostId', 'nodePath', 'argv', 'cwd', 'dshHome', 'port',
  'brokerPath', 'launcherId', 'mutexPath', 'mutexDir', 'instancePath', 'logPath', 'environment', 'readyTimeoutMs', 'exitWaitMs',
])
const ENVIRONMENT_KEYS = new Set(['DSH_HOME', 'APPDATA', 'LOCALAPPDATA', 'PROJECT_PANORAMA_PYTHON', 'PROJECT_PANORAMA_PYTHON_SITE', 'NO_COLOR', 'PYTHONDONTWRITEBYTECODE', 'DSH_LOCAL_RESTART_DIAGNOSTICS'])
const ENVIRONMENT_PATH_KEYS = new Set(['DSH_HOME', 'APPDATA', 'LOCALAPPDATA', 'PROJECT_PANORAMA_PYTHON', 'PROJECT_PANORAMA_PYTHON_SITE'])
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LAUNCHER_ID = /^managed-runtime\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ARGV = 128
const MIN_PORT = 1024
const MAX_PORT = 65535
const PROCESS_STAMP_MAX_LENGTH = 512
const PROCESS_STAMP_QUERY_TIMEOUT_MS = 12000
const MANAGED_RUNTIME_BROKER_MODES = new Set(['restart', 'start'])

export class ManagedRuntimeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ManagedRuntimeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, label, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', `${label} is invalid`)
  }
  return value
}

function absolutePath(value, label) {
  const result = boundedString(value, label, 4096)
  if (!isAbsolute(result)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', `${label} must be absolute`)
  return normalize(resolve(result))
}

function samePath(left, right) {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function positiveInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', `${label} is out of range`)
  }
  return value
}

function normalizeManagedRuntimeBrokerMode(value) {
  const mode = value === undefined ? 'restart' : value
  if (!MANAGED_RUNTIME_BROKER_MODES.has(mode)) {
    throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker mode is invalid')
  }
  return mode
}

function defaultDshHome(processLike = globalThis.process) {
  const configured = processLike?.env?.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

function sortedDescriptor(descriptor) {
  return {
    formatVersion: descriptor.formatVersion,
    profileId: descriptor.profileId,
    hostId: descriptor.hostId,
    nodePath: descriptor.nodePath,
    argv: [...descriptor.argv],
    cwd: descriptor.cwd,
    dshHome: descriptor.dshHome,
    port: descriptor.port,
    brokerPath: descriptor.brokerPath,
    launcherId: descriptor.launcherId,
    ...(descriptor.mutexPath === undefined ? {} : { mutexPath: descriptor.mutexPath }),
    ...(descriptor.mutexDir === undefined ? {} : { mutexDir: descriptor.mutexDir }),
    ...(descriptor.instancePath === undefined ? {} : { instancePath: descriptor.instancePath }),
    ...(descriptor.logPath === undefined ? {} : { logPath: descriptor.logPath }),
    ...(descriptor.environment === undefined ? {} : { environment: { ...descriptor.environment } }),
    ...(descriptor.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: descriptor.readyTimeoutMs }),
    ...(descriptor.exitWaitMs === undefined ? {} : { exitWaitMs: descriptor.exitWaitMs }),
  }
}

/**
 * Normalize the only descriptor accepted by the managed launcher.
 * `brokerPath` is package-owned: a static operation file cannot redirect the
 * broker to an arbitrary command. RPC callers never receive this object.
 */
export function normalizeManagedRuntimeDescriptor(value, { launcherPath = BUNDLED_MANAGED_RUNTIME_LAUNCHER } = {}) {
  if (!record(value)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'local runtime descriptor must be an object')
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_KEYS.has(key)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_FIELDS', `descriptor field ${key} is not allowed`)
  }
  if (value.formatVersion !== MANAGED_RUNTIME_DESCRIPTOR_VERSION) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'descriptor version is unsupported')
  const profileId = boundedString(value.profileId, 'profileId', 128)
  if (!PROFILE_ID.test(profileId)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'profileId is invalid')
  if (value.hostId !== 'local') throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_IDENTITY', 'descriptor hostId is not local')
  const nodePath = absolutePath(value.nodePath, 'nodePath')
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > MAX_ARGV || value.argv.some(item => typeof item !== 'string' || item.length === 0 || item.length > 4096 || item.includes('\u0000'))) {
    throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'argv is invalid')
  }
  if (!samePath(value.argv[0], nodePath)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_IDENTITY', 'argv[0] does not match nodePath')
  const cwd = absolutePath(value.cwd, 'cwd')
  const dshHome = absolutePath(value.dshHome, 'dshHome')
  const port = positiveInteger(value.port, 'port', MIN_PORT, MAX_PORT)
  const launcherId = boundedString(value.launcherId, 'launcherId', 256)
  if (!LAUNCHER_ID.test(launcherId) || launcherId !== `managed-runtime/${profileId}`) {
    throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_IDENTITY', 'launcherId does not match profileId')
  }
  const bundledPath = absolutePath(launcherPath, 'launcherPath')
  const brokerPath = value.brokerPath === undefined ? bundledPath : absolutePath(value.brokerPath, 'brokerPath')
  if (!samePath(brokerPath, bundledPath)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_IDENTITY', 'brokerPath is not package-owned')
  const mutexPath = value.mutexPath === undefined ? undefined : absolutePath(value.mutexPath, 'mutexPath')
  const mutexDir = value.mutexDir === undefined ? undefined : absolutePath(value.mutexDir, 'mutexDir')
  const instancePath = value.instancePath === undefined ? undefined : absolutePath(value.instancePath, 'instancePath')
  const logPath = value.logPath === undefined ? undefined : absolutePath(value.logPath, 'logPath')
  const environment = normalizeEnvironment(value.environment, dshHome)
  const readyTimeoutMs = value.readyTimeoutMs === undefined ? 10000 : positiveInteger(value.readyTimeoutMs, 'readyTimeoutMs', 250, 30000)
  const exitWaitMs = value.exitWaitMs === undefined ? 30000 : positiveInteger(value.exitWaitMs, 'exitWaitMs', 1000, 300000)
  if (mutexPath === undefined && mutexDir === undefined) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'a mutexPath or mutexDir is required')
  if (instancePath === undefined) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'instancePath is required for owner verification')
  const resolvedMutexPath = mutexPath ?? join(mutexDir, `${profileId}.lock`)
  return Object.freeze(sortedDescriptor({
    formatVersion: MANAGED_RUNTIME_DESCRIPTOR_VERSION,
    profileId,
    hostId: 'local',
    nodePath,
    argv: [...value.argv],
    cwd,
    dshHome,
    port,
    brokerPath,
    launcherId,
    mutexPath: resolvedMutexPath,
    ...(mutexDir === undefined ? {} : { mutexDir }),
    ...(instancePath === undefined ? {} : { instancePath }),
    ...(logPath === undefined ? {} : { logPath }),
    ...(environment === undefined ? {} : { environment }),
    readyTimeoutMs,
    exitWaitMs,
  }))
}

function normalizeEnvironment(value, dshHome) {
  if (value === undefined) return undefined
  if (!record(value)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'environment must be an object')
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!ENVIRONMENT_KEYS.has(key)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_FIELDS', `environment field ${key} is not allowed`)
    const text = boundedString(raw, `environment.${key}`, 4096)
    if (key === 'DSH_HOME' && !samePath(text, dshHome)) throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_IDENTITY', 'environment DSH_HOME does not match dshHome')
    result[key] = ENVIRONMENT_PATH_KEYS.has(key) ? absolutePath(text, `environment.${key}`) : text
    if (!ENVIRONMENT_PATH_KEYS.has(key) && text !== '1') throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', `environment.${key} must be 1`)
  }
  if (result.DSH_HOME === undefined) result.DSH_HOME = dshHome
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))))
}

export function readManagedRuntimeDescriptor(filePath) {
  const path = absolutePath(filePath, 'descriptorPath')
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'trusted descriptor could not be read', { cause: String(error?.message ?? error) })
  }
  return normalizeManagedRuntimeDescriptor(value)
}

export function descriptorFingerprint(value) {
  const descriptor = value?.brokerPath === undefined ? normalizeManagedRuntimeDescriptor(value) : value
  return createHash('sha256').update(JSON.stringify(sortedDescriptor(descriptor))).digest('hex')
}

export function currentRuntimeIdentity({ processLike = globalThis.process, webServer } = {}) {
  return Object.freeze({
    nodePath: typeof processLike?.execPath === 'string' ? normalize(resolve(processLike.execPath)) : undefined,
    argv: Array.isArray(processLike?.argv) ? [...processLike.argv] : undefined,
    cwd: typeof processLike?.cwd === 'function' ? normalize(resolve(processLike.cwd())) : undefined,
    dshHome: absolutePath(defaultDshHome(processLike), 'DSH_HOME'),
    port: webServer?.port,
  })
}

function validProcessStamp(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= PROCESS_STAMP_MAX_LENGTH && !value.includes('\u0000')
}

/**
 * Read an OS process birth marker without terminating or mutating the target.
 * Windows uses an asynchronous fixed PowerShell query; Linux uses procfs so a
 * recycled PID cannot be mistaken for the original DSH process.
 */
export async function readProcessBirthStamp(pid, {
  platform = process.platform,
  execFileProcess = execFile,
  read = readFile,
  processEnv = globalThis.process?.env ?? {},
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined
  if (platform === 'linux') {
    try {
      const [bootId, stat] = await Promise.all([
        read('/proc/sys/kernel/random/boot_id', 'utf8'),
        read(`/proc/${pid}/stat`, 'utf8'),
      ])
      const close = stat.lastIndexOf(')')
      if (close < 0) return undefined
      const fields = stat.slice(close + 1).trim().split(/\s+/)
      const startTime = fields[19]
      const boot = bootId.trim()
      return /^\w[\w-]*$/.test(boot) && /^\d+$/.test(startTime ?? '') ? `linux:${boot}:${startTime}` : undefined
    } catch {
      return undefined
    }
  }
  if (platform === 'win32') {
    const script = '(Get-Process -Id ([int]$env:DSH_MANAGED_PID) -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()'
    const value = await new Promise(resolveStamp => {
      try {
        execFileProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          timeout: PROCESS_STAMP_QUERY_TIMEOUT_MS,
          maxBuffer: 8192,
          env: { ...processEnv, DSH_MANAGED_PID: String(pid) },
          stdio: ['ignore', 'pipe', 'ignore'],
        }, (error, stdout) => {
          if (error || typeof stdout !== 'string') return resolveStamp(undefined)
          resolveStamp(stdout.trim())
        })
      } catch { resolveStamp(undefined) }
    })
    return /^\d+$/.test(value ?? '') ? `windows:${value}` : undefined
  }
  const value = await new Promise(resolveStamp => {
    try {
      execFileProcess('ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: PROCESS_STAMP_QUERY_TIMEOUT_MS,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'ignore'],
      }, (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolveStamp(undefined)
        resolveStamp(stdout.trim())
      })
    } catch { resolveStamp(undefined) }
  })
  return validProcessStamp(value) ? `posix:${value}` : undefined
}

export function verifyCurrentRuntimeIdentity(descriptorValue, { processLike = globalThis.process, webServer } = {}) {
  const descriptor = normalizeManagedRuntimeDescriptor(descriptorValue)
  const current = currentRuntimeIdentity({ processLike, webServer })
  if (!current.nodePath || !samePath(current.nodePath, descriptor.nodePath)
    || !Array.isArray(current.argv) || current.argv.length !== descriptor.argv.length
    || current.argv.some((value, index) => value !== descriptor.argv[index])
    || !current.cwd || !samePath(current.cwd, descriptor.cwd)
    || !samePath(current.dshHome, descriptor.dshHome)
    || current.port !== descriptor.port
    || Object.entries(descriptor.environment ?? {}).some(([key, value]) => {
      const currentValue = currentProcessEnvironment(processLike, key)
      return currentValue !== value && !(key === 'DSH_HOME' && typeof currentValue === 'string' && samePath(currentValue, value))
    })) {
    throw new ManagedRuntimeError('LOCAL_RESTART_IDENTITY', 'current runtime does not match the trusted descriptor')
  }
  return true
}

function currentProcessEnvironment(processLike, key) {
  const value = processLike?.env?.[key]
  if (value === undefined && key === 'DSH_HOME') return normalize(resolve(defaultDshHome(processLike)))
  return typeof value === 'string' ? (ENVIRONMENT_PATH_KEYS.has(key) ? normalize(resolve(value)) : value) : value
}

async function acquireMutex(path, { isPidAlive = defaultIsAlive, getProcessBirthStamp = readProcessBirthStamp } = {}) {
  await mkdir(dirname(path), { recursive: true })
  try {
    return await createMutex(path, { getProcessBirthStamp })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const stale = await readLockRecord(path)
    if (stale === undefined || stale === null) throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher lock could not be verified')
    const initialIdentity = await processIdentityMatches(stale.pid, stale.birthStamp, { isPidAlive, getProcessBirthStamp })
    if (initialIdentity.state !== 'dead' && initialIdentity.state !== 'recycled') throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher lock owner could not be verified')
    const reclaim = await createReclaimGuard(path, { getProcessBirthStamp })
    if (reclaim === undefined) throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher stale-lock recovery is already in progress')
    try {
      const current = await readLockRecord(path)
      if (!sameLockRecord(current, stale)) throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher lock changed during stale-lock recovery')
      const currentIdentity = await processIdentityMatches(current.pid, current.birthStamp, { isPidAlive, getProcessBirthStamp })
      if (currentIdentity.state !== 'dead' && currentIdentity.state !== 'recycled') throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher lock owner changed during stale-lock recovery')
      await unlink(path).catch(error => {
        if (error?.code === 'ENOENT') throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher lock changed during stale-lock recovery')
        throw error
      })
      try {
        return await createMutex(path, { getProcessBirthStamp })
      } catch (retryError) {
        if (retryError?.code === 'EEXIST') throw new ManagedRuntimeError('MANAGED_RUNTIME_BUSY', 'managed runtime launcher is already running')
        throw retryError
      }
    } finally {
      await reclaim()
    }
  }
}

async function createMutex(path, { getProcessBirthStamp = readProcessBirthStamp } = {}) {
  const lockId = randomUUID()
  const tempPath = `${path}.${lockId}.tmp`
  const pid = globalThis.process?.pid
  const birthStamp = await getProcessBirthStamp(pid)
  if (!validProcessStamp(birthStamp)) throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'launcher process identity could not be verified')
  const content = `${JSON.stringify({ pid: pid ?? null, birthStamp, launcherVersion: MANAGED_RUNTIME_LAUNCHER_VERSION, lockId })}\n`
  let handle
  try {
    // Publish a complete record with an atomic no-overwrite hard link. A
    // visible empty `wx` target must never be mistaken for an owner record.
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(tempPath, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'EEXIST') throw error
    throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime mutex could not be acquired')
  } finally {
    await unlink(tempPath).catch(() => {})
  }
  return async () => {
    const current = await readLockRecord(path)
    // Never unlink a lock that has been reclaimed and replaced by another
    // launcher between our work and release.
    if (current?.lockId !== lockId) return
    await unlink(path).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function createReclaimGuard(path, { getProcessBirthStamp = readProcessBirthStamp } = {}) {
  const guardPath = `${path}.reclaim`
  const guardId = randomUUID()
  const pid = globalThis.process?.pid
  const birthStamp = await getProcessBirthStamp(pid)
  if (!validProcessStamp(birthStamp)) throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'launcher process identity could not be verified')
  let handle
  try {
    handle = await open(guardPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid: pid ?? null, birthStamp, launcherVersion: MANAGED_RUNTIME_LAUNCHER_VERSION, guardId })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'EEXIST') return undefined
    throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'stale-lock recovery guard could not be acquired')
  }
  return async () => {
    const current = await readReclaimGuard(guardPath)
    if (current?.guardId !== guardId) return
    await unlink(guardPath).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function readReclaimGuard(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value) || typeof value.guardId !== 'string' || value.guardId.length < 1 || value.guardId.length > 128) return undefined
    return value
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined
  }
}

function sameLockRecord(left, right) {
  if (!record(left) || !record(right)) return false
  return left.pid === right.pid
    && left.launcherVersion === right.launcherVersion
    && left.lockId === right.lockId
    && left.birthStamp === right.birthStamp
}

async function readLockRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value) || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.launcherVersion !== MANAGED_RUNTIME_LAUNCHER_VERSION) return undefined
    if (value.lockId !== undefined && (typeof value.lockId !== 'string' || value.lockId.length < 1 || value.lockId.length > 128)) return undefined
    if (value.birthStamp !== undefined && !validProcessStamp(value.birthStamp)) return undefined
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return undefined
  }
}

async function readInstanceRecord(path) {
  if (path === undefined) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.fingerprint !== 'string') return null
    if (value.birthStamp !== undefined && !validProcessStamp(value.birthStamp)) return null
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return null
  }
}

async function processIdentityMatches(pid, birthStamp, { isPidAlive, getProcessBirthStamp }) {
  // Records written before birth stamps were introduced are intentionally
  // unverifiable. A deployment guard may archive them once, but the launcher
  // must not infer that a missing marker means the PID has exited.
  if (!validProcessStamp(birthStamp)) return { state: 'unknown' }
  let alive
  try { alive = await isPidAlive(pid) } catch { return { state: 'unknown' } }
  if (!alive) return { state: 'dead' }
  let current
  try { current = await getProcessBirthStamp(pid) } catch { return { state: 'unknown' } }
  if (!validProcessStamp(current)) return { state: 'unknown' }
  return { state: current === birthStamp ? 'same' : 'recycled', current }
}

async function writeInstanceRecord(path, recordValue) {
  if (path === undefined) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(recordValue)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function logLaunch(descriptor, event, details = {}) {
  if (descriptor.logPath === undefined) return
  await mkdir(dirname(descriptor.logPath), { recursive: true })
  await appendFile(descriptor.logPath, `${JSON.stringify({ time: new Date().toISOString(), event, profileId: descriptor.profileId, port: descriptor.port, ...details })}\n`, 'utf8')
}

async function spawnStdio(descriptor) {
  if (descriptor.logPath === undefined) return { stdio: 'ignore', close: async () => {} }
  await mkdir(dirname(descriptor.logPath), { recursive: true })
  const handle = await open(descriptor.logPath, 'a')
  return {
    stdio: ['ignore', handle.fd, handle.fd],
    close: async () => { await handle.close().catch(() => {}) },
  }
}

function stateOf(probe) {
  return typeof probe === 'string' ? probe : probe?.state
}

function ownerPidOf(probe) {
  return typeof probe === 'object' && Number.isSafeInteger(probe?.pid) ? probe.pid : undefined
}

function failureDetails(error) {
  if (!record(error?.details)) return {}
  const result = {}
  if (typeof error.details.stage === 'string') result.stage = error.details.stage
  for (const key of ['ownerPid', 'expectedPid', 'spawnedPid']) {
    if (Number.isSafeInteger(error.details[key]) && error.details[key] > 0) result[key] = error.details[key]
  }
  for (const key of ['ownerBirthStamp', 'expectedBirthStamp', 'spawnedBirthStamp']) {
    if (validProcessStamp(error.details[key])) result[key] = error.details[key]
  }
  return result
}

function endpointIsLocalListener(endpoint, port) {
  if (typeof endpoint !== 'string') return false
  const text = endpoint.trim()
  let host
  let portText
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0 || text[close + 1] !== ':') return false
    host = text.slice(1, close)
    portText = text.slice(close + 2)
  } else {
    const separator = text.lastIndexOf(':')
    if (separator <= 0) return false
    host = text.slice(0, separator)
    portText = text.slice(separator + 1)
  }
  if (!/^\d+$/.test(portText) || Number(portText) !== port) return false
  const normalizedHost = host.toLowerCase().replace(/%[^:]+$/, '')
  return normalizedHost === '127.0.0.1'
    || normalizedHost === '::1'
    || normalizedHost === '0.0.0.0'
    || normalizedHost === '::'
    || normalizedHost === '*'
}

/** Return one PID only when the output identifies one local listening owner. */
export function parsePortOwnerPid(stdout, port, platform = process.platform) {
  if (typeof stdout !== 'string' || !Number.isSafeInteger(port)) return undefined
  const pids = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    let localAddress
    let state
    let pidValues
    if (platform === 'win32') {
      if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue
      localAddress = columns[1]
      state = columns[3]?.toUpperCase()
      pidValues = [columns[4]]
      if (state !== 'LISTENING') continue
    } else {
      if (columns.length < 5 || columns[0].toUpperCase() !== 'LISTEN') continue
      localAddress = columns[3]
      state = columns[0].toUpperCase()
      pidValues = [...line.matchAll(/pid=(\d+)/g)].map(match => match[1])
      if (state !== 'LISTEN') continue
    }
    if (!endpointIsLocalListener(localAddress, port)) continue
    for (const value of pidValues) {
      const pid = Number(value)
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
    }
  }
  return pids.size === 1 ? [...pids][0] : undefined
}

function queryPortOwnerPid(port) {
  const command = process.platform === 'win32' ? 'netstat.exe' : 'ss'
  const args = process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-ltnp']
  return new Promise(resolveOwner => {
    execFile(command, args, { windowsHide: true, timeout: 1500, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== 'string') return resolveOwner(undefined)
      resolveOwner(parsePortOwnerPid(stdout, port, process.platform))
    })
  })
}

function portState(port, host = '127.0.0.1') {
  return new Promise(resolveState => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const settle = state => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveState(state)
    }
    socket.once('connect', async () => {
      socket.setTimeout(0)
      settle({ state: 'occupied', pid: await queryPortOwnerPid(port) })
    })
    socket.once('error', error => settle(error?.code === 'ECONNREFUSED' || error?.code === 'EHOSTUNREACH' ? 'free' : 'unknown'))
    socket.setTimeout(500, () => settle('unknown'))
  })
}

async function waitForPortReady(port, { inspectPort = portState, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await inspectPort(port)
    const state = stateOf(probe)
    if (state === 'occupied' || state === 'expected') return probe
    if (state === 'unknown') throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'managed runtime port state is unknown', { stage: 'ready-port' })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime did not become ready')
}

function spawnResult(child) {
  if (child === undefined || child === null) throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime spawn returned no process')
  if (typeof child.once !== 'function') return Promise.resolve(child)
  return new Promise((resolveSpawn, rejectSpawn) => {
    let settled = false
    const resolveOnce = value => { if (!settled) { settled = true; resolveSpawn(value) } }
    const rejectOnce = error => { if (!settled) { settled = true; rejectSpawn(error) } }
    child.once('error', error => rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime spawn failed', { cause: String(error?.message ?? error) })))
    child.once('spawn', () => resolveOnce(child))
    if (child.pid !== undefined && child.spawned === true) resolveOnce(child)
  })
}

/**
 * Start the exact descriptor after the old process has exited. The launcher
 * owns one filesystem mutex and refuses an unknown occupied port; it never
 * kills an existing process or invents a command line.
 */
export async function launchManagedRuntime(descriptorValue, {
  spawnProcess = spawn,
  inspectPort = portState,
  acquire = acquireMutex,
  isPidAlive = defaultIsAlive,
  getProcessBirthStamp = readProcessBirthStamp,
  readInstance = readInstanceRecord,
  writeInstance = writeInstanceRecord,
  log = logLaunch,
  env = globalThis.process?.env ?? {},
  waitTimeoutMs,
  platform = globalThis.process?.platform ?? process.platform,
  supervise = false,
} = {}) {
  const descriptor = normalizeManagedRuntimeDescriptor(descriptorValue)
  const release = await acquire(descriptor.mutexPath, { isPidAlive, getProcessBirthStamp })
  try {
    const fingerprint = descriptorFingerprint(descriptor)
    const instance = await readInstance(descriptor.instancePath)
    if (instance !== undefined) {
      if (instance === null) {
        throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'instance record is malformed and cannot be verified', { stage: 'instance-record' })
      } else {
        const identity = await processIdentityMatches(instance.pid, instance.birthStamp, { isPidAlive, getProcessBirthStamp })
        if (identity.state === 'dead' || identity.state === 'recycled') {
          const stalePort = await inspectPort(descriptor.port)
          const staleState = stateOf(stalePort)
          if (staleState !== 'free') {
            throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'instance record owner identity is stale while its port is not free', {
              stage: identity.state === 'recycled' ? 'instance-recycled' : 'instance-exited',
              ownerPid: ownerPidOf(stalePort), expectedPid: instance.pid,
              ...(instance.birthStamp === undefined ? {} : { expectedBirthStamp: instance.birthStamp }),
              ...(identity.current === undefined ? {} : { ownerBirthStamp: identity.current }),
            })
          }
          await unlink(descriptor.instancePath).catch(() => {})
        } else if (identity.state === 'unknown') {
          throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'instance record owner identity could not be verified', {
            stage: 'instance-identity', ownerPid: instance.pid, expectedPid: instance.pid,
            ...(instance.birthStamp === undefined ? {} : { expectedBirthStamp: instance.birthStamp }),
          })
        } else if (instance.fingerprint !== fingerprint || instance.port !== descriptor.port) {
          throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'instance record belongs to another runtime')
        } else {
          const existingPort = await inspectPort(descriptor.port)
          const existingState = stateOf(existingPort)
          const ownerPid = ownerPidOf(existingPort)
          const ownerBirthStamp = ownerPid === instance.pid ? await getProcessBirthStamp(ownerPid) : undefined
          if ((existingState === 'occupied' || existingState === 'expected') && ownerPid === instance.pid && ownerBirthStamp === instance.birthStamp) {
            return Object.freeze({ attached: true, launched: false, pid: instance.pid, profileId: descriptor.profileId })
          }
          if (existingState === 'occupied' || existingState === 'expected') {
            throw new ManagedRuntimeError('LOCAL_RESTART_PORT_OCCUPIED', 'expected runtime port owner did not match the instance identity', {
              stage: 'existing-owner', ownerPid, expectedPid: instance.pid,
              ...(instance.birthStamp === undefined ? {} : { expectedBirthStamp: instance.birthStamp }),
              ...(ownerBirthStamp === undefined ? {} : { ownerBirthStamp }),
            })
          }
          if (existingState === 'unknown') throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'expected runtime port state is unknown', { stage: 'existing-port' })
          throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'expected runtime is alive but its port is not listening')
        }
      }
    }
    const before = await inspectPort(descriptor.port)
    const beforeState = stateOf(before)
    if (beforeState === 'occupied' || beforeState === 'expected') {
      throw new ManagedRuntimeError('LOCAL_RESTART_PORT_OCCUPIED', 'managed runtime port is occupied by an unknown process', { stage: 'preflight-owner' })
    }
    if (beforeState !== 'free') throw new ManagedRuntimeError('LOCAL_RESTART_PORT_UNKNOWN', 'managed runtime port state is unknown', { stage: 'preflight-port' })
    let spawned
    let stdio
    let stdioClosed = false
    try {
      try {
        stdio = await spawnStdio(descriptor)
        spawned = spawnProcess(descriptor.nodePath, descriptor.argv.slice(1), {
          cwd: descriptor.cwd,
          env: { ...env, ...descriptor.environment, DSH_HOME: descriptor.dshHome },
          windowsHide: true,
          detached: platform !== 'win32',
          stdio: stdio.stdio,
        })
      } catch (error) {
        throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime spawn failed', { cause: String(error?.message ?? error) })
      }
      // Keep the log handle open until Node reports that the child has
      // spawned. Closing it immediately can suppress the spawn event on
      // Windows while leaving an untracked child and mutex behind.
      const child = await spawnResult(spawned)
      await stdio?.close()
      stdioClosed = true
      const pid = child?.pid
      if (!Number.isSafeInteger(pid) || pid < 1) throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime spawn returned no valid pid')
      const spawnedBirthStamp = await getProcessBirthStamp(pid)
      if (!validProcessStamp(spawnedBirthStamp)) {
        throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'managed runtime process identity could not be verified', { stage: 'spawned-identity', spawnedPid: pid })
      }
      await writeInstance(descriptor.instancePath, { pid, birthStamp: spawnedBirthStamp, fingerprint, profileId: descriptor.profileId, port: descriptor.port })
      if (platform !== 'win32' || !supervise) child.unref?.()
      const readyProbe = await waitForPortReady(descriptor.port, {
        inspectPort,
        timeoutMs: waitTimeoutMs ?? descriptor.readyTimeoutMs,
      })
      const readyState = stateOf(readyProbe)
      const ownerPid = ownerPidOf(readyProbe)
      const ownerBirthStamp = ownerPid === pid ? await getProcessBirthStamp(ownerPid) : undefined
      if (ownerPid !== pid || ownerBirthStamp !== spawnedBirthStamp) {
        throw new ManagedRuntimeError('LOCAL_RESTART_PORT_OCCUPIED', 'managed runtime port owner did not match the spawned process identity', {
          stage: 'ready-owner', ownerPid, spawnedPid: pid, spawnedBirthStamp,
          ...(ownerBirthStamp === undefined ? {} : { ownerBirthStamp }),
        })
      }
      await log(descriptor, 'launched', { pid, readyState }).catch(() => {})
      return Object.freeze({ attached: readyState === 'expected', launched: readyState !== 'expected', pid, profileId: descriptor.profileId })
    } finally {
      if (!stdioClosed) await stdio?.close()
    }
  } catch (error) {
    await log(descriptor, 'failed', { code: error?.code ?? 'LOCAL_RESTART_LAUNCH_FAILED', ...failureDetails(error) }).catch(() => {})
    throw error
  } finally {
    await release()
  }
}

export function forkManagedRuntimeBroker(descriptorValue, {
  processLike = globalThis.process,
  forkProcess = fork,
  parentBirthStamp,
  getProcessBirthStamp = readProcessBirthStamp,
} = {}) {
  let brokerOptions = {}
  if (record(descriptorValue) && record(descriptorValue.descriptor) && descriptorValue.formatVersion === undefined) {
    brokerOptions = descriptorValue
    descriptorValue = descriptorValue.descriptor
    processLike = brokerOptions.processLike ?? processLike
  }
  const descriptor = normalizeManagedRuntimeDescriptor(descriptorValue)
  const parentPid = brokerOptions.parentPid ?? processLike?.pid
  const mode = normalizeManagedRuntimeBrokerMode(brokerOptions.mode)
  const configuredParentBirthStamp = brokerOptions.parentBirthStamp ?? parentBirthStamp
  const configuredGetProcessBirthStamp = brokerOptions.getProcessBirthStamp ?? getProcessBirthStamp
  const child = forkProcess(descriptor.brokerPath, [], {
    cwd: descriptor.cwd,
    execArgv: [],
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let cancelRequested = false
  let commitRequested = false
  let commitAcknowledged = false
  let readyMessage
  const cancel = () => {
    if (cancelRequested) return
    cancelRequested = true
    if (child?.connected === false) return
    try {
      if (child?.connected && typeof child.send === 'function') {
        child.send({ type: 'cancel' }, () => {
          if (child.connected !== false) {
            try { child.disconnect?.() } catch { /* already disconnected */ }
          }
        })
      } else {
        child?.disconnect?.()
      }
    } catch {
      try { child?.disconnect?.() } catch { /* already disconnected */ }
    }
  }
  // After the commit acknowledgement no more parent messages are needed: the
  // broker observes the parent by PID and birth stamp. This closes only the
  // IPC channel and never sends the cancellation message used by `cancel`.
  const close = () => {
    if (child?.connected === false) return
    try { child?.disconnect?.() } catch { /* the parent may already be closing */ }
  }
  let launchTimer
  let launchSettled = false
  let resolveLaunch
  let rejectLaunch
  const launched = mode === 'start' ? new Promise((resolve, reject) => {
    resolveLaunch = resolve
    rejectLaunch = reject
  }) : undefined
  // A ready failure can precede the CLI awaiting the launch result.
  launched?.catch(() => {})
  const failLaunch = error => {
    if (mode !== 'start' || launchSettled) return
    launchSettled = true
    clearTimeout(launchTimer)
    rejectLaunch(error)
    cancel()
  }
  let failReady
  const ready = new Promise((resolveReady, rejectReadyPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_READY_TIMEOUT', 'managed runtime broker did not complete the ready handshake'))
    }, descriptor.readyTimeoutMs)
    const resolveOnce = value => { if (!settled) { settled = true; clearTimeout(timer); resolveReady(value) } }
    const rejectOnce = error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        failLaunch(error)
        rejectReadyPromise(error instanceof Error ? error : new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker failed'))
        cancel()
      }
    }
    failReady = rejectOnce
    child?.once?.('error', error => {
      const failure = new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker failed', { cause: String(error?.message ?? error) })
      rejectOnce(failure)
      failLaunch(failure)
    })
    child?.once?.('disconnect', () => {
      if (!commitAcknowledged) rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker disconnected before commit'))
      failLaunch(new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker disconnected before launch confirmation'))
    })
    child?.on?.('message', message => {
      if (!record(message)) return
      if (message.type === 'ready') {
        if (message.fingerprint !== descriptorFingerprint(descriptor) || message.launcherVersion !== MANAGED_RUNTIME_LAUNCHER_VERSION) {
          rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_DESCRIPTOR_INVALID', 'managed runtime broker returned an unexpected descriptor identity'))
          return
        }
        readyMessage = message
        commitRequested = true
        try {
          child.send({ type: 'commit', fingerprint: message.fingerprint }, error => {
            if (error) rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker could not receive the commit', { cause: String(error?.message ?? error) }))
          })
        } catch (error) {
          rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker could not receive the commit', { cause: String(error?.message ?? error) }))
        }
      } else if (message.type === 'committed') {
        if (!commitRequested || !readyMessage || message.fingerprint !== readyMessage.fingerprint) {
          rejectOnce(new ManagedRuntimeError('LOCAL_RESTART_HANDSHAKE_INVALID', 'managed runtime broker commit was invalid'))
          return
        }
        commitAcknowledged = true
        // The broker observes the original process by its PID and birth
        // stamp after this point; keeping the IPC channel referenced would
        // prevent the official natural appExit shutdown from converging.
        if (mode === 'restart') {
          try { child.channel?.unref?.() } catch { /* preserve the handshake */ }
        } else {
          // Port readiness plus bounded process-identity queries. Keep IPC
          // referenced until the cold-start CLI has a ready/error result.
          launchTimer = setTimeout(() => failLaunch(new ManagedRuntimeError('LOCAL_RESTART_READY_TIMEOUT', 'managed runtime broker did not confirm launch')),
            descriptor.readyTimeoutMs + 3 * PROCESS_STAMP_QUERY_TIMEOUT_MS)
        }
        resolveOnce(readyMessage)
      } else if (message.type === 'launched' && mode === 'start') {
        if (!commitAcknowledged || message.fingerprint !== descriptorFingerprint(descriptor)
          || !record(message.result) || message.result.profileId !== descriptor.profileId
          || !Number.isSafeInteger(message.result.pid) || message.result.pid < 1
          || typeof message.result.attached !== 'boolean' || typeof message.result.launched !== 'boolean'
          || message.result.attached === message.result.launched) {
          failLaunch(new ManagedRuntimeError('LOCAL_RESTART_HANDSHAKE_INVALID', 'managed runtime launch confirmation was invalid'))
          return
        }
        if (launchSettled) return
        launchSettled = true
        clearTimeout(launchTimer)
        resolveLaunch(message.result)
        try { child.channel?.unref?.() } catch { /* result already delivered */ }
      }
      else if (message.type === 'error') {
        const failure = new ManagedRuntimeError(message.code ?? 'LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker rejected the descriptor')
        rejectOnce(failure)
        failLaunch(failure)
      }
    })
  })
  child.unref?.()
  Promise.resolve().then(async () => {
    const stamp = configuredParentBirthStamp ?? await configuredGetProcessBirthStamp(parentPid)
    if (!validProcessStamp(stamp)) throw new ManagedRuntimeError('LOCAL_RESTART_PARENT_IDENTITY', 'original runtime process identity could not be verified')
    if (cancelRequested) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
    child.send({ type: 'prepare', descriptor, parentPid, parentBirthStamp: stamp, mode }, error => {
      if (error) failReady?.(new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker could not receive the descriptor', { cause: String(error?.message ?? error) }))
    })
  }).catch(error => failReady?.(error instanceof Error ? error : new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime broker could not prepare the descriptor')))
  return { child, ready, launched, cancel, close, disconnect: cancel }
}

export function waitForProcessExit(pid, {
  isAlive = defaultIsAlive,
  getProcessBirthStamp = readProcessBirthStamp,
  birthStamp,
  isCancelled = () => false,
  timeoutMs = 30000,
  pollMs = 50,
  identityCheckMs = 500,
} = {}) {
  positiveInteger(pid, 'parentPid', 1, Number.MAX_SAFE_INTEGER)
  return new Promise((resolveExit, rejectExit) => {
    if (birthStamp !== undefined && !validProcessStamp(birthStamp)) return rejectExit(new ManagedRuntimeError('LOCAL_RESTART_PARENT_IDENTITY', 'original runtime process identity is invalid'))
    const deadline = Date.now() + timeoutMs
    let nextIdentityCheck = 0
    const tick = async () => {
      try {
        if (isCancelled()) return rejectExit(new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled'))
        if (!(await isAlive(pid))) return resolveExit()
        if (birthStamp !== undefined && Date.now() >= nextIdentityCheck) {
          nextIdentityCheck = Date.now() + Math.max(50, identityCheckMs)
          const currentBirthStamp = await getProcessBirthStamp(pid)
          if (validProcessStamp(currentBirthStamp) && currentBirthStamp !== birthStamp) return resolveExit()
          // A slow OS query can overlap the original process exit. Recheck
          // liveness before applying the timeout so a gone process is not
          // reported as an identity-query timeout.
          if (!(await isAlive(pid))) return resolveExit()
        }
        if (Date.now() >= deadline) return rejectExit(new ManagedRuntimeError('LOCAL_RESTART_EXIT_TIMEOUT', 'original runtime did not exit in time'))
        setTimeout(tick, pollMs)
      } catch (error) {
        rejectExit(error instanceof Error ? error : new ManagedRuntimeError('LOCAL_RESTART_EXIT_FAILED', 'could not observe original runtime'))
      }
    }
    void tick()
  })
}

function defaultIsAlive(pid) {
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export async function runManagedRuntimeBroker({
  descriptor,
  mode: modeValue,
  parentPid,
  parentBirthStamp,
  send = sendProcessMessage,
  isAlive = defaultIsAlive,
  getProcessBirthStamp = readProcessBirthStamp,
  isCancelled = () => false,
  wait = waitForProcessExit,
  waitForCommit = async () => {},
  launch = launchManagedRuntime,
} = {}) {
  const normalized = normalizeManagedRuntimeDescriptor(descriptor)
  const mode = normalizeManagedRuntimeBrokerMode(modeValue)
  verifyParentPid(parentPid)
  if (parentBirthStamp !== undefined && !validProcessStamp(parentBirthStamp)) throw new ManagedRuntimeError('LOCAL_RESTART_PARENT_IDENTITY', 'original runtime process identity is invalid')
  if (isCancelled()) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
  await sendMessage(send, { type: 'ready', fingerprint: descriptorFingerprint(normalized), launcherVersion: MANAGED_RUNTIME_LAUNCHER_VERSION })
  await waitForCommit()
  if (mode === 'restart') await wait(parentPid, { isAlive, getProcessBirthStamp, birthStamp: parentBirthStamp, isCancelled, timeoutMs: normalized.exitWaitMs })
  if (isCancelled()) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
  const result = await launch(normalized, { supervise: true })
  if (isCancelled()) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
  const delivered = await sendMessage(send, { type: 'launched', fingerprint: descriptorFingerprint(normalized), result })
  if (mode === 'start' && !delivered) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_FAILED', 'managed runtime launch confirmation could not be delivered')
  if (isCancelled()) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
  return result
}

async function sendMessage(send, message) {
  try { return await send(message) !== false } catch { return false }
}

async function sendProcessMessage(message) {
  if (globalThis.process?.connected === false || typeof globalThis.process?.send !== 'function') return false
  return new Promise(resolve => {
    try { globalThis.process.send(message, error => resolve(!error)) } catch { resolve(false) }
  })
}

function disconnectProcess() {
  if (globalThis.process?.connected === false) return
  try { globalThis.process?.disconnect?.() } catch { /* the IPC peer may already be gone */ }
}

function verifyParentPid(value) {
  positiveInteger(value, 'parentPid', 1, Number.MAX_SAFE_INTEGER)
  return value
}

async function runCli() {
  const descriptorFlag = globalThis.process.argv[2]
  if (descriptorFlag !== '--descriptor' || typeof globalThis.process.argv[3] !== 'string') {
    throw new ManagedRuntimeError('LOCAL_RESTART_LAUNCH_FAILED', 'usage: managed-runtime-launcher --descriptor <trusted-json>')
  }
  const descriptorPath = absolutePath(globalThis.process.argv[3], 'descriptorPath')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
  if (globalThis.process.platform !== 'win32') return launchManagedRuntime(descriptor)
  const broker = forkManagedRuntimeBroker({ descriptor, mode: 'start' })
  try {
    await broker.ready
    return await broker.launched
  } finally {
    broker.close()
  }
}

if (globalThis.process?.send && globalThis.process?.on && globalThis.process.argv[1] && samePath(globalThis.process.argv[1], BUNDLED_MANAGED_RUNTIME_LAUNCHER)) {
  let cancelRequested = false
  let started = false
  let readyMessage
  let commitRequested = false
  let commitReceived = false
  let mode = 'restart'
  let launchConfirmed = false
  let resolveCommit
  const commit = new Promise(resolve => { resolveCommit = resolve })
  // The parent runtime is expected to exit after it receives the committed
  // handshake. A disconnect before that explicit commit still cancels the
  // broker, so a ready message that was not received cannot trigger a launch.
  globalThis.process.once('disconnect', () => {
    if (!commitReceived || (mode === 'start' && !launchConfirmed)) {
      cancelRequested = true
      resolveCommit?.()
    }
  })
  globalThis.process.on('message', message => {
    if (record(message) && message.type === 'cancel') {
      cancelRequested = true
      resolveCommit?.()
      return
    }
    if (record(message) && message.type === 'commit') {
      if (!commitRequested || !readyMessage || message.fingerprint !== readyMessage.fingerprint) {
        cancelRequested = true
        resolveCommit?.()
        sendProcessMessage({ type: 'error', code: 'LOCAL_RESTART_HANDSHAKE_INVALID' })
        return
      }
      commitReceived = true
      resolveCommit?.()
      sendProcessMessage({ type: 'committed', fingerprint: readyMessage.fingerprint })
      return
    }
    if (started || !record(message) || message.type !== 'prepare') {
      sendProcessMessage({ type: 'error', code: 'LOCAL_RESTART_DESCRIPTOR_INVALID' })
      return
    }
    started = true
    mode = message.mode ?? 'restart'
    runManagedRuntimeBroker({
      descriptor: message.descriptor,
      mode,
      parentPid: message.parentPid,
      parentBirthStamp: message.parentBirthStamp,
      send: value => {
        if (value?.type === 'ready') {
          readyMessage = value
          commitRequested = true
        }
        return sendProcessMessage(value).then(delivered => {
          if (value?.type === 'launched' && delivered) launchConfirmed = true
          return delivered
        })
      },
      waitForCommit: async () => {
        await commit
        if (cancelRequested) throw new ManagedRuntimeError('LOCAL_RESTART_BROKER_CANCELLED', 'managed runtime broker was cancelled')
      },
      isCancelled: () => cancelRequested,
    })
      .then(() => disconnectProcess())
      .catch(async error => {
        await sendProcessMessage({ type: 'error', code: error?.code ?? 'LOCAL_RESTART_BROKER_FAILED' })
        disconnectProcess()
        // Only this broker's owned Windows child belongs to its Node Job;
        // exiting on launch failure cannot terminate an attached runtime.
        if (globalThis.process.platform === 'win32') globalThis.process.exit(1)
        globalThis.process.exitCode = 1
      })
  })
} else if (globalThis.process?.argv?.[1] && samePath(globalThis.process.argv[1], BUNDLED_MANAGED_RUNTIME_LAUNCHER)) {
  runCli().catch(error => {
    globalThis.process.stderr.write(`${error?.code ?? 'LOCAL_RESTART_LAUNCH_FAILED'}\n`)
    globalThis.process.exitCode = 1
  })
}
