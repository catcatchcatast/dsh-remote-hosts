// Public change history: docs/PUBLIC-CHANGES.md
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {BrowserHostHub,encodeCompositeId,createBrowserBootstrapScript} from '../packages/browser-host-hub-rc1/src/index.js'
import {wrapHostCarrier,createRuntimeInterface,canonicalToBrowserWire} from '../packages/runtime-interface/src/index.js'
import {planResourceProvider} from './fixtures/official-plan/plan-resource.mjs'
import {planAddress} from './fixtures/official-plan/plan.mjs'

test('official plan history events route reaches its owning Host, independent of selected Host',async()=>{
 const calls=[]
 const perHost=Object.fromEntries(['local','remote-test'].map(host=>[host,{
  async call(method,payload){calls.push({host,method,payload});return{ok:true,value:{records:[],throughSeq:0,hasMore:false}}},async *open(){throw Error('unexpected stream')}
 }]))
 const hub=new BrowserHostHub({perHost,selectedHost:'local'})
 const request={address:{kind:'session',sessionId:encodeCompositeId('remote-test','same-id')},maxMessages:25}
 const result=await hub.call('session/events',{args:{request}})
 assert.equal(result.ok,true)
 assert.deepEqual(calls,[{host:'remote-test',method:'session/events',payload:{args:{request:{address:{kind:'session',sessionId:'same-id'},maxMessages:25}}}}])
})

const markdown='# 官方计划\n\n保留正文、分页和调用编号。'
function row(type='tool/call',seq=3){return{type:'event',event:{type,seq,time:30,data:{name:'exit_plan_mode',...(type==='tool/call'?{callId:'call-1',arguments:JSON.stringify({plan:markdown})}:{subCallId:'call-1',arguments:{plan:markdown}})}}}}
function fixture({type='tool/call',paged=false,failure=false}={}){
 const calls=[]
 const hub=new BrowserHostHub({selectedHost:'wrong',browserVersion:'0.2.2-rc.5',perHost:Object.fromEntries(['local','remote-test','wrong'].map(host=>[host,wrapHostCarrier({hostId:host,upstreamVersion:'0.2.2-rc.5',carrier:{
  async call(method,payload,signal){signal?.throwIfAborted();calls.push({host,method,payload,signal});if(failure)return{ok:false,error:{code:'session/not-found',message:'original native error'}};return{ok:true,value:{cursor:50,records:paged&&method==='session/events'?[{type:'event',event:{type:'assistant/message',seq:9,time:90,data:{}}}]:[row(type)],hasMore:paged&&method==='session/events'}}},async *open(){throw Error('plan read must never subscribe')}
 }})]))})
 const remote=Object.fromEntries(['events','page'].map(method=>[method,(request,signal)=>hub.call('session/'+method,{args:{request}},signal)]))
 return{hub,calls,provider:planResourceProvider(remote)}
}
for(const host of ['local','remote-test'])for(const type of ['tool/call','tool/ptc-dispatch-start','tool/ptc-dispatch'])for(const paged of [false,true])test(`actual official plan provider reads ${host}/${type}/${paged?'earlier page':'current page'}`,async()=>{
 const f=fixture({type,paged});const signal=new AbortController().signal
 const session={kind:'session',sessionId:encodeCompositeId(host,'same-id')};const url=planAddress({session,callId:'call-1'})
 const frames=await Array.fromAsync(f.provider.open(url,{signal}))
 assert.deepEqual(frames,[{ok:true,value:{title:'官方计划',markdown,callId:'call-1'}}])
 assert.deepEqual(f.calls.map(x=>[x.host,x.method]),paged?[[host,'session/events'],[host,'session/page']]:[[host,'session/events']])
 assert.deepEqual(f.calls[0].payload,{args:{request:{address:{kind:'session',sessionId:'same-id'}}}})
 if(paged)assert.deepEqual(f.calls[1].payload,{args:{request:{address:{kind:'session',sessionId:'same-id'},throughSeq:50,beforeSeq:9}}})
 assert.ok(f.calls.every(x=>x.signal===signal))
})
test('subagent plan routes both address identities without changing the call identifier',async()=>{
 const f=fixture();const session={kind:'subagent',parentSessionId:encodeCompositeId('remote-test','parent'),childSessionId:encodeCompositeId('remote-test','child'),mode:'continuable'}
 const frames=await Array.fromAsync(f.provider.open(planAddress({session,callId:'call-1'}),{signal:new AbortController().signal}))
 assert.equal(frames[0].ok,true);assert.equal(frames[0].value.callId,'call-1')
 assert.deepEqual(f.calls[0].payload.args.request.address,{kind:'subagent',parentSessionId:'parent',childSessionId:'child',mode:'continuable'})
 assert.equal(f.calls[0].host,'remote-test')
})
test('mixed Host subagent plan does not reach any carrier',async()=>{
 const f=fixture();const session={kind:'subagent',parentSessionId:encodeCompositeId('local','parent'),childSessionId:encodeCompositeId('remote-test','child'),mode:'continuable'}
 const frames=await Array.fromAsync(f.provider.open(planAddress({session,callId:'call-1'}),{signal:new AbortController().signal}))
 assert.equal(frames[0].ok,false);assert.equal(f.calls.length,0)
})
test('native error and an already-cancelled read preserve the official provider semantics',async()=>{
 const f=fixture({failure:true});const url=planAddress({session:{kind:'session',sessionId:encodeCompositeId('remote-test','same-id')},callId:'call-1'})
 const frames=await Array.fromAsync(f.provider.open(url,{signal:new AbortController().signal}));assert.equal(frames[0].error.code,'session/not-found');assert.equal(f.calls.length,1)
 const abort=new AbortController();abort.abort();assert.deepEqual(await Array.fromAsync(f.provider.open(url,{signal:abort.signal})),[]);assert.equal(f.calls.length,1)
})
test('events and page share canonical legacy history conversion and the existing runtime Session port',async()=>{
 const raw={cursor:3,records:[row('tool/call')],hasMore:false}
 const carrier=wrapHostCarrier({hostId:'local',upstreamVersion:'0.1.2-rc.1',carrier:{async call(){return{ok:true,value:structuredClone(raw)}},async *open(){}}})
 const events=await carrier.call('session/events',{args:{}});const page=await carrier.call('session/page',{args:{}})
 assert.deepEqual(events,page);assert.equal(events.value.records[0].event.sourceSeq,3)
 const service={events:async()=>raw,page:async()=>raw}
 const runtime=createRuntimeInterface({upstreamVersion:'0.2.2-rc.5',hostId:'local',sessionController:service,workspaceController:{},connection:{},subagents:{}})
 assert.equal(typeof runtime.session.events,'function')
 assert.deepEqual(await runtime.session.events({address:{kind:'session',sessionId:'same-id'}}),await runtime.session.page({address:{kind:'session',sessionId:'same-id'}}))
})
test('browser bootstrap accepts the exact official plan request and forwards it to the existing BFF',async()=>{
 const calls=[];const sandbox={location:{href:'https://browser.test/',origin:'https://browser.test'},console,URL,TextEncoder,TextDecoder,Uint8Array,WebSocket:class{},fetch:async(input,init)=>{calls.push({input,init});return{ok:true}}}
 sandbox.globalThis=sandbox;vm.runInNewContext(createBrowserBootstrapScript(),sandbox)
 const method='session/events';const payload={args:{request:{address:{kind:'session',sessionId:encodeCompositeId('remote-test','same-id')}}}}
 const result=await sandbox.__DSH_TRANSPORT__.fetch('/api/'+method,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'plan-read',method,payload})})
 assert.equal(result.ok,true);assert.equal(calls.length,1)
 assert.equal(new URL(calls[0].input).pathname,'/api/browser-host-hub-rc1/session/events')
 assert.deepEqual(JSON.parse(calls[0].init.body).payload,{...payload,__hostId:'local'})
})
test('the already-deployed Antigravity quota route keeps owning-Host identity routing',async()=>{
 const f=fixture();const result=await f.hub.call('antigravityAcp/quota',{args:{request:{sessionId:encodeCompositeId('remote-test','quota-session')}}})
 assert.equal(result.ok,true);assert.equal(f.calls[0].host,'remote-test')
 assert.equal(f.calls[0].payload.args.request.sessionId,'quota-session')
})
