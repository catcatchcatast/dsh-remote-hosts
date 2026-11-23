// Public change history: docs/PUBLIC-CHANGES.md
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
// Public change history: docs/PUBLIC-CHANGES.md
import { editTurnMethods, sessionAccountPath } from 'dsh-runtime-interface/http-carrier'
// Public change history: docs/PUBLIC-CHANGES.md
import { createWorkspaceFileReader, cachedWorkspaceResponse, convertPreviewOffice } from 'dsh-runtime-interface'
// Public change history: docs/PUBLIC-CHANGES.md

export const FILE_PROXY_PREFIX = '/__dsh/remote-files'
export const NATIVE_FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'
const SIDEBAR_API_METHODS = new Set(['session.cwd', 'fs.tree', 'fs.search', 'fs.read', 'fs.write'])
const MAX_SIDEBAR_JSON_BYTES = 1024 * 1024
const MAX_EDIT_JSON_BYTES = 64 * 1024 * 1024 // dsh-edit-turn sends attachment data in the edit JSON.

const routeKind = path => {
  if (path === sessionAccountPath) return 'json'
  if (editTurnMethods[path]) return editTurnMethods[path] === 'POST' ? 'json' : 'query-file'
  if (path === '/api/upload' || path.startsWith('/api/upload/v2/') || path.startsWith('/api/file-browser/v1/')) return 'header'
  if (SIDEBAR_API_METHODS.has(path.slice('/sidebar/api/'.length)) && path.startsWith('/sidebar/api/')) return 'json'
  if (path === '/sidebar/upload' || path === NATIVE_FILE_UPLOAD_PATH) return 'query-upload'
  if (path === '/sidebar/file') return 'query-file'
  return undefined
}

const finish = (request, response, status, headers = {}) => {
  request.resume()
  response.writeHead(status, headers)
  response.end()
}

async function readJson(request, signal, limit) {
  const length = Number(request.headers['content-length'])
  if (length > limit) throw new RangeError('JSON body exceeds limit')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > limit) throw new RangeError('JSON body exceeds limit')
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function headerValue(request, name) {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

function querySession(url) {
  const values = url.searchParams.getAll('sessionId')
  return values.length === 1 ? values[0] : values.length === 0 ? undefined : null
}

export function createFileProxyHandler(connection, perHost, decodeId, prefix = FILE_PROXY_PREFIX) {
  return async (request, response) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const route = url.pathname.slice(prefix.length)
      const editMethod = editTurnMethods[route]
      const accountLookup = route === sessionAccountPath
      const rejected = editMethod || accountLookup || route === NATIVE_FILE_UPLOAD_PATH ? connection.ownerRequestRejection(request) : connection.requestRejection(request)
      if (rejected !== undefined) { finish(request, response, rejected); return }
      if ((editMethod || accountLookup) && (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
        || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host))) { finish(request, response, 403); return }
      if (!url.pathname.startsWith(prefix + '/')) { finish(request, response, 404); return }
      const kind = routeKind(route)
      if (kind === undefined) { finish(request, response, 404); return }

      if (kind === 'json' && request.method !== 'POST') {
        finish(request, response, 405, { allow: 'POST' })
        return
      }
      if (kind === 'query-upload' && request.method !== 'POST') {
        finish(request, response, 405, { allow: 'POST' })
        return
      }
      if (kind === 'query-file' && request.method !== 'GET') {
        finish(request, response, 405, { allow: 'GET' })
        return
      }

      let payload
      if (kind === 'json') {
        try { payload = await readJson(request, controller.signal, editMethod ? MAX_EDIT_JSON_BYTES : MAX_SIDEBAR_JSON_BYTES) } catch (error) {
          if (controller.signal.aborted) return
          finish(request, response, editMethod && error instanceof RangeError ? 413 : 400)
          return
        }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          finish(request, response, 400)
          return
        }
      }

      const headerSession = headerValue(request, 'x-session-id')
      const queryValue = querySession(url)
      if (queryValue === null) { finish(request, response, 400); return }
      const sessionPayload = accountLookup ? payload.payload : payload
      const bodySession = kind === 'json' ? sessionPayload?.sessionId : undefined
      const value = kind === 'json' ? bodySession : kind === 'header' ? headerSession : queryValue
      if (typeof value !== 'string' || value.length === 0
        || (headerSession !== undefined && headerSession !== value)
        || (queryValue !== undefined && queryValue !== value)
        || (bodySession !== undefined && bodySession !== value)) {
        finish(request, response, 400)
        return
      }
      let ref
      try { ref = decodeId(value) } catch { finish(request, response, 400); return }
      const host = perHost.get(ref.hostId)
      if (!host?.raw) { finish(request, response, 503); return }

      const upstreamUrl = new URL(url)
      if (queryValue !== undefined) upstreamUrl.searchParams.set('sessionId', ref.rawId)
      const upstreamHeaders = { ...request.headers, 'x-session-id': ref.rawId }
      const upstreamInit = {
        method: request.method,
        headers: upstreamHeaders,
        signal: controller.signal,
      }
      if (kind === 'json') {
        const translated = { ...sessionPayload, sessionId: ref.rawId }
        const body = Buffer.from(JSON.stringify(accountLookup ? { ...payload, payload: translated } : translated))
        upstreamHeaders['content-length'] = String(body.byteLength)
        delete upstreamHeaders['transfer-encoding']
        upstreamInit.body = body
      } else if (!['GET', 'HEAD'].includes(request.method)) upstreamInit.body = request

      const upstream = await host.raw(upstreamUrl.pathname.slice(prefix.length) + upstreamUrl.search, upstreamInit)
      const responseHeaders = { 'cache-control': 'no-store' }
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag', 'upload-offset']) {
        const value = upstream.headers.get(name)
        if (value !== null) responseHeaders[name] = value
      }
      if (editMethod) {
        responseHeaders['content-type'] = 'application/json'
        responseHeaders['x-content-type-options'] = 'nosniff'
      }
      response.writeHead(upstream.status, responseHeaders)
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal })
      else response.end()
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    } finally {
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    }
  }
}

export function fileProxyBootstrap() {
  return `;(()=>{
    const original=globalThis.fetch.bind(globalThis);
    const sidebarMethods=new Set(['session.cwd','fs.tree','fs.search','fs.read','fs.write']);
    const editMethods=${JSON.stringify(editTurnMethods)};
    const accountPath=${JSON.stringify(sessionAccountPath)};
    const isRemoteId=value=>typeof value==='string'&&value.startsWith('rh1.');
    const isSidebarApi=path=>path.startsWith('/sidebar/api/')&&sidebarMethods.has(path.slice('/sidebar/api/'.length));
    const isSidebarQuery=path=>path==='/sidebar/upload'||path==='/sidebar/file';
    const isUpload=path=>path==='/api/upload'||path.startsWith('/api/upload/v2/')||path.startsWith('/api/file-browser/v1/');
    const withPrefix=url=>{url.pathname=${JSON.stringify(FILE_PROXY_PREFIX)}+url.pathname;return url};
    globalThis.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url||input.href,location.href);
      const method=String(init?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
      const headers=new Headers(init?.headers||(input instanceof Request?input.headers:input?.headers));
      const session=headers.get('x-session-id');
      if(url.origin!==location.origin) return original(input,init);
      if(isUpload(url.pathname)&&isRemoteId(session)){
        withPrefix(url);
        const request=input instanceof Request?new Request(input,init):null;
        return original(request?new Request(url,request):url,request?undefined:init);
      }
      if((isSidebarQuery(url.pathname)||editMethods[url.pathname]==='GET')&&isRemoteId(url.searchParams.get('sessionId'))){
        withPrefix(url);
        const request=input instanceof Request?new Request(input,init):null;
        return original(request?new Request(url,request):url,request?undefined:init);
      }
      if((url.pathname===accountPath||isSidebarApi(url.pathname)||editMethods[url.pathname]==='POST')&&method==='POST'){
        const request=input instanceof Request?new Request(input.clone(),init):null;
        const send=payload=>{
          if(!payload||typeof payload!=='object'||Array.isArray(payload)||!isRemoteId(url.pathname===accountPath ? payload.payload?.sessionId : payload.sessionId)) return original(input,init);
          withPrefix(url);
          const body=request?JSON.stringify(payload):init.body;
          if(request) return original(new Request(url,{method:request.method,headers:request.headers,body,signal:request.signal,credentials:request.credentials,cache:request.cache,redirect:request.redirect}));
          return original(url,{...init,body});
        };
        if(request){
          return request.clone().json().then(send,()=>original(input,init));
        }
        if(typeof init?.body!=='string') return original(input,init);
        try{return send(JSON.parse(init.body));}catch{return original(input,init)}
      }
      return original(input,init);
    };
  })();`
}

/** Exact native binary RPC relay; no multipart parse, result rewrite, or cookie forwarding. */
export async function relayWorkspaceFileBytes(perHost, hostId, message, response, signal, getCache) {
  const source = typeof perHost === 'function' ? perHost() : perHost
  const host = source instanceof Map ? source.get(hostId) : source?.[hostId]
  if (typeof host?.raw !== 'function') throw new Error('Workspace file transport is unavailable')
  signal.throwIfAborted()
  if (!['workspaceFiles/readBytes', 'officeToPdf/render'].includes(message?.method)) throw new Error('Native binary endpoint is unavailable')
  const upstream = await host.raw(message.method === 'officeToPdf/render' ? '/api/officeToPdf/render' : '/api/workspaceFiles/readBytes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal,
  })
  if (signal.aborted) { await upstream.body?.cancel(); signal.throwIfAborted() }
  if (getCache && (message.method === 'officeToPdf/render' || message.payload.args.options?.range === undefined)
    && upstream.headers.get('content-type')?.startsWith('application/json')) {
    const result = await upstream.clone().json()
    if (result.type === 'server-response' && result.rpcId === message.rpcId
      && result.result?.ok === false && (result.result.error?.code === 'workspace-file/too-large'
        || (message.method === 'officeToPdf/render' && result.result.error?.code === 'document-render/failed'
          && ['input-too-large', 'output-too-large'].includes(result.result.error.details?.reason)))) {
      await upstream.body?.cancel()
      const args = message.payload.args, cache = getCache()
      let entry = await cache.prepare(hostId, args.workspaceFileScopeId, args.path, () => createWorkspaceFileReader(host), signal, args.options?.baseFile)
      let extra = {}
      if (message.method === 'officeToPdf/render') {
        const generation = await host.call('officeToPdf/generation', { args: {} }, signal)
        if (!generation.ok) throw new Error(generation.error.message)
        const extension = entry.path.split('.').at(-1).toLowerCase()
        entry = await cache.derive(entry, 'pdf:' + cache.conversionGeneration + ':' + generation.value,
          (input, output, current) => convertPreviewOffice(input, output, extension, entry.bytes, current), signal)
        extra = { generation: cache.conversionGeneration, missingFonts: entry.output.missingFonts }
      }
      const lease = await cache.get(entry.id)
      try {
        const cached = await cachedWorkspaceResponse(lease, message.rpcId, extra)
        response.writeHead(200, cached.headers)
        await pipeline(cached.body, response, { signal })
      } finally { lease?.release() }
      return
    }
  }
  const headers = { 'cache-control': 'no-store' }
  const contentType = upstream.headers.get('content-type')
  if (contentType !== null) headers['content-type'] = contentType
  response.writeHead(upstream.status, headers)
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response, { signal })
  else response.end()
}
