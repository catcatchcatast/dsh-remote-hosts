// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {releasePackageDirectories,releaseTestFiles} from '../tools/release-profile.mjs'
import {scanInterfaceBoundary} from '../tools/check-interface-boundary.mjs'
import {bindColdRestoreSelection} from '../packages/runtime-interface/src/client/cold-restore.js'
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'))

test('native default build selects exactly the two changed packages and no original subscription or whale build',()=>{
 assert.deepEqual(releasePackageDirectories(),['runtime-interface','remote-hosts'])
 assert.equal(json('package.json').scripts['test:legacy'],undefined)
 const files=releaseTestFiles().map(file=>file.replaceAll('\\','/'));assert.ok(files.length>10)
 assert.ok(files.includes('tests/load78-native-workspace-files.test.mjs'))
 assert.ok(files.includes('tests/runtime-interface-file-upload-host.test.mjs'))
 for(const file of files)assert.ok(fs.existsSync(file),file)
})
test('native package test retains Host upload regressions instead of importing removed client code',()=>{
 const script=json('packages/runtime-interface/package.json').scripts.test
 assert.ok(script.includes('runtime-interface-file-upload-host.test.mjs'))
 assert.equal(script.includes('runtime-interface-file-upload.test.mjs'),false)
 const root=json('package.json')
 assert.equal(root.devDependencies['@deepseek-ai/cordis'],'4.0.5')
 assert.equal(root.devDependencies['@deepseek-ai/schemastery'],'3.18.5')
 assert.equal(root.devDependencies['@deepseek-ai/dsh-web'],'0.2.1-rc.2')
 assert.equal(fs.readFileSync('pnpm-workspace.yaml','utf8').includes('packages/session-share'),false)
})
function store(value){const listeners=new Set();return{getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},set(next){value=next;for(const fn of [...listeners])fn()},get listeners(){return listeners.size}}}
function cold(){
 const generation=store({id:'generation-one'}),selection=store({sessionId:'rh1.a.b'}),sessions={calls:0,refresh(){this.calls++;return Promise.resolve()}}
 let reader,consume,unbound=0
 const dispose=bindColdRestoreSelection({get(name){return {sessions,uiWorkspace:{selection},connection:{generation}}[name]}},{bindColdRestoreReader(read,accept){reader=read;consume=accept;return()=>unbound++}})
 return{generation,selection,sessions,dispose,read:()=>reader(),accept:(value,phase)=>consume(value,phase),unbound:()=>unbound}
}
test('retained cold binding accepts only consumed same-generation complete envelopes',()=>{
 for(const value of [{result:{ok:false,error:{code:'fixture'}}},{ok:true,value:{}},undefined]){
  const c=cold();try{c.read();c.accept(value,'complete');assert.equal(c.dispose.completeBaselineAccepted(),false)}finally{c.dispose()}
 }
 const c=cold();try{c.read();c.accept({result:{ok:true,value:{items:[]}}},'complete');assert.equal(c.dispose.completeBaselineAccepted(),true);assert.equal(c.sessions.calls,0);c.generation.set({id:'generation-two'});assert.equal(c.dispose.completeBaselineAccepted(),false)}finally{c.dispose()}
})
test('retained target and failed cold reads keep the original completion refresh responsibility',async()=>{
 for(const phase of ['target','failed']){
  const c=cold();try{c.read();c.accept({result:{ok:true,value:{}}},phase);assert.equal(c.dispose.completeBaselineAccepted(),false);for(let i=0;i<6;i++)await Promise.resolve();assert.equal(c.sessions.calls,2)}finally{c.dispose();assert.equal(c.selection.listeners,0);assert.equal(c.generation.listeners,0)}
 }
})
test('cold selection change, generation cancellation and dispose never certify a stale completion',async()=>{
 for(const action of ['selection','generation','dispose']){
  const c=cold(),read=c.read()
  if(action==='selection')c.selection.set({sessionId:'rh1.other.target'})
  if(action==='generation')c.generation.set({id:'next'})
  if(action==='dispose')c.dispose()
  c.accept({result:{ok:true,value:{}}},'complete')
  assert.equal(read.signal.aborted,true);assert.equal(c.dispose.completeBaselineAccepted(),false)
  if(action!=='dispose')c.dispose()
  assert.equal(c.unbound(),1)
 }
 const c=cold();c.read();c.accept({result:{ok:true,value:{}}},'target');c.dispose();for(let i=0;i<6;i++)await Promise.resolve();assert.equal(c.sessions.calls,1)
})

test('default boundary inspection retains exception-owner packages without adding a product build target',()=>{
 const report=scanInterfaceBoundary();assert.equal(report.passed,true,JSON.stringify(report.summary));assert.ok(report.packageDirectories.includes('model-menu-filter'));assert.deepEqual(releasePackageDirectories(),['runtime-interface','remote-hosts']);
})
