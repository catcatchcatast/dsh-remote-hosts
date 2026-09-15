import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const patch = await readFile(new URL('../packages/runtime-interface/cordis.patch.yml', import.meta.url), 'utf8')
const connectionPatch = patch.match(/^- id: connection\r?\n([\s\S]*?)(?=^-[ \t]|$(?![\s\S]))/m)?.[1]
const composedInject = [...(connectionPatch ?? '').matchAll(/^    - (\w+)$/gm)].map(x => x[1])

test('web interface composition keeps startup and gives Connection its own WebServer dependency', () => {
  assert.deepEqual(composedInject, ['webRuntime', 'webServer'])
})

async function harness(spec, useInterfacePatch) {
  const modules = join(spec.root, 'node_modules')
  const [{ Context }, connectionModule] = await Promise.all([
    import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')).href),
    import(pathToFileURL(join(modules, '@deepseek-ai/dsh-client-connection/lib/index.js')).href),
  ])
  const root = new Context(), routes = new Map()
  const fixtures = root.registry.plugin({
    name: 'composition-services',
    apply(ctx) {
      ctx.provide('credentials', {})
      ctx.provide('webRuntime', {})
      ctx.provide('webServer', {
        register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      })
    },
  })
  await fixtures.await()
  // Use the real module's dependency declaration. Giving every owner webServer
  // here would conceal the rc.2 regression even when the actual route is absent.
  const connection = root.registry.plugin({
    name: 'real-connection',
    inject: [...new Set([...connectionModule.inject, ...(useInterfacePatch ? composedInject : [])])],
    apply(ctx) {
      new connectionModule.HostConnectionService(ctx, ['127.0.0.1:3180'], { isAuthenticated: () => false })
    },
  })
  await connection.await()
  const attempt = Promise.withResolvers()
  const caller = root.registry.plugin({
    name: 'existing-channel-caller',
    apply(ctx) {
      ctx.inject(['connection'], child => {
        // Match existing subscriptions: get() retains the Connection owner.
        const service = child.get('connection')
        child.effect(() => {
          try {
            const dispose = service.rpc.handle('/subscriptions-auth', async () => ({ ok: true, value: {} }))
            attempt.resolve(undefined)
            return dispose
          } catch (error) { attempt.resolve(error); throw error }
        }, 'existing-channel-registration')
      })
    },
  })
  await caller.await()
  const registrationError = await attempt.promise
  return { routes, registrationError, connection,
    async close() { await caller.dispose(); await connection.dispose(); await fixtures.dispose() } }
}

for (const spec of [
  { name: 'rc1', root: process.env.DSH_OFFICIAL_RC1_ROOT, nativeOwnsWebServer: true },
  { name: 'rc2', root: process.env.DSH_OFFICIAL_RC2_ROOT, nativeOwnsWebServer: false },
]) {
  test(`official ${spec.name} native Connection reproduces its actual owner scope`, async t => {
    if (!spec.root) return t.skip(`official ${spec.name} runtime root not provided`)
    const h = await harness(spec, false)
    try {
      assert.equal(h.routes.has('/subscriptions-auth'), spec.nativeOwnsWebServer)
      if (!spec.nativeOwnsWebServer) assert.match(h.registrationError?.message ?? '', /webServer.*without inject/)
      else assert.equal(h.registrationError, undefined)
    } finally { await h.close() }
  })

  test(`official ${spec.name} interface composition registers and releases authenticated RPC`, async t => {
    if (!spec.root) return t.skip(`official ${spec.name} runtime root not provided`)
    const h = await harness(spec, true)
    try {
      assert.equal(h.registrationError, undefined)
      const route = h.routes.get('/subscriptions-auth')
      assert.ok(route)
      for (const [host, status] of [['127.0.0.1:3180', 401], ['untrusted.invalid', 403]]) {
        const response = { status: undefined, writeHead(code) { this.status = code }, end() {} }
        await route.handler({ method: 'POST', url: '/subscriptions-auth/status', headers: { host } }, response)
        assert.equal(response.status, status)
      }
      await h.connection.dispose()
      assert.equal(h.routes.has('/subscriptions-auth'), false)
    } finally { await h.close() }
  })
}
