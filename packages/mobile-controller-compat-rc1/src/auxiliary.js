/**
 * Small compatibility surface for Android operations which are not owned by
 * the session/workspace controller.  The dispatcher consumes a plain facade,
 * so the host bridge can pass only `sessionController`, `commands`, and
 * `goals` from the current Cordis context; this module does not add a Cordis
 * service or import the main bridge.
 *
 */

export const MOBILE_AUXILIARY_COMPAT_METHODS = Object.freeze([
  'commands/execute',
  'goal.create',
  'goal.pause',
  'goal.resume',
  'goal.clear',
])

/** Dispatch one of the Android auxiliary RPCs through official public faces. */
export async function dispatchAuxiliary(ctx, method, payload, signal) {
  if (!MOBILE_AUXILIARY_COMPAT_METHODS.includes(method)) {
    throw new CapabilityUnavailableError(`${method} is not implemented by this bridge`)
  }
  throwIfAborted(signal)
  switch (method) {
    case 'commands/execute':
      return executeCommand(ctx, payload, signal)
    case 'goal.create':
      return createGoal(ctx, payload)
    case 'goal.pause':
      return mutateGoal(ctx, 'pause', payload)
    case 'goal.resume':
      return mutateGoal(ctx, 'resume', payload)
    case 'goal.clear':
      return clearGoal(ctx, payload)
  }
}

async function executeCommand(ctx, payload, signal) {
  const request = commandRequest(payload)
  const agent = await resolveAgent(ctx, request.agentId)
  const commands = ctx?.commands
  assertService(commands, 'commands', ['execute'])
  return unwrap(await commands.execute(agent, request.line, request.images, signal))
}

async function createGoal(ctx, payload) {
  expectObject(payload)
  const sessionId = requireSessionId(payload.sessionId)
  const objective = requireString(payload.objective, 'objective').trim()
  if (objective.length === 0) throw new BadRequestError('objective must not be blank')
  const maxGoalRounds = optionalPositiveInteger(payload.maxGoalRounds, 'maxGoalRounds')
  const goals = ctx?.goals
  assertService(goals, 'goals', ['remoteExportCreate'])
  const agent = await resolveAgent(ctx, sessionId)
  const value = unwrap(await goals.remoteExportCreate(agent, {
    objective,
    ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
  }))
  return requireGoalRefResult(value, 'goal create result')
}

async function mutateGoal(ctx, operation, payload) {
  expectObject(payload)
  const sessionId = requireSessionId(payload.sessionId)
  const ref = normalizeGoalRef(payload.ref)
  const goals = ctx?.goals
  assertService(goals, 'goals', [operation])
  const agent = await resolveAgent(ctx, sessionId)
  const value = unwrap(await goals[operation](agent, ref))
  return requireGoalViewResult(value, `goal ${operation} result`)
}

async function clearGoal(ctx, payload) {
  expectObject(payload)
  const sessionId = requireSessionId(payload.sessionId)
  const ref = normalizeGoalRef(payload.ref)
  const goals = ctx?.goals
  assertService(goals, 'goals', ['clear'])
  const agent = await resolveAgent(ctx, sessionId)
  unwrap(await goals.clear(agent, ref))
  return { cleared: true }
}

function commandRequest(payload) {
  expectObject(payload)
  // The Android client keeps the legacy command arguments under `args`.
  // Accepting the direct shape as well makes the bridge usable by an already
  // normalized caller without changing the wire contract.
  const args = payload.args === undefined ? payload : expectObject(payload.args, 'args')
  return {
    agentId: requireSessionId(args.agentId, 'agentId'),
    line: normalizeCommandLine(args.line),
    images: normalizeImages(args.images ?? []),
  }
}

async function resolveAgent(ctx, sessionId) {
  const controller = ctx?.sessionController
  assertService(controller, 'sessionController', ['resolveAgent'])
  const resolved = unwrap(await controller.resolveAgent(sessionId))
  if (resolved && typeof resolved === 'object' && resolved.agent !== undefined) return resolved.agent
  if (!resolved || typeof resolved !== 'object') throw new CapabilityUnavailableError('session Agent is unavailable')
  return resolved
}

function normalizeCommandLine(value) {
  const line = requireString(value, 'line')
  if (!line.startsWith('/') || line.includes('\n') || line.includes('\r')) {
    throw new BadRequestError('line must be one slash-prefixed line')
  }
  return line
}

function normalizeImages(value) {
  if (!Array.isArray(value)) throw new BadRequestError('images must be an array')
  return value.map((image, index) => {
    expectObject(image, `images[${index}]`)
    const mediaType = requireString(image.mediaType, `images[${index}].mediaType`)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
      throw new BadRequestError(`images[${index}].mediaType is unsupported`)
    }
    return optionalFields({
      mediaType,
      data: requireString(image.data, `images[${index}].data`),
      name: optionalString(image.name, `images[${index}].name`),
    })
  })
}

function normalizeGoalRef(value) {
  expectObject(value, 'ref')
  return {
    id: requireString(value.id, 'ref.id'),
    revision: normalizeSafeInteger(value.revision, 'ref.revision', 0),
  }
}

function requireGoalRefResult(value, name) {
  if (!value || typeof value !== 'object' || !value.ref) throw new AuxiliaryMappingError(`${name} is malformed`)
  return { ref: normalizeGoalRef(value.ref) }
}

function requireGoalViewResult(value, name) {
  if (!value || typeof value !== 'object') throw new AuxiliaryMappingError(`${name} is malformed`)
  return { ref: {
    id: requireString(value.id, `${name}.id`),
    revision: normalizeSafeInteger(value.revision, `${name}.revision`, 0),
  } }
}

function requireSessionId(value, name = 'sessionId') {
  const id = requireString(value, name)
  if (id.startsWith('rh1.')) throw new BadRequestError(`${name} must be a local Session id`)
  return id
}

function assertService(service, name, methods) {
  if (!service || methods.some(method => typeof service[method] !== 'function')) {
    throw new CapabilityUnavailableError(`${name} is unavailable`)
  }
}

function expectObject(value, name = 'payload') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError(`${name} must be an object`)
  }
  return value
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 * 1024 * 1024 || value.includes('\u0000')) {
    throw new BadRequestError(`${name} must be a bounded string`)
  }
  return value
}

function optionalString(value, name) {
  return value === undefined ? undefined : requireString(value, name)
}

function optionalPositiveInteger(value, name) {
  return value === undefined ? undefined : normalizeSafeInteger(value, name, 1)
}

function normalizeSafeInteger(value, name, min) {
  if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) {
    throw new BadRequestError(`${name} must be a safe integer >= ${String(min)}`)
  }
  return value
}

function optionalFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean' && Object.hasOwn(value, 'value')) {
    if (!value.ok) throw value.error ?? new Error('controller returned a failed result')
    return value.value
  }
  if (value && typeof value === 'object' && value.result && typeof value.result.ok === 'boolean') {
    if (!value.result.ok) throw value.result.error ?? new Error('controller returned a failed result')
    return value.result.value
  }
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('operation aborted')
}

export class CapabilityUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CapabilityUnavailableError'
    this.code = 'gateway/capability-unavailable'
  }
}

export class AuxiliaryMappingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuxiliaryMappingError'
    this.code = 'gateway/internal'
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
    this.code = 'gateway/bad-request'
  }
}
