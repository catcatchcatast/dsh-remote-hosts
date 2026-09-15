import { validateTarget } from 'dsh-rc1-host-carriers'
import { hostIdFromAlias, isConcreteSshAlias, parseConcreteSshAliases, suggestLocalPort } from './ssh-aliases.js'
import { publicErrorCode, publicHost } from './public.js'
import { loadUiState, mergeTargets, saveUiState } from './store.js'

export const CHANNEL = '/remote-hosts'
export const SYSTEMD_RESTART = 'systemctl --user restart dsh-web.service'

function requireHostId(payload) {
  const hostId = payload?.hostId
  if (typeof hostId !== 'string' || hostId.length === 0) throw new Error('HOST_ID_INVALID')
  return hostId
}

function assertRestartPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'hostId')) {
    throw new Error('HOST_RESTART_PARAMS_INVALID')
  }
}

export function createDispatcher(deps) {
  const {
    seedTargets,
    configFile,
    webPort,
    storeFile,
    readSshConfig,
    verifyAlias,
    helperReadable,
    control,
    localRuntime,
    localLabel = 'Local',
    loadState = loadUiState,
    saveState = saveUiState,
  } = deps

  async function readState() {
    return loadState(storeFile)
  }

  async function merged() {
    const { targets, removed } = await readState()
    return mergeTargets(seedTargets, targets, removed)
  }

  async function persist(uiTargets, removed) {
    const list = mergeTargets(seedTargets, uiTargets, removed)
    await saveState(storeFile, uiTargets, removed)
    await control.hydrate(list)
    return list
  }

  function usedPorts(list) {
    return [webPort, ...list.map(target => target.localPort)]
  }

  function assertLocalPortAvailable(list, localPort, hostId) {
    if (localPort === webPort || list.some(target => target.id !== hostId && target.localPort === localPort)) {
      throw new Error('DUPLICATE_HOST_TARGET')
    }
  }

  async function status() {
    const list = await merged()
    const live = control.snapshot()
    const local = live.local ?? {}
    const localRestart = typeof localRuntime?.status === 'function' ? localRuntime.status() : {}
    const hosts = [
      publicHost({
        kind: 'local',
        label: localLabel,
        state: local.state,
        lastError: local.lastError ? publicErrorCode(new Error(local.lastError)) : null,
        localPort: webPort,
        helperReadable: helperReadable(webPort),
        restartAvailable: localRestart.available === true,
        restartState: localRestart.state,
      }),
    ]
    for (const target of list) {
      const row = live.remotes?.[target.id] ?? {}
      hosts.push(publicHost({
        ...target,
        kind: 'remote',
        state: row.state,
        lastError: row.lastError ? publicErrorCode(new Error(row.lastError)) : null,
        helperReadable: row.helperReadable === true,
      }))
    }
    return {
      hosts,
      suggestedLocalPort: suggestLocalPort(usedPorts(list)),
    }
  }

  async function discoverAliases() {
    const text = await readSshConfig(configFile)
    const used = new Set((await merged()).map(target => target.alias.toLowerCase()))
    return { aliases: parseConcreteSshAliases(text).filter(alias => !used.has(alias.toLowerCase())) }
  }

  async function add(payload, signal) {
    signal?.throwIfAborted()
    const alias = payload?.alias
    if (!isConcreteSshAlias(alias)) throw new Error('HOST_ALIAS_INVALID')
    await verifyAlias(configFile, alias)
    signal?.throwIfAborted()
    const state = await readState()
    const list = mergeTargets(seedTargets, state.targets, state.removed)
    const id = typeof payload?.id === 'string' && payload.id ? payload.id : hostIdFromAlias(alias)
    const localPort = Number.isInteger(payload?.localPort) ? payload.localPort : suggestLocalPort(usedPorts(list))
    if (list.some(item => item.id === id || item.alias === alias)) {
      throw new Error('DUPLICATE_HOST_TARGET')
    }
    assertLocalPortAvailable(list, localPort)
    const target = validateTarget({
      id,
      label: typeof payload?.label === 'string' && payload.label.trim() ? payload.label.trim() : alias,
      alias,
      configFile,
      localPort,
      remotePort: Number.isInteger(payload?.remotePort) ? payload.remotePort : 3080,
      launch: payload?.launch === 'systemd-user' ? 'systemd-user' : 'none',
    })
    const nextUi = [
      ...state.targets.filter(item => item?.id !== id),
      { ...target, enabled: payload?.enabled !== false },
    ]
    await persist(nextUi, state.removed.filter(item => item !== id))
    return status()
  }

  async function update(payload, signal) {
    signal?.throwIfAborted()
    const hostId = requireHostId(payload)
    if (hostId === 'local') throw new Error('HOST_LOCAL_READONLY')
    const state = await readState()
    const list = mergeTargets(seedTargets, state.targets, state.removed)
    const current = list.find(target => target.id === hostId)
    if (!current) throw new Error('HOST_NOT_FOUND')
    const nextTarget = validateTarget({
      ...current,
      label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : current.label,
      localPort: Number.isInteger(payload.localPort) ? payload.localPort : current.localPort,
      remotePort: Number.isInteger(payload.remotePort) ? payload.remotePort : current.remotePort,
      launch: payload.launch === undefined ? current.launch : (payload.launch === 'systemd-user' ? 'systemd-user' : 'none'),
      configFile,
    })
    assertLocalPortAvailable(list, nextTarget.localPort, hostId)
    const enabled = payload.enabled === undefined ? current.enabled : payload.enabled !== false
    const replacement = { ...nextTarget, enabled }
    const nextUi = state.targets.some(item => item?.id === hostId)
      ? state.targets.map(item => item?.id === hostId ? replacement : item)
      : [...state.targets, replacement]
    await persist(nextUi, state.removed.filter(item => item !== hostId))
    return status()
  }

  async function remove(payload, signal) {
    signal?.throwIfAborted()
    const hostId = requireHostId(payload)
    if (hostId === 'local') throw new Error('HOST_LOCAL_READONLY')
    const state = await readState()
    const list = mergeTargets(seedTargets, state.targets, state.removed)
    if (!list.some(target => target.id === hostId)) throw new Error('HOST_NOT_FOUND')
    const nextUi = state.targets.filter(item => item?.id !== hostId)
    await persist(nextUi, [...new Set([...state.removed, hostId])])
    return status()
  }

  async function retry(payload, signal) {
    signal?.throwIfAborted()
    const hostId = requireHostId(payload)
    if (hostId === 'local') throw new Error('HOST_LOCAL_READONLY')
    await control.retry(hostId, signal)
    return status()
  }

  async function disconnect(payload, signal) {
    signal?.throwIfAborted()
    const hostId = requireHostId(payload)
    if (hostId === 'local') throw new Error('HOST_LOCAL_READONLY')
    await control.disconnect(hostId, signal)
    return status()
  }

  async function restart(payload, signal) {
    signal?.throwIfAborted()
    assertRestartPayload(payload)
    const hostId = requireHostId(payload)
    if (hostId === 'local') {
      if (typeof localRuntime?.restart !== 'function') throw new Error('RESTART_UNSUPPORTED')
      // Read the only filesystem-backed snapshot before starting the broker.
      // The accepted response is then assembled synchronously after restart;
      // a deferred appExit cannot race a second status() file read.
      const snapshot = await status()
      await localRuntime.restart()
      return {
        ...snapshot,
        hosts: snapshot.hosts.map(host => host.id === 'local' ? { ...host, restartState: 'requested' } : host),
      }
    }
    const list = await merged()
    const current = list.find(target => target.id === hostId)
    if (!current) throw new Error('HOST_NOT_FOUND')
    if (current.launch !== 'systemd-user') throw new Error('RESTART_UNSUPPORTED')
    await control.restart(hostId, signal)
    return status()
  }

  const handlers = { status, discoverAliases, add, update, remove, retry, disconnect, restart }

  async function dispatch(endpoint, payload, signal) {
    try {
      signal?.throwIfAborted()
      const handler = handlers[endpoint]
      if (handler === undefined) throw new Error('HOST_UNAVAILABLE')
      return { ok: true, value: await handler(payload ?? {}, signal) }
    } catch (error) {
      const code = publicErrorCode(error)
      return { ok: false, error: { code, message: code, details: {} } }
    }
  }
  dispatch.boot = async () => { await control.hydrate(await merged()) }
  return dispatch
}
