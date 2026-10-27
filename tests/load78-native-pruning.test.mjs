// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     

import test from 'node:test'

import assert from 'node:assert/strict'

import fs from 'node:fs'

import path from 'node:path'

import {pathToFileURL} from 'node:url'

import * as boundary from '../packages/runtime-interface/src/index.js'
import * as mobileSync from '../packages/mobile-session-sync-rc1/src/index.js'

const native=process.env.DSH_OFFICIAL_021_ROOT || path.resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))

assert.ok(native)

const {Context}=await import(pathToFileURL(native+'/node_modules/@deepseek-ai/cordis/lib/index.js').href)

const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/native-retired-sources.json',import.meta.url),'utf8'))

const read=p=>fs.readFileSync(p,'utf8')

test('native candidate physically removes every frozen retired source, including time sidebar and sharing package',()=>{

 for(const relative of plan.paths)assert.equal(fs.existsSync(relative),false,relative)

 assert.deepEqual(fs.readdirSync('packages/runtime-interface/src/client').sort(),['agent-presets.js','cold-restore.js','entry.js','index.js','model-catalog.js'])

 assert.deepEqual(fs.readdirSync('packages/remote-hosts/src').sort(),['client.js','index.js'])

})

test('current publication exports/build/patch cannot reinstall sharing or legacy directory UI',()=>{

 const pkg=JSON.parse(read('packages/runtime-interface/package.json'))

 assert.equal(Object.keys(pkg.exports).some(x=>x.includes('session-share')),false)

 assert.equal(pkg.exports['./client-file-upload'],undefined)

 // 源码默认测试先于构建；唯一生成导出须有真实源入口与输出声明，不能借旧lib文件通过。
 const clientBuild=read('packages/runtime-interface/tsdown.config.mjs')
 for(const target of Object.values(pkg.exports))if(typeof target==='string'){
  if(target==='./lib/client.js'){
   assert.ok(fs.existsSync('packages/runtime-interface/src/client/entry.js'))
   assert.match(clientBuild,/entry:\s*\{\s*client:\s*'src\/client\/entry\.js'/)
   assert.match(clientBuild,/outDir:\s*'lib'/)
   assert.match(clientBuild,/entryFileNames:\s*'client\.js'/)
  }else assert.ok(fs.existsSync('packages/runtime-interface/'+target),target)
 }

 assert.doesNotMatch(read('packages/runtime-interface/build.mjs'),/session-share/)

 assert.doesNotMatch(read('packages/runtime-interface/src/index.js'),/createSessionShareInterface|sessionShareInterface/)

 assert.equal(JSON.parse(read('packages/remote-hosts/module-sources.json')).sidebar,undefined)

 assert.doesNotMatch(read('packages/remote-hosts/cordis.patch.yml'),/directory-picker/)

 // Host上传、管理重启、冷恢复和移动协议仍是现有边界。

 for(const rel of ['file-upload-host.js','managed-runtime-launcher.mjs','subscriptions.js','subscription-preferences.js','browser.js','workspace-wire.js','mobile-assistant-stream.js'])assert.ok(fs.existsSync('packages/runtime-interface/src/'+rel),rel)

})

test('actual Cordis default apply has no sharing lifecycle and preserves the original subscriptions port',async()=>{

 const ctx=new Context(),routes=new Map(),presets=[]

 try{

  for(const[k,v]of Object.entries({typertGateway:{},webServer:{port:0,register(route){const token={};routes.set(route.path,token);return()=>{if(routes.get(route.path)===token)routes.delete(route.path)}}},sessionController:{},workspaceController:{},connection:{},subagents:{},commands:{},goals:{},agentPresets:{register(...args){presets.push(args)}},sessionPersistence:{}}))ctx.provide(k,v)

  const owner=ctx.plugin(boundary,{historyEpoch:{datasetId:'native-prune',sequenceFormatGeneration:4,generation:1}});await owner.await()

  assert.equal(ctx.get('sessionShareInterface'),undefined)

  const port=ctx.get('runtimeInterface');assert.equal(typeof port.subscriptions.install,'function');assert.ok(boundary.SubscriptionsConfig)

  assert.equal(routes.size,0)
  await ctx.plugin(mobileSync)
  assert.equal(routes.size,3)
  const original=await import(new URL('../packages/subscriptions-compat-rc1/src/index.js',import.meta.url).href)
  const compatibility=ctx.plugin(original);await compatibility.await();assert.equal(compatibility.state,2)
  await compatibility.dispose();assert.equal(routes.size,3);assert.deepEqual(presets,[])
 }finally{await ctx.fiber.dispose();assert.equal(routes.size,0)}

})

