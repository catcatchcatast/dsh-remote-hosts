import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteHostsClient } from '../packages/runtime-interface/src/client/index.js'

test('management client binds the official RPC and gives UI only canonical public host data', async () => {
  const calls = []
  const api = createRemoteHostsClient({ call: async (...args) => {
    calls.push(args)
    return { ok: true, value: { hosts: [{ id: 'local', kind: 'local', state: 'connected', localPort: 3180, configFile: 'private', token: 'private' }], suggestedLocalPort: 33080, privateField: 'secret' } }
  } })
  const value = await api.call('status')
  assert.deepEqual(calls, [['/remote-hosts', 'status', {}, undefined]])
  assert.equal(Object.hasOwn(api, 'rpc'), false)
  assert.equal(value.hosts[0].configFile, undefined)
  assert.equal(value.hosts[0].token, undefined)
  assert.equal(value.privateField, undefined)
  assert.ok(Object.isFrozen(value.hosts[0]))
})

test('management client refuses unknown methods, private parameters, malformed replies and invalid ports', async () => {
  let calls = 0
  const api = createRemoteHostsClient({ call: async () => { calls++; return { ok: true, value: null } } })
  await assert.rejects(api.call('shell/exec', {}), { code: 'HOST_UNAVAILABLE' })
  await assert.rejects(api.call('add', { configFile: 'private' }), { code: 'HOST_UNAVAILABLE' })
  await assert.rejects(api.call('add', { localPort: 0 }), { code: 'HOST_PORT_INVALID' })
  assert.equal(calls, 0)
  await assert.rejects(api.call('status'), { code: 'HOST_UNAVAILABLE' })
})
