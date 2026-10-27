// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {MockAdapter,textResponse} from './fixtures/load78-official-mock-adapter.mjs'
import {createForkInboxIsolationPort} from '../packages/runtime-interface/src/fork-inbox-isolation.js'
import * as originalGuard from '../packages/fork-inbox-guard/src/index.js'
const native=process.env.DSH_OFFICIAL_021_ROOT || fileURLToPath(new URL('..',import.meta.url)),req=createRequire(path.join(native,'package.json'))
const load=name=>import(pathToFileURL(req.resolve('@deepseek-ai/'+name)).href)
const [{Context},{default:LlmRuntime,createUserMessage},{default:SessionStore,SessionId,SessionLogOffset,buildForkSeed},{default:SystemPrompt},{default:ToolRuntime},{default:AgentRegistry},{default:AgentLoop},{default:SessionProjectionRegistry}]=await Promise.all(['cordis','dsh-llm','dsh-session','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-session-projection'].map(load))
const send=(agent,text)=>agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}))
const userTexts=agent=>agent.session.snapshotEvents().filter(e=>e.type==='user/message').flatMap(e=>e.data.content).filter(x=>x.type==='text').map(x=>x.text)

test('original source-only guard admits the actual native Cordis version without editing its policy',()=>{
 const semver=req('semver'),version=JSON.parse(fs.readFileSync(req.resolve('@deepseek-ai/cordis/package.json'))).version
 const manifest=JSON.parse(fs.readFileSync(new URL('../packages/fork-inbox-guard/package.json',import.meta.url)))
 assert.equal(semver.satisfies(version,manifest.peerDependencies['@deepseek-ai/cordis']),true)
})

for(const historical of [true,false])test(`real public AgentLoop with original guard isolates ${historical?'historical':'latest'} fork without dropping new child input`,{timeout:10000},async()=>{
 let parent
 const queued=createUserMessage({content:[{type:'text',text:'fixture queued parent input'}],source:{kind:'user'}})
 const adapter=new MockAdapter([()=>{parent.followup(queued);return textResponse('first result')},textResponse('queued result'),textResponse('child result'),textResponse('unexpected replay')])
 const ctx=new Context()
 try{
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop,{agents:[]});ctx.llm.registerAdapter(['mock'],adapter)
  ctx.provide('runtimeInterface',{forkInboxIsolation:createForkInboxIsolationPort(ctx,{upstreamVersion:'0.2.1-rc.2',persistence:{async readFrom(id){return{events:ctx.sessions.get(id).snapshotEvents()}}}})})
  if(process.env.LOAD78_FORK_GUARD_ENABLE!=='0')await ctx.plugin(originalGuard)
  parent=await ctx.agentLoop.create(SessionId('fixture-parent-'+historical),{provider:'mock',model:'mock'})
  send(parent,'fixture first input');await parent.whenIdle()
  assert.equal(adapter.requests.length,2)
  const events=parent.session.snapshotEvents(),cut=historical?events.find(e=>e.type==='turn/end'&&e.data.turn===1).seq:events.at(-1).seq
  const child=(await ctx.agents.create({sessionId:SessionId('fixture-child-'+historical),seed:buildForkSeed(events,cut),inheritedEventCount:SessionLogOffset(cut+1),meta:{isSeeded:true,parentSession:parent.id},agentOptions:{provider:'mock',model:'mock'}})).agent
  assert.deepEqual(child.inbox.nextTurn.map(x=>x.id),[])
  assert.equal(adapter.requests.length,2,'creating a branch never starts a turn')
  send(child,'fixture fresh child input');await child.whenIdle()
  assert.equal(adapter.requests.length,3)
  assert.equal(userTexts(child).filter(x=>x==='fixture fresh child input').length,1)
  assert.equal(userTexts(child).filter(x=>x==='fixture queued parent input').length,historical?0:1)
 }finally{await ctx.fiber.dispose()}
})
