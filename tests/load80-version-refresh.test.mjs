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
  const entry=++entryCount
  return{async call(endpoint,payload,signal){
   const version=actualVersion; calls.push({endpoint,payload,entry,signal})
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

 const runtimeInterface={...runtime,wrapHostCarrier(options){versions.push(options.upstreamVersion);const actual=runtime.wrapHostCarrier(options);return{...actual,get upstreamVersion(){return actual.upstreamVersion},async *open(...args){wrappedOpens.push(args[3]);yield* actual.open(...args)}}}}
 const control=module.namespace.createRemoteHostControl({seedTargets:[],perHost,localCarrier:local,lifetime:life.signal,runtimeInterface,createCarrier,WebSocket:class{}})
 let state={targets:[],removed:[]}
 const dispatch=createDispatcher({seedTargets:[],webPort:3180,configFile:'owned-config',storeFile:'RAM',readSshConfig:async()=>'',verifyAlias:async()=>{},helperReadable:()=>false,control,loadState:async()=>state,saveState:async(_p,targets,removed)=>{state={targets,removed}}})
 const result=await dispatch('add',{alias:'synthetic-home',localPort:33180,remotePort:3080});assert.equal(result.ok,true)
 return{perHost,control,dispatch,calls,versions,wrappedOpens,ssh,rawCalls,setVersion(v){actualVersion=v},closeCurrent(){forwards.at(-1).kill()},get targets(){return state.targets},async close(){life.abort();await Promise.resolve();for(const c of children)c.kill();assert.equal(children.size,0)}}
}

const signal=()=>new AbortController().signal;
const payload=id=>({args:{workspaceFileScopeId:encodeCompositeId(id,'synthetic-session'),path:'test.md'}});
test('same live SSH entry upgraded 020 to 021 permits the first real Hub text preview without reconnect',async()=>{
 const f=await fixture('0.2.0-rc.2');try{
  const id=f.targets[0].id,c=f.perHost.get(id),hub=new BrowserHostHub({perHost:f.perHost,browserVersion:'0.2.1-rc.2'});
  await c.call('session/list',{args:{}},signal());assert.equal(c.upstreamVersion,'0.2.0-rc.2');f.setVersion('0.2.1-rc.2');
  const result=await hub.call('workspaceFiles/read',payload(id),signal());
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(c.upstreamVersion,'0.2.1-rc.2');
  assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,1);
  assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,2);
  assert.equal(f.ssh.filter(x=>x.includes('-N')).length,1);
 }finally{await f.close()}
});
test('unknown first description can be re-confirmed by a later native preview without cancelling base reads',async()=>{
 let descriptions=0;const f=await fixture('0.2.1-rc.2',{describe:()=>++descriptions===1?{ok:false,error:{code:'AUXILIARY_FAILED'}}:{ok:true,value:{version:'0.2.1-rc.2'}}});
 try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());assert.equal(c.upstreamVersion,undefined);
 const hub=new BrowserHostHub({perHost:f.perHost,browserVersion:'0.2.1-rc.2'});assert.equal((await hub.call('workspaceFiles/read',payload(id),signal())).ok,true);assert.equal(descriptions,2);
 }finally{await f.close()}
});
test('explicit configured 021 fallback never grants unknown capability but can recover after real metadata confirmation',async()=>{
 let descriptions=0;const f=await fixture('0.2.1-rc.2',{describe:()=>++descriptions===1?{ok:false,error:{code:'AUXILIARY_FAILED'}}:{ok:true,value:{version:'0.2.1-rc.2'}}});
 try{
  await f.control.hydrate([{...f.targets[0],upstreamVersion:'0.2.1-rc.2'}]);const id=f.targets[0].id,c=f.perHost.get(id);
  await c.call('session/list',{args:{}},signal());assert.equal(c.upstreamVersion,undefined,'configured fallback is not a confirmed version');
  const hub=new BrowserHostHub({perHost:f.perHost,browserVersion:'0.2.1-rc.2'});assert.equal((await hub.call('workspaceFiles/read',payload(id),signal())).ok,true);
  assert.equal(descriptions,2);assert.equal(c.upstreamVersion,'0.2.1-rc.2');assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,1);
 }finally{await f.close()}
});
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject}};
test('two concurrent denied previews share one description; cancelling one does not cancel the other or its entry',async()=>{
 let count=0;const gate=deferred(),f=await fixture('0.2.0-rc.2',{describe:({version})=>++count===1?{ok:true,value:{version}}:gate.promise});
 try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());
 const cancelled=new AbortController(),a=c.call('workspaceFiles/read',payload(id),cancelled.signal),b=c.call('workspaceFiles/read',payload(id),signal());
 await tick();assert.equal(count,2);cancelled.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(f.calls[2].signal.aborted,false);
 gate.resolve({ok:true,value:{version:'0.2.1-rc.2'}});assert.equal((await b).ok,true);assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,1);assert.equal(c.getState(),'connected');
 }finally{gate.resolve({ok:false});await f.close()}
});
test('an old entry delayed description cannot refill a new entry after target retry',async()=>{
 let count=0;const gate=deferred(),f=await fixture('0.2.0-rc.2',{describe:({version})=>++count===2?gate.promise:{ok:true,value:{version}}});
 try{const id=f.targets[0].id,old=f.perHost.get(id);await old.call('session/list',{args:{}},signal());
 const pending=old.call('workspaceFiles/read',payload(id),signal());const refusal=assert.rejects(pending,{name:'AbortError'});await tick();
 f.setVersion('0.2.0-rc.2');await f.control.retry(id);const current=f.perHost.get(id);gate.resolve({ok:true,value:{version:'0.2.1-rc.2'}});await refusal;
 assert.equal(current.upstreamVersion,'0.2.0-rc.2');assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,0);
 await assert.rejects(current.call('workspaceFiles/read',payload(id),signal()),{code:'runtime-interface/capability-unavailable'});assert.equal(current.upstreamVersion,'0.2.0-rc.2');
 }finally{gate.resolve({ok:false});await f.close()}
});
for(const mode of ['old','unknown','metadata-error'])test('real '+mode+' remains refused while base reads and the SSH entry remain healthy',async()=>{
 let count=0;const f=await fixture('0.2.0-rc.2',{describe:({version})=>{count++;if(mode==='metadata-error'&&count>1)throw new SyntaxError('synthetic metadata only');return mode==='unknown'?{ok:false,error:{code:'AUXILIARY_FAILED'}}:{ok:true,value:{version}}}});
 try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());
 await assert.rejects(c.call('workspaceFiles/read',payload(id),signal()),{code:'runtime-interface/capability-unavailable'});
 assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,0);assert.equal(count,2);assert.equal(c.getState(),'connected');
 await c.call('session/list',{args:{}},signal());assert.equal(count,2,'base read does not re-probe');assert.equal(f.ssh.filter(x=>x.includes('-N')).length,1);
 }finally{await f.close()}
});
for(const status of [401,403])test('reconfirmation preserves original authentication '+status+' without sending a preview',async()=>{
 let count=0;const f=await fixture('0.2.0-rc.2',{describe:({version})=>{if(++count>1)throw new Error('CARRIER_RESULT_HTTP_'+status);return{ok:true,value:{version}}}});
 try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());await assert.rejects(c.call('workspaceFiles/read',payload(id),signal()),{message:'CARRIER_RESULT_HTTP_'+status});assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,0)}finally{await f.close()}
});
class BinaryReply extends Writable{constructor(){super();this.parts=[]}writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true}_write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}}
for(const method of ['workspaceFiles/readBytes','officeToPdf/render'])test(method+' first visit after upgrade re-confirms before the original byte gate',async()=>{
 const f=await fixture('0.2.0-rc.2');try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());f.setVersion('0.2.1-rc.2');const response=new BinaryReply();
 await new BrowserHostHub({perHost:f.perHost,browserVersion:'0.2.1-rc.2'}).relayWorkspaceFileBytes({type:'client-request',rpcId:'synthetic',method,payload:{args:{...payload(id).args,...(method==='officeToPdf/render'?{priority:'foreground'}:{options:{}})}}},response,signal());
 assert.equal(response.status,200);assert.equal(Buffer.concat(response.parts).toString(),'opaque-native-bytes');assert.equal(f.rawCalls.length,1);assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,2);
 }finally{await f.close()}
});
test('supported previews avoid additional probing, an existing follow is not closed, and a failed write is never replayed',async()=>{
 const f=await fixture('0.2.0-rc.2',{failWrite:true});let stream;try{const id=f.targets[0].id,c=f.perHost.get(id);await c.call('session/list',{args:{}},signal());
 stream=c.open('session/follow',{args:{request:{address:{kind:'session',sessionId:'synthetic-session'}}}},signal());assert.equal((await stream.next()).value.type,'snapshot');f.setVersion('0.2.1-rc.2');
 await c.call('workspaceFiles/read',payload(id),signal());await c.call('workspaceFiles/read',payload(id),signal());assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,2);assert.equal((await stream.next()).done,true);
 await assert.rejects(c.call('session/rename',{args:{sessionId:'synthetic-session',title:'synthetic'}},signal()),{message:'CARRIER_DISCONNECTED'});assert.equal(f.calls.filter(x=>x.endpoint==='session/rename').length,1);assert.equal(f.calls.filter(x=>x.endpoint==='host.describe').length,2);
 }finally{await stream?.return();await f.close()}
});
