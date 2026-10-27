// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                             
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, composite } from './official-ui-fixture.mjs'
const owned=path.dirname(fileURLToPath(import.meta.url))
const local=composite('local','same'),remote=composite('remote-example','same')
const now=Date.now()
const sessions={phase:'loading',projectionsBySession:{},ids:[local,remote],byId:{
  [local]:{id:local,title:'Local session',cwd:'C:\\work space\\项目',createdAt:now,updatedAt:now,workspaceId:local,retainedBy:{},origin:'user',blank:false,running:false},
  [remote]:{id:remote,title:'Remote session',cwd:'/home/test/项目 with space',createdAt:now,updatedAt:now,workspaceId:remote,retainedBy:{},origin:'user',blank:false,running:false},
}}
const workspaces={phase:'loading',state:'loading',items:[
  {workspaceId:local,title:'Local workspace',path:'C:\\work space\\项目',sessionIds:[local],createdAt:now},
  {workspaceId:remote,title:'Remote workspace',path:'/home/test/项目 with space',sessionIds:[remote],createdAt:now},
],archivedSessionIds:[],pinnedSessionIds:[]}
const f=await fixture({interfaceClient:owned+'/baseline-bundles/dsh-runtime-interface.js',remoteClient:process.env.BASELINE?owned+'/baseline-bundles/dsh-remote-hosts.js':owned+'/source/packages/remote-hosts/lib/client.js',sessionSnapshot:sessions,workspaceSnapshot:workspaces})
const d=f.dom.window.document
const click=e=>{assert.ok(e,'click target');e.click()}
const find=(selector,text)=>[...d.querySelectorAll(selector)].find(e=>e.textContent===text)
const menuItems=()=>[...d.querySelectorAll('[role="menuitem"]')].map(x=>x.textContent)
const key=(name)=>d.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}))
async function openRow(id,kind='session'){
  const row=[...d.querySelectorAll('[role="treeitem"]')].find(e=>e.getAttribute('data-row-key')===kind+':'+id)
  assert.ok(row,kind+' row exists '+JSON.stringify({errors:f.errors,keys:[...d.querySelectorAll('[data-row-key]')].map(e=>e.dataset.rowKey)}))
  const buttons=[...row.querySelectorAll('button')]
  const trigger=buttons.find(e=>/actions/.test(e.getAttribute('aria-label')??''))
  assert.ok(trigger,'actual action trigger '+row.outerHTML.slice(0,450))
  click(trigger);await f.settle();return trigger
}
try {
  f.nativeEntry.store.create().actions.setGroupBy('flat');await f.settle()
  await openRow(remote)
  assert.ok(menuItems().includes('Copy workspace path'),'RED: native session menu lacks workspace path')
  assert.ok(!menuItems().includes('Open workspace folder'),'remote must not open local folder')
  click(find('[role="menuitem"]','Copy workspace path'));await f.settle()
  assert.deepEqual(f.copied,['/home/test/项目 with space'])
  await openRow(remote);click(find('[role=menuitem]','Copy Session ID'));await f.settle();assert.equal(f.copied.at(-1),remote,'original copy ID still uses complete owner ID')
  await openRow(local)
  assert.ok(menuItems().includes('Open workspace folder'))
  click(find('[role="menuitem"]','Open workspace folder'));await f.settle()
  assert.deepEqual(f.opened,[{app:'explorer',path:'C:\\work space\\项目'}])
  f.nativeEntry.store.create().actions.setGroupBy('workspace');await f.settle()
  const groupTrigger=await openRow(local,'workspace')
  assert.deepEqual(menuItems(),['Rename','Delete workspace','Copy workspace path','Open workspace folder'])
  find('[role="menuitem"]','Copy workspace path').focus();key('ArrowDown')
  assert.equal(d.activeElement.textContent,'Open workspace folder')
  key('Home');assert.equal(d.activeElement.textContent,'Rename')
  key('End');assert.equal(d.activeElement.textContent,'Open workspace folder')
  key('Tab');await f.settle()
  assert.equal(d.querySelector('[role="menu"]'),null)
  assert.equal(f.opened.length,2)
  const trigger2=await openRow(remote,'workspace')
  assert.deepEqual(menuItems(),['Rename','Delete workspace','Copy workspace path'])
  find('[role="menuitem"]','Copy workspace path').focus();key('Escape');await f.settle()
  assert.equal(d.querySelector('[role="menu"]'),null)
  assert.equal(d.activeElement,trigger2)
  // 同一目录Host原始ID碰撞：完整复合身份定位，切勿取当前选择。
  const beforeNative=[...d.querySelectorAll('[data-row-key]')].map(e=>e.dataset.rowKey)
  for(const mode of ['workspace','workspace-tree','flat']){
    f.nativeEntry.store.create().actions.setGroupBy(mode);await f.settle()
    // 原workspaces展开状态是公开viewStore；只展开该合成workspace，不触碰会话。
    if(mode!=='flat'){
      const row=[...d.querySelectorAll('[data-row-key]')].find(e=>e.dataset.rowKey==='workspace:'+remote)
      if(row?.getAttribute('aria-expanded')==='false'){row.click();await f.settle()}
    }
    await openRow(remote)
    assert.equal(menuItems().filter(x=>x==='Copy workspace path').length,1)
    assert.equal(menuItems().filter(x=>x==='Open workspace folder').length,0)
    click(find('[role="menuitem"]','Copy workspace path'));await f.settle()
    assert.equal(f.copied.at(-1),'/home/test/项目 with space')
  }
  // 菜单已经打开后目录更新，点击时重读该ID新路径。
  f.nativeEntry.store.create().actions.setGroupBy('flat');await f.settle()
  await openRow(local)
  const updatedSessions={...sessions,byId:{...sessions.byId,[local]:{...sessions.byId[local],cwd:'\\\\server\\share\\updated 项目'}}}
  f.sessions.set(updatedSessions);await f.settle()
  click(find('[role="menuitem"]','Copy workspace path'));await f.settle()
  assert.equal(f.copied.at(-1),'\\\\server\\share\\updated 项目')
  assert.equal(f.openerChoice.getSnapshot(),'vscode','explicit folder open does not persist another preferred app')
  await openRow(local)
  f.sessions.set({...updatedSessions,byId:{...updatedSessions.byId,[local]:{...updatedSessions.byId[local],cwd:''}}});await f.settle()
  assert.equal(find('[role="menuitem"]','Copy workspace path'),undefined)
  assert.equal(find('[role="menuitem"]','Open workspace folder'),undefined)
  key('Escape');await f.settle();f.sessions.set(sessions);await f.settle()
  f.openerApps.set(['vscode','terminal']);await openRow(local)
  assert.equal(find('[role="menuitem"]','Open workspace folder'),undefined,'IDE and terminal do not count as native folder capabilities')
  key('Escape');await f.settle();f.openerApps.set(['vscode','filemanager'])
  await openRow(local);click(find('[role="menuitem"]','Open workspace folder'));await f.settle()
  assert.deepEqual(f.opened.at(-1),{app:'filemanager',path:'C:\\work space\\项目'})
  f.openerApps.set(['vscode','finder']);await openRow(local);click(find('[role="menuitem"]','Open workspace folder'));await f.settle()
  assert.deepEqual(f.opened.at(-1),{app:'finder',path:'C:\\work space\\项目'})
  f.openerApps.set(['vscode','explorer'])
  // 工作区路径更新/缺失只改变新增行，原两项保留；移除和复挂不产生重复或旧闭包。
  f.nativeEntry.store.create().actions.setGroupBy('workspace');await f.settle()
  await openRow(local,'workspace')
  const originalButtons=[...d.querySelectorAll('[role="menuitem"]')].slice(0,2)
  const firstMenu=d.querySelector('[role="menu"]'),pathButton=find('[role="menuitem"]','Copy workspace path')
  const anchor=[...d.querySelectorAll('[data-row-key]')].find(e=>e.dataset.rowKey==='workspace:'+local).querySelector('button')
  anchor.dispatchEvent(new f.dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:pathButton}))
  pathButton.dispatchEvent(new f.dom.window.MouseEvent('pointerover',{bubbles:true,relatedTarget:anchor}))
  await new Promise(resolve=>setTimeout(resolve,240));await f.settle()
  assert.equal(d.querySelector('[role="menu"]'),firstMenu,'pointer crossing to appended native DOM item keeps original menu open')
  const updatedWorkspaces={...workspaces,items:workspaces.items.map(item=>item.workspaceId===local?{...item,path:'/new actual/group 项目'}:item)}
  f.workspaces.set(updatedWorkspaces);await f.settle()
  assert.equal(d.querySelectorAll('[role="menuitem"]')[0],originalButtons[0]);assert.equal(d.querySelectorAll('[role="menuitem"]')[1],originalButtons[1])
  click(find('[role="menuitem"]','Copy workspace path'));await f.settle();assert.equal(f.copied.at(-1),'/new actual/group 项目')
  await openRow(local,'workspace')
  f.workspaces.set({...updatedWorkspaces,items:updatedWorkspaces.items.map(item=>item.workspaceId===local?{...item,path:''}:item)});await f.settle()
  assert.deepEqual(menuItems(),['Rename','Delete workspace'])
  key('Escape');await f.settle();f.workspaces.set(workspaces);await f.settle()
  await openRow(local,'workspace')
  const staleCopy=find('[role="menuitem"]','Copy workspace path'),copiesBefore=f.copied.length
  await f.remotePlugin.dispose();await f.settle()
  assert.equal(d.querySelector('[role=menu]'),null,'existing recency adapter unmount closes its native row menu')
  await openRow(local,'workspace');assert.deepEqual(menuItems(),['Rename','Delete workspace'])
  staleCopy.click();await f.settle();assert.equal(f.copied.length,copiesBefore)
  key('Escape');await f.settle()
  const reinstalled=f.mountRemote();await reinstalled;await f.settle()
  await openRow(local,'workspace');assert.equal(menuItems().filter(x=>x==='Copy workspace path').length,1)
  // 原Menu的外部指针离开和Shift+Tab仍收起；不接管或拦截原键盘事件。
  find('[role="menuitem"]','Copy workspace path').dispatchEvent(new f.dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:d.body}))
  await new Promise(resolve=>setTimeout(resolve,240));await f.settle();assert.equal(d.querySelector('[role="menu"]'),null)
  const shiftAnchor=await openRow(local,'workspace');find('[role="menuitem"]','Copy workspace path').focus()
  d.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));await f.settle()
  assert.equal(d.querySelector('[role="menu"]'),null);assert.equal(d.activeElement,shiftAnchor)
  await openRow(local,'workspace');click(find('[role="menuitem"]','Rename'));await f.settle()
  assert.ok(d.querySelector('[role="dialog"]'),'original rename still opens original dialog')
  key('Escape');await f.settle()
  await openRow(local,'workspace');click(find('[role=menuitem]','Delete workspace'));await f.settle()
  assert.ok(d.querySelector('[role="dialog"]'),'original delete keeps its confirmation')
  assert.equal(f.calls.length,0,'no model/business RPC from menu restore')
  assert.deepEqual(f.errors,[])
  console.log(JSON.stringify({passed:true,cases:['session exact remote copy','local native app excludes selected IDE','original group items','group arrows/Home/End/Tab','Escape focus return','remote open hidden','all three native modes','fresh UNC/POSIX/Unicode paths','missing path and capabilities','pointer over/leave','original native buttons identity and rename dialog','dispose/remount unique + stale click inert'],errors:f.errors}))
} finally {await f.close()}

