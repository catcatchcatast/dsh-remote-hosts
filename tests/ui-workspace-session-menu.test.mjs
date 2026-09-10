
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { patchFormalRc1Client } from '../packages/ui-workspace-menu-compat-rc1/src/patch-client.mjs'

const formalPath = process.env.DSH_RC1_WORKSPACE_CLIENT

test('formal rc1 workspace bundle is patched only at its pinned anchors', async (t) => {
  if (!formalPath) return t.skip('set DSH_RC1_WORKSPACE_CLIENT to formal rc1 lib/client.js')
  const source = await readFile(formalPath, 'utf8')
  const patched = patchFormalRc1Client(source)
  assert.match(patched, /dsh:session-menu-v1/)
  assert.match(patched, /detail: \{ kind: "open", sessionId: node\.id, title: row\.title, anchor: e\.currentTarget \}/)
  assert.match(patched, /detail\.result = forkSession\(detail\.sessionId\)/)
  assert.match(patched, /detail\.result = result/)
  assert.ok(patched.length > source.length)
  assert.throws(() => patchFormalRc1Client(patched), /SHA-256/)
})

test('unrecognized bundle content fails closed before writing', () => {
  assert.throws(() => patchFormalRc1Client('untrusted bundle'), /SHA-256/)
})


test('actual patched action handler keeps target, completion and cleanup', async (t) => {
  if (!formalPath) return t.skip('requires pinned formal bundle')
  const patched = patchFormalRc1Client(await readFile(formalPath,'utf8'))
  const start = patched.lastIndexOf('(0, react.useEffect)', patched.indexOf('const onSessionMenu ='))
  const end = patched.indexOf('}, [archiveSession, forkSession, onSessionRename]);', start) + '}, [archiveSession, forkSession, onSessionRename]);'.length
  const bus = new EventTarget(), calls = []; let cleanup
  const action = name => id => { calls.push([name,id]); return Promise.resolve(name) }
  new Function('react','window','onSessionRename','forkSession','archiveSession','console', patched.slice(start,end))(
    {useEffect: fn => {cleanup=fn()}},bus,(id,title)=>calls.push(['rename',id,title]),action('fork'),action('archive'),console)
  for (const action of ['rename','fork','archive']) {
    const detail={kind:'action', action, sessionId:'rh1.remote.same-id', title:'same title'}
    const event=new CustomEvent('dsh:session-menu-v1',{cancelable:true,detail})
    bus.dispatchEvent(event); assert.equal(event.defaultPrevented,true)
    if(action!=='rename') assert.equal(await detail.result,action)
  }
  assert.deepEqual(calls,[['rename','rh1.remote.same-id','same title'],['fork','rh1.remote.same-id'],['archive','rh1.remote.same-id']])
  cleanup()
  const event=new CustomEvent('dsh:session-menu-v1',{cancelable:true,detail:{kind:'action',action:'archive',sessionId:'local',title:'x'}})
  bus.dispatchEvent(event); assert.equal(event.defaultPrevented,false); assert.equal(calls.length,3)
})

test('actual project click falls back natively unless unified menu handles it', async(t)=>{
  if (!formalPath) return t.skip('requires pinned formal bundle')
  const patched=patchFormalRc1Client(await readFile(formalPath,'utf8'))
  const at=patched.indexOf('const menuEvent = new CustomEvent(')
  const start=patched.lastIndexOf('onClick: (e) => {',at)+'onClick: '.length
  const end=patched.indexOf('setMenuOpen((v) => !v);',at)+'setMenuOpen((v) => !v);'.length
  const bus=new EventTarget(); let toggles=0, opens=0
  const click=new Function('window','node','row','setMenuOpen','return '+patched.slice(start,end)+'}')(
    bus,{id:'rh1.remote.same-id'},{title:'duplicate title'},()=>toggles++)
  const pointer={stopPropagation(){},currentTarget:{}}
  click(pointer); assert.equal(toggles,1)
  bus.addEventListener('dsh:session-menu-v1',event=>{ assert.equal(event.detail.sessionId,'rh1.remote.same-id'); opens++; event.preventDefault() })
  click(pointer); assert.equal(toggles,1); assert.equal(opens,1)
})
