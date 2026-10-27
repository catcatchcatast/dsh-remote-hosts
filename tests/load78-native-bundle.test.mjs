// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                 
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import{createRequire}from'node:module';import{fileURLToPath,pathToFileURL}from'node:url';
import * as boundary from '../packages/runtime-interface/src/index.js';
const workspace=fileURLToPath(new URL('..',import.meta.url)),own=process.env.DSH_TEST_DIRECTORY||path.join(workspace,'.tmp/synthetic-bundle-tests');await fs.mkdir(own,{recursive:true});
const specs=[{name:'021',root:process.env.DSH_OFFICIAL_021_ROOT,upstreamVersion:'0.2.1-rc.2',startup:'webStartup'},{name:'020',root:process.env.DSH_WEB020_RUNTIME,upstreamVersion:'0.2.0-rc.2',startup:'webRuntime'}];
async function composition(spec){
 assert.ok(spec.root,'explicit actual SDK root required: '+spec.name);const req=createRequire(path.join(spec.root,'package.json')),load=s=>import(pathToFileURL(req.resolve(s)).href);
 const boot=await load('@deepseek-ai/dsh-app-boot'),yaml=req('js-yaml');
 const source=path.join(workspace,'packages/runtime-interface'),dir=await fs.mkdtemp(path.join(own,'profile-'));const packageDir=path.join(dir,'node_modules/dsh-runtime-interface');await fs.mkdir(packageDir,{recursive:true});
 await fs.copyFile(path.join(source,'package.json'),path.join(packageDir,'package.json'));await fs.copyFile(process.env.LOAD78_BUNDLE_CONTROL==='before'?process.env.LOAD78_BUNDLE_BEFORE_PATCH:path.join(source,'cordis.patch.yml'),path.join(packageDir,'cordis.patch.yml'));
 const installation=path.join(dir,'installation'),webPackage=path.dirname(req.resolve('@deepseek-ai/dsh-web-app/package.json')),webManifest=JSON.parse(await fs.readFile(path.join(webPackage,'package.json'),'utf8')),webTarget=path.join(installation,'node_modules/@deepseek-ai/dsh-web-app');await fs.mkdir(webTarget,{recursive:true});await fs.writeFile(path.join(installation,'package.json'),JSON.stringify({name:'load78-closed-test-anchor'}));await fs.copyFile(path.join(webPackage,'package.json'),path.join(webTarget,'package.json'));for(const original of boot.bundlePatchPaths(webPackage,webManifest.dsh.bundle)){const target=path.join(webTarget,path.relative(webPackage,original));await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(original,target);}
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'load78-synthetic-profile',dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app','dsh-runtime-interface']}}}));
 try{
  const profile=boot.loadProfileDirectory('load78',dir,path.join(installation,'package.json'),{userLayer:false});assert.deepEqual(profile.skippedBundles,[]);assert.equal(path.resolve(profile.layers.find(x=>x.packageName==='dsh-runtime-interface').packageDir),path.resolve(packageDir));assert.equal(await fs.readFile(profile.layers[1].patchPaths[0],'utf8'),await fs.readFile(process.env.LOAD78_BUNDLE_CONTROL==='before'?process.env.LOAD78_BUNDLE_BEFORE_PATCH:path.join(source,'cordis.patch.yml'),'utf8'));
  const entries=boot.composeEntries(profile.layers.map(layer=>layer.patches)),flat=[];const walk=rows=>{for(const row of rows){flat.push(row);if(row.group&&Array.isArray(row.config))walk(row.config)}};walk(entries);
  const base=boot.composeEntries([profile.layers[0].patches]);const baseFlat=[];const baseWalk=rows=>{for(const row of rows){baseFlat.push(row);if(row.group&&Array.isArray(row.config))baseWalk(row.config)}};baseWalk(base);
  return{req,load,boot,yaml,dir,connection:flat.find(x=>x.id==='connection'),interface:flat.find(x=>x.id==='runtime-interface'),baseConnection:baseFlat.find(x=>x.id==='connection'),async close(){await fs.rm(dir,{recursive:true,force:true});}};
 }catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
}
for(const spec of specs){
 test('public '+spec.name+' bundle preserves the actual official Connection entry inputs',async()=>{
  const c=await composition(spec);try{assert.deepEqual(c.connection.inject,c.baseConnection.inject);assert.deepEqual(c.connection.config,c.baseConnection.config);assert.deepEqual(c.baseConnection.inject,[spec.startup]);assert.equal(c.interface.name,'dsh-runtime-interface');}finally{await c.close();}
 });
 test('public '+spec.name+' bundle actual boot activates original Connection and interface, subscriptions097 Fetch routes and auth', {timeout:15000},async()=>{
  const c=await composition(spec),routes=new Map();let ctx,prepared;
  try{
   const module=await c.load('@deepseek-ai/dsh-client-connection');
   const rows=[{...c.connection,name:'cordis:real-connection'},{...c.interface,name:'cordis:actual-interface',config:{upstreamVersion:spec.upstreamVersion,historyEpoch:{datasetId:'bundle-synthetic',sequenceFormatGeneration:4,generation:1}}}];
   const {entryListSchema}=await c.load('@deepseek-ai/cordis-plugin-include');const file=path.join(c.dir,'cordis.yml');await fs.writeFile(file,c.yaml.dump(rows,{schema:entryListSchema}));
   ctx=await c.boot.boot('load78',file,[],async root=>{
    prepared=root;root.loader.builtins['real-connection']=module;root.loader.builtins['actual-interface']=boundary;
    const stored=new Map();const services={credentials:{async modifyRecord(key,update){const next=await update(stored.get(key));if(next!==undefined)stored.set(key,next);return stored.get(key);}},webServer:{port:0,register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}},webStartup:{trustedHosts:['127.0.0.1:3180']},typertGateway:{},sessionController:{},workspaceController:{},subagents:{},commands:{},goals:{},agentPresets:{},sessionPersistence:{}};
    if(spec.name==='020')services.webRuntime={trustedHosts:['127.0.0.1:3180']};
    await root.plugin({name:'synthetic-services',apply(scope){for(const[k,v]of Object.entries(services))scope.provide(k,v);}});
   });
   assert.ok(ctx.get('connection'));assert.ok(ctx.get('runtimeInterface'));assert.equal([...ctx.get('loader').entries()].find(e=>e.options.id==='connection').fiber.state,2);assert.equal([...ctx.get('loader').entries()].find(e=>e.options.id==='runtime-interface').fiber.state,2);
   const release=ctx.get('runtimeInterface').registerManagementRpc({channel:'/fixture-management',dispatch:async()=>({fixture:true})});assert.ok(routes.has('/fixture-management'));release();assert.equal(routes.has('/fixture-management'),false);
   const nativeReq=createRequire(path.join(process.env.DSH_OFFICIAL_021_ROOT,'package.json'));const packageRoot=path.dirname(nativeReq.resolve('dsh-plugin-subscriptions/package.json'));const{registerAuthRpc}=await import(pathToFileURL(path.join(packageRoot,'lib/auth/rpc.js')).href);
   const registration=ctx.plugin({name:'actual-original-subscriptions-fetch',apply(scope){registerAuthRpc(scope,{async status(){return{busy:false,accounts:[]};}},{});}});await registration;
   const connection=ctx.get('connection'),request=new Request('http://fixture.invalid/api/subscriptions-auth.status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'synthetic-auth',method:'subscriptions-auth.status',payload:{}})});
   const reply=await connection.createSharedFetchHandler('/api').fetch(request,connection.browserPeer??connection.operator);const result=await reply.json();assert.equal(result.rpcId,'synthetic-auth');assert.equal(result.result.ok,true);assert.equal(Object.keys(result.result.value.providers).length,5);
   const api=routes.get('/api'),res={status:undefined,writeHead(code){this.status=code;},end(){}};await api.handler({method:'POST',url:'/api/subscriptions-auth.status',headers:{host:'127.0.0.1:3180'}},res);assert.equal(res.status,401);
   await registration.dispose();assert.equal((await connection.createSharedFetchHandler('/api').fetch(request,connection.browserPeer??connection.operator)).status,404);
  }finally{await ctx?.fiber.dispose();if(!ctx&&prepared)await prepared.fiber.dispose();await c.close();assert.equal(routes.size,0);}
 });
}
