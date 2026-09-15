import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteHostsClient } from '../packages/runtime-interface/src/client/index.js'
import { createRuntimeInterface } from '../packages/runtime-interface/src/index.js'
import { CHANNEL, createDispatcher } from '../packages/remote-hosts-settings-rc1/src/dispatch.js'

const seedTarget = {
  id: 'ubuntu-dell',
  label: 'Ubuntu Dell',
  alias: 'Ubuntu-dell-tailscale',
  configFile: '',
  localPort: 33080,
  remotePort: 3080,
  launch: 'systemd-user',
}

async function createHarness({ beforeVerifyAlias } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-management-contract-'))
  const configFile = join(directory, 'ssh-config')
  const storeFile = join(directory, 'targets.json')
  await writeFile(configFile, 'Host Ubuntu-dell-tailscale\n  HostName 100.0.0.1\nHost other-box\n  HostName 10.0.0.2\nHost *\n  User ignored\n')

  const live = {
    local: { state: 'connected' },
    remotes: { 'ubuntu-dell': { state: 'connected', helperReadable: true } },
  }
  const control = {
    snapshot: () => live,
    hydrate: async list => { control.hydrated = list },
    retry: async () => {},
    disconnect: async () => {},
    restart: async () => {},
  }
  let verified = 0
  const dispatcher = createDispatcher({
    seedTargets: [{ ...seedTarget, configFile }],
    configFile,
    webPort: 3080,
    storeFile,
    readSshConfig: path => readFile(path, 'utf8'),
    verifyAlias: async (path, alias) => {
      assert.equal(path, configFile)
      assert.ok(['Ubuntu-dell-tailscale', 'other-box'].includes(alias))
      beforeVerifyAlias?.()
      verified += 1
    },
    helperReadable: () => true,
    control,
  })

  const registered = new Map()
  const rpcCalls = []
  const rpc = {
    handle(channel, handler) {
      registered.set(channel, handler)
      return async () => { registered.delete(channel) }
    },
    async call(channel, method, params, signal) {
      rpcCalls.push([channel, method, params, signal])
      const handler = registered.get(channel)
      if (handler === undefined) throw new Error('RPC_CHANNEL_UNAVAILABLE')
      assert.equal(typeof handler, 'function')
      return handler(method, params, signal ?? new AbortController().signal)
    },
  }
  const runtime = createRuntimeInterface({
    sessionController: {},
    workspaceController: {},
    connection: {
      authenticatedUrl: value => value,
      requestRejection: () => undefined,
      rpc,
    },
    subagents: {},
  })
  const dispose = runtime.registerManagementRpc({
    channel: CHANNEL,
    dispatch: ({ method, params, signal }) => dispatcher(method, params, signal),
  })

  return {
    api: createRemoteHostsClient(rpc),
    control,
    dispatcher,
    handler: registered.get(CHANNEL),
    dispose,
    rpcCalls,
    storeFile,
    verified: () => verified,
  }
}

test('management client reaches the real dispatcher through the runtime registrar', async () => {
  const { api, control, rpcCalls, storeFile } = await createHarness()

  const initial = await api.call('status')
  assert.deepEqual(initial.hosts.map(host => host.id), ['local', 'ubuntu-dell'])
  assert.equal(initial.hosts[0].kind, 'local')
  assert.equal(initial.hosts[0].restartAvailable, false)
  assert.equal(initial.hosts[1].state, 'connected')
  assert.equal(initial.suggestedLocalPort, 33081)
  assert.equal(JSON.stringify(initial).includes('ssh-config'), false)

  assert.deepEqual(await api.call('discoverAliases'), { aliases: ['other-box'] })

  const added = await api.call('add', { alias: 'other-box', label: 'Other', launch: 'none' })
  assert.equal(added.hosts.find(host => host.id === 'other-box').localPort, 33081)
  assert.equal(control.hydrated.at(-1).alias, 'other-box')

  const updated = await api.call('update', { hostId: 'ubuntu-dell', label: 'Renamed', localPort: 33082 })
  assert.equal(updated.hosts.find(host => host.id === 'ubuntu-dell').label, 'Renamed')
  assert.equal(updated.hosts.find(host => host.id === 'ubuntu-dell').localPort, 33082)

  await assert.rejects(api.call('update', { hostId: 'local', label: 'Cannot rename local' }), error => error.code === 'HOST_LOCAL_READONLY')
  await assert.rejects(api.call('remove', { hostId: 'local' }), error => error.code === 'HOST_LOCAL_READONLY')

  const removed = await api.call('remove', { hostId: 'ubuntu-dell' })
  assert.deepEqual(removed.hosts.map(host => host.id), ['local', 'other-box'])
  const saved = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(saved.targets.map(target => target.id), ['other-box'])
  assert.deepEqual(saved.removed, ['ubuntu-dell'])
  assert.deepEqual(rpcCalls.slice(0, 2).map(([, method]) => method), ['status', 'discoverAliases'])
})

test('management ingress rejects malformed envelopes before dispatch', async () => {
  const { handler } = await createHarness()

  await assert.rejects(handler(null, {}, new AbortController().signal), error => error.code === 'runtime-interface/invalid-method')
  await assert.rejects(handler('bad method', {}, new AbortController().signal), error => error.code === 'runtime-interface/invalid-method')
  await assert.rejects(handler('status', [], new AbortController().signal), error => error.code === 'runtime-interface/invalid-params')
})

test('management ingress forwards supported cancellation to the real dispatcher', async () => {
  const controller = new AbortController()
  const { api, rpcCalls, verified } = await createHarness({
    beforeVerifyAlias: () => controller.abort(new Error('caller-cancelled')),
  })

  await assert.rejects(api.call('add', { alias: 'other-box' }, controller.signal), error => error.code === 'HOST_UNAVAILABLE')
  assert.equal(rpcCalls.at(-1)[3], controller.signal)
  assert.equal(verified(), 1)
  assert.deepEqual((await api.call('status')).hosts.map(host => host.id), ['local', 'ubuntu-dell'])
})

test('management RPC disposer removes the registered channel', async () => {
  const { api, dispose } = await createHarness()

  await api.call('status')
  assert.equal(typeof dispose, 'function')
  const releasing = dispose()
  assert.equal(typeof releasing?.then, 'function')
  await releasing
  await assert.rejects(api.call('status'), /RPC_CHANNEL_UNAVAILABLE/)
})
