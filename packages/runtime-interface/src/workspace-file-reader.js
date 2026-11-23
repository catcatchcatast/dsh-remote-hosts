// Public change history: docs/PUBLIC-CHANGES.md
import { Readable } from 'node:stream'
import { openAsBlob } from 'node:fs'

export async function createWorkspaceFileReader(host) {
  const [{ Context }, { installConnection }] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-client-connection/client'),
  ])
  const ctx = new Context()
  installConnection(ctx, { interactions: 'none', transport: {
    fetch: (endpoint, init) => host.raw('/' + endpoint, init),
  } })
  return {
    async call(method, args, signal) {
      const result = method === 'stat'
        ? await host.call('workspaceFiles/stat', { args }, signal)
        : await ctx.get('connection').rpc.call('/api', 'workspaceFiles/' + method, { args }, signal)
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
      return result.value
    },
    close: () => ctx.fiber.dispose(),
  }
}

/** Keep the existing bytes-complete renderer and its original resource identity. */
export async function cachedWorkspaceResponse(entry, rpcId, extra = {}) {
  const form = new FormData()
  form.set('metadata', JSON.stringify({ type: 'server-response', rpcId,
    result: { ok: true, value: { absolutePath: entry.path, version: entry.version,
      bytes: entry.output?.bytes ?? entry.bytes, offset: 0, data: null, eof: true, ...extra } },
    attachments: [{ path: ['data'], part: 'data', codec: 'bytes' }],
  }))
  form.set('data', await openAsBlob(entry.file), 'data')
  const response = new Response(form)
  return { headers: { 'content-type': response.headers.get('content-type'), 'cache-control': 'no-store' },
    body: Readable.fromWeb(response.body) }
}
