// Public change history: docs/PUBLIC-CHANGES.md
const SHARE_PRESET_ID = 'dsh-session-share:restricted-v1'
const SHARE_PRESET_PLUGIN = 'dsh-runtime-interface/session-share-agent'
const SESSION_SHARE_AGENT_POLICY_SERVICE = 'sessionShareAgentPolicy'
const SHARE_VISITOR_MESSAGE_KIND = 'dsh-session-share-visitor'
const MAX_SESSION_ID = 512
const MAX_MESSAGE_ID = 256
const SHARE_PRESET_PORTS = new WeakMap()

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function boundedString(value, label, max = MAX_SESSION_ID) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new TypeError(`${label} is invalid`)
  return value
}
function safeString(value) { return typeof value === 'string' ? value.slice(0, 4096) : '' }
function requiredService(ctx, name) {
  const value = typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
  if (value === undefined || value === null) throw Object.assign(new Error(`official capability unavailable: ${name}`), { code: 'SHARE_CAPABILITY_UNAVAILABLE' })
  return value
}
function modelSelection(value) {
  if (!record(value) || typeof value.provider !== 'string' || value.provider.length === 0
    || typeof value.model !== 'string' || value.model.length === 0) return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  }
}
function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim().slice(0, 32 * 1024)
}
function modelFromEvents(events, liveAgent, selectionProjection) {
  const projected = record(selectionProjection)
    ? modelSelection(selectionProjection.next) ?? modelSelection(selectionProjection.lastUsed)
    : undefined
  if (projected !== undefined) return projected
  let fallback = modelSelection(liveAgent?.options)
  for (const event of events) {
    if (!record(event) || event.type !== 'request/header' || !record(event.data)) continue
    const data = event.data
    const config = record(data.header?.config) ? data.header.config : data.config
    const historical = modelSelection(config)
    if (historical !== undefined) fallback = historical
  }
  return fallback
}
function projectionValue(baseline, name) {
  const values = record(baseline?.values) ? baseline.values : undefined
  return values?.[name]
}
function projectSessionEvent(sessionId, event) {
  if (!record(event) || typeof event.type !== 'string') return undefined
  const data = record(event.data) ? event.data : {}
  if (event.type === 'user/message') {
    const messageSource = record(data.source) ? data.source : {}
    const content = Array.isArray(data.content) ? data.content : []
    return Object.freeze({
      type: 'user-message', sessionId,
      ...(typeof data.id === 'string' ? { messageId: data.id } : {}),
      sourceKind: typeof messageSource.kind === 'string' ? messageSource.kind : '',
      ...(typeof messageSource.plugin === 'string' ? { sourcePlugin: messageSource.plugin } : {}),
      ...(typeof messageSource.form === 'string' ? { sourceForm: messageSource.form } : {}),
      text: textFromContent(content),
    })
  }
  if (event.type === 'turn/start') return Object.freeze({ type: 'turn-start', sessionId })
  if (event.type === 'tool/call') return Object.freeze({
    type: 'tool-start', sessionId,
    ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
  })
  if (event.type === 'tool/result') {
    const message = record(data.message) ? data.message : {}
    const source = record(message.source) ? message.source : {}
    const content = Array.isArray(message.content) ? message.content : []
    return Object.freeze({
      type: 'tool-finish', sessionId,
      ...(typeof source.callId === 'string' ? { callId: source.callId } : {}),
      failed: content.some(block => record(block) && block.isError === true),
    })
  }
  if (event.type === 'assistant/message') {
    const message = record(data.message) ? data.message : {}
    return Object.freeze({
      type: 'assistant-message', sessionId,
      ...(Number.isSafeInteger(data.turn) ? { turn: data.turn } : {}),
      text: textFromContent(message.content),
    })
  }
  if (event.type === 'turn/end') return Object.freeze({
    type: 'turn-end', sessionId, ...(Number.isSafeInteger(data.turn) ? { turn: data.turn } : {}),
  })
  return undefined
}
function projectQuestionFrame(frame) {
  if (!record(frame) || frame.type !== 'server-request' || typeof frame.method !== 'string' || !record(frame.payload)) return undefined
  const payload = frame.payload
  if (frame.method === 'question/requested') {
    if (typeof frame.rpcId !== 'string' || !Array.isArray(payload.questions) || typeof payload.sessionId !== 'string') return undefined
    const questions = payload.questions.flatMap(question => {
      if (!record(question) || typeof question.id !== 'string' || typeof question.question !== 'string') return []
      const options = Array.isArray(question.options)
        ? Object.freeze(question.options.flatMap(option => {
          if (!record(option) || typeof option.label !== 'string') return []
          return [Object.freeze({
            label: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
          })]
        }))
        : undefined
      return [Object.freeze({
        id: question.id,
        question: question.question,
        ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
        ...(typeof question.header === 'string' ? { header: question.header } : {}),
        ...(options === undefined ? {} : { options }),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      })]
    })
    return Object.freeze({ type: 'question-requested', sessionId: payload.sessionId, rpcId: frame.rpcId, questions: Object.freeze(questions) })
  }
  if (frame.method === 'question/resolved') {
    if (typeof payload.questionRpcId !== 'string') return undefined
    return Object.freeze({
      type: 'question-resolved', rpcId: payload.questionRpcId,
      outcome: typeof payload.outcome === 'string' ? payload.outcome : 'cancelled',
    })
  }
  return undefined
}
const AGENT_RESOLUTION_FAILURES = Object.freeze({
  'session/not-found': Object.freeze({ reason: 'session/not-found', status: 404, message: 'share branch session was not found' }),
  'session/agent-busy': Object.freeze({ reason: 'session/agent-busy', status: 409, message: 'share branch Agent is busy' }),
  'session/writer-held': Object.freeze({ reason: 'session/writer-held', status: 409, message: 'share branch session is already in use' }),
  'gateway/internal': Object.freeze({ reason: 'gateway/internal', status: 500, message: 'share branch Agent could not be restored' }),
})
function mapAgentResolutionError(value) {
  const failure = record(value) && typeof value.code === 'string'
    ? AGENT_RESOLUTION_FAILURES[value.code]
    : undefined
  const stable = failure ?? Object.freeze({ reason: 'unknown', status: 500, message: 'share branch Agent could not be restored' })
  return Object.assign(new Error(stable.message), {
    code: 'SHARE_AGENT_RESOLUTION_FAILED',
    source: 'session-controller',
    reason: stable.reason,
    status: stable.status,
  })
}
function policySnapshot(value) {
  if (!record(value) || value.state !== 'ACTIVE') return undefined
  const branchSessionId = boundedString(value.branchSessionId, 'branchSessionId')
  const workspaceRoot = boundedString(value.workspaceRoot, 'workspaceRoot', 4096)
  const provider = boundedString(value.provider, 'provider', 256)
  const model = boundedString(value.model, 'model', 512)
  if (typeof value.isAuthorizedVisitorMessage !== 'function' || typeof value.normalizeImage !== 'function') return undefined
  return Object.freeze({
    state: 'ACTIVE',
    branchSessionId, workspaceRoot, provider, model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
    isAuthorizedVisitorMessage: value.isAuthorizedVisitorMessage,
    normalizeImage: value.normalizeImage,
  })
}

/**
 * Create the stable boundary for the frozen 0.1.3 share plugin. Only plain
 * share values and bounded callbacks cross this object; official contexts,
 * Agents, controller responses, events, tools, and attachment references stay
 * inside this module.
 */
export function createSessionShareInterface(ctx, sharedState, managed = false) {
  const shared = sharedState ?? { installations: new Set(), presetReady: undefined, presetDisposer: undefined }
  const branchHandles = new Map()
  const pendingPolicies = new Map()
  const removalBeforePublish = new Map()
  let businessBinding
  let questionAbort
  let questionTask
  let activationDisposer
  let disposePromise
  const ownedDisposers = new Set()
  const sourceSnapshots = new Map()

  const controller = () => requiredService(ctx, 'sessionController')
  const agents = () => requiredService(ctx, 'agents')
  const composeRestrictedPreset = async presetId => {
    const registry = requiredService(ctx, 'agentPresets')
    if (typeof registry.resolve !== 'function' || typeof registry.mount !== 'function'
      || typeof registry.composedPreset !== 'function' || typeof registry.serviceFor !== 'function') {
      throw Object.assign(new Error('official agent-preset composition is unavailable'), { code: 'SHARE_PRESET_COMPOSITION_UNAVAILABLE' })
    }
    const preset = await registry.resolve(presetId)
    if (!record(preset) || preset.id !== presetId || typeof preset.broken === 'string') {
      throw Object.assign(new Error('official restricted agent preset is unavailable'), { code: 'SHARE_PRESET_UNAVAILABLE' })
    }
    return Object.freeze({
      agentPreset: presetId,
      setup: async (agentCtx, agent) => {
        const mounted = await registry.mount(agentCtx, presetId)
        if (!record(mounted) || mounted.id !== presetId) throw new Error('official restricted agent preset did not mount')
        if (registry.composedPreset(agentCtx) !== presetId) throw new Error('official restricted agent preset was not bound to the Agent scope')
        const policyService = registry.serviceFor(agent, SESSION_SHARE_AGENT_POLICY_SERVICE)
        if (!record(policyService) || typeof policyService.verifyAgent !== 'function') throw new Error('restricted agent policy service is unavailable')
        await policyService.verifyAgent(String(agent?.id ?? ''))
      },
    })
  }
  const resolveOrdinaryAgent = async sessionId => {
    const sessionController = controller()
    let result
    try { result = await sessionController.resolveAgent(sessionId) }
    catch (error) { throw mapAgentResolutionError(error) }
    if (!record(result)) throw new Error('official session controller returned a malformed Agent resolution')
    if (record(result.error)) throw mapAgentResolutionError(result.error)
    if (!record(result.agent) || String(result.agent.id) !== sessionId) {
      throw new Error('official session controller did not publish the requested Agent')
    }
    return result.agent
  }
  const closeHandle = async (map, id) => {
    const handle = map.get(id)
    if (handle === undefined) return
    map.delete(id)
    await handle.dispose()
  }

  const resolvePolicyForAgent = async rawBranchSessionId => {
    const branchSessionId = boundedString(rawBranchSessionId, 'branchSessionId')
    for (const installation of shared.installations) {
      const pending = installation.pendingPolicies.get(branchSessionId)
      if (pending !== undefined) return policySnapshot(pending)
      const policy = policySnapshot(await installation.resolvePolicy(branchSessionId))
      if (policy?.branchSessionId === branchSessionId) return policy
    }
    return undefined
  }
  const resolvePolicyForAgentSync = rawBranchSessionId => {
    let branchSessionId
    try { branchSessionId = boundedString(rawBranchSessionId, 'branchSessionId') } catch { return undefined }
    for (const installation of shared.installations) {
      const pending = installation.pendingPolicies.get(branchSessionId)
      if (pending !== undefined) return policySnapshot(pending)
      try {
        const value = installation.resolvePolicy(branchSessionId)
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') return undefined
        const policy = policySnapshot(value)
        if (policy?.branchSessionId === branchSessionId) return policy
      } catch { return undefined }
    }
    return undefined
  }

  const internal = {
    async installAgentPolicy(presetCtx) {
      const { installRestrictedShareTools } = await import('../lib/session-share/session-share-safe-tools.mjs')
      installRestrictedShareTools(presetCtx, {
        resolvePolicy: resolvePolicyForAgent,
        resolvePolicySync: resolvePolicyForAgentSync,
      })
      presetCtx.on('agent/pre-step', async ({ agent, messages }, next) => {
        const id = boundedString(agent?.id, 'agent.id')
        const policy = await resolvePolicyForAgent(id)
        if (policy === undefined) throw new Error('share branch has no active restricted policy')
        const deniedIds = new Set()
        for (const message of messages) {
          if (message?.source?.kind !== SHARE_VISITOR_MESSAGE_KIND) continue
          try {
            if (!policy.isAuthorizedVisitorMessage(String(message.id))) deniedIds.add(String(message.id))
          } catch { deniedIds.add(String(message.id)) }
        }
        let removeMessageIds
        for (const installation of shared.installations) {
          removeMessageIds = installation.removalBeforePublish.get(id)
          if (removeMessageIds !== undefined) break
        }
        const removeIds = new Set(removeMessageIds ?? [])
        for (const message of messages) if (removeIds.has(String(message.id))) deniedIds.add(String(message.id))
        if (deniedIds.size === 0) return next()
        const decision = await next()
        if (decision.kind === 'reject') return decision
        return { ...decision, messages: decision.messages.filter(message => !deniedIds.has(String(message.id))) }
      })
      presetCtx.on('agent/request', async ({ agent }, next) => {
        const id = boundedString(agent?.id, 'agent.id')
        const policy = await resolvePolicyForAgent(id)
        if (policy === undefined) throw new Error('share branch has no active restricted policy')
        const base = await next()
        return {
          ...base,
          provider: policy.provider,
          model: policy.model,
          ...(policy.reasoningEffort === undefined ? {} : { reasoningEffort: policy.reasoningEffort }),
        }
      })
      presetCtx.provide(SESSION_SHARE_AGENT_POLICY_SERVICE, Object.freeze({
        async verifyAgent(id) {
          const policy = await resolvePolicyForAgent(id)
          if (policy === undefined) throw new Error('share branch has no active restricted policy')
          const workspace = await import('../lib/session-share/session-share-path-policy.mjs')
          workspace.WorkspacePathPolicy.createSync(policy.workspaceRoot)
          return true
        },
      }))
    },
  }

  const api = Object.freeze({
    presetId: SHARE_PRESET_ID,
    createInstallation() {
      if (managed) throw new Error('only the runtime interface root can create a session-share installation')
      return createSessionShareInterface(ctx, shared, true)
    },
    async ready() {
      if (shared.presetReady !== undefined) return await shared.presetReady
      const registry = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : ctx?.agentPresets
      if (registry === undefined || registry === null || typeof registry.register !== 'function') return false
      shared.presetReady = (async () => {
        shared.presetDisposer = await registry.register({
          id: SHARE_PRESET_ID,
          name: 'Session Share Restricted',
          description: 'Protected policy for a single-visitor shared session branch.',
          order: -100000,
          plugins: [{
            id: 'share-policy', name: SHARE_PRESET_PLUGIN,
            isolate: { [SESSION_SHARE_AGENT_POLICY_SERVICE]: true },
          }],
        })
        return true
      })()
      return await shared.presetReady
    },
    async activate(binding) {
      await api.ready()
      if (!record(binding) || typeof binding.resolvePolicy !== 'function' || typeof binding.onSessionEvent !== 'function'
        || typeof binding.onQuestionEvent !== 'function' || typeof binding.onQuestionError !== 'function') {
        throw new TypeError('session-share stable callbacks are required')
      }
      if (businessBinding !== undefined) throw new Error('session-share interface is already active')
      const mobileEvents = requiredService(ctx, 'mobileSessionEvents')
      businessBinding = binding
      const unsubscribe = ctx.on('session/event', (session, event) => {
        const projected = projectSessionEvent(String(session.id), event)
        if (projected !== undefined) businessBinding?.onSessionEvent(projected)
      })
      questionAbort = new AbortController()
      questionTask = (async () => {
        try {
          const stream = mobileEvents.subscribe({ signal: questionAbort.signal })
          for await (const frame of stream) {
            if (questionAbort.signal.aborted) break
            const projected = projectQuestionFrame(frame)
            if (projected !== undefined) businessBinding?.onQuestionEvent(projected)
          }
        } catch (error) {
          if (!questionAbort?.signal.aborted) businessBinding?.onQuestionError(error instanceof Error ? error.name : typeof error)
        }
      })()
      let disposed = false
      const dispose = async () => {
        if (disposed) return
        disposed = true
        if (businessBinding !== binding) return
        businessBinding = undefined
        questionAbort?.abort()
        if (typeof unsubscribe === 'function') unsubscribe()
        await questionTask?.catch(() => {})
        questionAbort = undefined
        questionTask = undefined
      }
      activationDisposer = dispose
      return dispose
    },
    registerOwnerRoute(handler) {
      if (typeof handler !== 'function') throw new TypeError('owner route handler is required')
      const webServer = requiredService(ctx, 'webServer')
      if (typeof webServer.register !== 'function') throw new Error('official web route registration is unavailable')
      const remove = webServer.register({ kind: 'prefix', path: '/api/session-share/v1', handler: async (request, response) => {
        let body
        try {
          const chunks = []
          let size = 0
          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += bytes.length
            if (size > 64 * 1024) throw Object.assign(new Error('request body too large'), { status: 413 })
            chunks.push(bytes)
          }
          if (chunks.length > 0) {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!record(body)) throw new Error('JSON object required')
          }
        } catch (error) {
          const status = Number(error?.status)
          const value = { status: status >= 400 && status <= 599 ? status : 400, body: { error: error instanceof Error ? error.message : 'invalid request' } }
          return sendOwnerResponse(response, value)
        }
        let result
        try {
          result = await handler(Object.freeze({
            method: typeof request.method === 'string' ? request.method : 'GET',
            path: typeof request.url === 'string' ? request.url : '/',
            remoteAddress: typeof request.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : undefined,
            host: typeof request.headers?.host === 'string' ? request.headers.host : undefined,
            body,
          }))
        } catch (error) {
          result = { status: 500, body: { error: error instanceof Error ? error.message : 'request failed' } }
        }
        return sendOwnerResponse(response, result)
      } })
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        ownedDisposers.delete(dispose)
        remove()
      }
      ownedDisposers.add(dispose)
      return dispose
    },
    async listenPublicHttps(options) {
      if (!record(options) || typeof options.handler !== 'function') throw new TypeError('public HTTPS handler is required')
      const { listenSessionShareHttps } = await import('./session-share-http.js')
      const remove = await listenSessionShareHttps(options)
      let disposed = false
      const dispose = async () => {
        if (disposed) return
        disposed = true
        ownedDisposers.delete(dispose)
        await remove()
      }
      ownedDisposers.add(dispose)
      return dispose
    },
    async inspectSource(rawSessionId) {
      const sessionId = boundedString(rawSessionId, 'sessionId')
      const abort = new AbortController().signal
      const summaryValue = await controller().list({}, abort)
      const rows = Array.isArray(summaryValue?.items) ? summaryValue.items : []
      const summary = rows.find(row => record(row) && String(row.sessionId) === sessionId)
      if (summary === undefined) throw Object.assign(new Error('source session was not found'), { code: 'SESSION_NOT_FOUND' })
      if (summary.running === true) throw Object.assign(new Error('cannot share a session while a turn is running'), { code: 'SESSION_RUNNING' })
      const inspected = await controller().inspect(sessionId, abort)
      if (!record(inspected?.meta) || !Array.isArray(inspected.events)) throw new Error('session inspection returned a malformed result')
      const liveAgent = agents().get?.(sessionId)
      if (liveAgent?.status === 'running') throw Object.assign(new Error('cannot share a session while a turn is running'), { code: 'SESSION_RUNNING' })
      let sourceAnchorSeq
      for (const event of inspected.events) if (record(event) && event.type === 'turn/end' && Number.isSafeInteger(event.seq)) sourceAnchorSeq = event.seq
      if (!Number.isSafeInteger(sourceAnchorSeq)) throw Object.assign(new Error('source session has no completed turn to share'), { code: 'SESSION_NO_COMPLETED_TURN' })
      const projection = await controller().projections({ sessionId }, abort)
      const model = modelFromEvents(inspected.events, liveAgent, projectionValue(projection, 'modelSelection'))
      if (model === undefined) throw Object.assign(new Error('source session has no selected model'), { code: 'SESSION_MODEL_UNAVAILABLE' })
      const modelInfo = await requiredService(ctx, 'llm').resolveModelInfo(model.provider, model.model)
      const availableModels = await controller().modelCatalog()
      const routable = Array.isArray(availableModels?.groups) && availableModels.groups.some(group => group?.id === model.provider
        && Array.isArray(group.models) && group.models.some(candidate => candidate?.id === model.model))
      if (!routable) throw Object.assign(new Error('the selected source model is not currently routable'), { code: 'SESSION_MODEL_UNAVAILABLE' })
      const attachmentLimits = requiredService(ctx, 'attachments').imageLimits
      const imageLimits = {}
      const caps = { maxImages: 4, maxImageBytes: 8 * 1024 * 1024, maxMessageBytes: 20 * 1024 * 1024, maxPixels: 40_000_000, maxDimension: 65_535 }
      for (const [target, source] of Object.entries({
        maxImages: 'maxImagesPerMessage', maxImageBytes: 'maxImageBytes', maxMessageBytes: 'maxMessageImageBytes',
        maxPixels: 'maxImagePixels', maxDimension: 'maxImageDimension',
      })) imageLimits[target] = Math.min(caps[target], attachmentLimits[source])
      const result = Object.freeze({
        sessionId,
        workspaceRoot: boundedString(inspected.meta.cwd, 'cwd', 4096),
        sourceAnchorSeq,
        title: typeof projectionValue(projection, 'title') === 'string' ? projectionValue(projection, 'title') : undefined,
        ...model,
        modelAcceptsImages: Array.isArray(modelInfo?.inputModalities) && modelInfo.inputModalities.includes('image'),
        imageLimits: Object.freeze(imageLimits),
      })
      sourceSnapshots.delete(sessionId)
      sourceSnapshots.set(sessionId, { snapshot: result, meta: inspected.meta, events: inspected.events })
      while (sourceSnapshots.size > 8) sourceSnapshots.delete(sourceSnapshots.keys().next().value)
      return result
    },
    async isProtectedShareBranch(rawSessionId) {
      const sessionId = boundedString(rawSessionId, 'sessionId')
      const inspected = await controller().inspect(sessionId, new AbortController().signal)
      return inspected?.meta?.agentPreset === SHARE_PRESET_ID
    },
    async createRestrictedBranch(input) {
      if (!await api.ready()) throw Object.assign(new Error('official agent-preset registration is unavailable'), { code: 'SHARE_PRESET_REGISTRY_UNAVAILABLE' })
      const sourceSessionId = boundedString(input?.sourceSessionId, 'sourceSessionId')
      const branchSessionId = boundedString(input?.branchSessionId, 'branchSessionId')
      const title = boundedString(input?.title, 'title', 512)
      const snapshot = await api.inspectSource(sourceSessionId)
      if (snapshot.sourceAnchorSeq !== input.sourceAnchorSeq) throw Object.assign(new Error('source history changed while the share was prepared'), { code: 'SESSION_HISTORY_CHANGED' })
      const source = sourceSnapshots.get(sourceSessionId)
      sourceSnapshots.delete(sourceSessionId)
      const inspected = source && source.snapshot.sourceAnchorSeq === input.sourceAnchorSeq
        ? { meta: source.meta, events: source.events }
        : await controller().inspect(sourceSessionId, new AbortController().signal)
      const cut = snapshot.sourceAnchorSeq
      if (!Number.isSafeInteger(cut) || inspected.events[cut]?.seq !== cut || inspected.events[cut]?.type !== 'turn/end') {
        throw Object.assign(new Error('source session has no completed turn to share'), { code: 'SESSION_NO_COMPLETED_TURN' })
      }
      const { buildForkSeed } = await import('@deepseek-ai/dsh-session/fork')
      const seed = buildForkSeed(inspected.events, cut)
      const policy = policySnapshot({ ...input.policy, state: 'ACTIVE', branchSessionId })
      if (policy === undefined) throw new TypeError('restricted branch policy is invalid')
      pendingPolicies.set(branchSessionId, policy)
      let handle
      try {
        const composition = await composeRestrictedPreset(SHARE_PRESET_ID)
        handle = await agents().create({
          sessionId: branchSessionId,
          seed,
          inheritedEventCount: cut + 1,
          meta: {
            cwd: snapshot.workspaceRoot,
            parentSession: sourceSessionId,
            isSeeded: true,
            agentPreset: SHARE_PRESET_ID,
          },
          agentOptions: {
            provider: policy.provider,
            model: policy.model,
            ...(policy.reasoningEffort === undefined ? {} : { reasoningEffort: policy.reasoningEffort }),
          },
          setup: composition.setup,
        })
        branchHandles.set(branchSessionId, handle)
        await attachForkToWorkspace(ctx, inspected.meta, branchSessionId)
        await controller().rename({ sessionId: branchSessionId, title })
        return Object.freeze({ branchSessionId })
      } catch (error) {
        if (handle !== undefined) await handle.dispose().catch(() => {})
        throw error
      } finally {
        pendingPolicies.delete(branchSessionId)
      }
    },
    async discardRestrictedBranch(rawBranchSessionId) {
      const branchSessionId = boundedString(rawBranchSessionId, 'branchSessionId')
      await closeHandle(branchHandles, branchSessionId)
      pendingPolicies.delete(branchSessionId)
    },
    async ensureRestrictedBranch(input) {
      if (!await api.ready()) throw Object.assign(new Error('official agent-preset registration is unavailable'), { code: 'SHARE_PRESET_REGISTRY_UNAVAILABLE' })
      const branchSessionId = boundedString(input?.branchSessionId, 'branchSessionId')
      const inspected = await controller().inspect(branchSessionId, new AbortController().signal)
      if (inspected?.meta?.agentPreset !== SHARE_PRESET_ID) {
        throw Object.assign(new Error('share branch is incompatible with the current protected runtime; existing share data was preserved'), {
          status: 409, code: 'SHARE_BRANCH_INCOMPATIBLE',
        })
      }
      const resolved = await businessBinding?.resolvePolicy(branchSessionId)
      const policy = policySnapshot(resolved)
      if (policy === undefined) throw new Error('share branch policy is unavailable')
      const live = agents().get?.(branchSessionId)
      if (live !== undefined) return branchState(live)
      const removeIds = [...new Set((Array.isArray(input.removeMessageIds) ? input.removeMessageIds : []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_MESSAGE_ID))]
      if (removeIds.length > 0) removalBeforePublish.set(branchSessionId, removeIds)
      try {
        return branchState(await resolveOrdinaryAgent(branchSessionId))
      } finally {
        removalBeforePublish.delete(branchSessionId)
      }
    },
    async enqueueVisitorMessage(input) {
      const branchSessionId = boundedString(input?.branchSessionId, 'branchSessionId')
      const text = typeof input?.text === 'string' ? input.text : ''
      if (text.length === 0 || text.length > 32 * 1024) throw new TypeError('visitor message text is invalid')
      const branch = await api.ensureRestrictedBranch(input)
      const live = agents().get?.(branchSessionId) ?? branchHandles.get(branchSessionId)?.agent
      if (live === undefined) throw new Error('share branch agent is unavailable')
      const pending = live.inbox.nextTurn.length
      if (pending >= 8) throw Object.assign(new Error('shared queue is full'), { status: 429, code: 'SHARE_QUEUE_FULL' })
      const attachments = requiredService(ctx, 'attachments')
      const images = Array.isArray(input.images) ? input.images : []
      const refs = images.length === 0 ? [] : await attachments.saveImages(images.map(image => ({ data: image.bytes, mediaType: image.mediaType })))
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      const message = createUserMessage({ content: [{ type: 'text', text }, ...refs.map(attachment => ({ type: 'image', attachment }))], source: { kind: SHARE_VISITOR_MESSAGE_KIND } })
      const position = pending + (live.status === 'running' ? 2 : 1)
      const receipt = Object.freeze({ messageId: String(message.id), position, running: live.status === 'running' })
      await input.beforeDelivery(receipt)
      try {
        live.followup(message)
      } catch (error) {
        try { await input.onDeliveryFailure?.(receipt) } catch { /* the original delivery error stays authoritative */ }
        throw error
      }
      return receipt
    },
    async cancelAndRemoveGuestMessages(branchSessionIdValue, messageIdsValue, options = {}) {
      const branchSessionId = boundedString(branchSessionIdValue, 'branchSessionId')
      const messageIds = [...new Set((Array.isArray(messageIdsValue) ? messageIdsValue : []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_MESSAGE_ID))]
      let live = agents().get?.(branchSessionId) ?? branchHandles.get(branchSessionId)?.agent
      if (live === undefined && messageIds.length > 0) {
        if (options?.liveOnly === true) return Object.freeze({ live: false, removedCount: 0 })
        await api.ensureRestrictedBranch({ branchSessionId, removeMessageIds: messageIds })
        live = agents().get?.(branchSessionId) ?? branchHandles.get(branchSessionId)?.agent
      }
      if (live === undefined) return Object.freeze({ live: false, removedCount: 0 })
      if (live.status === 'running') live.cancel({ kind: 'hook', reason: 'share revoked' }, { keepInbox: true })
      let removedCount = 0
      for (const id of messageIds) if (live.inbox.remove(id)) removedCount++
      return Object.freeze({ live: true, removedCount })
    },
    async respondQuestion(branchSessionIdValue, rpcIdValue, answer) {
      const branchSessionId = boundedString(branchSessionIdValue, 'branchSessionId')
      await api.ensureRestrictedBranch({ branchSessionId })
      const rpcId = boundedString(rpcIdValue, 'rpcId', 256)
      if (!record(answer) || !Array.isArray(answer.answers)) return Object.freeze({ accepted: false })
      const service = requiredService(ctx, 'mobileInteractions')
      const result = await service.respond({ type: 'client-response', rpcId, result: { ok: true, value: { sessionId: branchSessionId, answer } } })
      return Object.freeze({ accepted: result?.accepted === true })
    },
    async dispose() {
      if (disposePromise !== undefined) return await disposePromise
      disposePromise = (async () => {
        const failures = []
        const attempt = async callback => {
          try { await callback?.() } catch (error) { failures.push(error) }
        }
        await attempt(activationDisposer)
        for (const dispose of [...ownedDisposers].reverse()) await attempt(dispose)
        questionAbort?.abort()
        await questionTask?.catch(error => failures.push(error))
        // Do not dispose AgentHandles here: official handle disposal removes the
        // persisted Session. Runtime teardown owns the live registry lifecycle.
        businessBinding = undefined
        pendingPolicies.clear()
        removalBeforePublish.clear()
        sourceSnapshots.clear()
        branchHandles.clear()
        if (managed) shared.installations.delete(installation)
        else {
          for (const instance of [...shared.installations]) await attempt(() => instance.api.dispose())
          shared.installations.clear()
          await attempt(shared.presetDisposer)
          shared.presetDisposer = undefined
          shared.presetReady = undefined
        }
        if (failures.length > 0) throw new AggregateError(failures, 'session-share interface disposal failed')
      })()
      return await disposePromise
    },
  })
  const installation = Object.freeze({
    api,
    pendingPolicies,
    removalBeforePublish,
    resolvePolicy: id => businessBinding?.resolvePolicy(id),
  })
  if (managed) shared.installations.add(installation)
  SHARE_PRESET_PORTS.set(api, internal)
  return api
}

function branchState(agent) {
  return Object.freeze({ status: agent.status, pending: agent.inbox.nextTurn.length })
}

function sendOwnerResponse(response, value) {
  const status = Number(value?.status)
  const body = value?.body
  const bytes = Buffer.from(JSON.stringify(body === undefined ? { error: 'invalid owner response' } : body))
  response.writeHead(status >= 100 && status <= 599 ? status : 500, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  })
  response.end(bytes)
}

async function attachForkToWorkspace(ctx, sourceHeader, childId) {
  const registry = ctx.get?.('workspaceRegistry')
  const workspaces = registry?.list?.()
  if (!Array.isArray(workspaces)) return
  let workspace = workspaces.find(candidate => Array.isArray(candidate.sessionIds) && candidate.sessionIds.some(id => String(id) === String(sourceHeader.id)))
  if (workspace === undefined && sourceHeader.origin === 'subagent') {
    const lineage = await ctx.sessionQuery.traceSession(sourceHeader.id)
    for (const ancestor of lineage.ancestors ?? []) {
      workspace = workspaces.find(candidate => Array.isArray(candidate.sessionIds) && candidate.sessionIds.some(id => String(id) === String(ancestor.header?.id)))
      if (workspace !== undefined) break
    }
  }
  if (workspace !== undefined) await workspace.attachSession(childId)
}

/** Internal preset entry. The share business package never receives an Agent context. */
export function installSessionShareAgentPreset(ctx) {
  const port = ctx?.get?.('sessionShareInterface')
  const internal = SHARE_PRESET_PORTS.get(port)
  if (internal === undefined) throw new Error('session-share interface is unavailable')
  return internal.installAgentPolicy(ctx)
}
