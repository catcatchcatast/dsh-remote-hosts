import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizeRuntimeVersion } from 'dsh-runtime-interface'
import { validateTarget } from 'dsh-rc1-host-carriers'


export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured || join(homedir(), '.dsh')
}

export function storePath(home, env = process.env) {
  // An explicit home preserves the original public helper semantics. The
  // no-argument path follows the official DSH_HOME profile root so isolated
  // candidate launchers do not reuse the controlling user's targets file.
  const root = home === undefined ? resolveDshHome(env) : join(home, '.dsh')
  return join(root, 'plugins', 'remote-hosts', 'targets.json')
}

function asTarget(value) {
  const upstreamVersion = value.upstreamVersion === undefined
    ? undefined
    : normalizeRuntimeVersion(value.upstreamVersion)
  const target = validateTarget({
    id: value.id,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : value.id,
    alias: value.alias,
    configFile: value.configFile,
    localPort: value.localPort,
    remotePort: value.remotePort,
    launch: value.launch === 'systemd-user' ? 'systemd-user' : 'none',
  })
  return { ...target, ...(upstreamVersion === undefined ? {} : { upstreamVersion }), enabled: value.enabled !== false }
}

export function mergeTargets(seed, ui, removed = []) {
  const skip = new Set(removed)
  const merged = new Map()
  for (const item of seed ?? []) {
    if (!skip.has(item.id)) merged.set(item.id, asTarget(item))
  }
  for (const item of ui ?? []) {
    if (skip.has(item.id)) continue
    const inherited = merged.get(item.id)
    merged.set(item.id, asTarget(inherited === undefined ? item : { ...inherited, ...item }))
  }
  const ids = new Set(['local'])
  const ports = new Set()
  const list = []
  for (const target of merged.values()) {
    if (ids.has(target.id) || ports.has(target.localPort)) throw new Error('DUPLICATE_HOST_TARGET')
    ids.add(target.id)
    ports.add(target.localPort)
    list.push(target)
  }
  return list
}

export async function loadUiState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || raw.version !== 1) return { targets: [], removed: [] }
    return {
      targets: Array.isArray(raw.targets) ? raw.targets : [],
      removed: Array.isArray(raw.removed) ? raw.removed.filter(id => typeof id === 'string') : [],
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { targets: [], removed: [] }
    throw new Error('HOST_UNAVAILABLE')
  }
}

export async function saveUiState(path, targets, removed = []) {
  const body = `${JSON.stringify({ version: 1, targets, removed: [...removed] }, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, body, { encoding: 'utf8' })
  await rename(tmp, path)
}
