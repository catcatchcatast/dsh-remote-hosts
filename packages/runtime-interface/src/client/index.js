const CHANNEL = '/remote-hosts'
const METHODS = new Set(['status', 'discoverAliases', 'add', 'update', 'remove', 'retry', 'disconnect', 'restart'])
const REQUEST_KEYS = new Set(['id', 'hostId', 'label', 'alias', 'localPort', 'remotePort', 'launch', 'enabled'])
const HOST_KEYS = ['id', 'kind', 'label', 'alias', 'state', 'lastError', 'localPort', 'remotePort', 'launch', 'enabled', 'restartAvailable', 'restartState', 'helperReadable']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = code => Object.assign(new Error(code), { code })

function responseValue(method, result) {
  if (!record(result) || result.ok !== true) {
    const code = result?.error?.code
    throw failure(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : 'HOST_UNAVAILABLE')
  }
  const value = result.value
  if (!record(value)) throw failure('HOST_UNAVAILABLE')
  if (method === 'discoverAliases') {
    if (!Array.isArray(value.aliases) || value.aliases.some(alias => typeof alias !== 'string' || alias.length > 256)) throw failure('HOST_UNAVAILABLE')
    return Object.freeze({ aliases: Object.freeze([...value.aliases]) })
  }
  if (!Array.isArray(value.hosts) || !Number.isInteger(value.suggestedLocalPort)) throw failure('HOST_UNAVAILABLE')
  const hosts = value.hosts.map(host => {
    if (!record(host) || typeof host.id !== 'string' || !['local', 'remote'].includes(host.kind) || typeof host.state !== 'string') throw failure('HOST_UNAVAILABLE')
    return Object.freeze(Object.fromEntries(HOST_KEYS.filter(key => Object.hasOwn(host, key)).map(key => [key, host[key]])))
  })
  return Object.freeze({ hosts: Object.freeze(hosts), suggestedLocalPort: value.suggestedLocalPort })
}

/** Own the official browser RPC binding; UI gets only this stable, bounded API. */
export function createRemoteHostsClient(rpc) {
  if (typeof rpc?.call !== 'function') throw new TypeError('official client RPC binding is required')
  return Object.freeze({
    async call(method, payload = {}, signal) {
      signal?.throwIfAborted()
      if (!METHODS.has(method) || !record(payload) || Object.keys(payload).some(key => !REQUEST_KEYS.has(key))) throw failure('HOST_UNAVAILABLE')
      for (const [key, value] of Object.entries(payload)) {
        if (['localPort', 'remotePort'].includes(key)) {
          if (!Number.isInteger(value) || value < 1024 || value > 65535) throw failure('HOST_PORT_INVALID')
        } else if (key === 'enabled') {
          if (typeof value !== 'boolean') throw failure('HOST_UNAVAILABLE')
        } else if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw failure('HOST_UNAVAILABLE')
      }
      return responseValue(method, await rpc.call(CHANNEL, method, { ...payload }, signal))
    },
  })
}

export const inject = ['connection']
export function apply(ctx) {
  ctx.provide('remoteHostsInterface', createRemoteHostsClient(ctx.get('connection').rpc))
}
