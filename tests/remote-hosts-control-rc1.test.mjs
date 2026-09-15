import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapHostCarrier } from 'dsh-runtime-interface'
import { apply, createRemoteHostControl } from '../packages/rc1-host-carriers/src/index.js'

const runtimeInterface = { wrapHostCarrier }

test('local carrier inherits the active interface version and rejects conflicting explicit configuration', async () => {
  for (const version of ['0.1.2-rc.1', '0.1.5-rc.2']) {
    const services = new Map()
    const cleanup = []
    const context = {
      webServer: { port: 3180 },
      runtimeInterface: {
        upstreamVersion: version,
        wrapHostCarrier,
        connection: { authenticatedUrl() { throw new Error('lazy transport must not connect during registration') } },
      },
      provide: (name, service) => services.set(name, service),
      effect: setup => cleanup.push(setup()),
    }
    await apply(context, { targets: [] })
    assert.equal(services.get('perHost').get('local').upstreamVersion, version)
    assert.equal(services.get('remoteHostsControl').snapshot().local.state, 'offline')
    for (const dispose of cleanup) dispose()
    await assert.rejects(apply(context, { upstreamVersion: version === '0.1.2-rc.1' ? '0.1.5-rc.2' : '0.1.2-rc.1' }), /LOCAL_UPSTREAM_VERSION_MISMATCH/)
  }
})

test('control restart is unsupported without systemd-user and does not connect', async () => {
  const lifetime = new AbortController()
  const perHost = new Map()
  const localCarrier = { getState: () => 'connected', close() {} }
  perHost.set('local', localCarrier)
  let connects = 0
  const control = createRemoteHostControl({
    seedTargets: [{
      id: 'lab', label: 'Lab', alias: 'lab', configFile: '/tmp/ssh', localPort: 33080, remotePort: 3080, launch: 'none',
    }],
    createCarrier: async () => { connects++; return { raw: async () => ({ status: 200 }), call: async () => ({}), open: async function* () {} } },
    WebSocket: class {},
    perHost,
    localCarrier,
    runtimeInterface,
    lifetime: lifetime.signal,
  })
  assert.equal(perHost.get('lab').runtimeInterfaceCarrier, true)
  assert.equal(perHost.get('lab').upstreamVersion, '0.1.2-rc.1')
  assert.equal(typeof perHost.get('lab').call, 'function')
  assert.equal(typeof perHost.get('lab').open, 'function')
  assert.equal(typeof perHost.get('lab').raw, 'function')
  await assert.rejects(control.restart('lab'), /RESTART_UNSUPPORTED/)
  await assert.rejects(control.restart('local'), /HOST_LOCAL_READONLY/)
  assert.equal(connects, 0)
  const aborted = new AbortController()
  aborted.abort(new Error('cancelled'))
  await assert.rejects(control.retry('lab', aborted.signal), /cancelled/)
  assert.equal(connects, 0)
  await control.disconnect('lab')
  assert.equal(perHost.has('lab'), false)
  lifetime.abort()
})

test('control preserves an explicit official upstream version per Host', () => {
  const lifetime = new AbortController()
  const perHost = new Map([['local', { getState: () => 'connected', close() {} }]])
  createRemoteHostControl({
    seedTargets: [{
      id: 'official', label: 'Official', alias: 'official', configFile: '/tmp/ssh',
      localPort: 33081, remotePort: 3080, launch: 'none', upstreamVersion: '0.1.5-rc.2',
    }],
    createCarrier: async () => ({ raw: async () => ({ status: 200 }), call: async () => ({}), open: async function* () {} }),
    WebSocket: class {},
    perHost,
    localCarrier: perHost.get('local'),
    runtimeInterface,
    lifetime: lifetime.signal,
  })
  assert.equal(perHost.get('official').upstreamVersion, '0.1.5-rc.2')
  lifetime.abort()
})
