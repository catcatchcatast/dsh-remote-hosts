import store from './bootstrap-store.cjs'

export const name = 'mobile-bootstrap-rc1'
export const inject = ['webServer', 'connection']
export function apply(ctx) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('BOOTSTRAP_REQUIRES_LOOPBACK')
  const port = store.portNumber(ctx.webServer.port)
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
  return ctx.effect(() => store.publishBootstrap(port, url), 'mobile-bootstrap-rc1: protected SSH bootstrap')
}
