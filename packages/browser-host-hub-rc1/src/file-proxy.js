import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'


export const FILE_PROXY_PREFIX = '/__dsh/remote-files'
const SIDEBAR_API_METHODS = new Set(['session.cwd', 'fs.tree', 'fs.search', 'fs.read', 'fs.write'])
const MAX_SIDEBAR_JSON_BYTES = 1024 * 1024

const routeKind = path => {
  if (path === '/api/upload' || path.startsWith('/api/upload/v2/') || path.startsWith('/api/file-browser/v1/')) return 'header'
  if (SIDEBAR_API_METHODS.has(path.slice('/sidebar/api/'.length)) && path.startsWith('/sidebar/api/')) return 'json'
  if (path === '/sidebar/upload') return 'query-upload'
  if (path === '/sidebar/file') return 'query-file'
  return undefined
}

const finish = (request, response, status, headers = {}) => {
  request.resume()
  response.writeHead(status, headers)
  response.end()
}

async function readJson(request, signal) {
  const length = Number(request.headers['content-length'])
  if (Number.isFinite(length) && length > MAX_SIDEBAR_JSON_BYTES) throw new Error('sidebar JSON body exceeds limit')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > MAX_SIDEBAR_JSON_BYTES) throw new Error('sidebar JSON body exceeds limit')
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

export function createFileProxyHandler(connection, perHost, decodeId) {
  return async (request, response) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const rejected = connection.requestRejection(request)
      if (rejected !== undefined) { finish(request, response, rejected); return }
      const url = new URL(request.url, 'http://127.0.0.1')
      const route = url.pathname.slice(FILE_PROXY_PREFIX.length)
      if (!url.pathname.startsWith(FILE_PROXY_PREFIX + '/')) { finish(request, response, 404); return }
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
        try { payload = await readJson(request, controller.signal) } catch (error) {
          if (controller.signal.aborted) return
          finish(request, response, 400)
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
      const bodySession = kind === 'json' ? payload.sessionId : undefined
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
        const body = Buffer.from(JSON.stringify({ ...payload, sessionId: ref.rawId }))
        upstreamHeaders['content-length'] = String(body.byteLength)
        delete upstreamHeaders['transfer-encoding']
        upstreamInit.body = body
      } else if (!['GET', 'HEAD'].includes(request.method)) upstreamInit.body = request

      const upstream = await host.raw(upstreamUrl.pathname.slice(FILE_PROXY_PREFIX.length) + upstreamUrl.search, upstreamInit)
      const responseHeaders = { 'cache-control': 'no-store' }
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag', 'upload-offset']) {
        const value = upstream.headers.get(name)
        if (value !== null) responseHeaders[name] = value
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
      if(isSidebarQuery(url.pathname)&&isRemoteId(url.searchParams.get('sessionId'))){
        withPrefix(url);
        const request=input instanceof Request?new Request(input,init):null;
        return original(request?new Request(url,request):url,request?undefined:init);
      }
      if(isSidebarApi(url.pathname)&&method==='POST'){
        const request=input instanceof Request?new Request(input.clone(),init):null;
        const send=payload=>{
          if(!payload||typeof payload!=='object'||Array.isArray(payload)||!isRemoteId(payload.sessionId)) return original(input,init);
          withPrefix(url);
          const body=JSON.stringify(payload);
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
