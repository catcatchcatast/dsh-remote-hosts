// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
                                                                                                                                           
                                                                                                                                             
/** Workspace protocol and identity conversion; Hub aggregates the stable pins list. */
import { isWebRuntimeVersion } from './web-020.js'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw Object.assign(new Error(message), { code: 'runtime-interface/invalid-stream' }) }
const ids = value => {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.includes('\0'))) invalid('Invalid workspace identity list')
  return value
}
export const WORKSPACE_METHODS = Object.freeze(['initializeDefault', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession', 'create', 'delete', 'follow', 'insertBefore', 'insertSessionBefore', 'rename'])
export const WORKSPACE_FILE_ENDPOINTS = Object.freeze(['workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/changes', 'workspaceFiles/readBytes'])
export const OFFICE_TO_PDF_ENDPOINTS = Object.freeze(['officeToPdf/render', 'officeToPdf/generation'])
export const WORKSPACE_BINARY_ENDPOINTS = Object.freeze(['workspaceFiles/readBytes', 'officeToPdf/render'])
export function assertWorkspaceCapability(endpoint, version) {
  if ((WORKSPACE_FILE_ENDPOINTS.includes(endpoint) || OFFICE_TO_PDF_ENDPOINTS.includes(endpoint)) && version !== '0.2.1-rc.2') throw Object.assign(new Error('Workspace files are unavailable on this runtime'), { code: 'runtime-interface/capability-unavailable' })
  if (endpoint === 'workspace/initializeDefault' && version !== '0.2.1-rc.2') throw Object.assign(new Error('Default workspace initialization is unavailable'), { code: 'runtime-interface/capability-unavailable' })
  if (!isWebRuntimeVersion(version) && ['workspace/pinSession', 'workspace/unpinSession', 'workspace/unarchiveSession'].includes(endpoint)) {
    throw Object.assign(new Error('This host has no requested workspace capability'), { code: 'runtime-interface/capability-unavailable', details: { endpoint } })
  }
}
function canonicalValue(value, version, baseline = false) {
  if (!record(value)) invalid('Invalid workspace value')
  const result = { ...value }
  if (baseline && (!Array.isArray(value.items) || !Array.isArray(value.archivedSessionIds))) invalid('Invalid workspace baseline')
  if (value.archivedSessionIds !== undefined) ids(value.archivedSessionIds)
  if (value.workspaceIds !== undefined) ids(value.workspaceIds)
  if (value.workspaceState === true) { ids(value.pins); return result }
  if (baseline || Object.hasOwn(value, 'pinnedSessionIds')) {
    result.workspaceState = true
    result.pins = isWebRuntimeVersion(version) || value.pinnedSessionIds !== undefined ? ids(value.pinnedSessionIds) : []
    delete result.pinnedSessionIds
  }
  return result
}
export function canonicalWorkspaceWire(endpoint, value, version) {
  if (!endpoint?.startsWith('workspace/') || !record(value)) return value
  if (value.ok !== undefined) return value.ok === true ? { ...value, value: canonicalWorkspaceWire(endpoint, value.value, version) } : value
  if (endpoint !== 'workspace/follow') {
    if (['workspace/pinSession', 'workspace/unpinSession'].includes(endpoint)) ids(value.workspaceState === true ? value.pins : value.pinnedSessionIds)
    return canonicalValue(value, version)
  }
  if (value.type === 'baseline') return { ...value, value: canonicalValue(value.value, version, true) }
  if (value.type === 'pins') { ids(value.pins); return value }
  if (value.type === 'pinned') return { type: 'pins', pins: ids(value.pinnedSessionIds) }
  if (value.type === 'archived') ids(value.archivedSessionIds)
  else if (value.type === 'order') ids(value.workspaceIds)
  else if (value.type === 'upsert' && !record(value.workspace)) invalid('Invalid workspace row')
  else if (value.type === 'remove' && typeof value.workspaceId !== 'string') invalid('Invalid workspace removal')
  else if (!['archived', 'order', 'upsert', 'remove'].includes(value.type)) invalid('Invalid workspace increment')
  return value
}
export function browserWorkspaceWire(value, target) {
  if (!record(value)) return value
  if (value.type === 'pins') return isWebRuntimeVersion(target) ? { type: 'pinned', pinnedSessionIds: ids(value.pins) } : undefined
  if (value.type === 'baseline' && value.value?.workspaceState === true) return { ...value, value: browserWorkspaceWire(value.value, target) }
  if (value.workspaceState !== true) return value
  const { pins, workspaceState: _workspaceState, ...result } = value
  return isWebRuntimeVersion(target) ? { ...result, pinnedSessionIds: ids(pins) } : result
}
export function workspaceIdentityReferences(endpoint, request) {
  if (endpoint === 'officeToPdf/generation') {
    if (!record(request) || Object.keys(request).length) invalid('Invalid Office generation request')
    return []
  }
  if (WORKSPACE_FILE_ENDPOINTS.includes(endpoint) || endpoint === 'officeToPdf/render') {
    const fields = endpoint === 'officeToPdf/render' ? ['workspaceFileScopeId', 'path', 'priority'] : endpoint === 'workspaceFiles/read' ? ['workspaceFileScopeId', 'path', 'range'] : endpoint === 'workspaceFiles/readBytes' ? ['workspaceFileScopeId', 'path', 'options'] : ['workspaceFileScopeId', 'path']
    if (!record(request) || Object.keys(request).some(key => !fields.includes(key)) || typeof request.workspaceFileScopeId !== 'string' || !request.workspaceFileScopeId || request.workspaceFileScopeId.includes('\0') || typeof request.path !== 'string') invalid('Invalid workspace file scope request')
    if (endpoint === 'officeToPdf/render' && !['foreground', 'background'].includes(request.priority)) invalid('Invalid Office render priority')
    // 官方lookup的wire字段承载SessionId，不是workspaceId或文件路径。
    return [{ value: request.workspaceFileScopeId, path: 'args.workspaceFileScopeId' }]
  }
  if (!endpoint.startsWith('workspace/') || !record(request)) return []
  return ['workspaceId', 'beforeWorkspaceId', 'sessionId', 'beforeSessionId'].flatMap(key => {
    const value = request[key]
    if (value !== undefined && (typeof value !== 'string' || !value)) invalid('Invalid workspace request identity')
    return value === undefined ? [] : [{ value, path: `args.request.${key}` }]
  })
}
export function mapWorkspaceRequest(endpoint, request, hostId, codec) {
  const result = { ...request }
  for (const { value, path } of workspaceIdentityReferences(endpoint, request)) {
    if (!value.startsWith('rh1.')) continue
    const decoded = codec.decodeCompositeId(value)
    if (decoded.hostId !== hostId) invalid('Workspace request crosses host identity')
    result[path.split('.').at(-1)] = decoded.rawId
  }
  return result
}
function scopeView(value, hostId, codec) {
  if (!record(value)) return value
  const result = { ...value }
  if (typeof result.workspaceId === 'string') result.workspaceId = codec.encodeCompositeId(hostId, result.workspaceId)
  if (result.sessionIds !== undefined) result.sessionIds = ids(result.sessionIds).map(id => codec.encodeCompositeId(hostId, id))
  return result
}
export function scopeWorkspaceValue(value, hostId, codec) {
  if (!record(value)) return value
  const result = { ...value }
  if (record(result.workspace)) result.workspace = scopeView(result.workspace, hostId, codec)
  for (const key of ['workspaceIds', 'archivedSessionIds', 'pins']) if (result[key] !== undefined) result[key] = ids(result[key]).map(id => codec.encodeCompositeId(hostId, id))
  return result
}
export function scopeWorkspaceFrame(frame, hostId, codec) {
  if (!record(frame)) return frame
  if (frame.type === 'baseline') return { ...frame, value: { ...scopeWorkspaceValue(frame.value, hostId, codec), items: frame.value.items.map(item => scopeView(item, hostId, codec)) } }
  if (frame.type === 'upsert') return { ...frame, workspace: scopeView(frame.workspace, hostId, codec) }
  if (frame.type === 'remove') return { ...frame, workspaceId: codec.encodeCompositeId(hostId, frame.workspaceId) }
  return scopeWorkspaceValue(frame, hostId, codec)
}

/** Only the existing native binary invocation is relayed; its response stays opaque. */
export function workspaceFileBytesRequest(message, hostId, codec, version) {
  assertWorkspaceCapability(message?.method, version)
  if (!record(message) || message.type !== 'client-request' || !WORKSPACE_BINARY_ENDPOINTS.includes(message.method) || typeof message.rpcId !== 'string' || !message.rpcId) invalid('Invalid workspace file binary envelope')
  return { type: message.type, rpcId: message.rpcId, method: message.method,
    payload: { args: mapWorkspaceRequest(message.method, message.payload?.args, hostId, codec) } }
}
