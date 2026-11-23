// Public change history: docs/PUBLIC-CHANGES.md
// dsh-file-upload client face: Claude-desktop-style file upload.
//   - paperclip button in the composer toolbar (conversation.input.left)
//   - global drag-and-drop overlay: drag files anywhere over the window and
//     drop them onto the chat to attach (conversation.input.dock hosts cards)
//   - small text files are inlined straight into the composer via the
//     official `slash/input-insert-text` event; larger text and documents
//     insert a path reference the agent reads with read_document.
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-uploads/<sessionId>), where the agent's fs backend can
// always resolve them.
// Public change history: docs/PUBLIC-CHANGES.md

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { claimFileDrag } from './drop.ts'
import { normalizeImageForPolicy } from './image-intake.ts'
import { SubmittedUploadTracker } from './submitted-uploads.ts'
import { createUploadErrorStore } from './upload-error.ts'
import type { ImageIntakePolicy, NormalizedImage } from './image-intake.ts'

const SOURCE_NAME = 'dsh-file-upload'
const STYLE_TAG = 'dsh-file-upload/style.css'

interface UploadMeta {
  name: string
  bytes: number
  label: string
  status: 'uploading' | 'verifying' | 'paused' | 'ready' | 'error'
  progress: number
  error?: string
  previewUrl?: string
  relativePath?: string
  path?: string
  uploadId?: string
  handling?: 'image' | 'readable' | 'generic'
  hint?: string
  fallback?: boolean
}

/** Per-session attachment metadata: Map<sessionId, Map<path, meta>>. */
const uploadMetaBySession = new Map<string, Map<string, UploadMeta>>()
/** Upload cards belonging to the current, not-yet-sent composer draft. */
const draftUploadRefsBySession = new Map<string, Set<string>>()
/** Completed uploads that were injected into the current composer draft. */
const attachedUploadRefsBySession = new Map<string, Set<string>>()
const submittedUploadTrackers = new Map<string, SubmittedUploadTracker>()

function metaFor(sessionId: string): Map<string, UploadMeta> {
  let m = uploadMetaBySession.get(sessionId)
  if (m === undefined) {
    m = new Map()
    uploadMetaBySession.set(sessionId, m)
  }
  return m
}

function refsFor(store: Map<string, Set<string>>, sessionId: string): Set<string> {
  let refs = store.get(sessionId)
  if (refs === undefined) {
    refs = new Set()
    store.set(sessionId, refs)
  }
  return refs
}

function trackerFor(sessionId: string): SubmittedUploadTracker {
  let tracker = submittedUploadTrackers.get(sessionId)
  if (tracker === undefined) {
    tracker = new SubmittedUploadTracker(SOURCE_NAME)
    submittedUploadTrackers.set(sessionId, tracker)
  }
  return tracker
}

function replaceDraftRef(sessionId: string, previous: string, next: string): void {
  const refs = refsFor(draftUploadRefsBySession, sessionId)
  if (!refs.delete(previous)) return
  refs.add(next)
}

function markDraftUploadAttached(sessionId: string, ref: string): void {
  refsFor(attachedUploadRefsBySession, sessionId).add(ref)
}

function releasePreview(meta: UploadMeta | undefined): void {
  if (meta?.previewUrl !== undefined) URL.revokeObjectURL(meta.previewUrl)
}

function consumeSubmittedDraftUploads(sessionId: string, refs: readonly string[]): void {
  const draftRefs = refsFor(draftUploadRefsBySession, sessionId)
  const attachedRefs = refsFor(attachedUploadRefsBySession, sessionId)
  const metas = metaFor(sessionId)
  let changed = false
  for (const ref of refs) {
    changed = draftRefs.delete(ref) || changed
    attachedRefs.delete(ref)
    const meta = metas.get(ref)
    if (meta?.previewUrl !== undefined) {
      releasePreview(meta)
      metas.set(ref, { ...meta, previewUrl: undefined })
    }
  }
  if (changed) notifyUploadState()
}
const uploadErrors = createUploadErrorStore()

interface UploadJob {
  key: string
  file: File
  sessionId: string
  actions: UploadActions
  uploadId?: string
  offset: number
  chunkSize: number
  controller: AbortController
  fallback: boolean
  retryAttempt: number
  retryTimer?: ReturnType<typeof setTimeout>
}

const uploadJobs = new Map<string, UploadJob>()
const uploadListeners = new Set<() => void>()

function notifyUploadState(): void {
  for (const listener of uploadListeners) listener()
}

function subscribeUploadState(listener: () => void): () => void {
  uploadListeners.add(listener)
  return () => uploadListeners.delete(listener)
}

function updateUploadMeta(sessionId: string, key: string, update: Partial<UploadMeta>): void {
  const map = metaFor(sessionId)
  const previous = map.get(key)
  if (previous === undefined) return
  map.set(key, { ...previous, ...update })
  notifyUploadState()
}

function randomKey(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  } catch {
    return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

interface ResumeRecord {
  uploadId: string
  sessionId: string
  name: string
  size: number
  lastModified: number
  firstChunkSha256: string
  lastChunkSha256: string
}

function resumeStorageKey(sessionId: string, file: File): string {
  return `dsh-file-upload:v2:${sessionId}:${file.name}:${file.size}:${file.lastModified}`
}

function loadResumeRecord(sessionId: string, file: File): ResumeRecord | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(resumeStorageKey(sessionId, file))
    if (raw === null || raw === undefined) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Partial<ResumeRecord>
    return typeof record.uploadId === 'string' && record.sessionId === sessionId && record.name === file.name && record.size === file.size && record.lastModified === file.lastModified && typeof record.firstChunkSha256 === 'string' && typeof record.lastChunkSha256 === 'string'
      ? record as ResumeRecord
      : null
  } catch {
    return null
  }
}

function saveResumeRecord(sessionId: string, file: File, record: ResumeRecord): void {
  try {
    globalThis.sessionStorage?.setItem(resumeStorageKey(sessionId, file), JSON.stringify(record))
  } catch {
    // Session storage may be unavailable in private browsing or an embedded webview.
  }
}

function clearResumeRecord(sessionId: string, file: File): void {
  try {
    globalThis.sessionStorage?.removeItem(resumeStorageKey(sessionId, file))
  } catch {
    // Best effort only; the server-side transfer remains cancellable.
  }
}

function setUploadError(text: string): void {
  uploadErrors.set(text)
}

function clearUploadError(): void {
  uploadErrors.clear()
}

function badgeStyle(name: string): { bg: string; ext: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4)
  const lower = ext.toLowerCase()
  if (lower === 'pdf') return { bg: '#C93B2E', ext: 'PDF' }
  if (lower === 'docx' || lower === 'doc') return { bg: '#2B579A', ext: 'DOC' }
  if (lower === 'xlsx' || lower === 'xls') return { bg: '#217346', ext: 'XLS' }
  if (lower === 'csv' || lower === 'tsv') return { bg: '#217346', ext: 'CSV' }
  if (lower === 'txt' || lower === 'md' || lower === 'markdown') return { bg: '#757575', ext: 'TXT' }
  if (lower === 'zip') return { bg: '#7A5BB0', ext: 'ZIP' }
  if (lower === 'json' || lower === 'jsonl') return { bg: '#B8860B', ext: 'JSON' }
  if (lower === 'png' || lower === 'jpg' || lower === 'jpeg' || lower === 'gif' || lower === 'webp') return { bg: '#2E7D6B', ext: 'IMG' }
  return { bg: '#5B7DB1', ext: ext === '' ? 'FILE' : ext }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-file-upload'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = `
.dsh-upload-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;border-radius:6px;padding:4px;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dsh-upload-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor)}
.dsh-upload-btn:disabled{opacity:.45;cursor:default}
.dsh-upload-hint{position:relative;display:inline-flex}
.dsh-upload-hint::after{content:attr(data-dsh-upload-hint);position:absolute;z-index:10001;max-width:240px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-surface-3,#29292f);color:var(--dsw-alias-label-primary,#fff);font-size:11px;line-height:1.35;white-space:nowrap;box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.24));opacity:0;visibility:hidden;pointer-events:none;transition:opacity .08s ease}
.dsh-upload-hint[data-dsh-upload-placement="top"]::after{left:50%;bottom:calc(100% + 8px);transform:translateX(-50%)}
.dsh-upload-hint[data-dsh-upload-placement="right"]::after{left:calc(100% + 8px);top:50%;transform:translateY(-50%)}
.dsh-upload-hint[data-dsh-upload-placement="bottom"]::after{left:50%;top:calc(100% + 8px);transform:translateX(-50%)}
.dsh-upload-hint:hover::after,.dsh-upload-hint:focus-within::after{opacity:1;visibility:visible}
.dsh-upload-picker{position:relative;display:inline-flex}
.dsh-upload-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:10000;display:flex;flex-direction:column;min-width:150px;padding:4px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));border-radius:9px;background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,#202024));box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.24))}
.dsh-upload-menu button{border:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;text-align:left;border-radius:6px;padding:7px 9px;font-size:12px;white-space:nowrap}
.dsh-upload-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-upload-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset);display:flex;flex-wrap:wrap;gap:8px;flex:none}
.dsh-upload-card{position:relative;flex-direction:column;align-items:center;gap:5px;width:88px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:12px;padding:12px 8px 9px;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}
.dsh-upload-badge{width:44px;height:56px;border-radius:6px;color:#fff;font-size:12px;font-weight:700;font-family:var(--ds-font-family-code,monospace);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;flex:none;box-shadow:inset 0 -10px 14px rgba(0,0,0,.14),inset 0 10px 12px rgba(255,255,255,.16)}
.dsh-upload-name{width:100%;font-size:12px;line-height:16px;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.dsh-upload-size{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;flex:none}
.dsh-upload-progress{width:100%;height:4px;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.18)}
.dsh-upload-progress>i{display:block;height:100%;background:var(--dsw-alias-interactive-bg-accent,#668cff);transition:width .12s ease}
.dsh-upload-status{font-size:10px;color:var(--dsw-alias-label-tertiary,inherit);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-upload-action{border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:10px;padding:1px 3px}
.dsh-upload-action:hover{color:var(--dsw-alias-label-primary,inherit)}
.dsh-upload-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-upload-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-upload-card>.dsh-upload-remove{position:absolute;top:4px;right:4px}
.dsh-upload-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-upload-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.dsh-upload-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-surface-1,#101014) 72%,transparent);backdrop-filter:blur(2px);opacity:0;transition:opacity .12s ease}
.dsh-upload-overlay.active{opacity:1}
.dsh-upload-overlay-box{border:2px dashed var(--dsw-alias-border-accent,rgba(99,132,255,.55));border-radius:16px;padding:28px 44px;color:var(--dsw-alias-label-primary,inherit);font-size:15px;display:flex;flex-direction:column;align-items:center;gap:8px;background:var(--dsw-specific-input-major,rgba(127,127,127,.08))}
.dsh-upload-overlay-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
`
  document.head.appendChild(tag)
}

interface InputSnapshot {
  draftRev: number
  phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  occurrences: Array<{ source: string; ref: string; occurrenceId: string; offset: number }>
}

interface UploadUi {
  Hint: ComponentType<{ message: string; placement?: 'top' | 'right' | 'bottom'; children: ReactNode }>
  AttachmentGlyph: ComponentType<{ size?: number; className?: string }>
  DismissGlyph: ComponentType<{ size?: number; className?: string }>
}

interface UploadActions {
  readonly sessionId: string
  readonly ui: UploadUi
  hasConversation(): boolean
  supportsNativeImages(): boolean
  request(path: string, init?: RequestInit): Promise<Response>
  insertText(value: string): void
  insertReference(value: { source: string; ref: string; label: string; clipboardText: string }): void
  imageIds(): readonly string[]
  imageBudget(imageIds: readonly string[]): { count: number; totalBytes: number; hasInvalidSize: boolean }
  createDraftImages(files: readonly File[]): readonly string[]
  addDraftImages(ids: readonly string[]): boolean
  releaseDraftImages(ids: readonly string[]): void
}

interface UploadResponse {
  path?: string
  name?: string
  bytes?: number
  sha256?: string
  handling?: 'image' | 'readable' | 'generic'
  hint?: string
  genericPrompt?: string
  sniffedType?: string
  label?: string
  imageMode?: 'native' | 'ocr'
  imageDescription?: string
  relativePath?: string
  error?: string
}

interface UploadCapability {
  chunkSize: number
  maxBytes: number
  imageIntake?: ImageIntakePolicy
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function httpErrorText(status: number): string {
  if (status === 413) return '文件超过大小限制'
  if (status === 415) return '文件类型不被允许'
  if (status === 403) return '会话校验失败，请刷新页面重试'
  if (status === 429) return '上传太频繁，请稍后再试'
  return `HTTP ${status}`
}

function isCapabilityMiss(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

function abortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError' || err instanceof Error && err.name === 'AbortError'
}

async function responseError(res: Response, fileName: string): Promise<Error> {
  let detail = httpErrorText(res.status)
  try {
    const payload = (await res.json()) as { error?: string }
    if (typeof payload.error === 'string') detail = payload.error
  } catch {
    // Keep the status-based message.
  }
  const error = new Error(`${fileName}: ${detail}`) as Error & { status?: number }
  error.status = res.status
  return error
}

function isRetryableUploadError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const status = err instanceof Error ? (err as Error & { status?: number }).status : undefined
  return status === 429 || status === 502 || status === 503 || status === 504
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) throw new Error('Web Crypto SHA-256 is unavailable')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function edgeDigests(file: File, chunkSize: number): Promise<{ firstChunkSha256: string; lastChunkSha256: string }> {
  const first = await file.slice(0, Math.min(chunkSize, file.size)).arrayBuffer()
  const lastStart = Math.max(0, file.size - chunkSize)
  const last = await file.slice(lastStart, file.size).arrayBuffer()
  return {
    firstChunkSha256: await sha256Hex(first),
    lastChunkSha256: await sha256Hex(last)
  }
}

function updatePending(job: UploadJob, update: Partial<UploadMeta>): void {
  updateUploadMeta(job.sessionId, job.key, update)
}

function jobActive(job: UploadJob): boolean {
  return uploadJobs.get(job.key) === job && !job.controller.signal.aborted && metaFor(job.sessionId).has(job.key)
}

function jobRemoved(job: UploadJob): boolean {
  return uploadJobs.get(job.key) !== job || !metaFor(job.sessionId).has(job.key)
}

function ensureJobActive(job: UploadJob): void {
  if (!jobActive(job)) throw new DOMException('Upload removed or paused', 'AbortError')
}

async function deleteTransferAfterRace(job: UploadJob): Promise<void> {
  if (job.uploadId === undefined || !jobRemoved(job)) return
  await job.actions.request(`/api/upload/v2/transfers/${encodeURIComponent(job.uploadId)}`, {
    method: 'DELETE',
    headers: { 'x-session-id': job.sessionId }
  }).catch(() => undefined)
}

function commitMeta(job: UploadJob, payload: UploadResponse): string {
  if (!jobActive(job)) throw new DOMException('Upload removed or paused', 'AbortError')
  if (typeof payload.path !== 'string') throw new Error('missing path in response')
  const name = payload.name ?? job.file.name
  const bytes = payload.bytes ?? job.file.size
  const hint = payload.hint ?? payload.genericPrompt
  const map = metaFor(job.sessionId)
  map.delete(job.key)
  replaceDraftRef(job.sessionId, job.key, payload.path)
  map.set(payload.path, {
    name,
    bytes,
    label: payload.label ?? name.slice(name.lastIndexOf('.') + 1).toUpperCase(),
    status: 'ready',
    progress: 100,
    path: payload.path,
    uploadId: job.uploadId,
    ...(job.fallback ? { fallback: true } : {}),
    ...(payload.handling !== undefined ? { handling: payload.handling } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(payload.relativePath !== undefined ? { relativePath: payload.relativePath } : {}),
    ...(job.file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(job.file) } : {})
  })
  notifyUploadState()
  clearResumeRecord(job.sessionId, job.file)
  return payload.path
}

function insertPayload(actions: UploadActions, payload: UploadResponse, name: string, sessionId: string): void {
  if (!actions.hasConversation() || typeof payload.path !== 'string') return
  markDraftUploadAttached(sessionId, payload.path)
  const relativePath = payload.relativePath ?? payload.path

  if (payload.handling === 'generic') {
    const hint = payload.hint ?? payload.genericPrompt ?? `该格式当前不能直接解析。请先将它复制到项目文件夹中合适的可见位置，再按用户要求处理，并在回复中说明复制后的路径。`
    actions.insertText(`附件：@${relativePath}\n${hint.replace(/^附件：@[^\n]+\n/u, '')}`)
    return
  }
  if (payload.sniffedType === 'image' || payload.handling === 'image') {
    const description =
      payload.imageMode === 'native'
        ? `当前模型支持图像输入,请用 read_image 工具查看 ${payload.path}`
        : payload.imageDescription !== undefined
          ? `图片讲解(自动生成):\n${payload.imageDescription}\n原始文件: ${payload.path}`
          : `图片以文件形式上传(${payload.path});未生成讲解,请用 read_document 工具读取`
    actions.insertText(`[图片: ${name}] ${description}`)
    return
  }

  actions.insertReference({
    source: SOURCE_NAME,
    ref: payload.path,
    label: payload.hint ?? '',
    clipboardText: `@${relativePath}`
  })
}

async function uploadLegacy(job: UploadJob): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relPath = (job.file as any).relPath as string | undefined
  updatePending(job, { status: 'uploading', progress: 0, fallback: true, hint: '此主机不支持断点续传，请升级' })
  const res = await job.actions.request('/api/upload', {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(job.file.name),
      ...(relPath !== undefined ? { 'x-file-relpath': encodeURIComponent(relPath) } : {}),
      'x-session-id': job.sessionId
    },
    body: job.file,
    signal: job.controller.signal
  })
  if (!res.ok) throw await responseError(res, job.file.name)
  const payload = (await res.json()) as UploadResponse
  if (!jobActive(job)) {
    if (typeof payload.path === 'string') {
      await job.actions.request('/api/upload', {
        method: 'DELETE',
        headers: { 'x-session-id': job.sessionId, 'x-file-path': encodeURIComponent(payload.path) }
      }).catch(() => undefined)
    }
    throw new DOMException('Upload removed or paused', 'AbortError')
  }
  const path = commitMeta(job, payload)
  clearUploadError()
  insertPayload(job.actions, payload, payload.name ?? job.file.name, job.sessionId)
  return path
}

function parseImageIntake(value: unknown): ImageIntakePolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as Record<string, unknown>
  const targetValue = body.target
  if (body.version !== 1 || body.mode !== 'auto-fit' || typeof body.modelAcceptsImages !== 'boolean' ||
    !Array.isArray(body.acceptedMediaTypes) || typeof body.sourceMaxMessageBytes !== 'number' || typeof body.sourceMaxDimension !== 'number' ||
    typeof body.policyFingerprint !== 'string' || typeof targetValue !== 'object' || targetValue === null) return undefined
  const target = targetValue as Record<string, unknown>
  const numeric = ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension'] as const
  if (numeric.some((key) => !isSafePositiveInteger(target[key]))) return undefined
  if (!isSafePositiveInteger(body.sourceMaxMessageBytes) || !isSafePositiveInteger(body.sourceMaxDimension)) return undefined
  const acceptedMediaTypes = body.acceptedMediaTypes.filter((item): item is string => typeof item === 'string')
  return {
    version: 1,
    mode: 'auto-fit',
    modelAcceptsImages: body.modelAcceptsImages,
    acceptedMediaTypes,
    sourceMaxMessageBytes: body.sourceMaxMessageBytes,
    sourceMaxDimension: body.sourceMaxDimension,
    target: {
      maxImageBytes: target.maxImageBytes as number,
      maxImagesPerMessage: target.maxImagesPerMessage as number,
      maxMessageImageBytes: target.maxMessageImageBytes as number,
      maxImagePixels: target.maxImagePixels as number,
      maxImageDimension: target.maxImageDimension as number,
      mediaTypes: acceptedMediaTypes
    },
    policyFingerprint: body.policyFingerprint
  }
}

async function describeV2(actions: UploadActions, sessionId: string): Promise<UploadCapability | null> {
  const res = await actions.request('/api/upload/v2/describe', { headers: { 'x-session-id': sessionId } })
  if (isCapabilityMiss(res.status)) return null
  if (!res.ok) throw await responseError(res, '文件上传')
  const body = (await res.json()) as { chunkSize?: number; chunkBytes?: number; maxBytes?: number; maxFileBytes?: number; imageIntake?: unknown }
  const chunkSize = body.chunkSize ?? body.chunkBytes ?? 4 * 1024 * 1024
  const maxBytes = body.maxBytes ?? body.maxFileBytes ?? 1024 * 1024 * 1024
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(maxBytes) || maxBytes < 0) throw new Error('invalid file-transfer-v2 capabilities')
  return { chunkSize, maxBytes, imageIntake: parseImageIntake(body.imageIntake) }
}

async function uploadV2(job: UploadJob, capability: UploadCapability): Promise<string> {
  job.chunkSize = capability.chunkSize
  if (job.file.size > capability.maxBytes) throw new Error(`${job.file.name}: 文件超过大小限制`)
  const edges = await edgeDigests(job.file, job.chunkSize)
  ensureJobActive(job)
  if (job.uploadId === undefined) {
    const saved = loadResumeRecord(job.sessionId, job.file)
    if (saved !== null && saved.firstChunkSha256 === edges.firstChunkSha256 && saved.lastChunkSha256 === edges.lastChunkSha256) {
      const resumed = await job.actions.request(`/api/upload/v2/transfers/${encodeURIComponent(saved.uploadId)}`, {
        headers: { 'x-session-id': job.sessionId },
        signal: job.controller.signal
      })
      ensureJobActive(job)
      if (resumed.ok) {
        const status = (await resumed.json()) as { uploadId?: string; fileName?: string; name?: string; size?: number; offset?: number; receivedBytes?: number; chunkSize?: number; chunkBytes?: number }
        ensureJobActive(job)
        const statusName = status.fileName ?? status.name
        if (status.uploadId === saved.uploadId && statusName === job.file.name && status.size === job.file.size) {
          job.uploadId = saved.uploadId
          job.offset = status.offset ?? status.receivedBytes ?? 0
          job.chunkSize = status.chunkSize ?? status.chunkBytes ?? job.chunkSize
        }
      }
    }
  }
  if (job.uploadId === undefined) {
    const relPath = (job.file as any).relPath as string | undefined
    const init = await job.actions.request('/api/upload/v2/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': job.sessionId },
      body: JSON.stringify({
        fileName: job.file.name,
        size: job.file.size,
        mediaType: job.file.type,
        lastModified: job.file.lastModified,
        firstChunkSha256: edges.firstChunkSha256,
        lastChunkSha256: edges.lastChunkSha256,
        ...(relPath !== undefined ? { relativePath: relPath } : {})
      }),
      signal: job.controller.signal
    })
    if (!jobActive(job)) {
      if (init.ok) {
        const abandoned = (await init.json()) as { uploadId?: string }
        if (typeof abandoned.uploadId === 'string') job.uploadId = abandoned.uploadId
        await deleteTransferAfterRace(job)
      }
      throw new DOMException('Upload removed or paused', 'AbortError')
    }
    if (!init.ok) {
      if (isCapabilityMiss(init.status)) {
        job.fallback = true
        return uploadLegacy(job)
      }
      throw await responseError(init, job.file.name)
    }
    const created = (await init.json()) as { uploadId?: string; offset?: number; chunkSize?: number; chunkBytes?: number }
    if (!jobActive(job)) {
      if (typeof created.uploadId === 'string') job.uploadId = created.uploadId
      await deleteTransferAfterRace(job)
      throw new DOMException('Upload removed or paused', 'AbortError')
    }
    if (typeof created.uploadId !== 'string') throw new Error('missing uploadId in response')
    job.uploadId = created.uploadId
    job.offset = created.offset ?? 0
    job.chunkSize = created.chunkSize ?? created.chunkBytes ?? capability.chunkSize
    saveResumeRecord(job.sessionId, job.file, {
      uploadId: job.uploadId,
      sessionId: job.sessionId,
      name: job.file.name,
      size: job.file.size,
      lastModified: job.file.lastModified,
      ...edges
    })
  } else {
    const status = await job.actions.request(`/api/upload/v2/transfers/${encodeURIComponent(job.uploadId)}`, {
      headers: { 'x-session-id': job.sessionId },
      signal: job.controller.signal
    })
    ensureJobActive(job)
    if (!status.ok) {
      if (status.status === 404) {
        job.uploadId = undefined
        job.offset = 0
        return uploadV2(job, capability)
      }
      throw await responseError(status, job.file.name)
    }
    const resumed = (await status.json()) as { status?: string; path?: string; relativePath?: string; name?: string; fileName?: string; bytes?: number; sha256?: string; handling?: 'image' | 'readable' | 'generic'; hint?: string; genericPrompt?: string; sniffedType?: string; imageMode?: 'native' | 'ocr'; imageDescription?: string; offset?: number; receivedBytes?: number; chunkSize?: number; chunkBytes?: number }
    ensureJobActive(job)
    if (resumed.status === 'completed' && typeof resumed.path === 'string') {
      const payload = resumed as UploadResponse
      const path = commitMeta(job, payload)
      clearUploadError()
      insertPayload(job.actions, payload, payload.name ?? resumed.fileName ?? job.file.name, job.sessionId)
      return path
    }
    job.offset = resumed.offset ?? resumed.receivedBytes ?? 0
    job.chunkSize = resumed.chunkSize ?? resumed.chunkBytes ?? job.chunkSize
  }
  updatePending(job, { status: 'uploading', progress: job.file.size === 0 ? 100 : Math.floor(job.offset / job.file.size * 100), uploadId: job.uploadId })
  while (job.offset < job.file.size) {
    if (job.controller.signal.aborted) throw new DOMException('Upload paused', 'AbortError')
    const start = job.offset
    const end = Math.min(start + job.chunkSize, job.file.size)
    const chunk = await job.file.slice(start, end).arrayBuffer()
    const digest = await sha256Hex(chunk)
    const response = await job.actions.request(`/api/upload/v2/transfers/${encodeURIComponent(job.uploadId)}`, {
      method: 'PATCH',
      headers: {
        'x-session-id': job.sessionId,
        'Upload-Offset': String(start),
        'X-Chunk-SHA256': digest
      },
      body: chunk,
      signal: job.controller.signal
    })
    if (!jobActive(job)) {
      await deleteTransferAfterRace(job)
      throw new DOMException('Upload removed or paused', 'AbortError')
    }
    if (response.status === 409) {
      const conflict = (await response.json()) as { offset?: number }
      if (typeof conflict.offset === 'number' && conflict.offset >= 0 && conflict.offset <= job.file.size) {
        job.offset = conflict.offset
        continue
      }
    }
    if (!response.ok) throw await responseError(response, job.file.name)
    const next = (await response.json()) as { offset?: number; receivedBytes?: number }
    ensureJobActive(job)
    const nextOffset = next.offset ?? next.receivedBytes
    if (typeof nextOffset !== 'number' || nextOffset <= start || nextOffset > job.file.size) throw new Error('invalid upload offset in response')
    job.offset = nextOffset
    updatePending(job, { status: 'uploading', progress: Math.floor(job.offset / job.file.size * 100), uploadId: job.uploadId })
  }
  updatePending(job, { status: 'verifying', progress: 100, uploadId: job.uploadId })
  ensureJobActive(job)
  const commit = await job.actions.request(`/api/upload/v2/transfers/${encodeURIComponent(job.uploadId)}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': job.sessionId },
    body: '{}',
    signal: job.controller.signal
  })
  if (!jobActive(job)) {
    await deleteTransferAfterRace(job)
    throw new DOMException('Upload removed or paused', 'AbortError')
  }
  if (!commit.ok) throw await responseError(commit, job.file.name)
  const payload = (await commit.json()) as UploadResponse
  ensureJobActive(job)
  const path = commitMeta(job, payload)
  clearUploadError()
  insertPayload(job.actions, payload, payload.name ?? job.file.name, job.sessionId)
  return path
}

async function runUploadJob(job: UploadJob, capability?: UploadCapability | null): Promise<string | null> {
  try {
    if (job.retryTimer !== undefined) {
      clearTimeout(job.retryTimer)
      job.retryTimer = undefined
    }
    updatePending(job, { status: 'uploading', error: undefined })
    if (job.fallback) return await uploadLegacy(job)
    const described = capability ?? await describeV2(job.actions, job.sessionId)
    if (described === null) {
      job.fallback = true
      return await uploadLegacy(job)
    }
    return await uploadV2(job, described)
  } catch (err) {
    if (abortError(err) || job.controller.signal.aborted) {
      updatePending(job, { status: 'paused' })
      return null
    }
    if (isRetryableUploadError(err) && uploadJobs.get(job.key) === job) {
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(job.retryAttempt, 5))
      job.retryAttempt += 1
      updatePending(job, {
        status: 'paused',
        error: `连接中断，${Math.ceil(delay / 1000)} 秒后自动续传`
      })
      job.retryTimer = setTimeout(() => {
        job.retryTimer = undefined
        if (uploadJobs.get(job.key) !== job) return
        job.controller = new AbortController()
        void runUploadJob(job).catch((retryError) =>
          setUploadError(retryError instanceof Error ? retryError.message : String(retryError)))
      }, delay)
      return null
    }
    updatePending(job, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    const meta = metaFor(job.sessionId).get(job.key)
    if (meta?.status === 'ready') uploadJobs.delete(job.key)
  }
}

async function uploadFile(actions: UploadActions, file: File, sessionId: string, capability?: UploadCapability | null): Promise<string | null> {
  if (!actions.hasConversation()) throw new Error('conversation service unavailable')
  const key = randomKey()
  const job: UploadJob = {
    key,
    file,
    sessionId,
    actions,
    offset: 0,
    chunkSize: 4 * 1024 * 1024,
    controller: new AbortController(),
    fallback: false,
    retryAttempt: 0
  }
  metaFor(sessionId).set(key, {
    name: file.name,
    bytes: file.size,
    label: file.name.slice(file.name.lastIndexOf('.') + 1).toUpperCase() || 'FILE',
    status: 'uploading',
    progress: 0,
    uploadId: undefined
  })
  refsFor(draftUploadRefsBySession, sessionId).add(key)
  uploadJobs.set(key, job)
  notifyUploadState()
  return runUploadJob(job, capability)
}

function pauseUpload(key: string): void {
  const job = uploadJobs.get(key)
  if (job === undefined) return
  if (job.retryTimer !== undefined) {
    clearTimeout(job.retryTimer)
    job.retryTimer = undefined
  }
  job.controller.abort()
  updatePending(job, { status: 'paused', error: undefined })
}

function resumeUpload(key: string): void {
  const job = uploadJobs.get(key)
  if (job === undefined) return
  if (job.retryTimer !== undefined) {
    clearTimeout(job.retryTimer)
    job.retryTimer = undefined
  }
  job.retryAttempt = 0
  job.controller = new AbortController()
  void runUploadJob(job).catch((err) => setUploadError(err instanceof Error ? err.message : String(err)))
}

/** Recursively collect files from dropped dataTransfer items (folder support). */
async function collectDroppedFiles(items: DataTransferItemList | null): Promise<File[]> {
  if (items === null) return []
  const files: File[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry === null) return
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => entry.file(resolve))
      if (file !== null) {
        if (prefix !== '') {
          const rel = `${prefix}/${file.name}`
          Object.defineProperty(file, 'relPath', { value: rel })
        }
        files.push(file)
      }
      return
    }
    if (entry.isDirectory) {
      const reader = entry.createReader()
      // readEntries returns in batches; loop until empty.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const entries = await new Promise<any[]>((resolve) => reader.readEntries(resolve))
        if (entries.length === 0) break
        for (const child of entries) await walk(child, prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      }
    }
  }
  const jobs: Promise<void>[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
    if (entry !== null) {
      jobs.push(walk(entry, ''))
    } else {
      const f = item.getAsFile()
      if (f !== null) files.push(f)
    }
  }
  await Promise.all(jobs)
  return files
}

/** Files carried by a paste event (images and files). */
function filesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  const files: File[] = []
  if (items !== undefined) {
    for (let i = 0; i < items.length; i += 1) {
      const f = items[i].getAsFile()
      if (f !== null) files.push(f)
    }
  }
  return files
}

function isImageCandidate(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name)
}

async function attachNativeImage(actions: UploadActions, normalized: NormalizedImage, policy: ImageIntakePolicy): Promise<boolean> {
  if (!actions.hasConversation()) throw new Error('conversation service unavailable')
  if (!actions.supportsNativeImages()) return false
  const existingIds = actions.imageIds()
  const existing = actions.imageBudget(existingIds)
  if (existing.count >= policy.target.maxImagesPerMessage || existing.hasInvalidSize ||
    existing.totalBytes + normalized.file.size > policy.target.maxMessageImageBytes) return false
  const ids = actions.createDraftImages([normalized.file])
  if (ids.length !== 1 || !actions.addDraftImages(ids)) {
    actions.releaseDraftImages(ids)
    return false
  }
  return true
}

async function attachFiles(actions: UploadActions, files: File[], sessionId: string, mode: 'auto' | 'file' = 'auto'): Promise<void> {
  // One capability snapshot keeps a mixed drop ordered and avoids a request
  // per file. File uploads still fall back to the legacy endpoint on old Hosts.
  let capability: UploadCapability | null | undefined
  try {
    capability = await describeV2(actions, sessionId)
  } catch {
    capability = undefined
  }
  let visualSourceBytesRemaining = capability?.imageIntake?.modelAcceptsImages === true
    ? capability.imageIntake.sourceMaxMessageBytes
    : 0
  for (const file of files) {
    try {
      const canTryNative = mode === 'auto' && isImageCandidate(file) && capability?.imageIntake?.modelAcceptsImages === true && file.size <= visualSourceBytesRemaining
      if (canTryNative) {
        visualSourceBytesRemaining -= file.size
        try {
          const normalized = await normalizeImageForPolicy(file, capability.imageIntake)
          if (await attachNativeImage(actions, normalized, capability.imageIntake)) continue
          // Busy/claimed composers cannot accept a native draft; preserve the
          // attachment as an ordinary file rather than silently dropping it.
        } catch (error) {
          // Keep the source bytes available through file-transfer-v2 when a
          // browser decoder, worker, or Host image limit cannot normalize it.
          if (error instanceof DOMException && error.name === 'AbortError') throw error
        }
      }
      await uploadFile(actions, file, sessionId, capability)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }
}

interface UploadButtonProps {
  attach: (files: File[]) => Promise<void>
  attachAsFile?: (files: File[]) => Promise<void>
  ui: UploadUi
}

function UploadButton({ attach, attachAsFile, ui }: UploadButtonProps) {
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pick = (original: boolean): void => {
    setMenuOpen(false)
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (!original) input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.style.display = 'none'
    document.body.appendChild(input)
    inputRef.current = input
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      inputRef.current = null
      if (files.length === 0) return
      setBusy(true)
      const handler = original && attachAsFile !== undefined ? attachAsFile : attach
      void handler(files).finally(() => setBusy(false))
    }
    input.click()
  }
  return (
    <div className="dsh-upload-picker">
      <ui.Hint message={busy ? '上传中…' : '添加图片或文件'} placement="top">
        <button type="button" className="dsh-upload-btn" aria-label="添加图片或文件" disabled={busy} onClick={() => setMenuOpen((value) => !value)}>
          <ui.AttachmentGlyph size={14} />
        </button>
      </ui.Hint>
      {menuOpen && !busy && (
        <div className="dsh-upload-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick(false)}>选择图片（自动适配）</button>
          <button type="button" role="menuitem" onClick={() => pick(true)}>选择文件（原样上传）</button>
        </div>
      )}
    </div>
  )
}

/** Global drag overlay + paste: drag files/folders anywhere over the window
 * or paste images/files into the composer to attach (Claude/Codex style). */
function DragOverlay({ attach }: { attach: (files: File[]) => Promise<void> }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!claimFileDrag(e)) return
      depth.current += 1
      setActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      claimFileDrag(e)
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!claimFileDrag(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!claimFileDrag(e)) return
      depth.current = 0
      setActive(false)
      void (async () => {
        // Folder support: walk dropped entries (files + directories).
        const files = await collectDroppedFiles(e.dataTransfer?.items ?? null)
        if (files.length > 0) await attach(files)
      })()
    }

    // Paste support: images/files pasted into the composer upload too.
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented) return
      const files = filesFromClipboard(e)
      if (files.length > 0 && files.some((f) => f.type.startsWith('image/') || f.type !== '')) {
        e.preventDefault()
        void attach(files)
      }
    }

    document.addEventListener('dragenter', onDragEnter, true)
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('dragenter', onDragEnter, true)
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('paste', onPaste)
    }
  }, [attach])

  return (
    <div className={`dsh-upload-overlay${active ? ' active' : ''}`}>
      <div className="dsh-upload-overlay-box">
        <div>松开以添加文件</div>
        <div className="dsh-upload-overlay-hint">文件/文件夹将上传到当前会话,agent 可读取其内容</div>
      </div>
    </div>
  )
}

interface DockProps {
  attach: (files: File[]) => Promise<void>
  actions: UploadActions
  ui: UploadUi
  sessionId: string
  input?: InputSnapshot
}

function UploadDock({ attach, actions, ui, sessionId, input = { phase: 'plain', draftRev: -1, occurrences: [] } }: DockProps) {
  const [metaVersion, setMetaVersion] = useState(0)
  const [error, setError] = useState<{ seq: number; text: string } | null>(null)

  useEffect(() => {
    const offs = [
      uploadErrors.subscribe((next) => {
        setError(next)
        setMetaVersion((v) => v + 1)
      }),
      subscribeUploadState(() => setMetaVersion((v) => v + 1))
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])

  useEffect(() => {
    const syntheticOccurrences = Array.from(refsFor(attachedUploadRefsBySession, sessionId), (ref) => ({
      source: SOURCE_NAME,
      ref
    }))
    const consumed = trackerFor(sessionId).update({
      phase: input.phase,
      draftRev: input.draftRev,
      occurrences: [...input.occurrences, ...syntheticOccurrences]
    })
    if (consumed.length > 0) consumeSubmittedDraftUploads(sessionId, consumed)
  }, [sessionId, input.phase, input.draftRev, input.occurrences])

  const removeCard = (ref: string): void => {
    const job = uploadJobs.get(ref)
    const meta = metaFor(sessionId).get(ref)
    refsFor(draftUploadRefsBySession, sessionId).delete(ref)
    refsFor(attachedUploadRefsBySession, sessionId).delete(ref)
    metaFor(sessionId).delete(ref)
    releasePreview(meta)
    if (job !== undefined) {
      if (job.retryTimer !== undefined) clearTimeout(job.retryTimer)
      job.controller.abort()
      if (job.uploadId !== undefined) {
        void actions.request(`/api/upload/v2/transfers/${encodeURIComponent(job.uploadId)}`, {
          method: 'DELETE',
          headers: { 'x-session-id': sessionId }
        }).catch(() => undefined)
      }
      uploadJobs.delete(ref)
      clearResumeRecord(sessionId, job.file)
    } else {
      if (meta?.uploadId !== undefined && meta.fallback !== true) {
        void actions.request(`/api/upload/v2/transfers/${encodeURIComponent(meta.uploadId)}`, {
          method: 'DELETE',
          headers: { 'x-session-id': sessionId }
        }).catch(() => undefined)
      } else {
        void actions.request('/api/upload', {
          method: 'DELETE',
          headers: {
            'x-session-id': sessionId,
            // Browser headers accept ByteString values only. Percent encoding
            // keeps paths containing CJK or emoji transport-safe; the Host
            // handler decodes before applying its containment check.
            'x-file-path': encodeURIComponent(ref)
          }
        }).catch(() => undefined)
      }
    }
    setMetaVersion((v) => v + 1)
  }

  const metas = metaFor(sessionId)
  const entries = Array.from(refsFor(draftUploadRefsBySession, sessionId), (ref) => {
    const meta = metas.get(ref)
    return meta === undefined ? undefined : [ref, meta] as const
  }).filter((entry): entry is readonly [string, UploadMeta] => entry !== undefined)

  return (
    <>
      {entries.length > 0 && (
        <div className="dsh-upload-dock">
          {entries.map(([ref, meta]) => {
            const badge = badgeStyle(meta.name)
            return (
              <div key={ref} className="dsh-upload-card">
                {meta.previewUrl !== undefined ? (
                  <img
                    src={meta.previewUrl}
                    alt={meta.name}
                    className="dsh-upload-thumb"
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }}
                  />
                ) : (
                  <div className="dsh-upload-badge" style={{ background: badge.bg }}>
                    {badge.ext}
                  </div>
                )}
                <div className="dsh-upload-name" title={meta.name}>
                  {meta.name}
                </div>
                <div className="dsh-upload-size">{formatBytes(meta.bytes)}</div>
                {meta.status !== 'ready' && (
                  <>
                    <div className="dsh-upload-progress" aria-label={`上传进度 ${meta.progress}%`}>
                      <i style={{ width: `${meta.progress}%` }} />
                    </div>
                    <div className="dsh-upload-status">
                      {meta.fallback === true ? '此主机不支持断点续传，请升级' : meta.status === 'uploading' ? `${meta.progress}% 上传中` : meta.status === 'verifying' ? '校验中…' : meta.status === 'paused' ? meta.error ?? '已暂停' : meta.error ?? '上传失败'}
                    </div>
                    {meta.fallback !== true && (meta.status === 'uploading' || meta.status === 'paused' || meta.status === 'error') && (
                      <button type="button" className="dsh-upload-action" onClick={() => (meta.status === 'uploading' ? pauseUpload(ref) : resumeUpload(ref))}>
                        {meta.status === 'uploading' ? '暂停' : meta.status === 'error' ? '重试' : '继续'}
                      </button>
                    )}
                  </>
                )}
                <ui.Hint message="移除" placement="top">
                  <button
                    type="button"
                    className="dsh-upload-remove"
                    aria-label="移除"
                    onClick={() => removeCard(ref)}
                  >
                    <ui.DismissGlyph size={12} />
                  </button>
                </ui.Hint>
              </div>
            )
          })}
        </div>
      )}
      {error !== null && (
        <div className="dsh-upload-error">
          <span className="dsh-upload-error-text">{error.text}</span>
          <button
            type="button"
            className="dsh-upload-remove"
            aria-label="关闭"
            onClick={() => setError(null)}
          >
            <ui.DismissGlyph size={12} />
          </button>
        </div>
      )}
      <DragOverlay attach={attach} />
    </>
  )
}

export function apply(ctx: {
  effect(setup: () => void | (() => void | Promise<void>)): unknown
  fileUploadClientInterface: {
    createInstallation(): {
      port: {
        registerInputSource(source: {
          trigger: string
          name: string
          candidates: (projection: { sessionId: string }) => Promise<Array<{ name: string; description?: string; icon?: string }>>
          onPick: (pick: { sessionId: string; candidateName: string }) => { insert: { source: string; ref: string; label: string; clipboardText: string } } | undefined
          clipboardText: (ref: string) => string
          serialize: (ref: string) => Promise<string>
        }): void
        registerSlot(slot: {
          name: string
          id: string
          order: number
          component: unknown
          propsForSession: (context: { sessionId: string; actions: UploadActions }) => Record<string, unknown>
        }): void
      }
      release(): void | Promise<void>
    }
  }
}): void {
  injectCss()
  const installation = ctx.fileUploadClientInterface.createInstallation()
  const boundary = installation.port
  try {
    ctx.effect(() => installation.release)
    boundary.registerInputSource({
        trigger: '@',
        name: SOURCE_NAME,
        // Codex-style: pick an already-uploaded file by its relative path.
        candidates: async (projection: { sessionId: string }) => {
          const metas = uploadMetaBySession.get(projection.sessionId)
          if (metas === undefined) return []
          return Array.from(metas.entries()).map(([path, meta]) => ({
            name: meta.relativePath ?? path,
            description: `${meta.label} · ${formatBytes(meta.bytes)}`,
            icon: '📎'
          }))
        },
        onPick: (pick) => {
          const metas = uploadMetaBySession.get(pick.sessionId)
          if (metas === undefined) return undefined
          for (const [path, meta] of metas.entries()) {
            if ((meta.relativePath ?? path) === pick.candidateName) {
              return {
                insert: {
                  source: SOURCE_NAME,
                  ref: path,
                  label: meta.name,
                  clipboardText: `@${meta.relativePath ?? path}`
                }
              }
            }
          }
          return undefined
        },
        clipboardText: (ref: string) => ref,
        serialize: async (ref: string) => ref
      })
    boundary.registerSlot({
      name: 'conversation.input.left',
      id: 'dsh-file-upload-button',
      order: 0,
      component: UploadButton,
      propsForSession: ({ sessionId, actions }) => ({
        sessionId,
        actions,
        ui: actions.ui,
        attach: files => attachFiles(actions, files, sessionId),
        attachAsFile: files => attachFiles(actions, files, sessionId, 'file'),
      }),
    })
    boundary.registerSlot({
      name: 'conversation.input.dock',
      id: 'dsh-file-upload-dock',
      order: 5,
      component: UploadDock,
      propsForSession: ({ sessionId, actions }) => ({
        sessionId,
        actions,
        ui: actions.ui,
        attach: files => attachFiles(actions, files, sessionId),
      }),
    })
  } catch (error) {
    try {
      const cleanup = installation.release()
      if (cleanup && typeof (cleanup as Promise<void>).then === 'function') void (cleanup as Promise<void>).catch(() => undefined)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh-file-upload: client installation failed and cleanup reported errors')
    }
    throw error
  }
}

// The client bundle must export the plugin object; esbuild iife does not write
// module.exports automatically, so assign it explicitly (banner defines the
// module variable at runtime). Mirrors the official dual-face plugin pattern.
declare const module: { exports: unknown } | undefined
if (typeof module !== 'undefined' && module !== null) {
  module.exports = {
    apply,
    inject: ['fileUploadClientInterface']
  }
}
