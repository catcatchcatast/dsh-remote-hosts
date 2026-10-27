// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as hostBoundary from '../packages/runtime-interface/src/index.js'
import * as mobileSync from '../packages/mobile-session-sync-rc1/src/index.js'
const native=process.env.DSH_OFFICIAL_021_ROOT || path.resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))
assert.ok(native)
const {Context}=await import(pathToFileURL(`${native}/node_modules/@deepseek-ai/cordis/lib/index.js`).href)
const nextTurn=()=>new Promise(r=>setImmediate(r))

async function actualEntry(relative,calls,bridge) {
 const context=vm.createContext({console,AbortController,AbortSignal,Map,Set,Promise,Error,Symbol,globalThis:undefined})
 context.globalThis=context
 context.__DSH_BROWSER_HOST_HUB__=bridge
 const filename=path.resolve(relative)
 const source=fs.readFileSync(filename,'utf8')
 const exports=['bindColdRestoreSelection','bindComposerDeleteSelection','sanitizeStreamFailure','sanitizeTransportDiagnostic','createSessionShareClient','bindHostModelCatalogs','createDirectoryPickerClient','createThinkingTranslationClient','createFileUploadClientBoundary','createOfficialFileUploadClientPort','createOfficialFileUploadFetch','FileUploadUi','createWorkspaceRowsClient','createSidebarHostsClient','createSessionNavigationClient','createSessionPresentationClient','createSessionMenuClient','bindAgentPresetTargets','resolveComposerHistoryBootConfig','composerHistoryNodes','composerHistorySource','composerHistorySessionId','createElement','installSessionIndicators']
 const module=new vm.SourceTextModule(source,{context,identifier:filename})
 await module.link((spec,owner)=>{
  if(spec==='./index.js'&&owner.identifier.replaceAll('\\','/').endsWith('/client/entry.js'))return new vm.SourceTextModule(fs.readFileSync(path.join(path.dirname(owner.identifier),'index.js'),'utf8'),{context,identifier:path.join(path.dirname(owner.identifier),'index.js')})
  if(spec.includes('directory-primitives')){calls.push('legacy-directory-primitives-import');return new vm.SyntheticModule(['DirectoryButton'],function(){this.setExport('DirectoryButton',()=>{})},{context})}
  if(spec.includes('session-indicators'))calls.push('legacy-session-indicators-import')
  if(spec.includes('remote-hosts-settings'))return new vm.SyntheticModule(['inject','apply'],function(){this.setExport('inject',[]);this.setExport('apply',()=>{calls.push('settings')})},{context})
  if(spec.includes('sidebar/client'))return new vm.SyntheticModule(['createSidebarViews'],function(){this.setExport('createSidebarViews',()=>{calls.push('sidebar-factory');return {inject:[],apply(){calls.push('sidebar-mounted')}}})},{context})
  return new vm.SyntheticModule(exports,function(){for(const name of exports)this.setExport(name,(...args)=>{
   calls.push(name)
   if(name==='sanitizeStreamFailure'||name==='sanitizeTransportDiagnostic')return {}
   if(name==='bindColdRestoreSelection')return Object.assign(()=>{}, {completeBaselineAccepted:()=>true})
   if(name==='installSessionIndicators')return{dispose(){}}
   if(name.startsWith('bind'))return()=>{}
   return {}
  })},{context})
 })
 await module.evaluate()
 return module.namespace
}

function clientServices(ctx) {
 const rpc={async call(){throw new Error('no RPC is needed for entry ownership test')}}
 for(const [k,v]of Object.entries({connection:{rpc,generation:{}},sessions:{},conversation:{},uiWorkspace:{},uiSession:{},locale:{},slots:{},workspaces:{},inputTriggers:{},fileUpload:{},modelDirectories:{},remote:{$on(){return()=>{}}}}))ctx.provide(k,v)
 return rpc
}

test('native interface entry mounts no superseded UI and still publishes remote management',async()=>{
 const calls=[],ctx=new Context()
 try {
  clientServices(ctx)
  const entry=await actualEntry('packages/runtime-interface/src/client/index.js',calls,{})
  const owner=ctx.plugin({inject:[...entry.inject],apply:entry.apply})
  await owner.await();await nextTurn()
  assert.ok(ctx.get('remoteHostsInterface'))
  const forbidden=['bindComposerDeleteSelection','createSessionNavigationClient','createSessionPresentationClient','createSessionMenuClient','createWorkspaceRowsClient','createDirectoryPickerClient','createThinkingTranslationClient','createFileUploadClientBoundary','createSessionShareClient']
  assert.deepEqual(calls.filter(x=>forbidden.includes(x)),[])
  assert.ok(calls.includes('bindHostModelCatalogs'))
  assert.ok(calls.includes('bindAgentPresetTargets'))
  assert.ok(calls.includes('bindColdRestoreSelection'))
 }finally{await ctx.fiber.dispose()}
})

test('native remote entry mounts settings without even constructing the old sidebar',async()=>{
 const calls=[],ctx=new Context()
 try {
  const entry=await actualEntry('packages/remote-hosts/src/client.js',calls,{})
  await ctx.plugin({inject:[...entry.inject],apply:entry.apply})
  await nextTurn()
  assert.deepEqual(calls,['settings'])
 }finally{await ctx.fiber.dispose()}
})

test('real021 host entry activates with its original inject list',async()=>{
 const ctx=new Context(),routes=new Set()
 try {
  for(const[k,v]of Object.entries({typertGateway:{},webServer:{port:0,register(route){routes.add(route.path);return()=>routes.delete(route.path)}},sessionController:{},workspaceController:{},connection:{},subagents:{},commands:{},goals:{},agentPresets:{},sessionPersistence:{},jobController:{},appExit(){}}))ctx.provide(k,v)
  const owner=ctx.plugin(hostBoundary,{historyEpoch:{datasetId:'native-combination',sequenceFormatGeneration:4,generation:1}})
  await owner.await()
  await ctx.plugin(mobileSync)
  assert.ok(ctx.get('runtimeInterface'))
  assert.equal(routes.size,3)
 }finally{await ctx.fiber.dispose();assert.equal(routes.size,0)}
})


test('Connection-only install publishes synchronously, then binds late native services exactly once',async()=>{
 const ctx=new Context(),calls=[]
 try{
  ctx.provide('connection',{rpc:{call(){throw Error('NO_READ_EXPECTED')}}})
  const entry=await actualEntry('packages/runtime-interface/src/client/index.js',calls,{})
  const owner=ctx.plugin({inject:[...entry.inject],apply:entry.apply});await owner.await()
  assert.ok(ctx.get('remoteHostsInterface'))
  assert.equal(calls.filter(x=>x==='bindHostModelCatalogs').length,0)
  ctx.provide('modelDirectories',{});ctx.provide('remote',{$on(){return()=>{}}})
  await nextTurn();assert.equal(calls.filter(x=>x==='bindHostModelCatalogs').length,1)
  ctx.provide('slots',{});ctx.provide('sessions',{})
  await nextTurn();assert.equal(calls.filter(x=>x==='bindAgentPresetTargets').length,1)
 }finally{await ctx.fiber.dispose()}
})


test('actual tsdown entry excludes legacy indicator portal and directory primitives',async()=>{
 const calls=[],ctx=new Context()
 try{clientServices(ctx);ctx.provide('sessionPresentationInterface',{});const entry=await actualEntry('packages/runtime-interface/src/client/entry.js',calls,{});const owner=ctx.plugin({inject:[...entry.inject],apply:entry.apply});await owner.await();await nextTurn();assert.ok(ctx.get('remoteHostsInterface'));assert.deepEqual(calls.filter(x=>x.startsWith('legacy-')||x==='installSessionIndicators'),[])}finally{await ctx.fiber.dispose()}
})


async function separateHostProviders({jobs=false,exit=false,ancestorJob=false}={}) {
 const ctx=new Context(),routes=new Set(),jobReads=[],exitCalls=[]
 const job={async *list(){jobReads.push('list');yield{type:'snapshot',jobs:[]}},async *follow(){jobReads.push('follow');yield{type:'snapshot',job:{}}},kill(){throw Error('NO_JOB_WRITE_EXPECTED')}}
 if(ancestorJob)ctx.provide('jobController',job)
 const provider=ctx.plugin({name:'actual021-public-services',apply(scope){
  for(const[k,v]of Object.entries({typertGateway:{},webServer:{port:0,register(route){routes.add(route.path);return()=>routes.delete(route.path)}},sessionController:{},workspaceController:{},connection:{},subagents:{},commands:{},goals:{},agentPresets:{},sessionPersistence:{}}))scope.provide(k,v)
  if(jobs)scope.provide('jobController',job)
  if(exit)scope.provide('appExit',(...args)=>exitCalls.push(args))
 }})
 await provider.await()
 return{ctx,routes,jobReads,exitCalls,async install(){const owner=ctx.plugin(hostBoundary,{historyEpoch:{datasetId:'native-optional-services',sequenceFormatGeneration:4,generation:1}});await owner.await();assert.ok(ctx.get('runtimeInterface'),'full interface.apply must publish with original inject list');return ctx.get('runtimeInterface')},async close(){await ctx.fiber.dispose();assert.equal(routes.size,0);assert.deepEqual(exitCalls,[])}}
}

test('full actual021 interface.apply accepts a legacy Host without optional jobController or appExit',async()=>{
 const f=await separateHostProviders()
 try{const runtime=await f.install();assert.throws(()=>runtime.job.list({}),e=>e.code==='runtime-interface/capability-unavailable');assert.equal(runtime.localRuntime.status().available,false);await f.ctx.plugin(mobileSync);assert.equal(f.routes.size,3)}finally{await f.close()}
})
test('full actual021 interface.apply reads available peer-owned optional job service without undeclared property access',async()=>{
 const f=await separateHostProviders({jobs:true,exit:true})
 try{const runtime=await f.install();const read=runtime.job.list({});assert.equal((await read.next()).value.type,'snapshot');await read.return();assert.deepEqual(f.jobReads,['list']);assert.equal(runtime.localRuntime.status().available,false)}finally{await f.close()}
})
test('full actual021 interface.apply separately accepts a Host with ancestor job service but no appExit',async()=>{
 const f=await separateHostProviders({ancestorJob:true})
 try{const runtime=await f.install();assert.equal(runtime.localRuntime.status().available,false);assert.deepEqual(f.jobReads,[])}finally{await f.close()}
})
