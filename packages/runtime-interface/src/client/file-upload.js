// Public change history: docs/PUBLIC-CHANGES.md
import { createElement } from 'react'
import { createResourceLease } from '../resource-lease.js'

const RECORD = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const SAFE_HEADERS = new Set([
  'accept', 'content-type', 'content-length', 'x-session-id', 'x-file-name', 'x-file-relpath', 'x-file-path',
  'range', 'if-range', 'upload-offset', 'x-upload-offset', 'upload-length', 'x-upload-length', 'chunk-length',
  'x-chunk-length', 'upload-checksum', 'x-chunk-sha256', 'chunk-sha256', 'x-file-sha256', 'file-sha256',
])
const UPLOAD_PREFIXES = ['/api/upload/v2/', '/api/file-browser/v1/']
const UPLOAD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'])
const fail = (code = 'FILE_UPLOAD_INTERFACE_INVALID') => Object.assign(new Error(code), { code })
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

function UploadHint({ message, placement = 'right', children }) {
  if (typeof message !== 'string' || !['top', 'right', 'bottom'].includes(placement)) throw fail('FILE_UPLOAD_UI_INVALID')
  return createElement('span', {
    className: 'dsh-upload-hint',
    'data-dsh-upload-hint': message,
    'data-dsh-upload-placement': placement,
  }, children)
}

function UploadAttachmentGlyph({ size = 16, className }) {
  return createElement('svg', { className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function UploadDismissGlyph({ size = 16, className }) {
  return createElement('svg', { className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'm6 6 12 12M18 6 6 18', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }))
}

/** Stable upload-specific UI semantics, independent of official export names. */
export const FileUploadUi = Object.freeze({
  Hint: UploadHint,
  AttachmentGlyph: UploadAttachmentGlyph,
  DismissGlyph: UploadDismissGlyph,
})

function sessionIdOf(value) {
  const id = typeof value === 'string' ? value : value?.sessionId
  if (!text(id, 512)) throw fail()
  return id
}

function sessionContext(ctx, id) {
  if (typeof ctx?.sessions?.scope !== 'function') throw fail('FILE_UPLOAD_SESSION_UNAVAILABLE')
  return ctx.sessions.scope(id)
}

function getService(scope, name) {
  if (typeof scope?.get === 'function') return scope.get(name)
  return scope?.[name]
}

function referenceValue(value) {
  if (!RECORD(value) || !text(value.source, 256) || !text(value.ref, 4096)) throw fail()
  return Object.freeze({
    source: value.source,
    ref: value.ref,
    label: typeof value.label === 'string' ? value.label.slice(0, 2048) : '',
    clipboardText: typeof value.clipboardText === 'string' ? value.clipboardText.slice(0, 4096) : '',
  })
}

function inputSnapshot(value) {
  const snapshot = RECORD(value?.input) ? value.input : value
  if (!RECORD(snapshot) || !['plain', 'adjudicating', 'claimed', 'submitting'].includes(snapshot.phase) || !Number.isSafeInteger(snapshot.draftRev) || !Array.isArray(snapshot.occurrences)) {
    throw fail('FILE_UPLOAD_INPUT_STATE_INVALID')
  }
  const occurrences = snapshot.occurrences.map(item => {
    if (!RECORD(item) || !text(item.source, 256) || !text(item.ref, 4096)) throw fail('FILE_UPLOAD_INPUT_STATE_INVALID')
    return Object.freeze({ source: item.source, ref: item.ref })
  })
  return Object.freeze({ phase: snapshot.phase, draftRev: snapshot.draftRev, occurrences: Object.freeze(occurrences) })
}

function slotProps(value) {
  if (!RECORD(value)) throw fail('FILE_UPLOAD_SLOT_PROPS_INVALID')
  const projected = {}
  for (const key of ['sessionId', 'actions', 'ui', 'attach', 'attachAsFile']) {
    if (Object.hasOwn(value, key)) projected[key] = value[key]
  }
  if (Object.hasOwn(value, 'input')) projected.input = inputSnapshot(value.input)
  return projected
}

function routePath(input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || input.includes('\\')) throw fail('FILE_UPLOAD_ROUTE_INVALID')
  let url
  try { url = new URL(input, 'http://dsh-upload.invalid') } catch { throw fail('FILE_UPLOAD_ROUTE_INVALID') }
  const allowed = url.pathname === '/api/upload' || UPLOAD_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
  if (!allowed || url.origin !== 'http://dsh-upload.invalid') throw fail('FILE_UPLOAD_ROUTE_INVALID')
  return `${url.pathname}${url.search}`
}

function requestInit(init = {}) {
  if (!RECORD(init)) throw fail('FILE_UPLOAD_REQUEST_INVALID')
  const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
  if (!UPLOAD_METHODS.has(method)) throw fail('FILE_UPLOAD_METHOD_INVALID')
  const headers = new Headers()
  for (const [key, value] of new Headers(init.headers)) {
    if (SAFE_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  }
  const body = init.body
  return {
    method,
    headers,
    ...(body == null ? {} : { body, ...(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream ? { duplex: 'half' } : {}) }),
    ...(init.signal ? { signal: init.signal } : {}),
    credentials: 'same-origin',
    redirect: 'error',
  }
}

function draftSnapshot(ctx, id, imageIds) {
  const scope = sessionContext(ctx, id)
  const conversation = getService(scope, 'conversation')
  if (!conversation) throw fail('FILE_UPLOAD_CONVERSATION_UNAVAILABLE')
  const items = typeof conversation.draftImages === 'function'
    ? conversation.draftImages(imageIds)
    : typeof conversation.resolveDraftAttachments === 'function'
      ? conversation.resolveDraftAttachments(imageIds).filter(item => item?.kind === 'image')
      : []
  if (!Array.isArray(items)) throw fail('FILE_UPLOAD_IMAGE_STATE_INVALID')
  let totalBytes = 0
  let hasInvalidSize = false
  for (const item of items) {
    const size = item?.file?.size
    if (!Number.isFinite(size) || size < 0) hasInvalidSize = true
    else totalBytes += size
  }
  return Object.freeze({ count: items.length, totalBytes, hasInvalidSize })
}

function sessionActions(ctx, id, fetchImpl, assertActive = () => undefined) {
  assertActive()
  const scope = sessionContext(ctx, id)
  const conversation = getService(scope, 'conversation')
  const requireConversation = () => {
    if (!conversation) throw fail('FILE_UPLOAD_CONVERSATION_UNAVAILABLE')
    return conversation
  }
  const input = () => {
    assertActive()
    const service = requireConversation()
    if (typeof service.input?.for !== 'function') throw fail('FILE_UPLOAD_INPUT_UNAVAILABLE')
    return service.input.for(scope)
  }
  return Object.freeze({
    sessionId: id,
    ui: FileUploadUi,
    hasConversation() {
      assertActive()
      return Boolean(conversation)
    },
    supportsNativeImages() {
      assertActive()
      const target = conversation ? input() : undefined
      return typeof conversation?.createDraftImages === 'function' && typeof target?.addImages === 'function' ||
        typeof conversation?.createDrafts === 'function' && typeof target?.addAttachments === 'function'
    },
    request(path, init) {
      assertActive()
      if (typeof fetchImpl !== 'function') throw fail('FILE_UPLOAD_TRANSPORT_UNAVAILABLE')
      return Promise.resolve(fetchImpl(routePath(path), requestInit(init))).then(response => {
        assertActive()
        return response
      })
    },
    insertText(value) {
      assertActive()
      if (typeof value !== 'string') throw fail()
      const target = input()
      const snapshot = target.state?.getSnapshot?.()
      if (!RECORD(snapshot) || typeof snapshot.draft !== 'string' || !Number.isSafeInteger(snapshot.draftRev)) throw fail('FILE_UPLOAD_INPUT_STATE_INVALID')
      const span = Object.freeze({ start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev })
      scope.emit('slash/input-insert-text', { text: value, span })
    },
    insertReference(value) {
      assertActive()
      const target = input()
      const snapshot = target.state?.getSnapshot?.()
      if (!RECORD(snapshot) || typeof snapshot.draft !== 'string' || !Number.isSafeInteger(snapshot.draftRev)) throw fail('FILE_UPLOAD_INPUT_STATE_INVALID')
      const span = Object.freeze({ start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev })
      scope.emit('slash/input-insert-reference', { reference: referenceValue(value), span })
    },
    imageIds() {
      assertActive()
      const snapshot = input().state?.getSnapshot?.()
      const ids = snapshot?.imageIds ?? snapshot?.attachmentIds ?? []
      if (!Array.isArray(ids) || ids.some(item => !text(item, 512))) throw fail('FILE_UPLOAD_IMAGE_STATE_INVALID')
      return Object.freeze([...ids])
    },
    imageBudget(imageIds) {
      assertActive()
      if (!Array.isArray(imageIds) || imageIds.some(item => !text(item, 512))) throw fail()
      return draftSnapshot(ctx, id, imageIds)
    },
    createDraftImages(files) {
      assertActive()
      if (!Array.isArray(files) || files.length === 0) throw fail()
      const service = requireConversation()
      if (typeof service.createDraftImages === 'function') {
        const drafts = service.createDraftImages(files)
        if (!Array.isArray(drafts) || drafts.some(item => !text(item?.id, 512))) throw fail('FILE_UPLOAD_IMAGE_STATE_INVALID')
        return Object.freeze(drafts.map(item => item.id))
      }
      if (typeof service.createDrafts !== 'function') return Object.freeze([])
      const drafts = service.createDrafts(id, files)
      if (!Array.isArray(drafts) || drafts.some(item => !text(item?.id, 512))) throw fail('FILE_UPLOAD_IMAGE_STATE_INVALID')
      const images = drafts.filter(item => item?.kind === 'image')
      if (images.length !== drafts.length) {
        if (typeof service.releaseDraftAttachments === 'function') service.releaseDraftAttachments(drafts)
        else if (typeof service.releaseDraftAttachment === 'function') for (const item of drafts) service.releaseDraftAttachment(item.id)
        return Object.freeze([])
      }
      return Object.freeze(images.map(item => item.id))
    },
    addDraftImages(ids) {
      assertActive()
      if (!Array.isArray(ids) || ids.some(item => !text(item, 512))) throw fail()
      const target = input()
      if (typeof target.addImages === 'function') return target.addImages(ids) === true
      if (typeof target.addAttachments === 'function') return target.addAttachments(ids) === true
      return false
    },
    releaseDraftImages(ids) {
      assertActive()
      if (!Array.isArray(ids) || ids.some(item => !text(item, 512))) throw fail()
      const service = requireConversation()
      if (typeof service.releaseDraftImage === 'function') {
        for (const id of ids) service.releaseDraftImage(id)
      } else if (typeof service.releaseDraftAttachment === 'function') {
        for (const id of ids) service.releaseDraftAttachment(id)
      }
    },
  })
}

function uploadValue(value) {
  if (!RECORD(value) || !text(value.receiptId, 512) || !RECORD(value.file) || !text(value.file.attachmentId, 512) || !text(value.file.name, 1024) || !Number.isSafeInteger(value.file.bytes) || value.file.bytes < 0) {
    throw fail('FILE_UPLOAD_RESULT_INVALID')
  }
  return Object.freeze({
    receiptId: value.receiptId,
    file: Object.freeze({ attachmentId: value.file.attachmentId, name: value.file.name, bytes: value.file.bytes }),
  })
}

function remoteResult(value) {
  if (!RECORD(value) || typeof value.ok !== 'boolean') throw fail('FILE_UPLOAD_RESULT_INVALID')
  if (value.ok) return Object.freeze({ ok: true, value: uploadValue(value.value) })
  const error = RECORD(value.error) ? value.error : {}
  const code = text(error.code, 128) && /^[A-Za-z][A-Za-z0-9._/-]*$/.test(error.code) ? error.code : 'FILE_UPLOAD_FAILED'
  const message = typeof error.message === 'string' ? error.message.slice(0, 2048) : 'File upload failed'
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/**
 * Bind the frozen dsh-file-upload browser behavior to official client APIs.
 * Session contexts, slot props, input-trigger events, and HTTP routing never
 * escape this adapter.
 */
export function createFileUploadClientBoundary(ctx, { fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('official client context is required')
  const slots = ctx.slots
  const triggers = ctx.inputTriggers
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') throw fail('FILE_UPLOAD_SLOT_UNAVAILABLE')

  return Object.freeze({
    createInstallation() {
      const lease = createResourceLease()
      const rawFileUpload = createOfficialFileUploadClientPort(ctx.fileUpload)
      const fileUpload = Object.freeze({
        ui: rawFileUpload.ui,
        get available() { lease.assertActive(); return rawFileUpload.available },
        async upload(...args) {
          lease.assertActive()
          const result = await rawFileUpload.upload(...args)
          lease.assertActive()
          return result
        },
      })
      const port = Object.freeze({
        fileUpload,
        request(path, init) {
          lease.assertActive()
          if (typeof fetchImpl !== 'function') throw fail('FILE_UPLOAD_TRANSPORT_UNAVAILABLE')
          return Promise.resolve(fetchImpl(routePath(path), requestInit(init))).then(response => {
            lease.assertActive()
            return response
          })
        },
        registerSlot({ name, id, order = 0, component, propsForSession }) {
          lease.assertActive()
          if (!text(name, 256) || !text(id, 256) || !Number.isFinite(order) || typeof component !== 'function' || typeof propsForSession !== 'function') {
            throw new TypeError('slot registration is invalid')
          }
          const stableComponent = props => createElement(component, slotProps(props))
          const injection = slots.inject(name, () => {
            lease.assertActive()
            const registration = lease.track(slots.register({
              name,
              id,
              order,
              inject: rawSessionId => {
                lease.assertActive()
                const sessionId = sessionIdOf(rawSessionId)
                const actions = sessionActions(ctx, sessionId, fetchImpl, lease.assertActive)
                return propsForSession(Object.freeze({ sessionId, actions }))
              },
            }, stableComponent), 'slot registration')
            return registration
          })
          lease.track(injection, 'slot injection')
        },
        registerInputSource({ trigger, name, candidates, onPick, clipboardText, serialize }) {
          lease.assertActive()
          if (!triggers || typeof triggers.registerSource !== 'function') throw fail('FILE_UPLOAD_TRIGGER_UNAVAILABLE')
          if (!text(trigger, 16) || !text(name, 256) || typeof candidates !== 'function' || typeof onPick !== 'function') throw new TypeError('input source is invalid')
          const codec = Object.freeze({
            clipboardText: ref => { lease.assertActive(); return typeof clipboardText === 'function' ? clipboardText(String(ref)) : String(ref) },
            serialize: async ref => {
              lease.assertActive()
              const serialized = typeof serialize === 'function' ? await serialize(String(ref)) : String(ref)
              lease.assertActive()
              return serialized
            },
          })
          const source = {
            trigger,
            name,
            async candidates(projection) {
              lease.assertActive()
              const sessionId = sessionIdOf(projection)
              const rows = await candidates(Object.freeze({ sessionId }))
              lease.assertActive()
              if (!Array.isArray(rows)) throw fail('FILE_UPLOAD_CANDIDATES_INVALID')
              return rows.map(row => {
                if (!RECORD(row) || !text(row.name, 2048)) throw fail('FILE_UPLOAD_CANDIDATES_INVALID')
                return Object.freeze({
                  name: row.name,
                  ...(typeof row.description === 'string' ? { description: row.description.slice(0, 2048) } : {}),
                  ...(typeof row.icon === 'string' ? { icon: row.icon.slice(0, 64) } : {}),
                })
              })
            },
            onPick(pick) {
              lease.assertActive()
              const sessionId = sessionIdOf(pick?.session)
              const candidateName = pick?.candidate?.name
              if (!text(candidateName, 2048)) throw fail('FILE_UPLOAD_CANDIDATE_INVALID')
              const result = onPick(Object.freeze({ sessionId, candidateName }))
              if (result === undefined) return undefined
              if (!RECORD(result) || !RECORD(result.insert)) throw fail('FILE_UPLOAD_INSERT_INVALID')
              return Object.freeze({ insert: referenceValue(result.insert) })
            },
            codec,
          }
          lease.track(triggers.registerSource(source), 'input reference source')
        },
        forSession(sessionId) {
          lease.assertActive()
          return sessionActions(ctx, sessionIdOf(sessionId), fetchImpl, lease.assertActive)
        },
        ui: FileUploadUi,
      })
      return Object.freeze({ port, release: lease.release })
    },
  })
}

/**
 * Normalize the official file-upload service exposed by both 0.1.5 and 0.2.
 * The old `available` field is honored when present; its removal in 0.2 maps
 * to availability inferred from the required `upload` operation.
 */
export function createOfficialFileUploadClientPort(input) {
  const service = input?.fileUpload ?? input
  const available = typeof service?.upload === 'function' && service.available !== false
  return Object.freeze({
    ui: FileUploadUi,
    available,
    async upload(sessionId, data, name, signal, onProgress) {
      if (!available) return Object.freeze({ ok: false, error: Object.freeze({ code: 'FILE_UPLOAD_UNAVAILABLE', message: 'File upload is unavailable' }) })
      const id = sessionIdOf(sessionId)
      if (data == null || (typeof data !== 'object' && typeof data !== 'function')) throw new TypeError('upload data is required')
      if (name !== undefined && !text(name, 1024)) throw new TypeError('file name is invalid')
      if (signal !== undefined && typeof signal?.throwIfAborted !== 'function') throw new TypeError('abort signal is invalid')
      if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('progress callback is invalid')
      try {
        return remoteResult(await service.upload(id, data, name, signal, onProgress))
      } catch (error) {
        const candidate = error?.code
        const code = text(candidate, 128) && /^[A-Za-z][A-Za-z0-9._/-]*$/.test(candidate) ? candidate : 'FILE_UPLOAD_FAILED'
        return Object.freeze({ ok: false, error: Object.freeze({ code, message: typeof error?.message === 'string' ? error.message.slice(0, 2048) : 'File upload failed' }) })
      }
    },
  })
}

/**
 * Adapt the 0.1.5 URL-only and 0.2 string-or-URL official upload fetch hooks.
 * Passing a URL satisfies both contracts and prevents origin/path escape.
 */
export function createOfficialFileUploadFetch(fetchHook, baseUrl) {
  if (typeof fetchHook !== 'function') throw new TypeError('official upload fetch hook is required')
  const base = new URL(baseUrl)
  return (input, init = {}) => {
    let url
    try { url = new URL(input instanceof URL ? input.href : input, base) } catch { throw fail('FILE_UPLOAD_ROUTE_INVALID') }
    if (url.origin !== base.origin || url.pathname !== '/api/session/uploadFileBinary') throw fail('FILE_UPLOAD_ROUTE_INVALID')
    const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
    if (method !== 'POST') throw fail('FILE_UPLOAD_METHOD_INVALID')
    const contentType = new Headers(init.headers).get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/octet-stream') throw fail('FILE_UPLOAD_CONTENT_TYPE_INVALID')
    return fetchHook(url, { ...init, method })
  }
}
