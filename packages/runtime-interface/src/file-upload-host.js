// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                                                                   
                                                                                                                                                   
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createResourceLease } from './resource-lease.js'

const MEBIBYTE = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const RECORD = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => RECORD(value) && Object.hasOwn(value, key)
const sessionIdValue = value => typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : undefined
const boundedString = (value, limit = 4096) => typeof value === 'string' && value.length <= limit && !value.includes('\0')

function unavailable(capability) {
  return Object.assign(new Error(`File upload capability is unavailable: ${capability}`), {
    code: 'FILE_UPLOAD_CAPABILITY_UNAVAILABLE',
  })
}

function requireService(service, capability) {
  if (!service) throw unavailable(capability)
  return service
}

function contextService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch {}
  return ctx?.[name]
}

function imageLimitsValue(value) {
  if (!RECORD(value)) return undefined
  const limits = {}
  for (const key of ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension']) {
    if (Number.isSafeInteger(value[key]) && value[key] > 0) limits[key] = value[key]
  }
  if (Array.isArray(value.mediaTypes) && value.mediaTypes.every(item => typeof item === 'string' && item.length <= 128)) {
    limits.mediaTypes = Object.freeze([...value.mediaTypes])
  }
  return Object.keys(limits).length === 0 ? undefined : Object.freeze(limits)
}

function receiptValue(value) {
  if (!RECORD(value) || !boundedString(value.receiptId, 512) || !RECORD(value.file) ||
    !boundedString(value.file.attachmentId, 512) || !boundedString(value.file.name, 1024) ||
    !Number.isSafeInteger(value.file.bytes) || value.file.bytes < 0) {
    throw unavailable('file upload receipt projection')
  }
  return Object.freeze({
    receiptId: value.receiptId,
    file: Object.freeze({ attachmentId: value.file.attachmentId, name: value.file.name, bytes: value.file.bytes }),
  })
}

function fileReferenceValue(value) {
  if (value === undefined) return undefined
  if (!RECORD(value) || !boundedString(value.attachmentId, 512) || !boundedString(value.name, 1024) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw unavailable('file attachment projection')
  }
  return Object.freeze({ attachmentId: value.attachmentId, name: value.name, bytes: value.bytes })
}

function sessionCwd(session) {
  const cwd = session?.header?.cwd
  return boundedString(cwd) ? cwd : undefined
}

function headerCwd(value) {
  const header = RECORD(value) && own(value, 'header') ? value.header : value
  const cwd = header?.cwd
  return boundedString(cwd) ? cwd : undefined
}

function versionValue(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === null) return null
  if (Array.isArray(value)) return Object.freeze(value.map(versionValue))
  if (RECORD(value)) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().filter(key => boundedString(key, 128)).map(key => [key, versionValue(value[key])])))
  }
  return undefined
}

function targetValue(target) {
  if (!RECORD(target) || !boundedString(target.displayPath) || target.targetKey === undefined) {
    throw unavailable('filesystem target projection')
  }
  return Object.freeze({ path: target.displayPath, identity: String(target.targetKey) })
}

function requestRejection(connection, request) {
  if (typeof connection?.requestRejection !== 'function') throw unavailable('connection authentication')
  return connection.requestRejection(request)
}

function withConnectionAuth(connection, handler) {
  if (typeof handler !== 'function') throw new TypeError('route handler is required')
  return async (request, response) => {
    const rejection = requestRejection(connection, request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    await handler(request, response)
  }
}

async function normalizedImageRoute(ctx, sessionId) {
  try {
    const llm = contextService(ctx, 'llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') return false
    const session = ctx.sessions?.get?.(sessionId)
    const header = session?.requestHeader?.()
    const agent = contextService(ctx, 'agents')?.get?.(sessionId)
    const fallback = contextService(ctx, 'agentDefaultModel')?.currentSelection?.()
    const provider = header?.config?.provider ?? agent?.options?.provider ?? fallback?.provider
    const model = header?.config?.model ?? agent?.options?.model ?? fallback?.model
    if (provider === undefined || model === undefined) return false
    const info = await llm.resolveModelInfo(provider, model)
    return info?.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/**
 * Stable configuration schema for the frozen dsh-file-upload package.
 * Schemastery is kept at this boundary so the business package does not import
 * or negotiate an official schema package directly.
 */
export const FileUploadConfig = z.object({
  uploadMaxBytes: z.number().default(1024 * MEBIBYTE),
  allowedExtensions: z.array(z.string()).default([]),
  uploadTtlMs: z.number().default(7 * DAY_MS),
  sweepIntervalMs: z.number().default(60 * 60 * 1000),
  maxConcurrentUploads: z.number().default(4),
  inlineTextLimit: z.number().default(8 * 1024),
  previewTextLimit: z.number().default(2 * 1024),
  maxFileBytes: z.number().default(24 * MEBIBYTE),
  readLimit: z.number().default(2000),
  sheetRowLimit: z.number().default(200),
  maxSheets: z.number().default(5),
  cacheEntries: z.number().default(16),
  cacheMaxBytes: z.number().default(64 * MEBIBYTE),
  markitdownBin: z.string().default(''),
  markitdownTimeoutMs: z.number().default(120000),
  visionEndpoint: z.string().default(''),
  visionModel: z.string().default(''),
  visionApiKeyEnv: z.string().default('OPENAI_API_KEY'),
  visionMaxBytes: z.number().default(10 * MEBIBYTE),
  uploadDir: z.string().default(join(process.cwd(), 'uploads')),
})

/**
 * Capture all official Host APIs used by dsh-file-upload and expose only
 * stable projections and operations to its business code.
 *
 * @param {object} ctx - Official Host context, consumed only in this module.
 */
export function createFileUploadHostBinding(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('official host context is required')
  const fsTargets = new WeakMap()
  let uploadService = contextService(ctx, 'fileUploads')

  const fsPort = Object.freeze({
    async resolve(path, { cwd, signal } = {}) {
      if (!boundedString(path) || path.length === 0) throw new TypeError('file path is required')
      const service = requireService(ctx.fs, 'filesystem')
      const target = await service.resolve(path, {
        ...(boundedString(cwd) ? { cwd } : {}),
        ...(signal ? { signal } : {}),
      })
      const projected = targetValue(target)
      fsTargets.set(projected, target)
      return projected
    },
    async stat(file, signal) {
      const target = fsTargets.get(file)
      if (!target) throw new TypeError('file target was not created by this interface')
      const info = await requireService(ctx.fs, 'filesystem').stat(target, signal)
      if (info === undefined) return undefined
      if (!RECORD(info)) throw unavailable('filesystem stat projection')
      const size = Number.isSafeInteger(info.size) && info.size >= 0 ? info.size : undefined
      const revision = versionValue(info.version)
      return Object.freeze({
        type: typeof info.type === 'string' ? info.type : 'unknown',
        ...(size === undefined ? {} : { size }),
        ...(revision === undefined ? {} : { revision }),
      })
    },
    async readBytes(file, signal, maxBytes) {
      const target = fsTargets.get(file)
      if (!target) throw new TypeError('file target was not created by this interface')
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer')
      const bytes = await requireService(ctx.fs, 'filesystem').readBytes(target, signal, maxBytes)
      if (!(bytes instanceof Uint8Array)) throw unavailable('filesystem bytes projection')
      return new Uint8Array(bytes)
    },
    observe(file, observation, execution) {
      const target = fsTargets.get(file)
      const exec = executionContexts.get(execution)
      if (!target || !exec) throw new TypeError('filesystem observation context is invalid')
      if (!RECORD(observation) || !['absent', 'present'].includes(observation.kind)) throw new TypeError('filesystem observation is invalid')
      const revision = versionValue(observation.revision)
      ctx.emit('fs/observed', target, {
        kind: observation.kind,
        ...(revision === undefined ? {} : { version: revision }),
      }, exec)
    },
    error(message, code) {
      if (!boundedString(message) || !boundedString(code, 128)) throw new TypeError('filesystem error is invalid')
      return new FsError(message, code)
    },
  })

  const executionContexts = new WeakMap()
  const currentUploadService = () => uploadService
  const fileUploads = Object.freeze({
    get available() {
      const service = currentUploadService()
      return typeof service?.upload === 'function' && typeof service?.uploadStream === 'function'
    },
    async upload(sessionId, request, signal) {
      const id = sessionIdValue(sessionId)
      if (id === undefined || !RECORD(request) || typeof request.data !== 'string' ||
        request.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data) ||
        (request.name !== undefined && !boundedString(request.name, 1024))) throw new TypeError('encoded upload request is invalid')
      const agents = contextService(ctx, 'agents')
      const agent = await agents?.get?.(id)
      if (!agent) throw unavailable('session agent')
      const service = requireService(currentUploadService(), 'file upload service')
      const result = await service.upload(agent, {
        data: request.data,
        ...(request.name === undefined ? {} : { name: request.name }),
      }, signal ?? new AbortController().signal)
      return receiptValue(result)
    },
    async uploadStream(request) {
      if (!RECORD(request) || sessionIdValue(request.sessionId) === undefined ||
        !request.data || typeof request.data[Symbol.asyncIterator] !== 'function' ||
        (request.name !== undefined && !boundedString(request.name, 1024))) throw new TypeError('stream upload request is invalid')
      const service = requireService(currentUploadService(), 'file upload service')
      return receiptValue(await service.uploadStream({
        sessionId: request.sessionId,
        data: request.data,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.name === undefined ? {} : { name: request.name }),
      }))
    },
    async resolve(sessionId, receiptId) {
      const id = sessionIdValue(sessionId)
      if (id === undefined || !boundedString(receiptId, 512)) throw new TypeError('receipt lookup is invalid')
      const agent = await contextService(ctx, 'agents')?.get?.(id)
      if (!agent) return undefined
      const value = requireService(currentUploadService(), 'file upload service').resolve(agent, receiptId)
      return fileReferenceValue(value)
    },
    async bindPrompt(sessionId, receiptIds, requestId) {
      const id = sessionIdValue(sessionId)
      if (id === undefined || !Array.isArray(receiptIds) || receiptIds.some(value => !boundedString(value, 512)) || !boundedString(requestId, 512)) {
        throw new TypeError('prompt upload binding is invalid')
      }
      const agent = await contextService(ctx, 'agents')?.get?.(id)
      if (!agent) throw unavailable('session agent')
      const binding = requireService(currentUploadService(), 'file upload service').bindPrompt(agent, [...receiptIds], requestId)
      if (!binding || typeof binding.commit !== 'function') throw unavailable('prompt upload binding')
      return Object.freeze({
        commit: () => binding.commit(),
        dispose: () => {
          if (typeof binding.dispose === 'function') return binding.dispose()
          const dispose = binding[Symbol.dispose]
          if (typeof dispose === 'function') return dispose.call(binding)
        },
      })
    },
    async retirePrompt(sessionId, requestId) {
      const id = sessionIdValue(sessionId)
      if (id === undefined || !boundedString(requestId, 512)) throw new TypeError('prompt upload retirement is invalid')
      const agent = await contextService(ctx, 'agents')?.get?.(id)
      if (!agent) return false
      requireService(currentUploadService(), 'file upload service').retirePrompt(agent, requestId)
      return true
    },
    registerAgentResolver(resolveSession) {
      if (typeof resolveSession !== 'function') throw new TypeError('session resolver is required')
      const service = requireService(currentUploadService(), 'file upload service')
      if (typeof service.registerAgentResolver !== 'function') throw unavailable('session agent resolver')
      return service.registerAgentResolver(async rawSessionId => {
        const id = sessionIdValue(rawSessionId)
        if (id === undefined) throw unavailable('session identity')
        if (await resolveSession(id) === false) throw unavailable('session agent')
        const agent = await contextService(ctx, 'agents')?.get?.(id)
        if (!agent) throw unavailable('session agent')
        return agent
      })
    },
  })
  const createInstallation = () => {
    const lease = createResourceLease()
    const scopedFs = Object.freeze({
      resolve(...args) { lease.assertActive(); return fsPort.resolve(...args) },
      stat(...args) { lease.assertActive(); return fsPort.stat(...args) },
      readBytes(...args) { lease.assertActive(); return fsPort.readBytes(...args) },
      observe(...args) { lease.assertActive(); return fsPort.observe(...args) },
      error(...args) { lease.assertActive(); return fsPort.error(...args) },
    })
    const scopedFileUploads = Object.freeze({
      get available() { lease.assertActive(); return fileUploads.available },
      upload(...args) { lease.assertActive(); return fileUploads.upload(...args) },
      uploadStream(...args) { lease.assertActive(); return fileUploads.uploadStream(...args) },
      resolve(...args) { lease.assertActive(); return fileUploads.resolve(...args) },
      bindPrompt(...args) { lease.assertActive(); return fileUploads.bindPrompt(...args) },
      retirePrompt(...args) { lease.assertActive(); return fileUploads.retirePrompt(...args) },
      registerAgentResolver(...args) {
        lease.assertActive()
        lease.track(fileUploads.registerAgentResolver(...args), 'agent resolver')
      },
    })
    const tools = Object.freeze({
      register(definition) {
        lease.assertActive()
        if (!RECORD(definition) || typeof definition.name !== 'string' || typeof definition.execute !== 'function') {
          throw new TypeError('stable tool definition and executor are required')
        }
        const officialDefinition = defineTool({
          ...definition,
          async execute(args, officialExecution) {
            lease.assertActive()
            const sessionId = sessionIdValue(officialExecution?.agent?.session?.id ?? officialExecution?.agent?.session?.header?.id)
            const cwd = sessionCwd(officialExecution?.agent?.session)
            const execution = Object.freeze({
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(cwd === undefined ? {} : { cwd }),
              ...(officialExecution?.signal ? { signal: officialExecution.signal } : {}),
              fs: scopedFs,
            })
            executionContexts.set(execution, officialExecution)
            return definition.execute(args, execution)
          },
        })
        lease.track(requireService(ctx.tools, 'tool registry').register(officialDefinition), 'tool registration')
      },
    })

    const port = Object.freeze({
      tools,
      fs: scopedFs,
      fileUploads: scopedFileUploads,
      systemPrompt: Object.freeze({
        register(section) {
          lease.assertActive()
          if (!RECORD(section) || !boundedString(section.name) || !boundedString(section.text)) throw new TypeError('system prompt section is invalid')
          lease.track(requireService(ctx.systemPrompt, 'system prompt').section({ ...section }), 'system prompt section')
        },
      }),
      routes: Object.freeze({
        registerPrefix(path, handler) {
          lease.assertActive()
          if (!boundedString(path) || !path.startsWith('/') || !path.startsWith('/api/')) throw new TypeError('API prefix is invalid')
          const server = requireService(ctx.webServer, 'web server')
          if (typeof server.register !== 'function') throw unavailable('web route registration')
          lease.track(server.register({
            kind: 'prefix',
            path,
            handler: withConnectionAuth(ctx.connection, (request, response) => {
              lease.assertActive()
              return handler(request, response)
            }),
          }), 'API route registration')
        },
      }),
      sessions: Object.freeze({
        cwd(sessionId) {
          lease.assertActive()
          const id = sessionIdValue(sessionId)
          if (id === undefined) return undefined
          return sessionCwd(requireService(ctx.sessions, 'session store').get(id))
        },
        liveCwds() {
          lease.assertActive()
          const sessions = requireService(ctx.sessions, 'session store').list()
          if (!Array.isArray(sessions)) return Object.freeze([])
          return Object.freeze(sessions.map(sessionCwd).filter(Boolean))
        },
        async persistedCwds() {
          lease.assertActive()
          const persistence = contextService(ctx, 'sessionPersistence')
          if (typeof persistence?.list !== 'function') return Object.freeze([])
          try {
            const entries = await persistence.list()
            lease.assertActive()
            if (!Array.isArray(entries)) return Object.freeze([])
            return Object.freeze(entries.map(headerCwd).filter(Boolean))
          } catch {
            lease.assertActive()
            return Object.freeze([])
          }
        },
        async persistedCwd(sessionId) {
          lease.assertActive()
          const id = sessionIdValue(sessionId)
          if (id === undefined) return undefined
          const persistence = contextService(ctx, 'sessionPersistence')
          if (typeof persistence?.list !== 'function') return undefined
          try {
            const entries = await persistence.list()
            lease.assertActive()
            if (!Array.isArray(entries)) return undefined
            for (const entry of entries) {
              const header = RECORD(entry) && own(entry, 'header') ? entry.header : entry
              const candidateId = header?.id ?? header?.sessionId
              if (candidateId === id) return headerCwd(header)
            }
          } catch {
            lease.assertActive()
          }
          return undefined
        },
      }),
      async resolveCredential(name) {
        lease.assertActive()
        if (!boundedString(name, 256) || name.length === 0) return ''
        try {
          const credentials = requireService(ctx.credentials, 'credentials')
          const resolved = await credentials.resolve(credentialRef(name))
          lease.assertActive()
          if (typeof resolved?.value === 'string') return resolved.value
        } catch {
          lease.assertActive()
        }
        return typeof process !== 'undefined' && typeof process.env?.[name] === 'string' ? process.env[name] : ''
      },
      async imageCapabilities(sessionId) {
        lease.assertActive()
        const id = sessionIdValue(sessionId)
        if (id === undefined) return Object.freeze({ modelAcceptsImages: false })
        const attachments = contextService(ctx, 'attachments')
        const limits = imageLimitsValue(attachments?.imageLimits)
        const modelAcceptsImages = await normalizedImageRoute(ctx, id)
        lease.assertActive()
        return Object.freeze({ modelAcceptsImages, ...(limits === undefined ? {} : { imageLimits: limits }) })
      },
      registerEffect(setup) {
        lease.assertActive()
        if (typeof setup !== 'function') throw unavailable('effect lifecycle')
        lease.track(setup(), 'installation effect')
      },
    })
    return Object.freeze({ port, release: lease.release })
  }
  const port = Object.freeze({ createInstallation })
  return Object.freeze({
    port,
    createInstallation,
    bindFileUploads(service) {
      if (service !== undefined && !RECORD(service)) throw new TypeError('file upload service is invalid')
      uploadService = service
    },
  })
}

export function createFileUploadHostBoundary(ctx) {
  return createFileUploadHostBinding(ctx).port
}

export { withConnectionAuth }
