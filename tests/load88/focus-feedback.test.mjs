// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                      
import assert from 'node:assert/strict'
import {fixture,composite} from './official-ui-fixture.mjs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
const o=path.dirname(fileURLToPath(import.meta.url)),id=composite('local','same'),remote=composite('remote-example','same'),now=Date.now()
const f=await fixture({interfaceClient:o+'/baseline-bundles/dsh-runtime-interface.js',remoteClient:process.env.REMOTE_CLIENT??o+'/source/packages/remote-hosts/lib/client.js',workspaceSnapshot:{phase:'loading',state:'loading',items:[{workspaceId:id,path:'C:\\fixture\\项目',title:'Local',createdAt:now,sessionIds:[id]},{workspaceId:remote,path:'/remote/项目',title:'Remote',createdAt:now,sessionIds:[remote]}],archivedSessionIds:[],pinnedSessionIds:[]},sessionSnapshot:{phase:'loading',ids:[id,remote],byId:Object.fromEntries([id,remote].map(key=>[key,{id:key,title:'Synthetic',cwd:key===id?'C:\\fixture\\项目':'/remote/项目',updatedAt:now,retainedBy:{},origin:'user',blank:false,running:false}])),projectionsBySession:{}}})
const d=f.dom.window.document,items=()=>[...d.querySelectorAll('[role=menuitem]')],find=text=>items().find(e=>e.textContent===text)
const keyboard=(target,key,extra={})=>target.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}))
async function open(kind='workspace',which=id){
 const row=[...d.querySelectorAll('[data-row-key]')].find(e=>e.dataset.rowKey===kind+':'+which)
 const trigger=row.querySelector('span[class$="_rowActions"] button');trigger.focus();trigger.click();await f.settle();assert.ok(find('Copy workspace path'));return trigger
}
try{
 // fixture.shared来自原官方frontend SZ()，不是夹具手工注册的primitives。
 assert.ok(f.shared['@deepseek-ai/dsh-client-ui-primitives'].MenuItemButton)
 for(const gesture of ['Tab','Enter','Click']){
  const trigger=await open(),button=find('Copy workspace path');button.focus()
  if(gesture==='Tab') keyboard(button,'Tab')
  else {if(gesture==='Enter')keyboard(button,'Enter');button.click()} // JSDOM缺浏览器原生Enter默认click，只补DOM标准默认动作。
  await f.settle();assert.equal(d.querySelector('[role=menu]'),null);assert.equal(d.activeElement===trigger,true,gesture+' focus returns to the exact original trigger')
 }
 if(process.env.FOCUS_ONLY){console.log(JSON.stringify({passed:true,focusGestures:3}));}
 else {
  f.failCopy(true);await open();find('Copy workspace path').click();await f.settle()
  assert.ok([...d.querySelectorAll('[role=alert]')].some(e=>e.textContent==='Could not copy workspace path'))
  f.failCopy(false);f.failOpen(true);await open();find('Open workspace folder').click();await f.settle()
  assert.ok([...d.querySelectorAll('[role=alert]')].some(e=>e.textContent==='Could not open workspace folder'))
  assert.equal(f.opened.length,1,'failed native POST not retried')
  f.failOpen(false)
  // 已打开的旧button遇到目标消失，也须向用户报告，而不声称复制成功。
  await open();const stale=find('Copy workspace path'),before=f.copied.length
  f.workspaces.set({...f.workspaces.getSnapshot(),items:f.workspaces.getSnapshot().items.filter(e=>e.workspaceId!==id)})
  stale.click();await f.settle();assert.equal(f.copied.length,before)
  assert.ok([...d.querySelectorAll('[role=alert]')].some(e=>e.textContent==='Could not copy workspace path'))
  f.nativeEntry.store.create().actions.setGroupBy('flat');await f.settle()
  f.failCopy(true);const sessionTrigger=await open('session');find('Copy workspace path').click();await f.settle()
  assert.equal(d.querySelector('[role=menu]'),null);assert.equal(d.activeElement,sessionTrigger)
  assert.ok([...d.querySelectorAll('[role=alert]')].some(e=>e.textContent==='Could not copy workspace path'))
  f.failCopy(false);await open('session');find('Copy Session ID').click();await f.settle();assert.equal(f.copied.at(-1),id)
  assert.deepEqual(f.errors,[]);assert.equal(f.calls.length,0)
  console.log(JSON.stringify({passed:true,focusGestures:3,visibleFailures:['copy','open','stale target','session copy'],originalCopyId:true,platformSeed:true,errors:f.errors}))
 }
}finally{await f.close()}
