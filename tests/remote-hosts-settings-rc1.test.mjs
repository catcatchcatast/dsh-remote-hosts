import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostIdFromAlias, parseConcreteSshAliases, suggestLocalPort } from '../packages/remote-hosts-settings-rc1/src/ssh-aliases.js'
import { publicErrorCode, publicHost } from '../packages/remote-hosts-settings-rc1/src/public.js'
import { loadUiState, mergeTargets, saveUiState, storePath } from '../packages/remote-hosts-settings-rc1/src/store.js'
import { createDispatcher } from '../packages/remote-hosts-settings-rc1/src/dispatch.js'

const seed = [{
  id: 'ubuntu-dell',
  label: 'Ubuntu Dell',
  alias: 'Ubuntu-dell-tailscale',
  configFile: '/tmp/ssh-config',
  localPort: 33080,
  remotePort: 3080,
  launch: 'systemd-user',
}]

const settingsRequire = createRequire(new URL('../packages/remote-hosts-settings-rc1/package.json', import.meta.url))

function sshConfig() {
  return 'Host Ubuntu-dell-tailscale\n  HostName 100.0.0.1\nHost other-box\n  HostName 10.0.0.2\nHost *\n  User ignore\n'
}

async function dispatcher(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rh-'))
  const storeFile = join(dir, 'targets.json')
  const live = {
    local: { state: 'connected' },
    remotes: { 'ubuntu-dell': { state: 'connected', helperReadable: true } },
  }
  const control = {
    snapshot: () => live,
    hydrate: async list => { control.hydrated = list },
    retry: async id => { control.retried = id },
    disconnect: async id => { control.disconnected = id },
    restart: async id => { control.restarted = id },
  }
  const dispatch = createDispatcher({
    seedTargets: seed,
    configFile: '/tmp/ssh-config',
    webPort: 3080,
    storeFile,
    readSshConfig: async () => sshConfig(),
    verifyAlias: async (_file, alias) => {
      if (!['Ubuntu-dell-tailscale', 'other-box'].includes(alias)) throw new Error('SSH_ALIAS_UNAVAILABLE')
    },
    helperReadable: () => true,
    control,
    ...overrides,
  })
  return { dispatch, storeFile, control, live }
}

test('parses concrete SSH aliases and slugs ids without dots', () => {
  assert.deepEqual(parseConcreteSshAliases(sshConfig()), ['Ubuntu-dell-tailscale', 'other-box'])
  assert.equal(hostIdFromAlias('Ubuntu-dell-tailscale'), 'ubuntu-dell-tailscale')
  assert.equal(hostIdFromAlias('box.lab'), 'box-lab')
  assert.equal(suggestLocalPort([3080, 33080]), 33081)
})

test('public snapshot never includes hostname, token, or config path', () => {
  const row = publicHost({
    id: 'ubuntu-dell',
    kind: 'remote',
    label: 'Ubuntu Dell',
    alias: 'Ubuntu-dell-tailscale',
    configFile: 'C:\\Users\\example\\.ssh\\config',
    hostname: '192.0.2.10',
    authenticatedRootUrl: 'http://127.0.0.1:3080/?token=secret',
    localPort: 33080,
    remotePort: 3080,
    launch: 'systemd-user',
    state: 'connected',
    lastError: 'HOST_CONNECTION_FAILED_FORWARD',
  })
  const text = JSON.stringify(row)
  assert.equal(row.alias, 'Ubuntu-dell-tailscale')
  assert.equal(row.restartAvailable, true)
  assert.ok(!text.includes('100.86'))
  assert.ok(!text.includes('token'))
  assert.ok(!text.includes('.ssh'))
  assert.equal(publicErrorCode(new Error('ECONNREFUSED C:\\\\secret')), 'HOST_UNAVAILABLE')
})

test('seed and UI file merge, UI wins on the same id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rh-'))
  const path = join(dir, 'targets.json')
  const seeded = { ...seed[0], upstreamVersion: '0.1.5-rc.2' }
  await saveUiState(path, [{ ...seed[0], label: 'Renamed', launch: 'none' }])
  const list = mergeTargets([seeded], (await loadUiState(path)).targets)
  assert.equal(list[0].label, 'Renamed')
  assert.equal(list[0].launch, 'none')
  assert.equal(list[0].upstreamVersion, '0.1.5-rc.2')
  assert.equal(storePath('/home/x'), join('/home/x', '.dsh', 'plugins', 'remote-hosts', 'targets.json'))
})

test('default store follows an isolated DSH_HOME profile root', () => {
  assert.equal(
    storePath(undefined, { DSH_HOME: '/lab/candidate' }),
    join('/lab/candidate', 'plugins', 'remote-hosts', 'targets.json'),
  )
})

test('settings resolves the host carrier through its package export', async () => {
  const entry = settingsRequire.resolve('dsh-rc1-host-carriers')
  const carrier = await import(pathToFileURL(entry).href)
  assert.equal(typeof carrier.validateTarget, 'function')
})

test('status lists local plus remotes and suggests a free local port', async () => {
  const { dispatch } = await dispatcher()
  const result = await dispatch('status', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.hosts[0].id, 'local')
  assert.equal(result.value.hosts[0].kind, 'local')
  assert.equal(result.value.hosts[0].restartAvailable, false)
  assert.equal(result.value.hosts[1].id, 'ubuntu-dell')
  assert.equal(result.value.hosts[1].restartAvailable, true)
  assert.equal(result.value.suggestedLocalPort, 33081)
  assert.ok(!JSON.stringify(result.value).includes('100.0.0.1'))
})

test('discoverAliases omits aliases already used', async () => {
  const { dispatch } = await dispatcher()
  const result = await dispatch('discoverAliases', {})
  assert.deepEqual(result.value.aliases, ['other-box'])
})

test('add persists a new host and hydrates carriers', async () => {
  const { dispatch, storeFile, control } = await dispatcher()
  const result = await dispatch('add', { alias: 'other-box', label: 'Other', launch: 'none' })
  assert.equal(result.ok, true)
  assert.equal(result.value.hosts.at(-1).id, 'other-box')
  assert.equal(result.value.hosts.at(-1).localPort, 33081)
  const saved = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(saved.targets.map(target => target.id), ['other-box'])
  assert.deepEqual(saved.removed, [])
  assert.equal(control.hydrated.at(-1).alias, 'other-box')
  assert.ok(!JSON.stringify(saved).includes('100.0.0.1'))
})

test('UI updates keep patch seed metadata in the merged view', async () => {
  const { dispatch, storeFile, control } = await dispatcher({
    seedTargets: [{ ...seed[0], upstreamVersion: '0.1.5-rc.2' }],
  })
  const result = await dispatch('update', { hostId: 'ubuntu-dell', label: 'Renamed', localPort: 33082 })
  assert.equal(result.ok, true)
  assert.equal(result.value.hosts.find(host => host.id === 'ubuntu-dell').label, 'Renamed')
  assert.equal(control.hydrated.find(target => target.id === 'ubuntu-dell').upstreamVersion, '0.1.5-rc.2')
  const saved = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(saved.targets.map(target => target.id), ['ubuntu-dell'])
  assert.ok(!JSON.stringify(saved).includes('100.0.0.1'))
})

test('removing a patch seed writes a tombstone and keeps it hidden', async () => {
  const { dispatch, storeFile } = await dispatcher()
  const result = await dispatch('remove', { hostId: 'ubuntu-dell' })
  assert.equal(result.ok, true)
  assert.equal(result.value.hosts.length, 1)
  const saved = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(saved.targets, [])
  assert.deepEqual(saved.removed, ['ubuntu-dell'])
})

test('local web port and another target port cannot be reused', async () => {
  const { dispatch } = await dispatcher()
  assert.equal((await dispatch('add', { alias: 'other-box', localPort: 3080 })).error.code, 'DUPLICATE_HOST_TARGET')
  assert.equal((await dispatch('add', { alias: 'other-box' })).ok, true)
  assert.equal((await dispatch('update', { hostId: 'other-box', localPort: 33080 })).error.code, 'DUPLICATE_HOST_TARGET')
})

test('management dispatch passes cancellation signals to handlers', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  let verified = false
  const { dispatch } = await dispatcher({
    verifyAlias: async () => { verified = true },
  })
  const result = await dispatch('add', { alias: 'other-box' }, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'HOST_UNAVAILABLE')
  assert.equal(verified, false)
})

test('restart is unavailable for local without the optional runtime capability and for launch none', async () => {
  const { dispatch, control } = await dispatcher()
  assert.equal((await dispatch('restart', { hostId: 'local' })).error.code, 'RESTART_UNSUPPORTED')
  await dispatch('add', { alias: 'other-box', launch: 'none' })
  assert.equal((await dispatch('restart', { hostId: 'other-box' })).error.code, 'RESTART_UNSUPPORTED')
  assert.equal(control.restarted, undefined)
  const ok = await dispatch('restart', { hostId: 'ubuntu-dell' })
  assert.equal(ok.ok, true)
  assert.equal(control.restarted, 'ubuntu-dell')
})

test('local restart uses the injected narrow capability and rejects extra RPC fields', async () => {
  let calls = 0
  const localRuntime = {
    status: () => ({ available: true, state: calls === 0 ? 'ready' : 'requested' }),
    restart: async () => { calls += 1 },
  }
  const { dispatch } = await dispatcher({ localRuntime })
  const status = await dispatch('status', {})
  assert.equal(status.value.hosts[0].restartAvailable, true)
  assert.equal((await dispatch('restart', { hostId: 'local', command: 'node' })).error.code, 'HOST_RESTART_PARAMS_INVALID')
  const result = await dispatch('restart', { hostId: 'local' })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  assert.equal(result.value.hosts[0].restartState, 'requested')
})

test('local restart returns its pre-read snapshot before a delayed store read can race appExit', async () => {
  let storeReads = 0
  let exitCalled = false
  const localRuntime = {
    status: () => ({ available: true, state: 'ready' }),
    restart: async () => { setTimeout(() => { exitCalled = true }, 0) },
  }
  const { dispatch } = await dispatcher({
    localRuntime,
    loadState: async file => {
      storeReads += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(exitCalled, false)
      return loadUiState(file)
    },
  })
  const result = await dispatch('restart', { hostId: 'local' })
  assert.equal(result.ok, true)
  assert.equal(result.value.hosts[0].restartState, 'requested')
  assert.equal(storeReads, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(exitCalled, true)
})

test('remove and disconnect never call restart', async () => {
  const { dispatch, control } = await dispatcher()
  assert.equal((await dispatch('disconnect', { hostId: 'ubuntu-dell' })).ok, true)
  assert.equal(control.disconnected, 'ubuntu-dell')
  assert.equal((await dispatch('remove', { hostId: 'ubuntu-dell' })).ok, true)
  assert.equal(control.restarted, undefined)
  assert.equal((await dispatch('status', {})).value.hosts.length, 1)
})

test('client bundle registers a left-nav section and a restart action', async () => {
  const source = await readFile(new URL('../packages/remote-hosts-settings-rc1/lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /settings\.section/)
  assert.match(source, /id: "remote-hosts"|id: 'remote-hosts'/)
  assert.match(source, /restart/)
  assert.match(source, /localRestartUnavailable/)
  assert.match(source, /Edit host/)
  assert.match(source, /update/)
  assert.doesNotMatch(source, /Tailscale login/)
})

test('unknown RPC endpoints do not leak internals', async () => {
  const { dispatch } = await dispatcher()
  const result = await dispatch('eval', { cmd: 'rm -rf /' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'HOST_UNAVAILABLE')
  assert.equal(result.error.message, 'HOST_UNAVAILABLE')
})
