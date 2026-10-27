// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                           
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createHostInteractionSource } from '../packages/runtime-interface/src/host-interactions.js'
import { createRuntimeInterface, resolveInstalledRuntimeConfig, canonicalToBrowserWire, upstreamToCanonicalEvent, createSessionFollowStreamEncoder } from '../packages/runtime-interface/src/index.js'
import { createForkInboxIsolationPort } from '../packages/runtime-interface/src/fork-inbox-isolation.js'
import { readSessionSyncSnapshot } from '../packages/mobile-session-sync-rc1/src/index.js'
import { BrowserHostHub, encodeCompositeId } from '../packages/browser-host-hub-rc1/src/index.js'

const official = process.env.DSH_OFFICIAL_021_ROOT
assert.ok(official, 'Root isolated official0.2.1 runtime path required')
const load = name => import(pathToFileURL(`${official}/node_modules/@deepseek-ai/${name}/lib/index.js`).href)
const [{ Context }, { default: Typert }, { default: Access }, { default: Gateway }, { HostConnectionService, Peer }, { default: Controller }, { default: Workspace }] = await Promise.all(['cordis', 'dsh-typert-registry', 'dsh-api-remote-access', 'dsh-api-gateway', 'dsh-client-connection', 'dsh-api-session-controller', 'dsh-api-workspace-controller'].map(load))
const signal = () => new AbortController().signal
const untilAbort = signal => new Promise(done => { if(signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }) })
const options = { upstreamVersion: '0.2.1-rc.2', historyEpoch: 'synthetic-generation' }
function ports(extra = {}) { return { sessionController: {}, workspaceController: {}, connection: {}, subagents: {}, ...options, ...extra } }

async function gatewayFixture() {
 const ctx = new Context()
 await ctx.plugin(Typert); await ctx.plugin(Access)
 const connection = new HostConnectionService(ctx, [], {})
 const gateway = new Gateway(ctx, { websocketHeartbeatIntervalMs: 15000, streamInboxBytes: 16 * 1024 * 1024 })
 for(let i=0;i<10;i++) await Promise.resolve()
 const events = []
 let wake
 const remove = gateway.registerRemoteEvents(abort => ({ async *[Symbol.asyncIterator]() {
  while(!abort.aborted) { if(!events.length) await Promise.race([new Promise(r=>{wake=r}), untilAbort(abort)]); if(abort.aborted)return; yield events.shift() }
 } }), { home:'/synthetic' })
 const send = async (endpoint,payload,abort,peer=connection.browserPeer) => {
  const request = new Request(`http://synthetic/api/${endpoint}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'fixture-rpc',method:endpoint,payload}),signal:abort})
  const response = await connection.createSharedFetchHandler('/api').fetch(request, peer)
  return (await response.json()).result
 }
 return {ctx,connection,gateway,send,push(value){events.push(value);wake?.()}, async dispose(){await remove();await ctx.fiber.dispose()}}
}

for (const wiring of ['explicit source', 'runtime interface']) test(`actual021 ${wiring} retains the same live owner Peer for event open and answer`, async () => {
 const f = await gatewayFixture(), abort=new AbortController()
 let stream
 try {
  const source=wiring === 'explicit source'
   ? createHostInteractionSource(f.gateway,{upstreamVersion:'0.2.1-rc.2',peer:f.connection.browserPeer,sendResult:f.send})
   : createRuntimeInterface(ports({connection:f.connection,typertGateway:f.gateway})).hostInteractions
  assert.ok(source)
  stream=source.open(abort.signal)
  assert.deepEqual((await stream.next()).value,{type:'ready'})
  const settled=Promise.withResolvers(),subject={id:'synthetic-agent'}
  f.push({event:'user-questions/request',request:{agent:subject,questions:[]},context:{value:f.ctx,subject,agentId:subject.id},resolve:settled.resolve,reject:settled.reject})
  const item=(await stream.next()).value
  assert.equal(item.type,'pending')
  assert.equal(item.interaction.kind,'question')
  assert.deepEqual(await source.respond(item.interaction.id,{kind:'result',value:{answers:[]}},signal()),{accepted:true})
  assert.deepEqual(await settled.promise,{kind:'result',value:{answers:[]}})
  await assert.rejects(source.respond(item.interaction.id,{kind:'result',value:{answers:[]}},signal()),e=>e.code==='INTERACTION_UNCONFIRMED')
 } finally {abort.abort();await stream?.return();await f.dispose()}
})

test('actual021 Gateway rejects answering a stream through another Peer', async () => {
 const f=await gatewayFixture(),abort=new AbortController()
 let iterator
 try {
  iterator=(await f.gateway.wireStream.open('$events',{args:{}},(async function*(){})(),f.connection.browserPeer,abort.signal))[Symbol.asyncIterator]()
  const ready=(await iterator.next()).value
  const other=new Peer(f.ctx,{principal:{kind:'owner'}})
  const result=await f.send('$events/result',{args:{clientId:ready.clientId,eventId:'missing',outcome:{kind:'result',value:{answers:[]}}}},signal(),other)
  assert.equal(result.ok,false)
  assert.equal(result.error.code,'gateway/interactions-forbidden')
 } finally {abort.abort();await iterator?.return();await f.dispose()}
})

async function controllerFixture() {
 const ctx=new Context()
 await ctx.plugin(Typert);await ctx.plugin(Access)
 const live={id:'live',seq:6,header:{id:'live',createdAt:1,cwd:'/synthetic'}}
 const services={
  sessionProjections:{register(){return()=>{}},onChanged(){return()=>{}},cachedSnapshot(){return {asOfSeq:5,values:{title:{title:'live'}}}},snapshot(){return {asOfSeq:5,values:{title:{title:'live'}}}}},
  sessionProjectionCache:{cachedSnapshot(){return {asOfSeq:999,values:{title:{title:'cached'}}}}},
  sessionPersistence:{async stat(){return {header:{id:'migration'},formatStatus:'migration-required'}}},
  sessionQuery:{async listSessions(){return [{header:live.header,formatStatus:'current'},{header:{id:'cold',createdAt:2,cwd:'/synthetic'},formatStatus:'current'}]}},
  sessions:{get(id){return id==='live'?live:undefined},list(){return[live]}},agents:{get(){},list(){return[]}},fileUploads:{registerAgentResolver(){return()=>{}}},workspaceRegistry:{list(){return[]}},agentDefaultModel:{},attachments:{},fs:{},llm:{},
 }
 for(const[k,v]of Object.entries(services))ctx.provide(k,v)
 const controller=new Controller(ctx,{nativeOpen:false})
 return {ctx,controller}
}

test('actual021 cached list hints never become a mobile live cursor; real baseline fallback supplies it', async () => {
 const f=await controllerFixture()
 let follows=0
 try {
  const raw=await f.controller.list({},signal())
  assert.equal(raw.items.find(x=>x.sessionId==='cold').projections.kind,'cached')
  const runtime=createRuntimeInterface(ports({
   upstreamVersion:'0.2.0-rc.2',
   sessionController: {
    list:f.controller.list.bind(f.controller),
    async *follow(request) {
     follows++
     yield {type:'snapshot',cursor:6,header:{id:request.address.sessionId},records:[],hasMore:false,assistantStream:{revision:0},projections:{asOfSeq:6,values:{}}}
    },
   },
  }))
  const listed=await runtime.session.list({},signal())
  assert.equal(listed.items.find(x=>x.sessionId==='live').projections.asOfSeq,5)
  assert.equal(listed.items.find(x=>x.sessionId==='cold').projections.asOfSeq,undefined)
  const result=await readSessionSyncSnapshot({session:runtime.session,workspace:{async *follow(){yield {type:'baseline',value:{items:[],archivedSessionIds:[]}}}},signal:signal()})
  assert.equal(result.ok,true)
  assert.equal(result.value.sessions.find(x=>x.sessionId==='cold').lastSeq,6)
  assert.deepEqual(Object.keys(result.value.sessions.find(x=>x.sessionId==='cold')).sort(),['lastSeq','sessionId'])
  assert.equal(follows,1)
  assert.equal(raw.items.find(x=>x.sessionId==='cold').projections.asOfSeq,999,'official result is not mutated')
 }finally{await f.ctx.fiber.dispose()}
})

test('actual021 projections migration-required remains unsequenced and current version is selected', async () => {
 const f=await controllerFixture()
 try {
  const cfg=resolveInstalledRuntimeConfig({historyEpoch:{datasetId:'synthetic',sequenceFormatGeneration:4,generation:1}})
  assert.equal(cfg.upstreamVersion,'0.2.1-rc.2')
  const runtime=createRuntimeInterface(ports({sessionController:f.controller}))
  const migration=await runtime.session.projections({sessionId:'migration'},signal())
  assert.equal(migration.kind,'migration-required');assert.equal(migration.asOfSeq,undefined)
  const live=await runtime.session.projections({sessionId:'live'},signal())
  assert.equal(live.kind,'sequenced');assert.equal(live.asOfSeq,5)
 } finally {await f.ctx.fiber.dispose()}
})

test('actual021 default workspace routes only to its selected Host and preserves pin contract', async () => {
 const roots=[],calls=[]
 try {
  const entries=[]
  for(const hostId of ['local','remote']) {
   const ctx=new Context();roots.push(ctx);await ctx.plugin(Typert)
   ctx.provide('workspaceRegistry',{archivedSessionIds:[],pinnedSessionIds:[],async initializeDefault(){calls.push(hostId);return {id:hostId+'-workspace',path:'/synthetic',title:hostId,sessionIds:[],createdAt:1,updatedAt:1}},list(){return[]}})
   const workspace=new Workspace(ctx,{documentsDirectory:'D:/synthetic'})
   const runtime=createRuntimeInterface(ports({workspaceController:workspace}))
   entries.push({hostId,upstreamVersion:'0.2.1-rc.2',carrier:{async call(endpoint,_payload,abort){return {ok:true,value:await runtime.workspace.initializeDefault(abort)}},async *open(){}}})
  }
  const hub=new BrowserHostHub({perHost:Object.fromEntries(entries.map(e=>[e.hostId,e])),selectedHost:'local',browserVersion:'0.2.1-rc.2'})
  const result=await hub.call('workspace/initializeDefault',{args:{},__hostId:'remote'},signal())
  assert.equal(result.ok,true)
  assert.deepEqual(calls,['remote'])
  assert.equal(result.value.workspace.workspaceId,encodeCompositeId('remote','remote-workspace'))
  hub.setSelectedHost(undefined)
  const missing=await hub.call('workspace/initializeDefault',{args:{}},signal())
  assert.equal(missing.ok,false)
  assert.deepEqual(calls,['remote'],'no Host selection must not silently initialize local')
  assert.deepEqual(canonicalToBrowserWire({workspaceState:true,pins:['one'],archivedSessionIds:[]},'0.2.1-rc.2'),{pinnedSessionIds:['one'],archivedSessionIds:[]})
 }finally{await Promise.all(roots.map(c=>c.fiber.dispose()))}
})


test('actual021 owner Peer cancellation does not leave an actionable stale read', async () => {
 const f=await gatewayFixture(),abort=new AbortController()
 let stream
 try {
  const source=createRuntimeInterface(ports({connection:f.connection,typertGateway:f.gateway})).hostInteractions
  stream=source.open(abort.signal)
  assert.equal((await stream.next()).value.type,'ready')
  abort.abort()
  await stream.return()
  await assert.rejects(source.respond('stale',{kind:'result',value:{answers:[]}},signal()),e=>e.code==='INTERACTION_UNCONFIRMED')
  assert.equal(createHostInteractionSource(f.gateway,{upstreamVersion:'0.2.1-rc.2',sendResult:f.send}),undefined,'missing explicit Peer is not a legacy fallback')
 }finally{abort.abort();await stream?.return();await f.dispose()}
})

test('actual021 tool message survives the interface round trip and follow encoder unchanged', async () => {
 const {createToolResultMessage}=await load('dsh-llm')
 const message=createToolResultMessage({callId:'synthetic-tool',content:[{type:'text',text:'synthetic result'}],isError:false})
 const event={type:'tool/result',seq:0,time:1,data:{message}}
 const canonical=upstreamToCanonicalEvent(event)
 const decoded=canonicalToBrowserWire(canonical,'0.2.1-rc.2')
 assert.deepEqual(decoded.data.message,message)
 const encoder=createSessionFollowStreamEncoder({upstreamVersion:'0.2.1-rc.2',targetVersion:'0.2.1-rc.2',request:{address:{kind:'session',sessionId:'synthetic'},assistantStream:true},enabled:true})
 try {
  const frames=encoder.push({type:'snapshot',cursor:-1,records:[],hasMore:false,assistantStream:{revision:0}})
  assert.equal(frames[0].type,'snapshot')
  assert.deepEqual(encoder.push({type:'event',event:decoded})[0].event.data.message,message)
 }finally{encoder.close()}
})

test('actual021 CommandService runs once through agent operation port without a model request', async () => {
 const {Session}=await load('dsh-session'),{default:Commands}=await load('dsh-commands')
 const ctx=new Context(),session=Session.create('synthetic-command'),agent={id:session.id,session,ctx}
 let runs=0
 try {
  const commands=new Commands(ctx)
  commands.register({name:'probe',description:'synthetic',handler(){runs++;return {kind:'success',text:'synthetic'}}})
  const runtime=createRuntimeInterface(ports({commands,sessionController:{async resolveAgent(){return {agent}}}}))
  const result=await runtime.agentOperations.commands.execute({sessionId:session.id,line:'/probe'},signal())
  assert.equal(result.result.kind,'success')
  assert.equal(runs,1)
  const abort=new AbortController();abort.abort()
  await assert.rejects(runtime.agentOperations.commands.execute({sessionId:session.id,line:'/probe'},abort.signal))
  assert.equal(runs,1)
 }finally{await ctx.fiber.dispose()}
})

test('actual021 seeded Session lifecycle uses firstLifecycleSeq for creation events and fork isolation', async () => {
 const {Session}=await load('dsh-session')
 const ctx=new Context(),header={...Session.create('synthetic-fork').header,isSeeded:true,parentSession:'synthetic-parent'}
 const marker={type:'session/end-seed',seq:0,time:1,data:{inherited:true}}
 const session=Session.create('synthetic-fork',[marker],header,0)
 assert.equal(session.firstLifecycleSeq,0);assert.equal(session.firstLiveSeq,1)
 let created,checked=0
 try {
  const runtime=createRuntimeInterface(ports())
  runtime.bindEventSource(ctx).on('session/created',value=>{created=value})
  ctx.emit('session/created',session)
  assert.equal(created.firstLiveSeq,session.firstLifecycleSeq)
  assert.deepEqual(created.events.map(e=>e.type),['session/end-seed'])
  ctx.provide('sessions',{async flush(){}});ctx.provide('agents',{})
  const port=createForkInboxIsolationPort(ctx,{upstreamVersion:'0.2.1-rc.2',persistence:{async readFrom(){return {events:[marker]}}}})
  const dispose=port.install(()=>{checked++;return[]})
  for(let i=0;i<10;i++)await Promise.resolve()
  await ctx.parallel('agent/created',{agent:{session,inbox:{nextTurn:[],nextStep:[],remove(){throw new Error('unexpected removal')}}},signal:signal()})
  assert.equal(checked,1)
  await dispose()
 }finally{await ctx.fiber.dispose()}
})


test('021 mobile list never promotes an unknown projection kind; old untagged sequenced shape is retained', async () => {
 const listed={items:[{sessionId:'unknown',projections:{kind:'future',asOfSeq:900,values:{}}},{sessionId:'untagged',projections:{asOfSeq:800,values:{}}},{sessionId:'sequenced',projections:{kind:'sequenced',asOfSeq:7,values:{}}}]}
 const runtime=createRuntimeInterface(ports({sessionController:{async list(){return listed}}}))
 const actual=await runtime.session.list({},signal())
 assert.deepEqual(actual.items.map(x=>x.projections.asOfSeq),[undefined,undefined,7])
 const old=createRuntimeInterface(ports({upstreamVersion:'0.2.0-rc.2',sessionController:{async list(){return listed}}}))
 assert.equal((await old.session.list({},signal())).items[1].projections.asOfSeq,800)
 assert.equal(listed.items[0].projections.asOfSeq,900)
})
