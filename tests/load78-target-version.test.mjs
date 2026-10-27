// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                            
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {EventEmitter} from 'node:events'
import {PassThrough,Writable} from 'node:stream'
import {BrowserHostHub,encodeCompositeId} from '../packages/browser-host-hub-rc1/src/index.js'
import * as crypto from 'node:crypto'
import * as timers from 'node:timers/promises'
import {fileURLToPath} from 'node:url'
import * as runtime from '../packages/runtime-interface/src/index.js'
import * as lazyModule from '../packages/rc1-host-carriers/src/lazy-carrier.js'
import * as streamFailure from '../packages/runtime-interface/src/stream-failure.js'
import {apply as applyMobileController} from '../packages/mobile-controller-compat-rc1/src/index.js'
import {createDispatcher} from '../packages/remote-hosts-settings-rc1/src/dispatch.js'

async function fixture(actualVersion='0.2.1-rc.2',options={}){
 const ssh=[],calls=[],versions=[],wrappedOpens=[],rawCalls=[],children=new Set(),forwards=[],life=new AbortController(),perHost=new Map(),local={getState:()=> 'connected'}
 const spawn=(_command,args)=>{
  const child=new EventEmitter();child.pid=1000+ssh.length;child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false
  child.kill=()=>{if(!closed){closed=true;children.delete(child);child.emit('close',0,null)};return true};children.add(child);ssh.push(args)
  if(args.includes('-N'))forwards.push(child);else queueMicrotask(()=>{child.stdout.end(JSON.stringify({version:1,port:3080,authenticatedRootUrl:'http://127.0.0.1:3080/?token=synthetic'}));child.kill()})
  return child
 }
 const createConnection=()=>{const socket=new EventEmitter();socket.destroy=()=>{};socket.setTimeout=()=>{};queueMicrotask(()=>socket.emit('connect'));return socket}
 const context=vm.createContext({console,AbortController,AbortSignal,URL,Map,Set,Promise,Error,TypeError,process,setTimeout,clearTimeout})
 const filename=fileURLToPath(new URL('../packages/rc1-host-carriers/src/index.js',import.meta.url)),module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename})
 const namespaces={'node:crypto':crypto,'node:child_process':{spawn},'node:net':{createConnection},'node:timers/promises':timers,'dsh-runtime-interface':runtime,'./lazy-carrier.js':lazyModule}
 await module.link(spec=>{const ns=namespaces[spec];assert.ok(ns,spec);return new vm.SyntheticModule(Object.keys(ns),function(){for(const[k,v]of Object.entries(ns))this.setExport(k,v)},{context})});await module.evaluate()
 let entryCount=0
 const createCarrier=async()=>{
  const entry=++entryCount,version=actualVersion
  return{async call(endpoint,payload,signal){
   calls.push({endpoint,payload,entry,signal})
   if(endpoint==='host.describe'){
    if(options.describe)return options.describe({entry,version,signal})
    return{ok:true,value:{version}}
   }
   if(options.failWrite&&endpoint==='session/rename')throw new Error('CARRIER_DISCONNECTED')
   if(endpoint==='hostInteractions/v1/read')return{ok:true,value:{protocolVersion:1,runtimeEpoch:'synthetic-epoch',ownerInstanceId:'synthetic-owner',revision:0,available:true,pending:[],resolved:[]}}
   return{ok:true,value:{items:[]}}
  },async *open(endpoint,payload,signal,openOptions){
   calls.push({endpoint,payload,entry,openOptions})
   yield{type:'snapshot',header:{id:'synthetic-session'},cursor:0,records:[],hasMore:false,projections:{asOfSeq:0,values:{}}}
  },async raw(path,init){rawCalls.push({path,init,entry});return new Response('opaque-native-bytes',{headers:{'content-type':'multipart/mixed; boundary=synthetic'}})}}
 }

 const runtimeInterface={...runtime,wrapHostCarrier(options){versions.push(options.upstreamVersion);const actual=runtime.wrapHostCarrier(options);return{...actual,async *open(...args){wrappedOpens.push(args[3]);yield* actual.open(...args)}}}}
 const control=module.namespace.createRemoteHostControl({seedTargets:[],perHost,localCarrier:local,lifetime:life.signal,runtimeInterface,createCarrier,WebSocket:class{}})
 let state={targets:[],removed:[]}
 const dispatch=createDispatcher({seedTargets:[],webPort:3180,configFile:'owned-config',storeFile:'RAM',readSshConfig:async()=>'',verifyAlias:async()=>{},helperReadable:()=>false,control,loadState:async()=>state,saveState:async(_p,targets,removed)=>{state={targets,removed}}})
 const result=await dispatch('add',{alias:'synthetic-home',localPort:33180,remotePort:3080});assert.equal(result.ok,true)
 return{perHost,control,dispatch,calls,versions,wrappedOpens,ssh,rawCalls,setVersion(v){actualVersion=v},closeCurrent(){forwards.at(-1).kill()},get targets(){return state.targets},async close(){life.abort();await Promise.resolve();for(const c of children)c.kill();assert.equal(children.size,0)}}
}
const listRequest={args:{workspaceFileScopeId:'synthetic-session',path:'.'}}
test('normal Dispatcher.add target uses actual 021 capability instead of a guessed legacy version',async()=>{
 const f=await fixture();try{
  assert.equal(f.targets[0].upstreamVersion,undefined,'the actual public add persists no version')
  const result=await f.perHost.get(f.targets[0].id).call('workspaceFiles/list',listRequest,new AbortController().signal)
  assert.equal(result.ok,true);assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/list').length,1)
 }finally{await f.close()}
})
test('explicit 021 wrapper control reaches the same transport and endpoint',async()=>{
 const f=await fixture();try{
  await f.control.hydrate([{...f.targets[0],upstreamVersion:'0.2.1-rc.2'}])
  const result=await f.perHost.get(f.targets[0].id).call('workspaceFiles/list',listRequest,new AbortController().signal)
  assert.equal(result.ok,true);assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/list').length,1)
  assert.equal(f.ssh.length,2,'one controlled forward and one original bootstrap helper')
 }finally{await f.close()}
})

const tick=()=>new Promise(setImmediate)
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const followRequest={args:{request:{address:{kind:'session',sessionId:'synthetic-session'}}}}
for(const version of ['0.1.2-rc.1','0.1.5-rc.2','0.2.0-rc.2','0.2.1-rc.2'])test('entry discovers exact '+version+' once and retains its basic list/follow mapping',async()=>{
 const f=await fixture(version);try{
  const c=f.perHost.get(f.targets[0].id);assert.equal(c.upstreamVersion,undefined)
  assert.equal((await c.call('session/list',{args:{}},new AbortController().signal)).ok,true)
  const it=c.open('session/follow',followRequest,new AbortController().signal,{diagnosticOwner:'consumer'});assert.equal((await it.next()).value.type,'snapshot');await it.return()
  assert.equal(c.upstreamVersion,version);assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,1)
  assert.equal(f.wrappedOpens[0].diagnosticOwner,'consumer')
  if(version!=='0.2.1-rc.2')await assert.rejects(c.call('workspaceFiles/list',listRequest,new AbortController().signal),{code:'runtime-interface/capability-unavailable'})
 }finally{await f.close()}
})
for(const mode of ['404','business','unknown'])test('optional '+mode+' metadata does not close healthy base reads or claim modern files',async()=>{
 const f=await fixture('0.2.1-rc.2',{describe:async()=>{if(mode==='404')throw new Error('CARRIER_RESULT_HTTP_404');return mode==='business'?{ok:false,error:{code:'AUXILIARY_FAILED'}}:{ok:true,value:{version:'unknown-synthetic'}}}})
 try{
  // Even an old explicit hint must not turn unproven native file capability on.
  await f.control.hydrate([{...f.targets[0],upstreamVersion:'0.2.1-rc.2'}])
  const c=f.perHost.get(f.targets[0].id);assert.equal((await c.call('session/list',{args:{}},new AbortController().signal)).ok,true)
  const it=c.open('session/follow',followRequest,new AbortController().signal);assert.equal((await it.next()).value.type,'snapshot');await it.return()
  assert.equal(c.getState(),'connected');assert.equal(c.upstreamVersion,undefined);assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,1)
  await assert.rejects(c.call('workspaceFiles/list',listRequest,new AbortController().signal),{code:'runtime-interface/capability-unavailable'})
  assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/list').length,0)
 }finally{await f.close()}
})
test('401 or genuine transport death retains its original failure and sends no business call',async()=>{
 for(const message of ['CARRIER_RESULT_HTTP_401','CARRIER_DISCONNECTED']){
  const f=await fixture('0.2.1-rc.2',{describe:async()=>{throw new Error(message)}});try{
   const c=f.perHost.get(f.targets[0].id);await assert.rejects(c.call('session/list',{args:{}},new AbortController().signal),{message});assert.equal(c.getState(),'offline');assert.equal(c.upstreamVersion,undefined);assert.equal(f.calls.length,1)
  }finally{await f.close()}
 }
})
test('caller cancellation does not cancel shared discovery or another reader',async()=>{
 const gate=deferred(),f=await fixture('0.2.1-rc.2',{describe:()=>gate.promise});try{
  const c=f.perHost.get(f.targets[0].id),cancel=new AbortController(),a=c.call('workspaceFiles/list',listRequest,cancel.signal),b=c.call('session/list',{args:{}},new AbortController().signal)
  await tick();cancel.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(c.upstreamVersion,undefined)
  gate.resolve({ok:true,value:{version:'0.2.1-rc.2'}});assert.equal((await b).ok,true);assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,1);assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/list').length,0)
 }finally{gate.resolve({ok:false});await f.close()}
})
test('late old discovery cannot replace a retried generation and reconnect rediscovers changed version',async()=>{
 const old=deferred(),f=await fixture('0.2.1-rc.2',{describe:({entry,version})=>entry===1?old.promise:Promise.resolve({ok:true,value:{version}})})
 try{
  const id=f.targets[0].id,c=f.perHost.get(id),first=c.call('session/list',{args:{}},new AbortController().signal);await tick()
  const rejected=assert.rejects(first,{name:'AbortError'});f.setVersion('0.2.0-rc.2');await f.control.retry(id);old.resolve({ok:true,value:{version:'0.2.1-rc.2'}});await rejected
  const current=f.perHost.get(id);assert.equal(current.upstreamVersion,'0.2.0-rc.2');await assert.rejects(current.call('workspaceFiles/list',listRequest,new AbortController().signal),{code:'runtime-interface/capability-unavailable'})
  f.setVersion('0.2.1-rc.2');f.closeCurrent();await tick();assert.equal(current.upstreamVersion,undefined);assert.equal((await current.call('workspaceFiles/list',listRequest,new AbortController().signal)).ok,true);assert.equal(current.upstreamVersion,'0.2.1-rc.2')
                                                                                                
  assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,4)
 }finally{old.resolve({ok:false});await f.close()}
})
class BinaryResponse extends Writable{constructor(){super();this.parts=[]}writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true}_write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}}
test('a binary first visit connects once before the original native byte relay and keeps raw bytes opaque',async()=>{
 const f=await fixture();try{
  const id=f.targets[0].id,hub=new BrowserHostHub({perHost:f.perHost,browserVersion:'0.2.1-rc.2'}),response=new BinaryResponse()
  await hub.relayWorkspaceFileBytes({type:'client-request',rpcId:'synthetic-raw',method:'workspaceFiles/readBytes',payload:{args:{workspaceFileScopeId:encodeCompositeId(id,'synthetic-session'),path:'fixture.bin'}}},response,new AbortController().signal)
  assert.equal(response.status,200);assert.equal(Buffer.concat(response.parts).toString(),'opaque-native-bytes');assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,1);assert.equal(f.rawCalls.length,1)
  assert.equal(JSON.parse(f.rawCalls[0].init.body).payload.args.workspaceFileScopeId,'synthetic-session')
 }finally{await f.close()}
})
test('interaction read remains byte-value equivalent and a lost write is never replayed',async()=>{
 const f=await fixture('0.2.1-rc.2',{failWrite:true});try{
  const c=f.perHost.get(f.targets[0].id),query={runtimeEpoch:'synthetic-epoch',afterRevision:0};assert.equal((await c.interactions.read(query,new AbortController().signal)).revision,0)
  assert.deepEqual(f.calls.find(x=>x.endpoint==='hostInteractions/v1/read').payload,query)
  await assert.rejects(c.call('session/rename',{args:{sessionId:'synthetic-session',title:'synthetic'}},new AbortController().signal),{message:'CARRIER_DISCONNECTED'})
  assert.equal(f.calls.filter(x=>x.endpoint==='session/rename').length,1);assert.equal(c.getState(),'offline')
 }finally{await f.close()}
})

class MetadataRequest extends EventEmitter{constructor(body,headers){super();this.method='POST';this.headers=headers;this.body=body;this.complete=true;this.socket={remoteAddress:'127.0.0.1'}}async *[Symbol.asyncIterator](){yield Buffer.from(this.body)}}
class MetadataResponse extends EventEmitter{writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true}end(body=''){this.body=body;this.writableEnded=true}}
test('real HTTP carrier reads the existing authenticated mobile host description envelope without a new protocol',async()=>{
 for(const mode of ['known','auxiliary-failed','malformed-metadata','auth-refused']){
  const routes=new Map(),requests=[],signal=new AbortController(),cookie='synthetic_cookie=synthetic_value'
  const boundary=runtime.createRuntimeInterface({upstreamVersion:'0.2.1-rc.2',sessionController:{canOpenWorkspacePath:async()=>false},workspaceController:{},connection:{requestRejection:req=>mode==='auth-refused'?401:req.headers.cookie===cookie?undefined:401},mobileHost:{defaultSelection:async()=>undefined,attachedCount:async()=>{if(mode==='auxiliary-failed')throw new Error('synthetic auxiliary unavailable');return 0}}})
  const cleanup=applyMobileController({runtimeInterface:boundary,webServer:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}})
  try{
   const fetch=async(input,init={})=>{
    const u=new URL(input);requests.push(u.pathname)
    if(u.pathname==='/')return new Response(null,{status:303,headers:{location:'/', 'set-cookie':cookie+'; Path=/; HttpOnly'}})
    assert.equal(u.pathname,'/api/host.describe');assert.equal(init.method,'POST')
    const headers=Object.fromEntries(new Headers(init.headers)),req=new MetadataRequest(init.body,headers),res=new MetadataResponse()
    await routes.get('/api/host.describe').handler(req,res)
    if(mode==='malformed-metadata')return new Response('{',{status:200})
    return new Response(res.body,{status:res.status,headers:res.headers})
   }
   const filename=fileURLToPath(new URL('../packages/runtime-interface/src/http-carrier.js',import.meta.url)),context=vm.createContext({fetch,Headers,URL,AbortController,AbortSignal,Buffer,console,setTimeout,clearTimeout})
   const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename})
   await module.link(spec=>{const ns=spec==='node:crypto'?crypto:spec==='./stream-failure.js'?streamFailure:undefined;assert.ok(ns,spec);return new vm.SyntheticModule(Object.keys(ns),function(){for(const[k,v]of Object.entries(ns))this.setExport(k,v)},{context})});await module.evaluate()
   const carrier=await module.namespace.createCarrier('http://127.0.0.1:33180','http://127.0.0.1:33180/?token=synthetic',class{},signal.signal)
   if(mode==='auth-refused')await assert.rejects(boundary.readHostRuntimeVersion(carrier,signal.signal),{message:'CARRIER_RESULT_HTTP_401'});else assert.equal(await boundary.readHostRuntimeVersion(carrier,signal.signal),mode==='known'?'0.2.1-rc.2':undefined)
   assert.deepEqual(requests,['/','/api/host.describe'])
   await assert.rejects(carrier.call('host.other',{},signal.signal),{message:'CARRIER_ROUTE_INVALID'})
   assert.equal(requests.length,2,'no arbitrary dotted route reached fetch')
  }finally{signal.abort();cleanup();assert.equal(routes.size,0)}
 }
})

test('a stale configured 021 hint never overrides the actual connected 020 version',async()=>{
 const f=await fixture('0.2.0-rc.2');try{
  await f.control.hydrate([{...f.targets[0],upstreamVersion:'0.2.1-rc.2'}]);const c=f.perHost.get(f.targets[0].id)
  assert.equal((await c.call('session/list',{args:{}},new AbortController().signal)).ok,true);assert.equal(c.upstreamVersion,'0.2.0-rc.2')
  await assert.rejects(c.call('workspaceFiles/list',listRequest,new AbortController().signal),{code:'runtime-interface/capability-unavailable'})
 }finally{await f.close()}
})

test('optional metadata failures keep base compatibility while authentication and cancellation still fail',async()=>{
 for(const failure of [new SyntaxError('synthetic malformed metadata'),new DOMException('synthetic metadata timeout','TimeoutError'),new Error('CARRIER_RESULT_INVALID')]){
  assert.equal(await runtime.readHostRuntimeVersion({call:async()=>{throw failure}},new AbortController().signal),undefined)
 }
 for(const failure of [new Error('CARRIER_RESULT_HTTP_401'),new Error('CARRIER_RESULT_HTTP_403'),new Error('CARRIER_DISCONNECTED')]){
  await assert.rejects(runtime.readHostRuntimeVersion({call:async()=>{throw failure}},new AbortController().signal),error=>error===failure)
 }
 const controller=new AbortController(),reason=new Error('synthetic cancelled discovery')
 await assert.rejects(runtime.readHostRuntimeVersion({call:async()=>{controller.abort(reason);throw new SyntaxError('synthetic malformed after cancellation')}},controller.signal),error=>error===reason)
})
test('the exact connected raw entry checks native capability and leaves original legacy raw routes usable',async()=>{
 for(const known of [true,false]){
  const f=await fixture(known?'0.2.0-rc.2':'0.2.1-rc.2',known?{}:{describe:async()=>({ok:false,error:{code:'AUXILIARY_FAILED'}})})
  try{
   const c=f.perHost.get(f.targets[0].id);await c.connect(new AbortController().signal)
   await assert.rejects(c.raw('/api/officeToPdf/render',{method:'POST',signal:new AbortController().signal,body:'{}'}),{code:'runtime-interface/capability-unavailable'})
   assert.equal(f.rawCalls.length,0)
   assert.equal((await c.raw('/api/upload',{method:'POST',signal:new AbortController().signal,body:'synthetic'})).ok,true);assert.equal(f.rawCalls.length,1)
  }finally{await f.close()}
 }
})
