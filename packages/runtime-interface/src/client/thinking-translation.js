// Public change history: docs/PUBLIC-CHANGES.md
import React, { useEffect } from 'react'
import { parseTranslationRequest, translationProjectionValue, translationLocalSessionId } from '../translation-protocol.js'

const selector='[data-variant="think"],[data-variant="bash"],[data-variant="others"]'
const publicErrors=new Set(['cancelled','credential-missing','home-unreachable','provider-busy','provider-closed','provider-failed','provider-output-invalid','provider-output-too-large','provider-process-failed','provider-timeout','provider-queue-full','game-running','gpu-busy','gpu-overloaded','invalid-request','translation-disabled','unsupported-target-language','request-too-large'])
function localSession(value) {
  if(typeof value!=='string')return null
  if(/^rh\d+\./u.test(value)) {
    const parts=value.split('.');if(parts.length!==3)return null
    try {
      const decode=text=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(text.replace(/-/gu,'+').replace(/_/gu,'/')),char=>char.charCodeAt(0)))
      if(decode(parts[1])!=='local')return null
      value=decode(parts[2])
    } catch {return null}
  }
  try {return translationLocalSessionId(value)}catch{return null}
}
function titleAndSummary(root) {
  const row=root.querySelector('[data-disclosure-row="true"]')
  const container=row?.children.item(1)
  if(!container)return {row,title:null,summary:null}
  // 0.2 puts title and summary inside the second row child. The old
  // TextShimmer node itself was that child; keep that layout supported.
  const content=container.firstElementChild
  const title=content?.firstElementChild??container
  let summary=title===container?container.nextElementSibling:title.nextElementSibling??container.nextElementSibling
  while(summary&&!(summary.textContent?.trim()))summary=summary.nextElementSibling
  return {row,title,summary}
}
function displayedParts(root) {
  const {row,title,summary}=titleAndSummary(root),parts=[]
  const expected=root.matches('[data-variant="think"]')?['Think']:['Bash','Pwsh']
  if(title&&expected.includes(title.textContent?.trim()))title.textContent=root.matches('[data-variant="think"]')?'思考':'命令'
  if(summary)parts.push(summary)
  if(root.matches('[data-variant="think"]')) {
    let body=row?.nextElementSibling
    while(body) {if(!body.contains(title)&&body.textContent?.trim()){parts.push(body);break}body=body.nextElementSibling}
  }
  return parts
}
const hash=async(text,crypto)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('')

function* translationBatches(reference,segments,limits) {
  const logical=parseTranslationRequest({reference,targetLanguage:'zh-CN',segments},{...limits,maxSegments:segments.length})
  const encoder=new TextEncoder()
  let batch=[],body=''
  for(const segment of logical.segments) {
    let next=[...batch,{...segment,index:batch.length}],text=JSON.stringify({...logical,segments:next})
    if(batch.length&&(next.length>limits.maxSegments||encoder.encode(text).byteLength>limits.maxRequestBytes)) {
      yield {segments:batch,body};batch=[]
      next=[{...segment,index:0}];text=JSON.stringify({...logical,segments:next})
    }
    if(encoder.encode(text).byteLength>limits.maxRequestBytes)throw new RangeError('request-too-large')
    batch=next;body=text
  }
  if(batch.length)yield {segments:batch,body}
}

/** A session-owned observer. Business receives stable facts and bounded actions only. */
export function observeThinkingTranslation({sessionId,createScheduler,document=globalThis.document,window=globalThis.window,fetch=globalThis.fetch,crypto=globalThis.crypto}) {
  const session=localSession(sessionId);if(session===null)return ()=>{}
  const nodes=new Map(),ids=new WeakMap(),requests=new Set(),observed=new Set()
  let active=true,nextId=0,frame,capabilityPromise
  const describeLimits=()=>{
    if(!capabilityPromise) {
      const controller=new AbortController();requests.add(controller)
      capabilityPromise=(async()=>{
        const response=await fetch('/api/thinkingTranslation.describe',{signal:controller.signal})
        const described=JSON.parse(await response.text())
        if(!response.ok)return {ok:false,status:response.status,error:publicErrors.has(described?.error)?described.error:'provider-failed'}
        const limits=described.limits
        if(!limits||['maxSegments','maxSegmentChars','maxRequestBytes'].some(key=>!Number.isSafeInteger(limits[key])||limits[key]<1))throw new TypeError('invalid translation limits')
        return {ok:true,limits}
      })().then(result=>{if(!result.ok)capabilityPromise=undefined;return result},error=>{capabilityPromise=undefined;throw error}).finally(()=>requests.delete(controller))
    }
    return capabilityPromise
  }
  const visible=root=>{const rect=root.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.bottom>=0&&rect.top<=window.innerHeight}
  const current=(id,revision)=>{const row=nodes.get(id);return active&&row&&row.revision===revision&&document.contains(row.element)&&row.element.textContent===row.source?row:null}
  const read=id=>{
    const row=nodes.get(id);if(!active||!row||!document.contains(row.element))return null
    return Object.freeze({id,source:row.source,revision:row.revision,position:row.position,running:row.root.dataset.state==='running',visible:visible(row.root)})
  }
  const port=Object.freeze({read,
    async translate({id,revision,segments},signal) {
      const row=current(id,revision);if(!row||signal?.aborted)return Object.freeze({ok:false,status:499,error:'cancelled'})
      const controller=new AbortController(),cancel=()=>controller.abort();requests.add(controller);signal?.addEventListener('abort',cancel,{once:true})
      try {
        const sourceHash=await hash(row.source,crypto);if(!current(id,revision)||controller.signal.aborted)return {ok:false,status:499,error:'cancelled'}
        const reference={sessionId:session,turn:0,step:0,blockIndex:row.position,anchorSeq:row.position,throughSeq:row.position,sourceRevision:revision,sourceHash}
        const capability=await describeLimits()
        if(!current(id,revision)||controller.signal.aborted)return {ok:false,status:499,error:'cancelled'}
        if(!capability.ok)return Object.freeze(capability)
        const limits=capability.limits
        if(segments.some(segment=>row.source.slice(segment.start,segment.end)!==segment.text))throw new TypeError('invalid source range')
        const translations=[];let fingerprint,status=200
        for(const batch of translationBatches(reference,segments,limits)) {
          if(!current(id,revision)||controller.signal.aborted)return {ok:false,status:499,error:'cancelled'}
          const response=await fetch('/api/thinkingTranslation.translate',{method:'POST',headers:{'content-type':'application/json'},body:batch.body,signal:controller.signal})
          if(!active||controller.signal.aborted||!current(id,revision))return {ok:false,status:499,error:'cancelled'}
          const text=await response.text();if(text.length>256*1024)throw new TypeError('oversized translation response')
          if(!current(id,revision)||controller.signal.aborted)return {ok:false,status:499,error:'cancelled'}
          const payload=JSON.parse(text)
          if(!response.ok)return Object.freeze({ok:false,status:response.status,error:publicErrors.has(payload?.error)?payload.error:'provider-failed'})
          const projection=translationProjectionValue(payload)
          if(JSON.stringify(projection.reference)!==JSON.stringify(reference)||projection.targetLanguage!=='zh-CN'||projection.translations.length!==batch.segments.length||projection.translations.some((item,index)=>item.start!==batch.segments[index].start||item.end!==batch.segments[index].end)||fingerprint!==undefined&&fingerprint!==projection.providerFingerprint)throw new TypeError('invalid translation response')
          fingerprint=projection.providerFingerprint;status=response.status
          if(!current(id,revision)||controller.signal.aborted)return {ok:false,status:499,error:'cancelled'}
          const offset=translations.length
          translations.push(...projection.translations.map((item,index)=>({...item,index:offset+index})))
        }
        return Object.freeze({ok:true,status,translations})
      }catch(error) {return Object.freeze({ok:false,status:controller.signal.aborted||!active?499:error instanceof RangeError&&error.message==='request-too-large'?400:0,error:controller.signal.aborted||!active?'cancelled':error instanceof RangeError&&error.message==='request-too-large'?'request-too-large':'provider-failed'})}
      finally {requests.delete(controller);signal?.removeEventListener('abort',cancel)}
    },
    commit({id,revision,translated}) {
      const row=current(id,revision);if(!row||typeof translated!=='string'||translated.length>256*1024)return false
      row.translated=translated;row.element.textContent=translated;return true
    },
  })
  const scheduler=createScheduler(port)
  const scan=()=>{
    if(!active)return
    const present=new Set(),roots=[...document.querySelectorAll(selector)]
    for(const [position,root]of roots.entries()) {
      for(const element of displayedParts(root)) {
        let id=ids.get(element),row=id===undefined?undefined:nodes.get(id),text=element.textContent??''
        if(row&&text===row.translated){present.add(id);continue}
        if(!row){id=++nextId;row={element,root,position,source:text,revision:1};ids.set(element,id);nodes.set(id,row)}
        else if(text!==row.source){row.source=text;row.translated=undefined;row.revision++}
        row.position=position;row.root=root;present.add(id);scheduler.update(read(id))
      }
      if(!observed.has(root)){observed.add(root);intersection.observe(root)}
    }
    for(const [id]of nodes)if(!present.has(id)){nodes.delete(id);scheduler.remove(id)}
    for(const root of observed)if(!document.contains(root)){intersection.unobserve(root);observed.delete(root)}
  }
  const scheduleScan=()=>{if(active&&frame===undefined)frame=window.requestAnimationFrame(()=>{frame=undefined;scan()})}
  const intersection=new window.IntersectionObserver(entries=>{if(entries.some(row=>row.isIntersecting))scheduleScan()})
  const observer=new window.MutationObserver(scheduleScan)
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-state']})
  window.addEventListener('scroll',scheduleScan,true);document.addEventListener('scroll',scheduleScan,true);scheduleScan()
  return ()=>{if(!active)return;active=false;if(frame!==undefined)window.cancelAnimationFrame(frame);observer.disconnect();intersection.disconnect();window.removeEventListener('scroll',scheduleScan,true);document.removeEventListener('scroll',scheduleScan,true);for(const controller of requests)controller.abort();scheduler.dispose();nodes.clear();observed.clear()}
}

export function createThinkingTranslationClient(slots) {
  return Object.freeze({install({createScheduler}) {
    if(typeof createScheduler!=='function')throw new TypeError('translation scheduler is required')
    const stops=new Set();let active=true,unregister
    function Observer({sessionId}) {
      useEffect(()=>{if(!active)return;const stop=observeThinkingTranslation({sessionId,createScheduler});stops.add(stop);return ()=>{stops.delete(stop);stop()}},[sessionId])
      return null
    }
    const dispose=slots.inject('conversation.input.dock',()=>{
      const remove=slots.register({name:'conversation.input.dock',id:'dsh-thinking-translation-observer',order:1000,inject:sessionId=>({sessionId})},Observer)
      unregister=remove;return ()=>{for(const stop of stops)stop();stops.clear();remove();if(unregister===remove)unregister=undefined}
    })
    return ()=>{if(!active)return;active=false;for(const stop of stops)stop();stops.clear();dispose();unregister?.()}
  }})
}
