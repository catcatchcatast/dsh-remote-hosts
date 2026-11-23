// Public change history: docs/PUBLIC-CHANGES.md
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createLoopbackServer } from './third_party/preview-media/loopback.js'
import { mediaTypeOf } from './third_party/preview-media/mime.js'

const types = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css',
  js: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2' }
const mime = file => types[file.split('.').at(-1).toLowerCase()] ?? mediaTypeOf(file)

export async function previewOrigin(cache, perHost) {
  cache.mediaReady ??= (async () => {
    const resolve = value => {
      const match = /^\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(value)
      if (!match) throw Error('预览缓存不存在')
      return match[1]
    }
    const server = createLoopbackServer({ config: { maxBytes: Number.MAX_SAFE_INTEGER, chunkBytes: 1024 * 1024 },
      fs: {
        resolve: async value => resolve(value),
        async stat(id) { const entry = await cache.get(id); if (!entry) return undefined
          try { return { type: 'file', size: entry.output?.bytes ?? entry.bytes } } finally { entry.release() } },
        async readByteRange(id, range, signal) {
          signal.throwIfAborted()
          const entry = await cache.get(id)
          if (!entry) throw Error('预览缓存不存在')
          let handle
          try { handle = await open(entry.file, 'r'); const buffer = Buffer.alloc(range.length)
            const read = await handle.read(buffer, 0, range.length, range.offset); return buffer.subarray(0, read.bytesRead)
          } finally { await handle?.close(); entry.release() }
        },
      },
      async handle(request, response, token) {
        const url = new URL(request.url, 'http://127.0.0.1'), prefix = '/media/' + token + '/html/'
        if (!url.pathname.startsWith(prefix)) return false
        if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return true }
        const [id, root, ...parts] = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
        if (root !== 'root') { response.writeHead(404); response.end(); return true }
        const source = await cache.get(id)
        if (!source) { response.writeHead(404); response.end(); return true }
        const controller = new AbortController(), abort = () => controller.abort()
        response.once('close', abort)
        let asset
        try {
          const paths = /^[A-Za-z]:|\\/.test(source.path) ? path.win32 : path.posix
          const target = paths.resolve(paths === path.win32 ? parts.join('/') : '/' + parts.join('/'))
          const resources = JSON.parse(await readFile(source.file, 'utf8'))
          if (request.method === 'HEAD') for (const cachedId of Object.values(resources)) {
            const retained = await cache.get(cachedId)
            if (!retained) { response.writeHead(404); response.end(); return true }
            retained.release()
          }
          const selected = resources[paths.normalize(target)]
          if (!selected) { response.writeHead(404); response.end(); return true }
          asset = await cache.get(selected)
          if (!asset) { response.writeHead(404); response.end(); return true }
          response.writeHead(200, { 'content-type': mime(target), 'content-length': String(asset.bytes),
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            'access-control-allow-origin': '*',
            'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; media-src 'self'; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'" })
          if (request.method === 'HEAD') response.end()
          else await pipeline(createReadStream(asset.file), response, { signal: controller.signal })
        } finally { response.removeListener('close', abort); asset?.release(); source.release() }
        return true
      },
    })
    cache.mediaServer = server
    await server.listen()
    return server
  })()
  return cache.mediaReady
}
