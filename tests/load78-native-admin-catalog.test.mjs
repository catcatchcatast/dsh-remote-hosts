// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {wrapHostCarrier} from '../packages/runtime-interface/src/index.js'
import {adminCatalogRequest,adminCatalogResult,ADMIN_CATALOG_ENDPOINTS} from '../packages/runtime-interface/src/admin-catalog-wire.js'
import {BrowserHostHub,HOST_RPC_ALLOWLIST} from '../packages/browser-host-hub-rc1/src/index.js'
const native=process.env.DSH_OFFICIAL_021_ROOT, fixturePath=process.env.DSH_NATIVE_ADMIN_RESULTS
assert.ok(native&&fixturePath)
const req=createRequire(native+'/package.json')
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'))
assert.equal(fixture.nativeDirect,true);assert.equal(fixture.bypassedOwnHub,true);assert.equal(fixture.outputs.length,3)
for(const row of fixture.outputs)assert.equal(crypto.createHash('sha256').update(JSON.stringify(row.result)).digest('hex'),row.sha256)
const official=new Map()
for(const name of ['dsh-permission-presets','dsh-plugin-manager']){
 const {TYPERT}=req('@deepseek-ai/'+name+'/typert')
 for(const descriptor of TYPERT.invocations){const endpoint=descriptor.namespace+'/'+descriptor.method;if(ADMIN_CATALOG_ENDPOINTS.includes(endpoint))official.set(endpoint,descriptor)}
}
for(const endpoint of ADMIN_CATALOG_ENDPOINTS)test(`actual native021 ${endpoint} complete response crosses original wrapper and selected-host Hub`,async()=>{
 const expected=fixture.outputs.find(row=>row.endpoint===endpoint).result
 assert.deepEqual(official.get(endpoint).result.create().parse(expected.value),expected.value,'official schema must retain the complete captured response')
 let reads=0
 const carrier=wrapHostCarrier({hostId:'local',upstreamVersion:'0.2.1-rc.2',carrier:{async call(method,payload){reads++;assert.equal(method,endpoint);assert.deepEqual(payload,{args:{}});return structuredClone(expected)},async *open(){throw Error('NO_STREAM_ALLOWED')}}})
 const hub=new BrowserHostHub({perHost:{local:carrier}})
 assert.ok(HOST_RPC_ALLOWLIST.includes(endpoint))
 const actual=await hub.call(endpoint,{args:{},__hostId:'local'})
 assert.equal(actual.ok,true,'native read must remain available through the Hub')
 assert.deepEqual(actual,expected,'all fields, values and order must survive the boundary')
 assert.equal(reads,1);assert.ok(Object.isFrozen(actual.value))
 assert.equal(crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex'),fixture.outputs.find(row=>row.endpoint===endpoint).sha256)
})
test('native administrative reads retain strict request and write allowlist boundaries',async()=>{
 let calls=0
 const raw={async call(){calls++;return{ok:true,value:[]}},async *open(){throw Error('NO_STREAM_ALLOWED')}}
 const current=wrapHostCarrier({hostId:'local',upstreamVersion:'0.2.1-rc.2',carrier:raw})
 await assert.rejects(current.call('pluginManager/listBundles',{args:{write:true}}),e=>e.code==='runtime-interface/protocol-error')
 const old=wrapHostCarrier({hostId:'old',upstreamVersion:'0.1.5-rc.2',carrier:raw})
 await assert.rejects(old.call('permissionPresets/catalog',{args:{}}),e=>e.code==='runtime-interface/capability-unavailable')
 assert.throws(()=>adminCatalogRequest('permissionPresets/catalog',{args:{}},'unknown'),e=>e.code==='runtime-interface/capability-unavailable')
 const hub=new BrowserHostHub({perHost:{local:current}})
 await assert.rejects(hub.call('pluginManager/removeBundle',{args:{name:'synthetic'},__hostId:'local'}),/not allowlisted/)
 assert.equal(calls,0)
})
test('malformed results and native refusal remain sanitized and do not leak private error details',()=>{
 assert.throws(()=>adminCatalogResult('permissionPresets/catalog',{ok:true,value:{}},'0.2.1-rc.2'),e=>e.code==='runtime-interface/protocol-error')
 assert.deepEqual(adminCatalogResult('permissionPresets/catalog',{ok:false,error:{code:'private',message:'synthetic-secret',details:{token:'synthetic-secret'}}},'0.2.1-rc.2'),{ok:false,error:{code:'runtime-interface/catalog-unavailable',message:'Administrative catalog is unavailable'}})
})


test('version admission alone would lose the actual native bundle directory fields',()=>{
 const result=fixture.outputs.find(row=>row.endpoint==='pluginManager/listBundles').result
 const old=adminCatalogResult('pluginManager/listBundles',result,'0.2.0-rc.2')
 assert.ok(result.value.some(row=>Object.hasOwn(row,'official')&&Object.hasOwn(row,'availability')))
 assert.ok(old.value.some((row,index)=>!Object.hasOwn(row,'official')&&Object.hasOwn(result.value[index],'official')))
 assert.deepEqual(adminCatalogResult('pluginManager/listBundles',result,'0.2.1-rc.2'),result)
})
test('actual published020 contracts retain all three legacy Host responses and routing',async()=>{
 const oldRoot=process.env.DSH_WEB020_RUNTIME;assert.ok(oldRoot)
 const oldReq=createRequire(oldRoot+'/package.json'),schemas=new Map()
 for(const name of ['dsh-permission-presets','dsh-plugin-manager']){
  assert.equal(oldReq('@deepseek-ai/'+name+'/package.json').version,'0.2.0-rc.2')
  for(const descriptor of oldReq('@deepseek-ai/'+name+'/typert').TYPERT.invocations){const endpoint=descriptor.namespace+'/'+descriptor.method;if(ADMIN_CATALOG_ENDPOINTS.includes(endpoint))schemas.set(endpoint,descriptor.result.create())}
 }
 let calls=0
 const expected=new Map(fixture.outputs.map(row=>[row.endpoint,{ok:true,value:schemas.get(row.endpoint).parse(row.result.value)}]))
 const carrier=wrapHostCarrier({hostId:'legacy',upstreamVersion:'0.2.0-rc.2',carrier:{async call(endpoint,payload){calls++;assert.deepEqual(payload,{args:{}});return structuredClone(expected.get(endpoint))},async *open(){throw Error('NO_STREAM_ALLOWED')}}})
 const hub=new BrowserHostHub({perHost:{legacy:carrier}})
 for(const endpoint of ADMIN_CATALOG_ENDPOINTS)assert.deepEqual(await hub.call(endpoint,{args:{},__hostId:'legacy'}),expected.get(endpoint))
 assert.equal(calls,3)
})
