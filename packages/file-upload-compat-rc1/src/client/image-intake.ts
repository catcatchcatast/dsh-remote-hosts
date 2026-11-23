// Public change history: docs/PUBLIC-CHANGES.md
/// <reference lib="dom" />
// Public change history: docs/PUBLIC-CHANGES.md

/**
 * Browser-side image intake for the native DSH composer.
 *
 * Images used as model input are deliberately different from files uploaded
 * through file-transfer-v2: this module may resize/re-encode a visual image,
 * while the file path remains available for an explicit, lossless upload.
 */

export interface ImageIntakeTarget {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  maxImageDimension: number
  mediaTypes: readonly string[]
}

export interface ImageIntakePolicy {
  version: 1
  mode: 'auto-fit'
  modelAcceptsImages: boolean
  acceptedMediaTypes: readonly string[]
  sourceMaxMessageBytes: number
  sourceMaxDimension: number
  target: ImageIntakeTarget
  policyFingerprint?: string
}

export interface NormalizedImage {
  file: File
  mediaType: string
  width: number
  height: number
  sourceBytes: number
  transformed: boolean
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_QUALITY_ATTEMPTS = [0.86, 0.76, 0.66, 0.56, 0.46]
const SCALE_ATTEMPTS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]
const MAX_DIMENSION_PROBE_BYTES = 4 * 1024 * 1024
// This is a browser resource guard, not a Host capability override. A 100 MP
// source already represents roughly 400 MiB of RGBA pixels if a decoder ignores
// resize hints; larger originals remain available through file-transfer-v2.
const MAX_SOURCE_IMAGE_PIXELS = 100_000_000
const MAX_NORMALIZATIONS = 2

export interface EncodedImageInfo {
  width: number
  height: number
  animated: boolean
}

interface NormalizationWaiter {
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

let activeNormalizations = 0
const normalizationWaiters: NormalizationWaiter[] = []

function releaseNormalization(): void {
  activeNormalizations = Math.max(0, activeNormalizations - 1)
  while (normalizationWaiters.length > 0 && activeNormalizations < MAX_NORMALIZATIONS) {
    const waiter = normalizationWaiters.shift()!
    if (waiter.signal?.aborted === true) continue
    waiter.signal?.removeEventListener('abort', waiter.abort!)
    activeNormalizations += 1
    waiter.resolve(releaseNormalization)
    break
  }
}

function acquireNormalization(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException('Image normalization cancelled', 'AbortError'))
  if (activeNormalizations < MAX_NORMALIZATIONS) {
    activeNormalizations += 1
    return Promise.resolve(releaseNormalization)
  }
  return new Promise((resolve, reject) => {
    const waiter: NormalizationWaiter = { resolve, reject, signal }
    waiter.abort = () => {
      const index = normalizationWaiters.indexOf(waiter)
      if (index >= 0) normalizationWaiters.splice(index, 1)
      reject(new DOMException('Image normalization cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', waiter.abort, { once: true })
    normalizationWaiters.push(waiter)
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Image normalization cancelled', 'AbortError')
}

function startsWith(data: Uint8Array, signature: Uint8Array): boolean {
  if (data.length < signature.length) return false
  for (let i = 0; i < signature.length; i += 1) if (data[i] !== signature[i]) return false
  return true
}

/** Do not trust a browser-provided MIME type; inspect the encoded bytes. */
export function sniffImageMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (startsWith(data, PNG)) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6 &&
    ((data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && data[4] === 0x37 && data[5] === 0x61) ||
      (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && data[4] === 0x39 && data[5] === 0x61))) return 'image/gif'
  return null
}

function skipGifSubBlocks(data: Uint8Array, start: number): number | null {
  let offset = start
  while (offset < data.length) {
    const size = data[offset++]
    if (size === 0) return offset
    if (offset + size > data.length) return null
    offset += size
  }
  return null
}

/** Count real GIF image descriptors without scanning compressed payload bytes. */
export function isAnimatedGif(data: Uint8Array, mediaType: string): boolean {
  if (mediaType !== 'image/gif' || data.length < 13 || sniffImageMediaType(data) !== 'image/gif') return false

  const logicalScreenPacked = data[10]
  const globalColorTableBytes = (logicalScreenPacked & 0x80) === 0
    ? 0
    : 3 * (1 << ((logicalScreenPacked & 0x07) + 1))
  let offset = 13 + globalColorTableBytes
  let frames = 0

  while (offset < data.length) {
    const blockType = data[offset]
    if (blockType === 0x3b) return frames > 1
    if (blockType === 0x21) {
      // Extension introducer + label, followed by one or more data sub-blocks.
      if (offset + 2 > data.length) return false
      const next = skipGifSubBlocks(data, offset + 2)
      if (next === null) return false
      offset = next
      continue
    }
    if (blockType === 0x2c) {
      // Image descriptor is ten bytes including the introducer.
      if (offset + 10 > data.length) return false
      frames += 1
      if (frames > 1) return true
      const imagePacked = data[offset + 9]
      const localColorTableBytes = (imagePacked & 0x80) === 0
        ? 0
        : 3 * (1 << ((imagePacked & 0x07) + 1))
      offset += 10 + localColorTableBytes
      if (offset >= data.length) return false
      offset += 1 // LZW minimum code size.
      const next = skipGifSubBlocks(data, offset)
      if (next === null) return false
      offset = next
      continue
    }
    // Unknown/truncated blocks are malformed rather than proof of animation.
    return false
  }
  return false
}

function readU16Be(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1]
}

function readU16Le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}

function readU24Le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
}

function readU32Be(data: Uint8Array, offset: number): number {
  return (((data[offset] << 24) >>> 0) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]) >>> 0
}

function readU32Le(data: Uint8Array, offset: number): number {
  return (data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16) + ((data[offset + 3] << 24) >>> 0)) >>> 0
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] !== 0xff) offset += 1
    while (offset < data.length && data[offset] === 0xff) offset += 1
    if (offset >= data.length) break
    const marker = data[offset++]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= data.length) break
    const length = readU16Be(data, offset)
    if (length < 2 || offset + length > data.length) break
    if (sofMarkers.has(marker) && length >= 7) {
      return { height: readU16Be(data, offset + 3), width: readU16Be(data, offset + 5) }
    }
    offset += length
  }
  return null
}

function webpDimensions(data: Uint8Array): { width: number; height: number; animated: boolean } | null {
  if (data.length < 20 || sniffImageMediaType(data) !== 'image/webp') return null
  let offset = 12
  while (offset + 8 <= data.length) {
    const tag = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    const size = readU32Le(data, offset + 4)
    const payload = offset + 8
    if (payload + Math.min(size, 10) > data.length) break
    if (tag === 'VP8X' && size >= 10) {
      return {
        width: readU24Le(data, payload + 4) + 1,
        height: readU24Le(data, payload + 7) + 1,
        animated: (data[payload] & 0x02) !== 0,
      }
    }
    if (tag === 'VP8L' && size >= 5 && data[payload] === 0x2f) {
      const bits = readU32Le(data, payload + 1)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false }
    }
    if (tag === 'VP8 ' && size >= 10 && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      return { width: readU16Le(data, payload + 6) & 0x3fff, height: readU16Le(data, payload + 8) & 0x3fff, animated: false }
    }
    offset = payload + size + (size & 1)
  }
  return null
}

/** Read encoded dimensions before invoking a browser decoder. */
export function inspectEncodedImage(data: Uint8Array, mediaType: string): EncodedImageInfo | null {
  if (mediaType === 'image/png') {
    if (data.length < 24 || !startsWith(data, PNG) || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') return null
    return { width: readU32Be(data, 16), height: readU32Be(data, 20), animated: false }
  }
  if (mediaType === 'image/gif') {
    if (data.length < 10) return null
    return { width: readU16Le(data, 6), height: readU16Le(data, 8), animated: isAnimatedGif(data, mediaType) }
  }
  if (mediaType === 'image/jpeg') {
    const dimensions = jpegDimensions(data)
    return dimensions === null ? null : { ...dimensions, animated: false }
  }
  if (mediaType === 'image/webp') return webpDimensions(data)
  return null
}

function checkSourceDimensions(info: EncodedImageInfo, policy: ImageIntakePolicy): void {
  if (info.width < 1 || info.height < 1) throw new Error('invalid image dimensions')
  if (info.width > policy.sourceMaxDimension || info.height > policy.sourceMaxDimension) {
    throw new Error('image exceeds source dimension limit; upload it as a file instead')
  }
  if (info.width * info.height > MAX_SOURCE_IMAGE_PIXELS) {
    throw new Error('image exceeds browser pixel safety limit; upload it as a file instead')
  }
}

/** Compute a bounded, aspect-ratio-preserving target size without upscaling. */
export function fitImageDimensions(width: number, height: number, target: Pick<ImageIntakeTarget, 'maxImagePixels' | 'maxImageDimension'>): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('invalid image dimensions')
  const dimensionScale = Math.min(1, target.maxImageDimension / Math.max(width, height))
  const pixelScale = Math.min(1, Math.sqrt(target.maxImagePixels / (width * height)))
  const scale = Math.min(dimensionScale, pixelScale)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  }
}

function checkPolicy(policy: ImageIntakePolicy): void {
  const target = policy.target
  for (const [name, value] of [
    ['sourceMaxMessageBytes', policy.sourceMaxMessageBytes],
    ['sourceMaxDimension', policy.sourceMaxDimension],
    ['maxImageBytes', target.maxImageBytes],
    ['maxImagesPerMessage', target.maxImagesPerMessage],
    ['maxMessageImageBytes', target.maxMessageImageBytes],
    ['maxImagePixels', target.maxImagePixels],
    ['maxImageDimension', target.maxImageDimension]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid image intake policy: ${name}`)
  }
}

function outputTypes(policy: ImageIntakePolicy, sourceType: string): string[] {
  const accepted = new Set(policy.target.mediaTypes.length > 0 ? policy.target.mediaTypes : policy.acceptedMediaTypes)
  const preferred = ['image/webp', 'image/jpeg', 'image/png']
  const result = preferred.filter((type) => accepted.has(type))
  if (result.length === 0 && accepted.has(sourceType)) result.push(sourceType)
  return result
}

function canvasFor(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') throw new Error('image canvas is unavailable')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

async function canvasBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type, quality })
  return new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality))
}

async function decodeBitmap(data: BlobPart, mediaType: string, info: EncodedImageInfo, target: ImageIntakeTarget): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('image decoder is unavailable')
  const source = data instanceof Blob ? data : new Blob([data], { type: mediaType })
  const fitted = fitImageDimensions(info.width, info.height, target)
  const resize = fitted.width !== info.width || fitted.height !== info.height
  return createImageBitmap(source, {
    imageOrientation: 'from-image',
    ...(resize ? { resizeWidth: fitted.width, resizeHeight: fitted.height, resizeQuality: 'high' as const } : {}),
  })
}

function makeFile(data: BlobPart, source: File, mediaType: string): File {
  return new File([data], source.name || 'image', { type: mediaType, lastModified: source.lastModified })
}

async function normalizeOnMainThread(file: File, policy: ImageIntakePolicy, source: BlobPart, mediaType: string, info: EncodedImageInfo): Promise<NormalizedImage> {
  const sourceFitsTarget = info.width * info.height <= policy.target.maxImagePixels &&
    Math.max(info.width, info.height) <= policy.target.maxImageDimension
  const bitmap = await decodeBitmap(source, mediaType, info, policy.target)
  try {
    const fitted = fitImageDimensions(bitmap.width, bitmap.height, policy.target)
    const withinTarget = file.size <= policy.target.maxImageBytes &&
      sourceFitsTarget
    if (withinTarget) {
      // Reuse the caller-owned File whenever its declared type already matches
      // the sniffed type. This avoids a second full-size allocation for images
      // that are already within the Host policy.
      const normalizedFile = source === file && file.type === mediaType
        ? file
        : makeFile(source, file, mediaType)
      return { file: normalizedFile, mediaType, width: bitmap.width, height: bitmap.height, sourceBytes: file.size, transformed: mediaType !== file.type }
    }
    const types = outputTypes(policy, mediaType)
    if (types.length === 0) throw new Error('Host does not accept a supported visual image format')
    for (const scale of SCALE_ATTEMPTS) {
      const width = Math.max(1, Math.floor(fitted.width * scale))
      const height = Math.max(1, Math.floor(fitted.height * scale))
      const canvas = canvasFor(width, height)
      const context = canvas.getContext('2d')
      if (context === null) continue
      // JPEG has no alpha channel; a white backing avoids black transparent
      // pixels on hosts that only accept JPEG.
      for (const type of types) {
        context.clearRect(0, 0, width, height)
        if (type === 'image/jpeg') {
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, width, height)
        }
        context.drawImage(bitmap, 0, 0, width, height)
        for (const quality of MAX_QUALITY_ATTEMPTS) {
          const blob = await canvasBlob(canvas, type, quality)
          if (blob === null || blob.size > policy.target.maxImageBytes) continue
          return {
            file: makeFile(blob, file, type),
            mediaType: type,
            width,
            height,
            sourceBytes: file.size,
            transformed: true
          }
        }
      }
    }
    throw new Error('image cannot be reduced below the Host visual image limit; upload it as a file instead')
  } finally {
    bitmap.close()
  }
}

/**
 * The worker contains no imports or credentials and only receives image bytes
 * and numeric limits. It is intentionally an optional accelerator: older
 * browsers use the identical main-thread algorithm below.
 */
function imageWorkerEntry(): void {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<Record<string, unknown>>) => void) | null
    postMessage(message: unknown, transfer?: Transferable[]): void
  }
  scope.onmessage = async (event: MessageEvent<Record<string, unknown>>) => {
    const source = event.data.source
    const type = event.data.type
    const target = event.data.target as { maxImageBytes: number; maxImagePixels: number; maxImageDimension: number; mediaTypes: string[] }
    const sourceWidth = Number(event.data.sourceWidth)
    const sourceHeight = Number(event.data.sourceHeight)
    try {
      if (!(source instanceof Blob) || typeof type !== 'string') throw new Error('invalid worker image payload')
      if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) {
        throw new Error('invalid worker image dimensions')
      }
      const dimensionScale = Math.min(1, target.maxImageDimension / Math.max(sourceWidth, sourceHeight))
      const pixelScale = Math.min(1, Math.sqrt(target.maxImagePixels / (sourceWidth * sourceHeight)))
      const sourceScale = Math.min(dimensionScale, pixelScale)
      const fittedWidth = Math.max(1, Math.floor(sourceWidth * sourceScale))
      const fittedHeight = Math.max(1, Math.floor(sourceHeight * sourceScale))
      const bitmap = await createImageBitmap(source, {
        imageOrientation: 'from-image',
        ...(sourceScale < 1 ? { resizeWidth: fittedWidth, resizeHeight: fittedHeight, resizeQuality: 'high' } : {}),
      })
      try {
        const within = source.size <= target.maxImageBytes && sourceScale >= 1
        if (within) {
          // The main thread still owns the original File. Returning a marker
          // avoids cloning the full source image back from the worker.
          scope.postMessage({ ok: true, reuseSource: true, type, width: bitmap.width, height: bitmap.height, transformed: false })
          return
        }
        const accepted = new Set(target.mediaTypes)
        const types = ['image/webp', 'image/jpeg', 'image/png'].filter((candidate) => accepted.has(candidate))
        for (const scaleAttempt of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
          const width = Math.max(1, Math.floor(fittedWidth * scaleAttempt))
          const height = Math.max(1, Math.floor(fittedHeight * scaleAttempt))
          const canvas = new OffscreenCanvas(width, height)
          const context = canvas.getContext('2d')
          if (context === null) continue
          for (const outputType of types) {
            context.clearRect(0, 0, width, height)
            if (outputType === 'image/jpeg') {
              context.fillStyle = '#ffffff'
              context.fillRect(0, 0, width, height)
            }
            context.drawImage(bitmap, 0, 0, width, height)
            for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
              const output = await canvas.convertToBlob({ type: outputType, quality })
              if (output.size > target.maxImageBytes) continue
              const outputBytes = await output.arrayBuffer()
              scope.postMessage({ ok: true, bytes: outputBytes, type: outputType, width, height, transformed: true }, [outputBytes])
              return
            }
          }
        }
        throw new Error('image cannot be reduced below the Host visual image limit; upload it as a file instead')
      } finally {
        bitmap.close()
      }
    } catch (error) {
      scope.postMessage({ ok: false, error: error instanceof Error ? error.message : 'image normalization failed' })
    }
  }
}

const WORKER_SOURCE = `(${imageWorkerEntry.toString()})()`

async function normalizeWithWorker(file: File, policy: ImageIntakePolicy, source: Blob, mediaType: string, info: EncodedImageInfo, signal?: AbortSignal): Promise<NormalizedImage> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') {
    throw new Error('worker unavailable')
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  let worker: Worker
  try {
    worker = new Worker(url)
  } catch {
    URL.revokeObjectURL(url)
    throw new Error('worker unavailable')
  }
  try {
    return await new Promise<NormalizedImage>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      const abort = (): void => finish(() => reject(new DOMException('Image normalization cancelled', 'AbortError')))
      if (signal?.aborted === true) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = () => finish(() => reject(new Error('image worker failed')))
      worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        const body = event.data
        if (body.ok !== true) {
          finish(() => reject(new Error(typeof body.error === 'string' ? body.error : 'image normalization failed')))
          return
        }
        const validMetadata = typeof body.type === 'string' && typeof body.width === 'number' && typeof body.height === 'number'
        if (!validMetadata) {
          finish(() => reject(new Error('invalid image worker response')))
          return
        }
        if (body.reuseSource === true) {
          const normalizedFile = file.type === body.type ? file : makeFile(file, file, body.type as string)
          finish(() => resolve({
            file: normalizedFile,
            mediaType: body.type as string,
            width: body.width as number,
            height: body.height as number,
            sourceBytes: file.size,
            transformed: body.transformed === true
          }))
          return
        }
        if (!(body.bytes instanceof ArrayBuffer)) {
          finish(() => reject(new Error('invalid image worker response')))
          return
        }
        finish(() => resolve({
          file: makeFile(body.bytes as ArrayBuffer, file, body.type as string),
          mediaType: body.type as string,
          width: body.width as number,
          height: body.height as number,
          sourceBytes: file.size,
          transformed: body.transformed === true
        }))
      }
      // Send the File as a structured-cloneable Blob. This lets the worker
      // decode it without first materializing a full-size ArrayBuffer here.
      try {
        worker.postMessage({
          source,
          type: mediaType,
          target: { ...policy.target, mediaTypes: [...policy.target.mediaTypes] },
          sourceWidth: info.width,
          sourceHeight: info.height,
        })
      } catch {
        finish(() => reject(new Error('image worker failed')))
      }
    })
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}

/** Normalize one visual image to the current Host's real attachment limits. */
export async function normalizeImageForPolicy(file: File, policy: ImageIntakePolicy, signal?: AbortSignal): Promise<NormalizedImage> {
  const release = await acquireNormalization(signal)
  try {
    checkPolicy(policy)
    if (file.size > policy.sourceMaxMessageBytes) throw new Error('image exceeds source message limit; upload it as a file instead')
    throwIfAborted(signal)
    const probe = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_DIMENSION_PROBE_BYTES)).arrayBuffer())
    const mediaType = sniffImageMediaType(probe)
    if (mediaType === null) throw new Error('unsupported or malformed visual image')
    if (!policy.acceptedMediaTypes.includes(mediaType) && !policy.target.mediaTypes.includes(mediaType)) throw new Error('Host does not accept this visual image format')
    const info = inspectEncodedImage(probe, mediaType)
    if (info === null) throw new Error('image dimensions could not be verified; upload it as a file instead')
    checkSourceDimensions(info, policy)
    // Animations are never flattened into a visual attachment, even when their
    // encoded bytes happen to fit the target limits.
    if (info.animated || (mediaType === 'image/gif' && file.size > MAX_DIMENSION_PROBE_BYTES)) {
      throw new Error('animated image must be uploaded as a file')
    }
    throwIfAborted(signal)
    try {
      return await normalizeWithWorker(file, policy, file, mediaType, info, signal)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      // Worker creation/feature failures use the main-thread implementation;
      // actual image-limit errors are also safe to surface to the caller.
      if (error instanceof Error && (error.message === 'worker unavailable' || error.message === 'image worker failed')) {
        return normalizeOnMainThread(file, policy, file, mediaType, info)
      }
      throw error
    }
  } finally {
    release()
  }
}
