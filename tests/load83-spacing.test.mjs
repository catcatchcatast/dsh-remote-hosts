// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, composite } from './fixtures/load83-official-ui.mjs'
const remoteClient=process.env.REMOTE_CLIENT
const interfaceClient=process.env.INTERFACE_CLIENT
assert.ok(remoteClient&&interfaceClient,'Explicit pinned clients required')
const session=(host,id)=>composite(host,id)
const ids=[session('local','local'),session('remote-example','short'),session('remote-example','long')]
async function mode(f,label){
 f.dom.window.document.querySelector('button[aria-label="View options"]').click();await f.settle()
 const item=[...f.dom.window.document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent===label);assert.ok(item);item.click();await f.settle()
}
function pseudoProperties(f,row,pseudo){
 const style=f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]')
 const properties={}
 for(const rule of [...style.sheet.cssRules]){
  if(!rule.selectorText?.endsWith(pseudo))continue
  if(!row.matches(rule.selectorText.slice(0,-pseudo.length)))continue
  for(let index=0;index<rule.style.length;index++){const key=rule.style[index];properties[key]=rule.style.getPropertyValue(key)}
 }
 return properties
}
test('flat native rows retain name-dot spacing, add 4px before time, and center dots consistently',async()=>{
 const now=Date.now()
 const f=await fixture({interfaceClient,remoteClient,workspaceSnapshot:{phase:'loading',state:'loading',items:[{workspaceId:composite('local','ws'),path:'/synthetic/local',title:'Local',sessionIds:[ids[0]]},{workspaceId:composite('remote-example','ws'),path:'/synthetic/remote',title:'Remote',sessionIds:ids.slice(1)}],archivedSessionIds:[],pinnedSessionIds:[ids[1]]},sessionSnapshot:{phase:'loading',ids,byId:Object.fromEntries(ids.map((id,i)=>[id,{id,title:i===2?'A deliberately long synthetic session title to keep native ellipsis':'Synthetic '+i,updatedAt:now-(i+1)*120000,retainedBy:{},origin:'user',blank:false,running:false}])),projectionsBySession:{}}})
 try{
  const grouped=f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent
  await mode(f,'In one list')
  const rows=[...f.dom.window.document.querySelectorAll('[data-row-key^="session:"]')]
  assert.equal(rows.length,3)
  for(const row of rows){
   const dot=pseudoProperties(f,row,'::before'),label=pseudoProperties(f,row,'::after')
   const local=row.dataset.rowKey==='session:'+ids[0]
   if(local){assert.equal(dot.display,'none');assert.equal(label.display,'none');continue}
   assert.equal(dot['margin-inline-start'],'1px','existing host-name to dot spacing remains')
   assert.equal(dot['margin-inline-end']??'0px','4px','flat dot to time spacing')
   assert.equal(dot['align-self'],'center','dot centers in original native flex row')
   assert.equal(dot.width,'7px');assert.equal(dot.height,'7px');assert.equal(dot.flex,'0 0 auto','CSSOM canonical non-growing/non-shrinking dot')
   assert.equal(dot.order,'2');assert.equal(label.order,'1')
   assert.equal(label['margin-inline-start'],'4px')
   const time=row.querySelector('span[class$="_time"]')
   assert.ok(time);assert.equal(f.dom.window.getComputedStyle(time).order,'3')
   assert.equal(f.dom.window.getComputedStyle(row).height,'32px')
   assert.equal(parseFloat(f.dom.window.getComputedStyle(row).gap),0)
   assert.equal(f.dom.window.getComputedStyle(row).alignItems,'center')
  }
  await mode(f,'WorkSpace')
  assert.equal(f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent,grouped)
  await mode(f,'Workspace Tree')
  assert.equal(f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent,grouped)
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})

test('native workspace/tree generated CSS remains byte-identical to LOAD86 baseline',async()=>{
 const before=await fixture({interfaceClient,remoteClient:process.env.BASELINE_REMOTE_CLIENT})
 const after=await fixture({interfaceClient,remoteClient})
 try{
  for(const view of ['WorkSpace','Workspace Tree']){
   await mode(before,view);await mode(after,view)
   const css=f=>f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent
   assert.equal(css(after),css(before))
  }
  assert.deepEqual(before.errors,[]);assert.deepEqual(after.errors,[])
 }finally{await before.close();await after.close()}
})

test('remote flat time minimum is shared for short and long ages, right aligned; local and grouped unchanged',async()=>{
 const now=Date.now(),keys=[session('local','native'),session('remote-example','minutes'),session('remote-example','days')]
 const f=await fixture({interfaceClient,remoteClient,workspaceSnapshot:{phase:'loading',state:'loading',items:[{workspaceId:composite('local','ws'),path:'/synthetic/local',title:'Local',sessionIds:[keys[0]]},{workspaceId:composite('remote-example','ws'),path:'/synthetic/remote',title:'Remote',sessionIds:keys.slice(1)}],archivedSessionIds:[],pinnedSessionIds:[]},sessionSnapshot:{phase:'loading',ids:keys,byId:Object.fromEntries(keys.map((id,i)=>[id,{id,title:'Synthetic '+i,updatedAt:now-(i===2?5*86400000:24*60000),retainedBy:{},origin:'user',blank:false,running:false}])),projectionsBySession:{}}})
 try{
  await mode(f,'In one list')
  const rows=[...f.dom.window.document.querySelectorAll('[data-row-key^="session:"]')]
  const remote=rows.filter(row=>row.dataset.rowKey!=='session:'+keys[0])
  assert.equal(remote.length,2)
  assert.deepEqual(remote.map(row=>row.querySelector('span[class$="_time"]').textContent).sort(),['24min','5d'])
  for(const row of remote){
   const time=row.querySelector('span[class$="_time"]'),css=f.dom.window.getComputedStyle(time)
   assert.equal(css.minInlineSize,'4em','ordinary remote age uses same minimum column')
   assert.equal(css.textAlign,'right')
   assert.equal(css.fontSize,'10px');assert.equal(css.lineHeight,'16px')
   assert.equal(css.flex,'0 0 auto')
   assert.notEqual(css.overflow,'hidden','time/status must not gain clipping')
  }
  const local=rows.find(row=>row.dataset.rowKey==='session:'+keys[0]),nativeTime=f.dom.window.getComputedStyle(local.querySelector('span[class$="_time"]'))
  assert.notEqual(nativeTime.minInlineSize,'4em');assert.notEqual(nativeTime.textAlign,'right')
  const rules=[...f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').sheet.cssRules]
  const columns=rules.filter(r=>r.style?.getPropertyValue('min-inline-size')==='4em')
  assert.equal(columns.length,1);assert.equal(columns[0].style.length,2)
  assert.ok(columns[0].selectorText.includes(':not('));assert.ok(columns[0].selectorText.includes('session:rh1.bG9jYWw.'))
  await mode(f,'WorkSpace')
  assert.ok(!f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent.includes('min-inline-size:4em'))
  await mode(f,'Workspace Tree')
  assert.ok(!f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]').textContent.includes('min-inline-size:4em'))
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
