
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { bindManagementConnection } from '../packages/runtime-interface/src/management-binding.js'

const officialRoots = [
  { name: 'legacy', version: '0.1.2-rc.1', root: process.env.DSH_OFFICIAL_RC1_ROOT },
  { name: 'current', version: '0.1.5-rc.2', root: process.env.DSH_OFFICIAL_RC2_ROOT },
]

function nodeModulesRoot(root) {
  const candidate = join(root, 'node_modules')
  return candidate
}

function packageFile(root, name, relative) {
  return join(nodeModulesRoot(root), name, relative)
}

async function importFrom(file) {
  await access(file)
  return import(pathToFileURL(file).href)
}

async function createOfficialHarness(spec) {
  const cordisFile = packageFile(spec.root, '@deepseek-ai/cordis', 'lib/index.js')
  const connectionFile = packageFile(spec.root, '@deepseek-ai/dsh-client-connection', 'lib/index.js')
  const [{ Context, symbols }, { HostConnectionService }] = await Promise.all([
    importFrom(cordisFile),
    importFrom(connectionFile),
  ])
  const root = new Context()
  const routes = new Map()
  const webFiber = root.registry.plugin({
    name: 'web',
    apply(ctx) {
      ctx.provide('webServer', {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      })
    },
  })
  await webFiber.await()
  const connectionFiber = root.registry.plugin({
    name: 'connection',
    apply(ctx) {
      new HostConnectionService(ctx, ['127.0.0.1:3180'], { isAuthenticated: () => false })
    },
  })
  await connectionFiber.await()
  let caller
  const callerFiber = root.registry.plugin({
    name: 'caller',
    inject: ['webServer', 'connection'],
    apply(ctx) {
      assert.equal(Boolean(ctx.webServer), true)
      const bound = bindManagementConnection(ctx, ctx.connection, spec.version)
      assert.equal(bound.upstreamVersion, spec.version)
      const dispose = bound.register('/management-owner-binding', () => {})
      caller = { ctx, connection: ctx.connection, dispose }
    },
  })
  await callerFiber.await()
  return { callerFiber, caller, routes, symbols }
}

for (const spec of officialRoots) {
  test(`official ${spec.name} HostConnectionService binds RPC routes to caller scope`, async t => {
    if (!spec.root) return t.skip(`set DSH_OFFICIAL_${spec.name === 'legacy' ? 'RC1' : 'RC2'}_ROOT to run the official regression`)
    const { callerFiber, caller, routes } = await createOfficialHarness(spec)
    assert.equal(routes.has('/management-owner-binding'), true)
    const response = { status: undefined, body: undefined, writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await routes.get('/management-owner-binding').handler({ method: 'POST', url: '/management-owner-binding/status', headers: { host: '127.0.0.1:3180' } }, response)
    assert.equal(response.status, 401)
    assert.equal(response.body, 'unauthorized')
    await callerFiber.dispose()
    assert.equal(routes.has('/management-owner-binding'), false)
    await caller?.dispose?.()
  })
}

test('mock Connection without Cordis symbols remains compatible', async () => {
  const routes = new Map()
  const rpc = {
    handle(channel, handler) {
      routes.set(channel, handler)
      return async () => routes.delete(channel)
    },
  }
  const binding = bindManagementConnection({}, { rpc }, '0.1.2-rc.1')
  const handler = () => 'ok'
  const dispose = binding.register('/mock-management', handler)
  assert.equal(routes.get('/mock-management'), handler)
  await dispose()
  assert.equal(routes.has('/mock-management'), false)
})
