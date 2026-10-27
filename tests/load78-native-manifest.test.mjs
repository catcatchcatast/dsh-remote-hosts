// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
const official=process.env.DSH_OFFICIAL_021_ROOT || path.resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))
assert.ok(official)
const req=createRequire(official+'/package.json'),semver=req('semver')
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'))
const face=read('packages/runtime-interface/package.json'),remote=read('packages/remote-hosts/package.json')
test('native client graph starts the interface at Connection and never requires superseded UI externals',()=>{
 assert.deepEqual(face.dsh.client.inject,['@deepseek-ai/dsh-client-connection'])
 assert.deepEqual(face.dsh.client.external,[])
 assert.equal(remote.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'),false)
})
test('every already installed native peer and direct schema dependency satisfies its explicit declaration',()=>{
 for(const manifest of [face,remote])for(const[name,range]of Object.entries({...manifest.peerDependencies,...(manifest===face?{zod:manifest.dependencies.zod}:{})})){
  const file=path.join(official,'node_modules',name,'package.json')
  if(!fs.existsSync(file)){assert.ok(name==='react'||name==='dsh-plugin-subscriptions',name);continue}
  const actual=read(file).version
  assert.ok(semver.satisfies(actual,range),`${manifest.name}: ${name} ${actual} does not satisfy ${range}`)
 }
})
test('subscription declaration and optional status remain byte-value exact',()=>{
 assert.equal(face.peerDependencies['dsh-plugin-subscriptions'],'0.8.0 || 0.9.2 || 0.9.7')
 assert.deepEqual(face.peerDependenciesMeta['dsh-plugin-subscriptions'],{optional:true})
})
