// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                         
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const sourcePath=process.env.LOAD78_BOOTSTRAP_STORE || fileURLToPath(new URL('../packages/mobile-bootstrap-rc1/src/bootstrap-store.cjs',import.meta.url))
const source=fs.readFileSync(sourcePath,'utf8'),nativeRequire=createRequire(sourcePath)
const root=process.env.LOAD78_BOOTSTRAP_TEST_ROOT || path.resolve('build/load78-bootstrap-private-create')
fs.mkdirSync(root,{recursive:true})
const fixed='11111111-1111-4111-8111-111111111111'
const ps=(script,env={})=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,...env},stdio:['ignore','pipe','pipe']}).trim()
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex')
function load({collision=false,failNative,failFs,measureParent=false}={}){
 const events=[],nativeCalls=[]
 const actualFs=new Proxy(fs,{get(target,key){
  if(['openSync','writeFileSync','fsyncSync','renameSync','linkSync','unlinkSync'].includes(key))return(...args)=>{
   events.push({operation:key,path:typeof args[0]==='string'?args[0]:undefined,flags:args[1]})
   if(key===failFs)throw Object.assign(new Error('synthetic '+key),{code:'EIO'})
   return target[key](...args)
  }
  return target[key]
 }})
 const child={...nativeRequire('node:child_process'),execFileSync(command,args,options){
  let script=args[args.length-1],call
  if(command==='powershell.exe'&&script.includes('[IO.FileMode]::CreateNew')){
   call={script,input:options.input,path:options.env.DSH_BOOT_PATH};if(measureParent)call.parentBefore=acl([path.dirname(call.path)]).rows[0].sddl;nativeCalls.push(call)
   if(failNative==='write')script=script.replace('$inputStream.CopyTo($stream)',"throw 'synthetic-write'")
   if(failNative==='flush')script=script.replace('$stream.Flush($true)',"throw 'synthetic-flush'")
   if(failNative)assert.notEqual(script,args[args.length-1],'actual native fault seam must be present')
   args=[...args.slice(0,-1),script]
  }
  const result=execFileSync(command,args,options);if(call&&measureParent)call.parentAfter=acl([path.dirname(call.path)]).rows[0].sddl;return result
 }}
 const module={exports:{}}
 vm.runInNewContext(source+'\nmodule.exports.testAtomic=atomicPrivateWrite;module.exports.testDirectory=ensureDirectory;',{
  module,exports:module.exports,require(name){if(name==='node:fs')return actualFs;if(name==='node:child_process')return child;if(name==='node:crypto'&&collision)return{...nativeRequire(name),randomUUID:()=>fixed};return nativeRequire(name)},
  process,Buffer,URL,__filename:sourcePath,__dirname:path.dirname(sourcePath),console,
 },{filename:sourcePath})
 return{...module.exports,events,nativeCalls}
}
function fixture(options){
 const home=fs.mkdtempSync(path.join(root,'home-')),store=load(options)
 return{home,store,directory:store.testDirectory(home),close(){fs.rmSync(home,{recursive:true,force:true})}}
}
function acl(paths){
 return JSON.parse(ps("$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rows=@();foreach($p in (ConvertFrom-Json $env:LOAD78_PATHS)){$i=Get-Item -LiteralPath $p -Force;$a=$i.GetAccessControl();$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherited=$_.IsInherited}});$rows+=@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=$rules;sddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access');reparse=(($i.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0)}};@{currentSID=$sid;rows=$rows}|ConvertTo-Json -Depth 5 -Compress",{LOAD78_PATHS:JSON.stringify(paths)}))
}

test('Windows real V1 publication creates current-user/SYSTEM private files at CreateNew and preserves bytes', {skip:process.platform!=='win32',timeout:45000},async()=>{
 const f=fixture({measureParent:true});let release
 try{
  release=f.store.publishBootstrap(3180,'http://127.0.0.1:3180/?token=synthetic',f.home)
  assert.equal(f.store.readBootstrap(3180,f.home).pid,process.pid)
  assert.equal(f.store.nativeCalls.length,2,'helper and record must use the real CreateNew descriptor boundary')
  assert.equal(f.store.events.filter(x=>x.operation==='openSync'&&x.flags==='wx').length,0,'Windows must not create a default-owner file first')
  for(const call of f.store.nativeCalls){assert.ok(Buffer.isBuffer(call.input));assert.match(call.script,/FileSecurity/);assert.match(call.script,/\$stream\.Flush\(\$true\)/);assert.equal(call.parentAfter,call.parentBefore,'file creation itself must preserve the parent descriptor')}
  const files=fs.readdirSync(f.directory).map(name=>path.join(f.directory,name)),security=acl(files)
  for(const row of security.rows){
   assert.equal(row.owner,security.currentSID);assert.equal(row.protected,true);assert.equal(row.reparse,false)
   assert.deepEqual(row.rules.map(x=>x.sid).sort(),[security.currentSID,'S-1-5-18'].sort())
   for(const rule of row.rules){assert.equal(rule.type,'Allow');assert.equal(rule.inherited,false);assert.equal(rule.rights,2032127)}
  }
  assert.equal(hash(path.join(f.directory,'read-bootstrap.cjs')),createHash('sha256').update(source).digest('hex'))
 }finally{release?.();f.close()}
})

test('CreateNew collision preserves an existing ordinary temp without deleting it', {skip:process.platform!=='win32',timeout:30000},()=>{
 const f=fixture({collision:true}),temp=path.join(f.directory,'.'+fixed+'.tmp'),target=path.join(f.directory,'target')
 try{
  fs.writeFileSync(temp,'unchanged collision')
  assert.throws(()=>f.store.testAtomic(f.directory,'target','replacement'))
  assert.equal(fs.readFileSync(temp,'utf8'),'unchanged collision');assert.equal(fs.existsSync(target),false)
  assert.equal(f.store.events.filter(x=>x.operation==='unlinkSync'&&x.path===temp).length,0)
 }finally{f.close()}
})

test('native write and flush failures close the real handle and delete only the newly owned temp', {skip:process.platform!=='win32',timeout:35000},()=>{
 for(const failNative of ['write','flush']){
  const f=fixture({failNative})
  try{
   assert.throws(()=>f.store.testAtomic(f.directory,'target','not published'),/synthetic/)
   assert.equal(f.store.nativeCalls.length,1);assert.deepEqual(fs.readdirSync(f.directory),[])
  }finally{f.close()}
 }
})

test('rename or link failures remove their owned temp and do not mutate an existing target', {timeout:35000},()=>{
 for(const failFs of ['renameSync','linkSync']){
  const f=fixture({failFs}),target=path.join(f.directory,'target')
  try{
   // 故障目标必须先由无故障原函数私有创建，避免Home默认BA先在owner门禁失败。
   load().testAtomic(f.directory,'target','original')
   assert.throws(()=>f.store.testAtomic(f.directory,'target','replacement',failFs==='linkSync'),/synthetic/)
   assert.equal(fs.readFileSync(target,'utf8'),'original');assert.deepEqual(fs.readdirSync(f.directory),['target'])
  }finally{f.close()}
 }
})

test('immutable same data is reused and different data never overwrites the original', {skip:process.platform==='win32'&&process.env.LOAD78_BOOTSTRAP_REQUIRE_LINK!=='1',timeout:35000},()=>{
 const f=fixture();try{
  f.store.testAtomic(f.directory,'adapter','中文\noriginal🙂',true)
  f.store.testAtomic(f.directory,'adapter','中文\noriginal🙂',true)
  assert.throws(()=>f.store.testAtomic(f.directory,'adapter','different',true),/BOOTSTRAP_INVALID_ADAPTER/)
  assert.equal(fs.readFileSync(path.join(f.directory,'adapter'),'utf8'),'中文\noriginal🙂');assert.deepEqual(fs.readdirSync(f.directory),['adapter'])
 }finally{f.close()}
})

test('an existing default-owner BA/other target is rejected rather than adopted', {skip:process.platform!=='win32',timeout:25000},t=>{
 const f=fixture(),target=path.join(f.directory,'target')
 try{
  fs.writeFileSync(target,'existing foreign owner')
  const before=acl([target]);if(before.rows[0].owner===before.currentSID)return t.skip('local token default owner equals current SID; actual foreign-owner branch is a required Home control')
  assert.throws(()=>f.store.testAtomic(f.directory,'target','replacement'))
  assert.equal(fs.readFileSync(target,'utf8'),'existing foreign owner');assert.equal(acl([target]).rows[0].sddl,before.rows[0].sddl)
  assert.deepEqual(fs.readdirSync(f.directory),['target'])
 }finally{f.close()}
})

// Windows严格link场景由Root在可执行该原API的Home实验运行；本地EPERM不改产品链接合同。
test('V2 real immutable publication keeps the exact adapter and requested binding', {skip:process.platform==='win32'&&process.env.LOAD78_BOOTSTRAP_REQUIRE_LINK!=='1',timeout:45000},async()=>{
 const f=fixture();let release
 try{
  const adapter="module.exports={validateRequest:r=>r,exchangeCredential:async()=>({Cookie:'synthetic=value'}),success:(m,r,h)=>({version:2,ok:true,port:r.port,pid:m.pid,instanceId:m.instanceId,forwardPort:r.forwardPort,generation:r.generation,requestHeaders:h})}"
  release=f.store.publishBootstrap(3180,'http://127.0.0.1:3180/?token=synthetic',f.home,adapter)
  const reply=await f.store.readBootstrapV2({version:2,port:3180,forwardPort:33180,generation:'synthetic'},{home:f.home})
  assert.equal(reply.ok,true);assert.equal(reply.requestHeaders.Cookie,'synthetic=value');assert.equal(reply.forwardPort,33180);assert.equal(reply.generation,'synthetic')
  const record=JSON.parse(fs.readFileSync(path.join(f.directory,'bootstrap-3180.json')))
  assert.equal(fs.readFileSync(path.join(f.directory,`read-bootstrap-auth-${record.authAdapterSha256}.cjs`),'utf8'),adapter)
 }finally{release?.();f.close()}
})

test('CreateNew rejects a real reparse temp without deleting its link or destination', {skip:process.platform!=='win32'||process.env.LOAD78_BOOTSTRAP_REQUIRE_LINK!=='1',timeout:25000},()=>{
 const f=fixture({collision:true}),temp=path.join(f.directory,'.'+fixed+'.tmp')
 try{
  const destination=path.join(f.home,'junction-target');fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'keep'),'untouched')
  fs.symlinkSync(destination,temp,'junction')
  assert.throws(()=>f.store.testAtomic(f.directory,'target','replacement'))
  assert.equal(fs.lstatSync(temp).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(destination,'keep'),'utf8'),'untouched')
  assert.equal(f.store.events.filter(x=>x.operation==='unlinkSync'&&x.path===temp).length,0)
 }finally{f.close()}
})
