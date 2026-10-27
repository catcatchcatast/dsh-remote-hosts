// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
const hashPattern = /^[a-f0-9]{64}$/u
const languagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u
const record = (value, label) => { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`invalid ${label}`); return value }
const natural = (value, label) => { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${label}`); return value }
export function translationLocalSessionId(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /^rh\d+\./u.test(value)) throw new TypeError('invalid local session')
  return value
}
export function translationReference(value) {
  const row=record(value,'reference')
  if (typeof row.sourceHash !== 'string' || !hashPattern.test(row.sourceHash)) throw new TypeError('invalid source hash')
  const ref={sessionId:translationLocalSessionId(row.sessionId),...Object.fromEntries(['turn','step','blockIndex','anchorSeq','throughSeq','sourceRevision'].map(key=>[key,natural(row[key],key)])),sourceHash:row.sourceHash}
  if(ref.throughSeq<ref.anchorSeq)throw new TypeError('invalid reference range')
  return Object.freeze(ref)
}
function language(value) { if(typeof value!=='string'||!languagePattern.test(value))throw new TypeError('invalid language');return value }
export function parseTranslationRequest(value, limits) {
  const row=record(value,'request'), reference=translationReference(row.reference)
  if(!Array.isArray(row.segments)||row.segments.length<1||row.segments.length>limits.maxSegments)throw new TypeError('invalid segments')
  const segments=row.segments.map((value,position)=>{
    const row=record(value,'segment'),index=natural(row.index,'index'),start=natural(row.start,'start'),end=natural(row.end,'end')
    if(index!==position||end<=start||typeof row.text!=='string'||!row.text||row.text.length>limits.maxSegmentChars||row.text.length!==end-start)throw new TypeError('invalid segment')
    return Object.freeze({index,start,end,text:row.text})
  })
  return Object.freeze({reference,targetLanguage:language(row.targetLanguage),segments:Object.freeze(segments)})
}
export function parseTranslationProjectionQuery(value) {
  const row=record(value,'projection query')
  if(!Number.isSafeInteger(row.afterSeq)||row.afterSeq < -1||typeof row.targetLanguage!=='string'||row.targetLanguage.length>32)throw new TypeError('invalid projection query')
  return Object.freeze({sessionId:translationLocalSessionId(row.sessionId),afterSeq:row.afterSeq,targetLanguage:row.targetLanguage})
}
export function translationProjectionValue(value) {
  const row=record(value,'projection'),reference=translationReference(row.reference)
  if(typeof row.providerFingerprint!=='string'||!row.providerFingerprint||row.providerFingerprint.length>1024||!Array.isArray(row.translations))throw new TypeError('invalid projection')
  const translations=row.translations.map((value,position)=>{
    const row=record(value,'translation'),index=natural(row.index,'index'),start=natural(row.start,'start'),end=natural(row.end,'end')
    if(index!==position||end<=start||typeof row.text!=='string')throw new TypeError('invalid translation')
    return Object.freeze({index,start,end,text:row.text})
  })
  if(row.cached!==undefined&&typeof row.cached!=='boolean')throw new TypeError('invalid cached flag')
  return Object.freeze({reference,targetLanguage:language(row.targetLanguage),providerFingerprint:row.providerFingerprint,translations:Object.freeze(translations),...(row.cached===undefined?{}:{cached:row.cached})})
}
