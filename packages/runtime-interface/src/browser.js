// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                             
                                                                                                                                             
                                                                                                                                     
import { classifyStreamFailure, streamFailureBrowserPolicy } from './stream-failure.js'
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

/** Stable error metadata crosses the mux boundary alongside the existing envelope. */
export function encodeBrowserStreamFailure(error, options = {}) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'browser-host-hub-rc1/stream-failure',
    message: typeof error?.message === 'string' ? error.message : 'Browser stream failed',
    details: record(error?.details) ? error.details : {},
    streamFailure: classifyStreamFailure(error, options),
  }
}

// Self-contained browser codec: the policy is supplied by this interface module,
// so injected Hub code neither duplicates the vocabulary nor parses upstream text.
function createBrowserStreamFailureCodec(policy) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const metadata = value => {
    const input = isRecord(value?.streamFailure) ? value.streamFailure : value
    if (!isRecord(input) || !policy.reasons.includes(input.reason)) return undefined
    const row = {
      source: policy.sources.includes(input.source) ? input.source : 'interface',
      reason: input.reason, recoverable: policy.recoverable.includes(input.reason),
    }
    if (policy.stages.includes(input.stage)) row.stage = input.stage
    for (const key of ['expected', 'actual']) {
      if (Number.isSafeInteger(input[key]) && input[key] >= 0 && !Object.is(input[key], -0)) row[key] = input[key]
    }
    return row
  }
  const fromWire = value => {
    const error = new Error(typeof value?.message === 'string' ? value.message : 'Browser stream failed')
    if (typeof value?.code === 'string') error.code = value.code
    if (isRecord(value?.details)) error.details = value.details
    const failure = metadata(value)
    if (failure) {
      error.streamFailure = Object.freeze(failure)
      Object.assign(error, failure)
      if (failure.recoverable) error.dshRemoteStreamFailure = { kind: 'carrier' }
      else if (value?.code === 'browser-host-hub-rc1/session-follow-bootstrap-failed' && failure.stage === 'bootstrap') {
        // The public Gateway already accepts this page-local remote marker.
        // Only the existing bounded classification becomes terminal details;
        // upstream details/cause and retry policy do not cross this boundary.
        error.dshRemoteStreamFailure = { kind: 'remote', code: error.code, details: { ...failure } }
      }
    }
    return error
  }
  return Object.freeze({
    metadata, fromWire,
    diagnosticCode: value => policy.diagnosticCodes[metadata(value)?.reason] ?? 'unknown',
  })
}

export function browserStreamFailureCodecSource() {
  return `(${createBrowserStreamFailureCodec.toString()})(${JSON.stringify(streamFailureBrowserPolicy())})`
}

                                                                                                                                               
// Only the page-local public selection snapshot can identify what the official
// workspace will restore. Shared persisted storage may already belong to another page.
function readColdRestoreSession(reader) {
  try {
    const value = typeof reader === 'function' ? reader() : undefined
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'sessionId')) return undefined
    const id = value.sessionId
    return typeof id === 'string' && id.length > 0 && id.length <= 16384 && !id.includes('\0') ? id : undefined
  } catch { return undefined }
}
export function browserColdRestoreReaderSource() {
  return `(${readColdRestoreSession.toString()})`
}
