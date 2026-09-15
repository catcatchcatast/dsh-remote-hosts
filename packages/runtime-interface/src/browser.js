const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = endpoint => Object.assign(new Error('Invalid browser request envelope'), {
  code: 'browser-host-hub-rc1/invalid-request', details: { endpoint },
})

/** Official browser envelopes terminate here; business receives only the fixed request fields. */
export function decodeBrowserRequest(message, endpoint) {
  if (!record(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string' || !message.rpcId || message.method !== endpoint) throw invalid(endpoint)
  return Object.freeze({ type: 'client-request', method: endpoint, rpcId: message.rpcId, payload: message.payload })
}

export function encodeBrowserResponse(requestId, result) {
  if (typeof requestId !== 'string' || !requestId) throw invalid('response')
  return { type: 'server-response', rpcId: requestId, result }
}

/** Plugin multiplexing frames share the same boundary before subscription business handling. */
export function decodeBrowserStreamFrame(text) {
  const message = JSON.parse(text)
  if (!record(message) || !['open', 'cancel'].includes(message.type)) throw invalid('streams')
  if (message.type === 'cancel') return Object.freeze({ type: 'cancel', streamId: message.streamId })
  return Object.freeze({ type: 'open', streamId: message.streamId, endpoint: message.endpoint, payload: message.payload })
}
