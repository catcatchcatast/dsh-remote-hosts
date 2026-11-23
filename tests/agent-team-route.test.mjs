// Public change history: docs/PUBLIC-CHANGES.md
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {BrowserHostHub,encodeCompositeId,createBrowserBootstrapScript,mapControlFrame,mapSessionFollowFrame} from '../packages/browser-host-hub-rc1/src/index.js'
import {wrapHostCarrier,scopeProjection} from '../packages/runtime-interface/src/index.js'

const endpoint='agentTeams/setEnabled'
const sdk=process.env.DSH_OFFICIAL_021_ROOT
const require=createRequire(sdk+'/node_modules/@deepseek-ai/dsh/package.json')
const descriptor=require('@deepseek-ai/dsh-agent-team/typert').TYPERT.invocations.find(x=>x.namespace+'/'+x.method===endpoint)
const subagentSource=fs.readFileSync(sdk+'/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js','utf8')
const team={enabled:true,tasks:[{id:'task-1',revision:2,subject:'same child',description:'opaque',status:'pending',ownerId:'child',ownerName:'worker',blockedBy:['task-0'],writeScopes:['src/child'],ready:false,writeScopeWarnings:[]}],failure:undefined}
const block=()=>({kind:'sequenced',asOfSeq:7,values:{agentTeam:structuredClone(team),subagentCatalog:[{id:'child',mode:'continuable',label:'worker'}],inbox:{'next-turn':[{id:'message-1',role:'user',content:[]}],'next-step':[]}}})
function fixture({failure=false,afterWrite=false}={}){
 const calls=[],state={local:false,alpha:false,beta:false}
 const perHost=Object.fromEntries(Object.keys(state).map(host=>[host,wrapHostCarrier({hostId:host,upstreamVersion:'0.2.2-rc.5',carrier:{
  async call(method,payload,signal){
   signal?.throwIfAborted()
   calls.push({host,method,payload})
   if(method==='session/projections')return{ok:true,value:block()}
   assert.equal(method,endpoint)
   assert.equal(payload.args.agentId,'root')
   descriptor.parameters[1].codec.create().parse(payload.args.enabled)
   if(failure)return{ok:false,error:{code:'TEAM_LEAD_REQUIRED',message:'change Team mode from the root Session'}}
   state[host]=payload.args.enabled
   if(afterWrite)throw Object.assign(new Error('accepted connection ended'),{code:'ECONNRESET'})
   return{ok:true,value:undefined}
  },async *open(){throw Error('unexpected stream')}
 }} )]))
 return{hub:new BrowserHostHub({perHost,selectedHost:'local',baseUrl:'http://dsh.invalid/'}),calls,state}
}
test('actual rc3 descriptor is one direct scoped void mutation',()=>{
 assert.equal(descriptor.invocation.kind,'direct')
 assert.equal(descriptor.scope.wire,'agentId')
 assert.deepEqual(descriptor.parameters.map(x=>x.wire),['agentId','enabled'])
 assert.equal(descriptor.parameters[1].codec.create().safeParse(false).success,true)
 assert.equal(descriptor.parameters[1].codec.create().safeParse('false').success,false)
})
for(const host of ['local','alpha','beta'])test(`same raw root, selected beta: only ${host} receives both true and false`,async()=>{
 const {hub,calls,state}=fixture()
 for(const enabled of [true,false]){
  const result=await hub.call(endpoint,{__hostId:'beta',args:{agentId:encodeCompositeId(host,'root'),enabled}})
  assert.equal(result.ok,true)
  assert.deepEqual(calls.at(-1),{host,method:endpoint,payload:{args:{agentId:'root',enabled}}})
  assert.equal(state[host],enabled)
 }
 assert.equal(calls.length,2)
})
test('malformed and unavailable composite identities never reach another Host',async()=>{
 const {hub,calls}=fixture()
 for(const id of ['rh1.bad',encodeCompositeId('missing','root')]){
  const result=await hub.call(endpoint,{__hostId:'local',args:{agentId:id,enabled:true}})
  assert.equal(result.ok,false)
 }
 assert.equal(calls.length,0)
})
test('official refusal and a failed accepted write are returned once without replay',async()=>{
 for(const options of [{failure:true},{afterWrite:true}]){
  const {hub,calls,state}=fixture(options)
  const result=await hub.call(endpoint,{args:{agentId:encodeCompositeId('alpha','root'),enabled:true}})
  assert.equal(result.ok,false)
  if(options.failure)assert.equal(result.error.code,'TEAM_LEAD_REQUIRED')
  else assert.equal(state.alpha,true)
  assert.equal(calls.length,1)
 }
})
test('already cancelled selection cannot write to the Host',async()=>{
 const {hub,calls}=fixture(),life=new AbortController();life.abort()
 const result=await hub.call(endpoint,{args:{agentId:encodeCompositeId('alpha','root'),enabled:true}},life.signal)
 assert.equal(result.ok,false);assert.equal(calls.length,0)
})
test('generated browser transport uses the same Hub route and original rpc envelope',async()=>{
 const {hub,calls}=fixture();const native=[]
 const context=vm.createContext({URL,Headers,Request,Response,TextEncoder,TextDecoder,AbortController,AbortSignal,crypto:globalThis.crypto,console,
  location:{origin:'http://dsh.invalid',href:'http://dsh.invalid/'},fetch:async(input,init)=>{native.push({url:String(input),body:JSON.parse(init.body)});return hub.fetch(String(input),init)},
  setTimeout:()=>0,clearTimeout(){},WebSocket:class{},addEventListener(){},removeEventListener(){}})
 vm.runInContext(createBrowserBootstrapScript({apiPrefix:'/api',hosts:[{hostId:'local',label:'Local'},{hostId:'alpha',label:'Alpha'}]}),context)
 const response=await context.__DSH_TRANSPORT__.fetch('http://dsh.invalid/api/'+endpoint,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'same-rpc',method:endpoint,payload:{args:{agentId:encodeCompositeId('alpha','root'),enabled:false}}})})
 const result=await response.json();assert.equal(result.rpcId,'same-rpc');assert.equal(result.result.ok,true)
 assert.equal(native.length,1);assert.equal(native[0].body.method,endpoint);assert.equal(calls[0].host,'alpha')
})
function officialDirectoryConsumer(parent,projection,host){
 const child=encodeCompositeId(host,'child'),reads=[],opens=[]
 const state={projectionsBySession:{[parent]:{state:'ready',...projection}},byId:{[child]:{running:true}}}
 const ctx={sessions:{refreshProjections:async id=>reads.push(id),list:{getSnapshot:()=>state}}}
 const a=subagentSource.indexOf('async prepareCatalog(parentSessionId){'),b=subagentSource.indexOf(',refreshProjection(parentSessionId)',a)
 assert(a>=0&&b>a,'official prepareCatalog anchor')
 const actions=new Function('ctx','return ({'+subagentSource.slice(a,b)+'})')(ctx)
 const k=subagentSource.indexOf('const catalogs=(0,react.useMemo)(()=>{return '),j=subagentSource.indexOf('},[projections,summaries,statuses]);',k)
 assert(k>=0&&j>k,'official catalog status anchor')
 const catalogs=new Function('projections','summaries','statuses',subagentSource.slice(k+'const catalogs=(0,react.useMemo)(()=>{'.length,j))(state.projectionsBySession,state.byId,new Map([[child,{running:true}]]))
 const openAt=subagentSource.indexOf('const open=()=>{if(external)return;openChild('),openEnd=subagentSource.indexOf(';const handleKey=',openAt)
 assert(openAt>=0&&openEnd>openAt,'official open member anchor')
 const entry=catalogs[parent].entries[0]
 const open=new Function('external','openChild','parentSessionId','entry','closeCatalog',subagentSource.slice(openAt,openEnd)+';return open;')(false,address=>opens.push(address),parent,entry,()=>{})
 open()
 return actions.prepareCatalog(parent).then(()=>({reads,opens,entry,child}))
}
for(const host of ['alpha','beta'])test(`official members consumer routes reads, running status and navigation for ${host}`,async()=>{
 const {hub}=fixture(),parent=encodeCompositeId(host,'root')
 const result=await hub.call('session/projections',{args:{request:{sessionId:parent}}})
 assert.equal(result.ok,true)
 const actual=await officialDirectoryConsumer(parent,result.value,host)
 assert.deepEqual(actual.reads,[parent,actual.child]);assert.equal(actual.entry.activity,'running')
 assert.deepEqual(actual.opens,[{parentSessionId:parent,childSessionId:actual.child,mode:'continuable'}])
 assert.deepEqual(result.value.values.agentTeam,team)
})
test('query, baseline, delta and history preserve the same members and opaque team task board',()=>{
 for(const host of ['alpha','beta']){
  const parent=encodeCompositeId(host,'root'),input=block(),wanted=encodeCompositeId(host,'child')
  const scoped=scopeProjection(input,host,{encodeCompositeId})
  assert.equal(scoped.values.subagentCatalog[0].id,wanted)
  assert.equal(scoped.values.inbox['next-turn'][0].id,encodeCompositeId(host,'message-1'))
  const baseline=mapControlFrame({type:'baseline',value:{projections:{root:input}}},host)
  assert.deepEqual(baseline.value.projections[parent],scoped)
  const follow=mapSessionFollowFrame({type:'snapshot',header:{id:'root'},projections:input},host)
  assert.deepEqual(follow.projections,scoped)
  const delta=mapControlFrame({type:'projection',sessionId:'root',seq:8,key:'subagentCatalog',value:input.values.subagentCatalog},host)
  assert.equal(delta.sessionId,parent);assert.equal(delta.seq,8);assert.deepEqual(delta.value,scoped.values.subagentCatalog)
  const board=mapControlFrame({type:'projection',sessionId:'root',seq:9,key:'agentTeam',value:team},host)
  assert.deepEqual(board.value,team);assert.equal(board.seq,9)
  assert.deepEqual(input,block(),'upstream DTO is not mutated')
 }
})
