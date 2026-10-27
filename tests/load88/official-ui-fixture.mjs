// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                    
                                                                                                  
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (!process.env.DSH_OFFICIAL_021_RUNTIME) throw Error('Set DSH_OFFICIAL_021_RUNTIME to a clean 0.2.1-rc.2 installation')
const official=path.join(process.env.DSH_OFFICIAL_021_RUNTIME,'node_modules/@deepseek-ai')
const requireDev=createRequire(new URL('../../package.json',import.meta.url))
const {JSDOM}=requireDev('jsdom')
const owned=path.dirname(fileURLToPath(import.meta.url))
export const composite=(host,id)=>'rh1.'+Buffer.from(host).toString('base64url')+'.'+Buffer.from(id).toString('base64url')
export async function fixture({interfaceClient,remoteClient,workspaceSnapshot,sessionSnapshot,remoteFirst=false}={}) {
  const dom=new JSDOM('<!doctype html><html><head></head><body><div id="fixture-root"></div></body></html>',{url:'http://fixture.invalid/'})
  const timers=new Set(),intervals=new Set(),errors=[],calls=[],inventoryCalls=[]
  let visibility="visible", inventoryData, inventoryFailure=false, openFailure=false,copyFailure=false
  Object.defineProperty(dom.window.document,"visibilityState",{get(){return visibility},configurable:true})
  let disposeContext
  const copied=[],opened=[]
  Object.defineProperty(dom.window.navigator,"clipboard",{value:{writeText:async text=>{if(copyFailure)throw Error('synthetic clipboard denied');copied.push(text)}},configurable:true})
  try {
  const later=(fn,ms,...args)=>{const t=setTimeout(()=>{timers.delete(t);fn(...args)},ms);timers.add(t);return t}
  // JSDOM没有布局观测器；仅为原生虚拟列表提供固定容器尺寸，不参与任何排序。
  class FixtureResizeObserver { constructor(callback){this.callback=callback;this.active=true} observe(target){queueMicrotask(()=>{if(this.active)this.callback([{target,contentRect:{width:900,height:1800},borderBoxSize:[{inlineSize:900,blockSize:1800}],contentBoxSize:[{inlineSize:900,blockSize:1800}]}])})}unobserve(){}disconnect(){this.active=false} }
  const ctxvm=vm.createContext({ResizeObserver:FixtureResizeObserver,queueMicrotask,btoa,atob,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),console:{...console,error(...args){errors.push(args.map(x=>x?.stack??String(x)).join(' '))}},window:dom.window,document:dom.window.document,navigator:dom.window.navigator,location:dom.window.location,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,MutationObserver:dom.window.MutationObserver,HTMLIFrameElement:dom.window.HTMLIFrameElement,MouseEvent:dom.window.MouseEvent,KeyboardEvent:dom.window.KeyboardEvent,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,AbortSignal,performance,crypto:globalThis.crypto,setTimeout:later,clearTimeout(t){timers.delete(t);clearTimeout(t)},setInterval(fn,ms,...args){const t=setInterval(fn,ms,...args);intervals.add(t);return t},clearInterval(t){intervals.delete(t);clearInterval(t)},requestAnimationFrame(fn){return later(()=>fn(performance.now()),0)},cancelAnimationFrame(t){timers.delete(t);clearTimeout(t)},fetch(url,options){if(url==='open-in-app/apps')return Promise.resolve({ok:true,json:async()=>({apps:['vscode','explorer']})});if(url==='open-in-app/open'){opened.push(JSON.parse(options.body));return Promise.resolve({ok:!openFailure,status:openFailure?503:200})}inventoryCalls.push({url,options});if(inventoryFailure)return Promise.reject(new TypeError('inventory failed'));return Promise.resolve({ok:true,json:async()=>({hosts:inventoryData??roster.map(item=>({hostId:item.hostId??item.id,label:item.label,state:item.state}))})})},matchMedia(){return{matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}}})
  dom.window.matchMedia=ctxvm.matchMedia
  const modules=new Map()
  async function loadEsm(filename,source) {
    const key=pathToFileURL(filename).href
    if(modules.has(key))return modules.get(key)
    const m=new vm.SourceTextModule(source??fs.readFileSync(filename,'utf8'),{context:ctxvm,identifier:key,initializeImportMeta(meta){meta.url=key},importModuleDynamically(){throw Error('FIXTURE_NO_DYNAMIC_NETWORK')}})
    modules.set(key,m)
    await m.link(async(spec,parent)=>{
      if(!spec.startsWith('./'))throw Error('UNEXPECTED_FRONTEND_IMPORT:'+spec)
      const target=fileURLToPath(new URL(spec,parent.identifier)).replaceAll('\\','/')
      if(!target.startsWith(official+'/dsh-web-frontend/dist/assets/'))throw Error('FRONTEND_IMPORT_SCOPE')
      return loadEsm(target)
    })
    return m
  }
  // 测试只移除原应用自动启动尾段并导出原shared表，官方组件和公共Slot实现原字节执行，官方磁盘文件不改。
  const frontend=official+'/dsh-web-frontend/dist/assets/index-CN7NIWNw.js',text=fs.readFileSync(frontend,'utf8'),cut=text.indexOf('const Ms=globalThis.dshDesktopBoot')
  if(cut<0||!text.includes('function SZ(){return{react:'))throw Error('OFFICIAL_FRONTEND_BOUNDARY_CHANGED')
  const sharedModule=await loadEsm(frontend,text.slice(0,cut)+'\nexport const sharedForFixture=SZ();')
  await sharedModule.evaluate()
  const shared=sharedModule.namespace.sharedForFixture,loaded=new Map();let hostSubscriptions=0;const subscriptionHooks=new WeakMap();const labelReact={...shared.react,useSyncExternalStore(subscribe,getSnapshot,getServerSnapshot){let wrapped=subscriptionHooks.get(subscribe);if(!wrapped){wrapped=fn=>{hostSubscriptions++;const stop=subscribe(fn);let active=true;return()=>{if(active){active=false;hostSubscriptions--;stop()}}};subscriptionHooks.set(subscribe,wrapped)}return shared.react.useSyncExternalStore(wrapped,getSnapshot,getServerSnapshot)}}
  const loader={load({id,factory}){loaded.set(id,factory)}}
  dom.window.__ModuleLoader__=loader
  function requireBrowser(name){if(loaded.has(name)){const f=loaded.get(name);if(typeof f==='function'){const value=f(spec=>name==='dsh-remote-hosts'&&spec==='react'?labelReact:requireBrowser(spec));loaded.set(name,value);return value}return f}if(shared[name])return shared[name];throw Error('MISSING_BROWSER_MODULE:'+name)}
  function loadClient(name,file){vm.runInContext(fs.readFileSync(file,'utf8'),ctxvm,{filename:file});return requireBrowser(name)}
  const React=shared.react,store=shared['@deepseek-ai/dsh-client-store'],Context=shared['@deepseek-ai/cordis'].Context
  const renderer=loadClient('@deepseek-ai/dsh-client-ui-renderer',official+'/dsh-client-ui-renderer/lib/client.js')
  const workspace=loadClient('@deepseek-ai/dsh-client-ui-workspace',official+'/dsh-client-ui-workspace/lib/client.js')
  const ctx=new Context(),local=composite('local','same'),ubuntu=composite('remote-example','same')
  disposeContext=ctx
  const workspaces=store.createSnapshotStore(workspaceSnapshot??{phase:'loading',state:'loading',items:[{workspaceId:local,title:'same-workspace',path:'/synthetic/local',sessionIds:[]},{workspaceId:ubuntu,title:'same-workspace',path:'/synthetic/remote',sessionIds:[]}],archivedSessionIds:[],pinnedSessionIds:[]})
  const sessions=store.createSnapshotStore(sessionSnapshot??{phase:'loading',ids:[],byId:{}})
  const shortcuts=store.createSnapshotStore([]),panel=store.createSnapshotStore({activePanelId:null}),settingsPanel=store.createSnapshotStore(false)
  const dictionaries=new Map(),localeListeners=new Set()
  const locale={register(ns,dict){dictionaries.set(ns,dict.en);return()=>dictionaries.delete(ns)},bind(ns){return(key,args={})=>{let s=dictionaries.get(ns)?.[key]??key;for(const[k,v]of Object.entries(args))s=s.replaceAll('{'+k+'}',String(v));return s}},getSnapshot:()=>({revision:0}),subscribe(fn){localeListeners.add(fn);return()=>localeListeners.delete(fn)}}
  let roster=[{id:'local',hostId:'local',label:'Laptop',kind:'local',state:'connected'},{id:'remote-example',hostId:'remote-example',label:'Ubuntu',kind:'remote',state:'connected'}]
  const rpc={async call(channel,method,payload){calls.push({channel,method});if(channel==='/remote-hosts')return{ok:true,value:{hosts:roster,suggestedLocalPort:35000}};throw Error('UNEXPECTED_BUSINESS_RPC')}}
  const renderPlugin=ctx.plugin(renderer);await renderPlugin
  ctx.slots.installLocale(locale)
  ctx.slots.installScope('session',{current:store.createSnapshotStore({key:undefined,ctx:undefined}),resolve(){return {key:undefined,ctx:undefined}},subscribeReleased(){return()=>{}}})
  ctx.provide('sessions',{list:sessions,projectList(){throw Error('UNEXPECTED_SESSION_PROJECT')},search(){throw Error('UNEXPECTED_SEARCH')}})
  ctx.provide('workspaces',{list:workspaces})
  ctx.provide('locale',locale)
  ctx.provide('layout',{panelInfo:panel,beginNavigation(){throw Error('UNEXPECTED_NAVIGATION')},selectPanel(){throw Error('UNEXPECTED_NAVIGATION')}})
  ctx.provide('remote',{$host:{home:'/synthetic'},directoryPicker:{},$on(){return()=>{}}})
  ctx.provide('remote.directoryPicker',{})
  ctx.provide('remote.session',{})
  ctx.provide('remoteAccess',{source(){return store.createSnapshotStore(undefined)}})
  ctx.provide('shortcuts',{catalog:shortcuts,register(){return()=>{}}})
  let remote,remotePlugin
  if(remoteFirst){remote=loadClient('dsh-remote-hosts',remoteClient);remotePlugin=ctx.plugin(remote);await remotePlugin}
  const workspacePlugin=ctx.plugin(workspace);await workspacePlugin
  ctx.slots.provideRoot({hooks:{sessions,panelInfo:panel,sessionStatus:store.createSnapshotStore(new Map())},keyedHooks:{sessionAccess:()=>store.createSnapshotStore(undefined)}})
  const apiModule=loadClient('dsh-runtime-interface',interfaceClient)
  const api=apiModule.createRemoteHostsClient(rpc,{initialHosts:roster})
  ctx.provide('remoteHostsInterface',api)
  ctxvm.__DSH_BROWSER_HOST_HUB__={getHosts:()=>roster}
  ctx.slots.register({name:'root',children:{'sidebar.workspaces':{kind:'single',scope:'root'},'conversation.session.header.utilities':{kind:'list',scope:'root'},'shell.overlay':{kind:'list',scope:'root'},'settings.section':{kind:'list',scope:'root'}}},({renderSlot})=>{const show=React.useSyncExternalStore(settingsPanel.subscribe,settingsPanel.getSnapshot);return React.createElement(React.Fragment,null,renderSlot('sidebar.workspaces',{wide:true,expandSidebar(){}}),renderSlot('shell.overlay',{}),show?renderSlot('settings.section',{}):null)})
  const openerModule=loadClient('@deepseek-ai/dsh-client-ui-open-in-app',official+'/dsh-client-ui-open-in-app/lib/client.js')
  const openerPlugin=ctx.plugin(openerModule);await openerPlugin
  const openerFace=ctx.slots.entries('conversation.session.header.utilities').find(e=>e.options.id==='open-in-app').inject()
  const openerApps=openerFace.hooks.openInAppApps,openerChoice=openerFace.hooks.openInAppChoice,openerOperation=openerFace.hooks.openInAppLaunch
  openerChoice.set('vscode')
  const stopOpener=()=>openerPlugin.dispose()
  const nativeEntry=ctx.slots.entries('sidebar.workspaces')[0],nativeBefore={component:nativeEntry?.component,children:nativeEntry?.children,store:nativeEntry?.store,inject:nativeEntry?.inject,locale:nativeEntry?.locale}
  if(!remotePlugin){remote=loadClient('dsh-remote-hosts',remoteClient);remotePlugin=ctx.plugin(remote);await remotePlugin}
  const unmount=ctx.uiRenderer.mount(dom.window.document.getElementById('fixture-root'))
  const settle=async()=>{for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setTimeout(resolve,0))}}
  await settle()
  return{failOpen(value){openFailure=value},failCopy(value){copyFailure=value},copied,opened,openerChoice,openerApps,openerOperation,stopOpener,nativeEntry,nativeBefore,registrationDiagnostics:{workspaceState:workspacePlugin.state,required:workspace.inject.map(key=>({key,present:ctx.get(key)!==undefined}))},get hostSubscriptions(){return hostSubscriptions},mountRemote(){return ctx.plugin(remote)},dom,ctx,inventoryCalls,showSettings(value){settingsPanel.set(value)},setVisibility(value){visibility=value;dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))},setInventory(value){inventoryData=value},failInventory(value){inventoryFailure=value},get originalApi(){return api},get api(){const entry=ctx.slots.entries('settings.section').find(item=>item.options.id==='remote-hosts');const management=entry?.inject().hostsApi??api;return{...management,hosts:ctx.get('remoteWorkspaceHostLabels')}},remotePlugin,workspaces,sessions,local,ubuntu,errors,calls,React,shared,async settle(){await settle()},setRoster(next){roster=next},async close(){unmount();await ctx.fiber.dispose();for(const t of timers)clearTimeout(t);for(const t of intervals)clearInterval(t);timers.clear();intervals.clear();dom.window.close()},officialInputs:[frontend,official+'/dsh-client-ui-renderer/lib/client.js',official+'/dsh-client-ui-workspace/lib/client.js',official+'/dsh-client-ui-open-in-app/lib/client.js'],bootBoundaryCut:cut}
  } catch(error) { try{await disposeContext?.fiber.dispose()}finally{for(const t of timers)clearTimeout(t);for(const t of intervals)clearInterval(t);dom.window.close()}throw error }
}
