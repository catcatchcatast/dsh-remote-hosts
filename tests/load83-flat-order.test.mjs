// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                  
import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture,composite} from './fixtures/load83-official-ui.mjs'
const root=new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')
const remoteClient=process.env.REMOTE_CLIENT??root+'packages/remote-hosts/lib/client.js'
const interfaceClient=process.env.INTERFACE_CLIENT??root+'packages/runtime-interface/lib/client.js'
const session=host=>composite(host,'same-session'),workspace=host=>composite(host,'same-workspace')
const ids=['local','remote-example'].map(session)
async function mode(f,label){f.dom.window.document.querySelector('button[aria-label="View options"]').click();await f.settle();const item=[...f.dom.window.document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent===label);assert.ok(item);item.click();await f.settle()}
const style=f=>f.dom.window.document.querySelector('style[data-dsh-workspace-host-labels]')
test('native flat row title -> name/dot -> time/actions; grouped/tree CSS and menu unchanged',async()=>{
 const f=await fixture({interfaceClient,remoteClient,workspaceSnapshot:{phase:'loading',state:'loading',items:['local','remote-example'].map(host=>({workspaceId:workspace(host),path:'/synthetic/'+host,title:'synthetic',sessionIds:[session(host)]})),archivedSessionIds:[],pinnedSessionIds:[session('remote-example')]},sessionSnapshot:{phase:'loading',ids,byId:Object.fromEntries(ids.map(id=>[id,{id,title:'Synthetic title to preserve ellipsis and click ownership',updatedAt:Date.now()-120000,retainedBy:{},origin:'user',blank:false,running:false}])),projectionsBySession:{}}})
 try{
  const groupCSS=style(f).textContent
  assert.ok(!groupCSS.includes('[class$="_time"]'))
  await mode(f,'In one list')
  const time=f.dom.window.document.querySelector('[data-row-key^="session:"] > span[class$="_time"]')
  assert.ok(time);const row=time.parentElement,title=row.querySelector('span[class$="_title"]'),actions=row.querySelector('span[class$="_rowActions"]')
  assert.equal(f.dom.window.getComputedStyle(time).order,'3','time belongs after name(order1)/dot(order2)')
  const pinnedRow=[...f.dom.window.document.querySelectorAll('[data-row-key^="session:"]')].find(x=>x.getAttribute('data-row-key')==='session:'+session('remote-example'))
  const pin=pinnedRow.querySelector('span[class$="_pinIndicator"]');assert.ok(pin)
  assert.equal(f.dom.window.getComputedStyle(pin).order,'4','native pin remains after time')
  assert.equal(f.dom.window.getComputedStyle(actions).order,'5')
  assert.equal(f.dom.window.getComputedStyle(title).order,'0')
  assert.equal(row.children[1],title);assert.equal(row.children[2],time,'CSS must not move DOM nodes')
  assert.equal(title.textContent,'Synthetic title to preserve ellipsis and click ownership');assert.equal(time.textContent,'2min')
  const rules=[...style(f).sheet.cssRules],name=rules.find(r=>r.selectorText?.endsWith('::after')&&r.style.getPropertyValue('order')),dot=rules.find(r=>r.selectorText?.endsWith('::before')&&r.style.getPropertyValue('order'))
  assert.equal(name.style.getPropertyValue('order'),'1');assert.equal(dot.style.getPropertyValue('order'),'2')
  const changed=rules.filter(r=>r.selectorText?.includes('[class$="_time"]')||r.selectorText?.includes('[class$="_pinIndicator"]')||r.selectorText?.includes('[class$="_rowActions"]'))
  const orders=changed.filter(r=>r.style.getPropertyValue('order'));assert.equal(orders.length,3);for(const rule of orders){assert.equal(rule.style.length,1);assert.equal(rule.style[0],'order');assert.ok(rule.selectorText.includes('session:rh1.'))}
  const local=rules.filter(r=>r.selectorText?.includes('session:rh1.bG9jYWw.')&&r.selectorText.includes('::'));assert.ok(local.every(r=>r.style.getPropertyValue('display')==='none'))
  actions.querySelector('button').click();await f.settle();assert.ok(f.dom.window.document.querySelector('[role="menuitem"]'));assert.deepEqual(f.errors,[])
  // 收起原菜单后用原视图菜单切换，验证flat规则完全撤回，不作用于两个分组模式。
  actions.querySelector('button').click();await f.settle()
  await mode(f,'WorkSpace');assert.equal(style(f).textContent,groupCSS)
  await mode(f,'Workspace Tree');assert.equal(style(f).textContent,groupCSS)
  assert.equal(f.calls.length,0);assert.deepEqual(f.errors,[])
 }finally{await f.close()}
})
