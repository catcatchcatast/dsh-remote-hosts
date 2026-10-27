// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
                                                                                                                                             
/**
 * Narrow operation boundary for Agent-owned official services.
 *
 * The Session controller and the Agent itself stay inside this module.  Callers
 * receive only operation DTOs; they never receive a resolved Agent, its context,
 * or an official service object.
 *
 *                                                                                                                                   
 *                                                                                                                                                       
 */

export const LEGACY_AGENT_OPERATIONS_VERSION = '0.1.2-rc.1'
export const CURRENT_AGENT_OPERATIONS_VERSION = '0.1.5-rc.2'

export const AGENT_OPERATION_METHODS = Object.freeze([
  'commands.execute',
  'goal.create',
  'goal.pause',
  'goal.resume',
  'goal.clear',
  'agentPresets.select',
])

const COMMAND_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/**
 * Bind official Agent-owned services to a context-free operation facade.
 *
 * `sessionController.resolveAgent()` is intentionally captured here.  It is
 * called only immediately before an operation and its result never crosses
 * this module's public return boundary.
 */
export function createAgentOperations({
  sessionController,
  commands,
  goals,
  agentPresets,
  upstreamVersion = LEGACY_AGENT_OPERATIONS_VERSION,
} = {}) {
  const version = normalizeVersion(upstreamVersion)

  const executeCommand = async (request, signal) => {
    assertService(commands, 'commands', ['execute'])
    const normalized = normalizeCommandRequest(request)
    const submitted = version !== LEGACY_AGENT_OPERATIONS_VERSION
      ? normalized.attachments
      : normalized.attachments.map(stripLegacyCommandAttachment)
    const agent = await resolveAgent(sessionController, normalized.sessionId)
    return unwrap(await commands.execute(agent, normalized.line, submitted, signal))
  }

  const createGoal = async request => {
    assertService(goals, 'goals', ['remoteExportCreate'])
    const normalized = normalizeGoalCreateRequest(request)
    const agent = await resolveAgent(sessionController, normalized.sessionId)
    return unwrap(await goals.remoteExportCreate(agent, normalized.request))
  }

  const pauseGoal = async request => mutateGoal(goals, sessionController, 'pause', request)
  const resumeGoal = async request => mutateGoal(goals, sessionController, 'resume', request)
  const clearGoal = async request => mutateGoal(goals, sessionController, 'clear', request)

  const selectAgentPreset = async request => {
    assertService(agentPresets, 'agentPresets', ['select'])
    const normalized = normalizePresetRequest(request)
    const agent = await resolveAgent(sessionController, normalized.sessionId)
    return unwrap(await agentPresets.select(agent, normalized.agentPreset))
  }

  const commandOperations = Object.freeze({ execute: executeCommand })
  const goalOperations = Object.freeze({
    create: createGoal,
    pause: pauseGoal,
    resume: resumeGoal,
    clear: clearGoal,
  })
  const presetOperations = Object.freeze({ select: selectAgentPreset })

  return Object.freeze({
    commands: commandOperations,
    goal: goalOperations,
    agentPresets: presetOperations,
  })
}

/** Compatibility alias for interface constructors that describe this as a bind. */
export const bindAgentOperations = createAgentOperations

async function mutateGoal(goals, sessionController, operation, request) {
  assertService(goals, 'goals', [operation])
  const normalized = normalizeGoalMutationRequest(request)
  const agent = await resolveAgent(sessionController, normalized.sessionId)
  return unwrap(await goals[operation](agent, normalized.ref))
}

async function resolveAgent(sessionController, sessionId) {
  assertService(sessionController, 'sessionController', ['resolveAgent'])
  const resolved = unwrap(await sessionController.resolveAgent(sessionId))
  if (resolved?.error !== undefined) throw resolved.error
  if (resolved && typeof resolved === 'object' && resolved.agent !== undefined) return resolved.agent
  if (resolved && typeof resolved === 'object') return resolved
  throw new AgentOperationError('runtime-interface/capability-unavailable', 'session Agent is unavailable')
}

function normalizeVersion(value) {
  if (value !== LEGACY_AGENT_OPERATIONS_VERSION && value !== CURRENT_AGENT_OPERATIONS_VERSION && value !== '0.2.0-rc.2' && value !== '0.2.1-rc.2') {
    throw new AgentOperationError('runtime-interface/unsupported-version', 'The upstream runtime version is not supported', { version: value })
  }
  return value
}

function normalizeCommandRequest(request) {
  const source = expectObject(request, 'command request')
  const sessionId = requireString(source.sessionId ?? source.agentId, 'sessionId')
  const line = requireString(source.line, 'line')
  const attachments = normalizeCommandAttachments(source)
  return Object.freeze({ sessionId, line, attachments })
}

function normalizeCommandAttachments(source) {
  const hasImages = Object.hasOwn(source, 'images')
  const hasSubmittedAttachments = Object.hasOwn(source, 'submittedAttachments')
  if (hasImages && hasSubmittedAttachments) {
    throw new AgentOperationError('runtime-interface/invalid-request', 'images and submittedAttachments are mutually exclusive')
  }
  const field = hasSubmittedAttachments ? 'submittedAttachments' : 'images'
  const value = source[field] ?? []
  if (!Array.isArray(value)) throw new AgentOperationError('runtime-interface/invalid-request', `${field} must be an array`)
  return Object.freeze(value.map((item, index) => normalizeCommandAttachment(item, `${field}[${index}]`)))
}

function normalizeCommandAttachment(value, name) {
  const attachment = expectObject(value, name)
  if (attachment.type === 'file') {
    return Object.freeze({ type: 'file', receiptId: requireString(attachment.receiptId, `${name}.receiptId`) })
  }
  if (attachment.type !== undefined && attachment.type !== 'image') {
    throw new AgentOperationError('runtime-interface/invalid-request', `${name}.type must be image or file`)
  }
  return Object.freeze({ type: 'image', ...normalizeImage(attachment, name) })
}

function stripLegacyCommandAttachment(attachment) {
  if (attachment.type === 'image') {
    const { type: _type, ...image } = attachment
    return image
  }
  throw new AgentOperationError('runtime-interface/unsupported-attachment', 'file command attachments require the current upstream runtime')
}

function normalizeGoalCreateRequest(request) {
  const source = expectObject(request, 'goal request')
  const sessionId = requireString(source.sessionId, 'sessionId')
  const objective = requireString(source.objective, 'objective')
  const maxGoalRounds = source.maxGoalRounds
  if (maxGoalRounds !== undefined && (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1 || Object.is(maxGoalRounds, -0))) {
    throw new AgentOperationError('runtime-interface/invalid-request', 'maxGoalRounds must be a positive safe integer')
  }
  return Object.freeze({
    sessionId,
    request: Object.freeze({ objective, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) }),
  })
}

function normalizeGoalMutationRequest(request) {
  const source = expectObject(request, 'goal request')
  const sessionId = requireString(source.sessionId, 'sessionId')
  const ref = expectObject(source.ref, 'ref')
  const id = requireString(ref.id, 'ref.id')
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 0 || Object.is(ref.revision, -0)) {
    throw new AgentOperationError('runtime-interface/invalid-request', 'ref.revision must be a non-negative safe integer')
  }
  return Object.freeze({ sessionId, ref: Object.freeze({ id, revision: ref.revision }) })
}

function normalizePresetRequest(request) {
  const source = expectObject(request, 'agent preset request')
  return Object.freeze({
    sessionId: requireString(source.sessionId, 'sessionId'),
    agentPreset: requireString(source.agentPreset, 'agentPreset'),
  })
}

function normalizeImage(value, name = 'image') {
  const image = expectObject(value, name)
  const mediaType = requireString(image.mediaType, `${name}.mediaType`)
  if (!COMMAND_IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new AgentOperationError('runtime-interface/invalid-request', `${name}.mediaType is unsupported`)
  }
  const data = requireString(image.data, `${name}.data`)
  const imageName = image.name === undefined ? undefined : requireString(image.name, `${name}.name`)
  return Object.freeze({ mediaType, data, ...(imageName === undefined ? {} : { name: imageName }) })
}

function assertService(service, name, methods) {
  if (!service || methods.some(method => typeof service[method] !== 'function')) {
    throw new AgentOperationError('runtime-interface/capability-unavailable', `${name} is unavailable`, { service: name, methods })
  }
}

function expectObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentOperationError('runtime-interface/invalid-request', `${name} must be an object`)
  }
  return value
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new AgentOperationError('runtime-interface/invalid-request', `${name} must be a non-empty string`)
  }
  return value
}

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
    if (!value.ok) throw value.error ?? new AgentOperationError('runtime-interface/operation-failed', 'official operation failed')
    return value.value
  }
  if (value && typeof value === 'object' && value.result && typeof value.result.ok === 'boolean') {
    if (!value.result.ok) throw value.result.error ?? new AgentOperationError('runtime-interface/operation-failed', 'official operation failed')
    return value.result.value
  }
  return value
}

export class AgentOperationError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'AgentOperationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}
