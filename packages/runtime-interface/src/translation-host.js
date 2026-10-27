// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
import z from '@deepseek-ai/schemastery'
import { parseTranslationRequest, parseTranslationProjectionQuery, translationProjectionValue } from './translation-protocol.js'

const defaults={enabled:false,targetLanguage:'zh-CN',modelPath:'',stateDir:'',maxRequestBytes:64*1024,maxSegmentChars:600,maxSegments:16,requestTimeoutMs:15000,providerConcurrency:1,providerQueueLimit:24,cacheMaxBytes:100*1024*1024,cacheTtlMs:30*24*60*60*1000}
export const ThinkingTranslationConfig=z.object(Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,(typeof value==='boolean'?z.boolean():typeof value==='string'?z.string():z.number()).default(value)])))
const errors=new Set(['cancelled','credential-missing','home-unreachable','provider-busy','provider-closed','provider-failed','provider-output-invalid','provider-output-too-large','provider-process-failed','provider-timeout','provider-queue-full','game-running','gpu-busy','gpu-overloaded'])
const header=value=>Array.isArray(value)?value[0]:value
const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)
const statusFor=code=>code==='cancelled'?499:code==='provider-timeout'?504:code==='provider-queue-full'?429:['provider-busy','game-running','gpu-busy','gpu-overloaded'].includes(code)?409:503
function configValue(config={}) {
  const value={...defaults}
  for(const [key,fallback]of Object.entries(defaults)) {
    const item=config[key]??fallback
    if(typeof item!==typeof fallback)throw new TypeError(`invalid translation ${key}`)
    if(typeof fallback==='number'&&(!Number.isSafeInteger(item)||item<1))throw new RangeError(`invalid translation ${key}`)
    value[key]=item
  }
  if(value.providerConcurrency!==1)throw new RangeError('translation concurrency must be one')
  return Object.freeze(value)
}
async function readJson(req,maxBytes) {
  const chunks=[];let bytes=0
  for await(const chunk of req) { const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes)throw new RangeError('request-too-large');chunks.push(buffer) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function writeJson(res,status,value) {
  if(res.writableEnded===true)return
  const body=JSON.stringify(value);res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('content-length',String(Buffer.byteLength(body)));res.end(body)
}

/** Own all translation HTTP input, lifetime, trust checks and wire output. */
export function installThinkingTranslationHost(ctx,{config,createEngine}) {
  if(typeof createEngine!=='function')throw new TypeError('translation engine policy is required')
  const values=configValue(config),engine=createEngine(values),disposers=[],controllers=new Set()
  let active=true
  const stop=()=>{if(!active)return;active=false;for(const controller of controllers)controller.abort();for(const dispose of disposers.reverse())dispose();engine.close()}
  const register=(path,method,handle)=>disposers.push(ctx.webServer.register({kind:'exact',path,async handler(req,res) {
    if(!active)return writeJson(res,503,{error:'translation-unavailable'})
    if(!loopback(req.socket?.remoteAddress))return writeJson(res,403,{error:'loopback-only'})
    const host=header(req.headers.host),origin=header(req.headers.origin)
    if(origin!==undefined&&host!==undefined&&origin!==`http://${host}`&&origin!==`https://${host}`)return writeJson(res,403,{error:'same-origin-only'})
    if(req.method!==method)return writeJson(res,405,{error:'method-not-allowed'})
    const controller=new AbortController();controllers.add(controller)
    const aborted=()=>controller.abort(),closed=()=>{if(res.writableEnded!==true)controller.abort()}
    req.on('aborted',aborted);res.on('close',closed)
    const reply=(status,value)=>{if(active&&!controller.signal.aborted)writeJson(res,status,value)}
    try {await handle(req,reply,controller.signal)}
    catch {reply(503,{error:'provider-failed'})}
    finally {controllers.delete(controller);req.off?.('aborted',aborted);res.off?.('close',closed)}
  }}))
  const parse=async(req,reply,parser)=>{
    if(header(req.headers['content-type'])?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){reply(415,{error:'application-json-required'});return}
    try {return parser(await readJson(req,values.maxRequestBytes))}
    catch(error){reply(400,{error:error instanceof RangeError&&error.message==='request-too-large'?'request-too-large':error instanceof TypeError||error instanceof SyntaxError?'invalid-request':'request-failed'})}
  }
  try {
    register('/api/thinkingTranslation.describe','GET',async(_,reply)=>{
      const view=engine.describe()
      const stats=Object.fromEntries(['translateRequests','translated','cacheHits','rejected'].map(key=>[key,Number.isSafeInteger(view.stats?.[key])&&view.stats[key]>=0?view.stats[key]:0]))
      stats.lastError=errors.has(view.stats?.lastError)?view.stats.lastError:''
      const load=Object.fromEntries(Object.entries(view.providerLoad??{}).filter(([key,value])=>['active','queued','concurrency','queueLimit'].includes(key)&&Number.isSafeInteger(value)&&value>=0))
      reply(200,{protocolVersion:1,enabled:values.enabled,targetLanguage:values.targetLanguage,provider:typeof view.provider==='string'?view.provider:'',limits:{maxRequestBytes:values.maxRequestBytes,maxSegmentChars:values.maxSegmentChars,maxSegments:values.maxSegments},stats,providerLoad:load})
    })
    register('/api/thinkingTranslation.translate','POST',async(req,reply,signal)=>{
      engine.beginTranslate()
      if(!values.enabled)return reply(503,{error:'translation-disabled'})
      const request=await parse(req,reply,input=>parseTranslationRequest(input,values))
      if(!request)return
      if(request.targetLanguage!==values.targetLanguage)return reply(400,{error:'unsupported-target-language'})
      signal.throwIfAborted()
      const result=await engine.translate(request,signal);signal.throwIfAborted()
      if(result.ok!==true){const code=errors.has(result.error)?result.error:'provider-failed';return reply(statusFor(code),{error:code})}
      const projection=translationProjectionValue(result.projection)
      if(JSON.stringify(projection.reference)!==JSON.stringify(request.reference)||projection.targetLanguage!==request.targetLanguage||projection.translations.length!==request.segments.length||projection.translations.some((row,index)=>row.start!==request.segments[index].start||row.end!==request.segments[index].end))throw new Error('invalid translation output')
      reply(200,{...projection,cacheHit:result.cacheHit===true})
    })
    register('/api/thinkingTranslation.projections','POST',async(req,reply,signal)=>{
      const query=await parse(req,reply,parseTranslationProjectionQuery);if(!query)return
      const result=await engine.projections(query,signal);signal.throwIfAborted()
      if(!Array.isArray(result))throw new Error('invalid projection list')
      const projections=result.map(translationProjectionValue)
      if(projections.some(row=>row.reference.sessionId!==query.sessionId||row.targetLanguage!==query.targetLanguage||row.reference.throughSeq<=query.afterSeq))throw new Error('invalid projection scope')
      reply(200,{projections})
    })
    return stop
  }catch(error){stop();throw error}
}
