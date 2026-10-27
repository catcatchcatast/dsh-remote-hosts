// 公开打包追溯：docs/PUBLIC-CHANGES.md
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const names=['runtime-interface','remote-hosts','fork-inbox-guard']
test('exact three public package entries and official compatibility',()=>{
 for(const name of names){
  const dir=path.join(root,'packages',name),p=JSON.parse(fs.readFileSync(path.join(dir,'package.json')))
  assert.equal(p.license,'Apache-2.0');assert.ok(fs.existsSync(path.join(dir,p.main)))
  for(const dep of Object.values(p.dependencies??{}))assert.ok(!/^(workspace:|link:|file:)/.test(dep))
  assert.equal(p.peerDependencies['@deepseek-ai/cordis'],'4.0.5')
  if(name!=='runtime-interface'){assert.equal(p.peerDependencies['dsh-runtime-interface'],'0.1.0-rc.1');assert.equal(p.dependencies?.['dsh-runtime-interface'],undefined);assert.notEqual(p.peerDependenciesMeta?.['dsh-runtime-interface']?.optional,true)}
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'release-profile.json'))).supportedRuntimeVersions,['0.2.1-rc.2'])
})
test('full license texts and notices travel with every package',()=>{
 for(const name of names)for(const f of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.md','LICENSES/APACHE-2.0.txt','LICENSES/REMOTE-HOSTS-MIT.txt','LICENSES/UPSTREAM-NOTICE.txt'])assert.ok(fs.statSync(path.join(root,'packages',name,f)).size>0)
})
test('nine current internal module inputs remain available without publishing legacy plugins',()=>{
 const m=JSON.parse(fs.readFileSync(path.join(root,'packages/remote-hosts/module-sources.json')))
 assert.equal(m.modules.length,9)
 for(const name of m.modules)assert.ok(fs.existsSync(path.join(root,'packages',name,'src')))
})
test('no machine modules or private Git history are distributed',()=>{
 assert.ok(!fs.existsSync(path.join(root,'.git')));assert.ok(!fs.existsSync(path.join(root,'node_modules')))
})
