// Public change history: docs/PUBLIC-CHANGES.md
import { createReadStream } from 'node:fs'
// Public change history: docs/PUBLIC-CHANGES.md
import { pipeline } from 'node:stream/promises'
import { createWorkspaceFileReader, convertPreviewVideo } from 'dsh-runtime-interface'
import { previewOrigin } from './preview-origin.js'
import { htmlResources } from './html-resources.js'

export const FILE_PREVIEW_PATH = '/api/remote-hosts/file-preview'
const types = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', pdf: 'application/pdf' }
const end = (response, status, data = '') => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(data)
}

/** Multiple/unknown Range syntax falls back to a complete HTTP response. */
function byteWindow(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!match || (!match[1] && !match[2])) return undefined
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const stop = match[1] ? match[2] ? Math.min(size - 1, Number(match[2])) : size - 1 : size - 1
  return start > stop || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(stop) ? null : { start, end: stop }
}

export function createFilePreviewHandler(connection, perHost, decodeId, getCache) {
  return async (request, response) => {
    const controller = new AbortController(), abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    let lease
    try {
      const rejection = connection.ownerRequestRejection(request)
      if (rejection !== undefined) { request.resume(); end(response, rejection); return }
      const url = new URL(request.url, 'http://127.0.0.1')
      const cache = getCache()
      if (url.pathname === FILE_PREVIEW_PATH && request.method === 'POST') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const { sessionId, path, transcode, action, streamResponse } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof sessionId !== 'string' || typeof path !== 'string') { end(response, 400); return }
        const ref = decodeId(sessionId), host = perHost.get(ref.hostId)
        if (!host?.raw) { end(response, 503); return }
// Public change history: docs/PUBLIC-CHANGES.md
        if (action !== undefined) {
          if (!['open', 'reveal'].includes(action)) { end(response, 400); return }
          let target
          if (ref.hostId === 'local') {
            const reader = await createWorkspaceFileReader(host)
            try { target = (await reader.call('stat', { workspaceFileScopeId: ref.rawId, path }, controller.signal)).absolutePath }
            finally { await reader.close() }
          } else {
            const entry = await cache.prepare(ref.hostId, ref.rawId, path, () => createWorkspaceFileReader(host), controller.signal)
            target = await cache.openCopy(entry, controller.signal)
          }
          const result = await perHost.get('local').call('session/openWorkspacePath', {
            args: { request: { path: target, ...(action === 'reveal' ? { action: 'reveal' } : {}) } },
          }, controller.signal)
          if (!result.ok) throw new Error(result.error.message)
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ opened: true }))
          return
        }
        const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
        if (streamResponse === true) {
          response.writeHead(200, headers)
          response.write(' ')
        }
        let entry = await cache.prepare(ref.hostId, ref.rawId, path, () => createWorkspaceFileReader(host), controller.signal)
        const extension = entry.path.split('.').at(-1).toLowerCase()
        if (extension === 'mkv') entry = await cache.derive(entry, transcode === true ? 'h264' : 'mp4',
          (input, output, signal) => convertPreviewVideo(input, output, signal, transcode === true), controller.signal)
        const server = await previewOrigin(cache, perHost)
        const mediaUrl = server.origin + '/media/' + server.token + '?path=/' + entry.id + '.' + (extension === 'mkv' ? 'mp4' : extension)
        const originalParts = entry.path.replaceAll('\\', '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
        const htmlIndex = ['html', 'htm'].includes(extension) ? await htmlResources(cache, entry, host, controller.signal) : entry
        const htmlUrl = server.origin + '/media/' + server.token + '/html/' + htmlIndex.id + '/root/' + originalParts
        if (!response.headersSent) response.writeHead(200, headers)
        response.end(JSON.stringify({ id: entry.id, path: entry.path, bytes: entry.output?.bytes ?? entry.bytes,
          version: entry.version, mediaUrl, htmlUrl, conversion: entry.output?.conversion }))
        return
      }
      if (!['GET', 'HEAD'].includes(request.method)) { request.resume(); end(response, 405); return }
      const id = url.pathname.slice(FILE_PREVIEW_PATH.length + 1)
      lease = await cache.get(id)
      if (!lease) { end(response, 404); return }
      const bytes = lease.output?.bytes ?? lease.bytes
      const range = byteWindow(request.headers.range, bytes)
      if (range === null) {
        response.writeHead(416, { 'content-range': `bytes */${bytes}` }); response.end(); return
      }
      const headers = { 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff',
        'content-type': lease.output?.type ?? types[lease.path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(range ? range.end - range.start + 1 : bytes) }
      if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${bytes}`
      response.writeHead(range ? 206 : 200, headers)
      if (request.method === 'HEAD') response.end()
      else await pipeline(createReadStream(lease.file, range ?? {}), response, { signal: controller.signal })
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!response.headersSent) end(response, 502, error.message)
        else if (request.method === 'POST') response.end(JSON.stringify({ error: error.message || String(error) }))
        else response.destroy(error)
      }
    } finally {
      lease?.release()
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    }
  }
}
