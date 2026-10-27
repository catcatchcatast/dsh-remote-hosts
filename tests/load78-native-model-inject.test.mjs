// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                         
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {bindHostModelCatalogs} from '../packages/runtime-interface/src/client/model-catalog.js'

const native=process.env.DSH_OFFICIAL_021_ROOT,official=process.env.LOAD78_MODEL_RESOLVER_FILE
assert.ok(native&&official,'fixed actual official SDK and Root original Resolver compilation are required')
const {Context}=await import(pathToFileURL(path.join(native,'node_modules/@deepseek-ai/cordis/lib/index.js')))
const {ModelDirectoryResolver}=await import(pathToFileURL(official))
const entryFile=process.env.LOAD78_MODEL_ENTRY || fileURLToPath(new URL('../packages/runtime-interface/src/client/index.js',import.meta.url))
async function entry(errors){
 const context=vm.createContext({console,AbortController,AbortSignal,Map,Set,Promise,Error,TypeError,Symbol,TextDecoder,TextEncoder,Uint8Array,atob,btoa})
 context.__DSH_BROWSER_HOST_HUB__={}
 const module=new vm.SourceTextModule(fs.readFileSync(entryFile,'utf8'),{context,identifier:entryFile})
 await module.link(spec=>new vm.SyntheticModule(spec.includes('model-catalog')?['bindHostModelCatalogs']:spec.includes('cold-restore')?['bindColdRestoreSelection']:spec.includes('agent-presets')?['bindAgentPresetTargets']:['sanitizeStreamFailure','sanitizeTransportDiagnostic'],function(){
  if(spec.includes('model-catalog'))this.setExport('bindHostModelCatalogs',(...args)=>{try{return bindHostModelCatalogs(...args)}catch(error){errors.push(error.message);throw error}})
  else if(spec.includes('cold-restore'))this.setExport('bindColdRestoreSelection',()=>()=>{})
  else if(spec.includes('agent-presets'))this.setExport('bindAgentPresetTargets',()=>()=>{})
  else{this.setExport('sanitizeStreamFailure',()=>({}));this.setExport('sanitizeTransportDiagnostic',()=>({}))}
 },{context}));await module.evaluate();return module.namespace
}

async function verifyActualModels({existingOwn=false,laterForeign=false}={}){
 const errors=[],calls=[],plugin=await entry(errors),ctx=new Context()
 const sid='rh1.'+Buffer.from('laptop-load78').toString('base64url')+'.'+Buffer.from('synthetic-child').toString('base64url')
 const empty={default:{provider:'deepseek-official',model:'deepseek-flash'},routableProviders:[],groups:[],failures:[]}
 const catalog={default:{provider:'load78-synthetic',model:'isolated-scripted'},routableProviders:['load78-synthetic'],groups:[{id:'load78-synthetic',name:'load78-synthetic',models:[{id:'isolated-scripted',name:'synthetic'}]}],failures:[]}
 const projected={getSnapshot:()=>({next:null}),subscribe:()=>()=>{}},binding={session:{projections:{faceOf:()=>projected},getSnapshot:()=>({blank:false})}},sessionScope=ctx.extend({})
 const sessions={scope:id=>id===sid?sessionScope:undefined,binding:id=>id===sid?binding:undefined,subagentAddress:()=>undefined}
 const remote={session:{modelCatalog:async()=>({ok:true,value:empty}),selectModel:async()=>{throw new Error('write forbidden')}},$on:()=>()=>{}}
 const rpc={call:async(channel,method,payload)=>{calls.push({channel,method,payload});assert.equal(method,'session/modelCatalog');assert.equal(payload.__hostId,'laptop-load78');return{ok:true,value:catalog}}}
 let resolver,directory,owner,nativeCatalog,originalDescriptor,laterDescriptor
 try{
  const services=ctx.plugin({apply(c){c.provide('connection',{rpc});c.provide('remote',remote);c.provide('sessions',sessions)}});await services.await()
  const provider=ctx.plugin({inject:['sessions','remote'],apply(c){new ModelDirectoryResolver(c)}});await provider.await()
  const consumer=ctx.plugin({inject:['modelDirectories','sessions','remote'],apply(c){resolver=c.modelDirectories;directory=resolver.directoryFor(sid)}});await consumer.await();await new Promise(setImmediate)
  if(existingOwn)Object.defineProperty(resolver,'directoryFor',{value:Object.getPrototypeOf(resolver).directoryFor,configurable:true,enumerable:true,writable:false})
  originalDescriptor=Object.getOwnPropertyDescriptor(resolver,'directoryFor');nativeCatalog=directory.catalog
  owner=ctx.plugin({inject:[...plugin.inject],apply:plugin.apply});await owner.await();await new Promise(setImmediate);await new Promise(setImmediate)
  assert.deepEqual(errors,[],'actual Service caller scope must have sessions access')
  assert.equal(directory.store.getSnapshot().groups[0]?.id,'load78-synthetic');assert.equal(calls.length,1)
  assert.equal(resolver.directoryFor(sid),directory,'official resident identity is retained')
  assert.equal(calls.length,1,'same resident lookup shares its existing catalog')
  if(laterForeign){const foreign=()=>undefined;laterDescriptor={value:foreign,configurable:true,enumerable:true,writable:false};Object.defineProperty(resolver,'directoryFor',laterDescriptor)}
  await owner.dispose();owner=undefined
  assert.deepEqual(Object.getOwnPropertyDescriptor(resolver,'directoryFor'),laterDescriptor??originalDescriptor)
  assert.equal(directory.catalog,nativeCatalog)
 }finally{await owner?.dispose();await ctx.fiber.dispose()}
}
test('actual native Resolver resident directory rebinds and restores its original prototype method',()=>verifyActualModels())
test('actual native Resolver restores an existing own method descriptor exactly',()=>verifyActualModels({existingOwn:true}))
test('a later external method override is never removed or replaced during teardown',()=>verifyActualModels({laterForeign:true}))

test('declaring the nested model dependency keeps connection-only synchronous installation legal',async()=>{
 const errors=[],plugin=await entry(errors),ctx=new Context()
 try{
  ctx.provide('connection',{rpc:{call:async()=>{throw new Error('unexpected RPC')}}})
  const owner=ctx.plugin({inject:[...plugin.inject],apply:plugin.apply});await owner.await()
  assert.ok(ctx.get('remoteHostsInterface'));assert.deepEqual(errors,[])
 }finally{await ctx.fiber.dispose()}
})
