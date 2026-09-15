import store from './bootstrap-store.cjs'
import { createBootstrapPublisher } from './publisher.js'

export const name = 'mobile-bootstrap-rc1'
export const inject = ['runtimeInterface']

function reportBootstrapFailure(code) {
  if (/^BOOTSTRAP_[A-Z0-9_]+$/.test(code ?? '')) console.warn(`DSH_MOBILE_BOOTSTRAP_UNAVAILABLE ${code}`)
}

export function apply(ctx, { publisherOptions = {} } = {}) {
  const endpoint = ctx.runtimeInterface?.localBootstrapEndpoint?.()
  if (!endpoint || typeof endpoint !== 'object') throw new TypeError('runtimeInterface.localBootstrapEndpoint is required')
  const port = store.portNumber(endpoint.port)
  if (typeof endpoint.authenticatedRootUrl !== 'string') throw new Error('BOOTSTRAP_INVALID_URL')
  const options = { ...publisherOptions, port, authenticatedRootUrl: endpoint.authenticatedRootUrl }
  if (options.onFailure === undefined) options.onFailure = reportBootstrapFailure
  return ctx.effect(
    () => createBootstrapPublisher(options),
    'mobile-bootstrap-rc1: protected SSH bootstrap',
  )
}
