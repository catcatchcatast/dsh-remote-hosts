// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                                     
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const test = (name, run) => nodeTest(name, { timeout: 10000 }, run);
const workspace = fileURLToPath(new URL('..', import.meta.url));
const native = process.env.DSH_OFFICIAL_021_ROOT || workspace;
const requireNative = createRequire(path.join(native, 'package.json'));
const load = specifier => import(pathToFileURL(requireNative.resolve(specifier)).href);
const [{ Context }, { default: Typert }, { default: Access }, { default: Gateway }, ClientApi, { HostConnectionService }, { LocalFileSystem }, { default: WorkspaceFiles }, { default: filesRemote }, ConnectionClient, { default: Office, OfficeToPdfError }, { default: officeRemote }] = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-api-workspace-files', '@deepseek-ai/dsh-api-workspace-files/remote', '@deepseek-ai/dsh-client-connection/client', '@deepseek-ai/dsh-office-to-pdf', '@deepseek-ai/dsh-office-to-pdf/remote'].map(load));
const savedFetch = globalThis.fetch;
const vi = { stubGlobal(name, value) { assert.equal(name, 'fetch'); globalThis.fetch = value; }, unstubAllGlobals() { globalThis.fetch = savedFetch; } };
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { BrowserHostHub, encodeCompositeId, HOST_RPC_ALLOWLIST, handleBffRequest, serveStreamSocket } from '../packages/browser-host-hub-rc1/src/index.js';
import { wrapHostCarrier } from '../packages/runtime-interface/src/index.js';
import { createCarrier } from '../packages/runtime-interface/src/http-carrier.js';
const own = process.env.DSH_TEST_DIRECTORY || path.join(workspace, '.tmp/synthetic-native-office-tests');
await mkdir(own, { recursive: true });
const fresh = () => new AbortController();
async function fixture() {
    const root = await mkdtemp(path.join(own, 'files-')), hosts = [], calls = [], browser = new Context();
    const perHost = {}, endpoints = {};
    try {
        for (const hostId of ['local', 'home']) {
            const ctx = new Context(), directory = path.join(root, hostId);
            hosts.push(ctx);
            await mkdir(directory);
            await writeFile(path.join(directory, 'test.txt'), hostId + ' text');
            await ctx.plugin(LocalFileSystem, { cwd: directory });
            ctx.provide('sandboxPolicy', { workspaceRoot: directory, resolve: () => ({ mode: 'workspace-write', workspaceRoot: directory }) });
            ctx.provide('sessions', { get(id) { return id === 'same-session' ? { header: { id, cwd: directory } } : undefined; } });
            await ctx.plugin(Typert);
            await ctx.plugin(Access);
            const connection = new HostConnectionService(ctx, [], {});
            const gateway = new Gateway(ctx, { websocketHeartbeatIntervalMs: 15000, streamInboxBytes: 16 * 1024 * 1024 });
            await ctx.plugin(WorkspaceFiles, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 });
            await writeFile(path.join(directory, 'report.docx'), Buffer.from('SYNTHETIC-OOXML-TEST'));
            await ctx.plugin(Office);
            const provider = ctx.get('officeToPdf');
            provider.convert = async (request, signal) => {
                calls.push({ hostId, conversion: true, priority: request.priority });
                const loaded = await request.source.read(signal, 1024);
                assert.equal(Buffer.from(loaded.bytes).toString(), 'SYNTHETIC-OOXML-TEST');
                return { pdf: new TextEncoder().encode('%PDF-1.4\n'+hostId+' fixture\n%%EOF'), missingFonts: ['Fixture Serif'], generation: provider.generation, cacheKey: 'fixture' };
            };
            const fetch = connection.createSharedFetchHandler('/api');
            endpoints[hostId] = { fetch, connection, ctx };
            const carrier = {
                async call(endpoint, payload, signal) {
                    calls.push({ hostId, endpoint, payload, signal });
                    const request = new Request('http://fixture.invalid/api/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: endpoint, payload }), signal });
                    return (await (await fetch.fetch(request, connection.browserPeer)).json()).result;
                },
                async *open(endpoint, payload, signal) {
                    calls.push({ hostId, endpoint, payload, signal });
                    const stream = await gateway.wireStream.open(endpoint, payload, (async function* () { })(), connection.browserPeer, signal);
                    try {
                        for await (const frame of stream)
                            yield frame;
                    }
                    finally {
                        calls.push({ hostId, closed: endpoint });
                    }
                },
            };
            perHost[hostId] = { hostId, carrier: wrapHostCarrier({ hostId, carrier, upstreamVersion: '0.2.1-rc.2' }), upstreamVersion: '0.2.1-rc.2' };
        }
        const hub = new BrowserHostHub({ perHost, selectedHost: 'local', browserVersion: '0.2.1-rc.2' });
        await browser.plugin(Typert);
        const handle = { interactions: 'none', isLoopback: true, generation: { getSnapshot: () => undefined }, rpc: {
                call(_channel, endpoint, payload, signal) { return hub.call(endpoint, { ...payload, __hostId: hub.getSelectedHost() }, signal); },
                open(_channel, endpoint, payload, signal) { return hub.openStream(endpoint, { ...payload, __hostId: hub.getSelectedHost() }, signal); },
            }, openWebSocket() { throw Error('NO_SOCKET_EXPECTED'); } };
        browser.provide('connection', handle);
        await browser.plugin(ClientApi);
        await browser.get('remote').$mount(filesRemote);
        await browser.get('remote').$mount(officeRemote);
        return { root, hosts, browser, hub, calls, perHost, endpoints, handle, remote: browser.get('remote'), async close() { await browser.fiber.dispose(); for (const ctx of hosts.reverse())
                await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
    }
    catch (error) {
        await browser.fiber.dispose();
        for (const ctx of hosts.reverse())
            await ctx.fiber.dispose();
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
class Reply extends Writable {
    status = 0;
    headers = {};
    headersSent = false;
    chunks = [];
    wrote = Promise.withResolvers();
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
    _write(chunk, _encoding, done) { this.chunks.push(Buffer.from(chunk)); this.wrote.resolve(); done(); }
}
async function binaryTransport(f, mode = 'normal') {
    const rawCalls = [], browserCalls = [], upstreamSignals = [], lifetime = fresh();
    let cancelled = false;
    const gates = Promise.withResolvers();
    vi.stubGlobal('fetch', async (input, init = {}) => {
        const request = new Request(input, init), url = new URL(request.url);
        if (url.pathname === '/')
            return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'fixture=1' } });
        const hostId = url.port === '40101' ? 'local' : 'home', entry = f.endpoints[hostId];
        const message = JSON.parse(await request.clone().text());
        rawCalls.push({ hostId, path: url.pathname, message, method: request.method });
        upstreamSignals.push(init.signal);
        const response = await entry.fetch.fetch(request, entry.connection.browserPeer);
        assert.equal(init.redirect, 'error');
        if (mode === 'normal') {
            const headers = new Headers(response.headers);
            headers.set('set-cookie', 'fixture=private');
            headers.set('content-length', '1');
            headers.set('connection', 'keep-alive');
            return new Response(response.body, { status: response.status, headers });
        }
        const data = new Uint8Array(await response.arrayBuffer());
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(data); if (mode === 'fail')
                queueMicrotask(() => controller.error(Error('fixture-stream-error'))); }, cancel() { cancelled = true; gates.resolve(); } }), { status: response.status, headers: response.headers });
    });
    for (const [i, hostId] of ['local', 'home'].entries()) {
        const origin = `http://127.0.0.1:${40101 + i}`;
        const carrier = await createCarrier(origin, origin + '/?token=fixture', class {
            constructor() { throw Error('NO_SOCKET_EXPECTED'); }
        }, lifetime.signal);
        f.perHost[hostId].raw = carrier.raw;
    }
    const send = async (input, init) => {
        const request = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body, complete: true });
        const reply = new Reply();
        reply.on('error', () => { });
        browserCalls.push({ message: JSON.parse(init.body), request, reply });
        const abort = () => request.emit('aborted');
        init.signal?.addEventListener('abort', abort, { once: true });
        try {
            await handleBffRequest({ authorizeRequest: () => undefined }, f.hub, JSON.parse(init.body).method, request, reply);
            if (!reply.writableFinished) await finished(reply);
            return new Response(Buffer.concat(reply.chunks), { status: reply.status, headers: reply.headers });
        }
        finally {
            init.signal?.removeEventListener('abort', abort);
        }
    };
    const connectionCtx = new Context();
    ConnectionClient.installConnection(connectionCtx, { interactions: 'none', transport: { fetch: send, openStream: (endpoint, payload, signal) => f.hub.openStream(endpoint, payload, signal) } });
    f.handle.rpc = connectionCtx.get('connection').rpc;
    return { rawCalls, browserCalls, upstreamSignals, gates, get cancelled() { return cancelled; }, async close() { lifetime.abort(); await connectionCtx.fiber.dispose(); vi.unstubAllGlobals(); } };
}

test('Hub lifetime generation does not read selected Hosts and is stable across selection but unique per Hub', async () => {
 const f=await fixture(), abort=fresh();
 try {
  const first=await f.remote.officeToPdf.generation(abort.signal);assert.equal(first.ok,true);
  assert.match(first.value,/^dsh-hub-office-generation-/);
  f.hub.setSelectedHost('home');const again=await f.remote.officeToPdf.generation(abort.signal);assert.deepEqual(again,first);
  const other=new BrowserHostHub({perHost:f.perHost,selectedHost:'home',browserVersion:'0.2.1-rc.2'});
  const next=await other.call('officeToPdf/generation',{args:{}},abort.signal);assert.notEqual(next.value,first.value);
  assert.equal(f.calls.filter(x=>x.endpoint==='officeToPdf/generation').length,0);
 } finally {abort.abort();await f.close();}
});
test('actual Office render → native multipart → browser generated decoder preserves Host scope/rpcId/PDF/generation', async () => {
 const f=await fixture(), abort=fresh(), t=await binaryTransport(f);
 try {
  const result=await f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'report.docx','foreground',abort.signal);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(new TextDecoder().decode(result.value.data),'%PDF-1.4\nhome fixture\n%%EOF');
  assert.equal(result.value.generation,f.endpoints.home.ctx.get('officeToPdf').generation);
  assert.deepEqual(result.value.missingFonts,['Fixture Serif']);
  assert.equal(result.value.offset,0);assert.equal(result.value.eof,true);
  const raw=t.rawCalls.at(-1),browser=t.browserCalls.at(-1);
  assert.equal(raw.hostId,'home');assert.equal(raw.path,'/api/officeToPdf/render');
  assert.equal(raw.message.rpcId,browser.message.rpcId);
  assert.deepEqual(raw.message.payload,{args:{workspaceFileScopeId:'same-session',path:'report.docx',priority:'foreground'}});
  assert.deepEqual(Object.keys(browser.reply.headers).sort(),['cache-control','content-type']);
  assert.equal(f.calls.filter(x=>x.conversion).length,1);
 } finally {abort.abort();await t.close();await f.close();}
});

test('Hub lifetime marker differs from unchanged Host render generation and bytes', async () => {
 const f=await fixture(),abort=fresh(),t=await binaryTransport(f);
 try{
  const hubGeneration=await f.remote.officeToPdf.generation(abort.signal);
  const rendered=await f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'report.docx','foreground',abort.signal);
  assert.equal(hubGeneration.ok,true);assert.equal(rendered.ok,true);
  assert.match(hubGeneration.value,/^dsh-hub-office-generation-/);assert.notEqual(hubGeneration.value,rendered.value.generation);
  assert.equal(rendered.value.generation,f.endpoints.home.ctx.get('officeToPdf').generation);
  assert.equal(new TextDecoder().decode(rendered.value.data),'%PDF-1.4\nhome fixture\n%%EOF');
  assert.equal(f.calls.filter(x=>x.endpoint==='officeToPdf/generation').length,0);
 }finally{abort.abort();await t.close();await f.close();}
});
test('actual source lookup and converter error keep original public codes/reasons without a fallback Host or retry', async () => {
 const f=await fixture(), abort=fresh(), t=await binaryTransport(f);
 try {
  const missing=await f.remote.officeToPdf.render(encodeCompositeId('home','missing'),'report.docx','foreground',abort.signal);
  assert.equal(missing.ok,false);assert.equal(missing.error.code,'gateway/lookup-not-found');
  const absent=await f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'absent.docx','foreground',abort.signal);
  assert.equal(absent.ok,false);assert.equal(absent.error.code,'workspace-file/not-found');
  const unsupported=await f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'file.odt','foreground',abort.signal);
  assert.equal(unsupported.ok,false);assert.equal(unsupported.error.code,'document-render/failed');assert.equal(unsupported.error.details.reason,'unsupported-format');
  let count=0;f.endpoints.home.ctx.get('officeToPdf').convert=async()=>{count++;throw new OfficeToPdfError('timeout','PRIVATE_ENGINE_TEXT');};
  const failed=await f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'report.docx','foreground',abort.signal);
  assert.equal(failed.error.code,'document-render/failed');assert.equal(failed.error.details.reason,'timeout');assert.ok(!JSON.stringify(failed).includes('PRIVATE_ENGINE_TEXT'));
  assert.equal(count,1);assert.deepEqual(t.rawCalls.map(x=>x.hostId),['home','home','home','home']);
 } finally {abort.abort();await t.close();await f.close();}
});
test('render cancellation reaches the same actual provider and never starts a replacement conversion', async () => {
 const f=await fixture(), abort=fresh(), t=await binaryTransport(f), entered=Promise.withResolvers();let calls=0,upstream;
 try {
  f.endpoints.home.ctx.get('officeToPdf').convert=async(_request,signal)=>{calls++;upstream=signal;entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=f.remote.officeToPdf.render(encodeCompositeId('home','same-session'),'report.docx','foreground',abort.signal);
  await entered.promise;abort.abort();const result=await pending;
  assert.equal(result.ok,false);assert.equal(upstream.aborted,true);assert.equal(t.upstreamSignals[0].aborted,true);assert.equal(calls,1);assert.equal(t.rawCalls.length,1);
 } finally {abort.abort();await t.close();await f.close();}
});
test('finite Office gates reject extra aliases/priority/generation args and old Hosts before raw delivery', async () => {
 const f=await fixture(), abort=fresh(), t=await binaryTransport(f);
 try {
  for(const args of [
   {workspaceFileScopeId:encodeCompositeId('home','same-session'),path:'report.docx',priority:'foreground',sessionId:encodeCompositeId('local','same-session')},
   {workspaceFileScopeId:encodeCompositeId('home','same-session'),path:'report.docx',priority:'other'}
  ]){
   const request=Object.assign(new EventEmitter(),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'finite',method:'officeToPdf/render',payload:{args}}),complete:true}),reply=new Reply();
   await handleBffRequest({authorizeRequest:()=>undefined},f.hub,'officeToPdf/render',request,reply);assert.equal(t.rawCalls.length,0);assert.notEqual(reply.status,200);
  }
  const extra=await f.hub.call('officeToPdf/generation',{args:{path:'private'},__hostId:'home'},abort.signal);assert.equal(extra.ok,false);
  await assert.rejects(f.hub.call('officeToPdf/render',{args:{}},abort.signal),{code:'browser-host-hub-rc1/binary-http-only'});
  f.perHost.home.carrier=wrapHostCarrier({hostId:'home',upstreamVersion:'0.2.0-rc.2',carrier:{call(){throw Error('NO_LEGACY_CALL');},async *open(){throw Error('NO_LEGACY_STREAM');}}});
  const request=Object.assign(new EventEmitter(),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'legacy',method:'officeToPdf/render',payload:{args:{workspaceFileScopeId:encodeCompositeId('home','same-session'),path:'report.docx',priority:'foreground'}}}),complete:true}),reply=new Reply();await handleBffRequest({authorizeRequest:()=>undefined},f.hub,'officeToPdf/render',request,reply);assert.notEqual(reply.status,200);assert.equal(t.rawCalls.length,0);
  await assert.rejects(f.perHost.local.raw('/api/officeToPdf/render',{method:'GET',signal:abort.signal}),/CARRIER_METHOD_INVALID/);
  await assert.rejects(f.perHost.local.raw('/api/officeToPdf/render',{method:'POST',headers:{'content-type':'text/plain'},signal:abort.signal}),/CARRIER_CONTENT_TYPE_INVALID/);
  await assert.rejects(f.perHost.local.raw('/api/officeToPdf/render/extra',{method:'POST',signal:abort.signal}),/CARRIER_ROUTE_INVALID/);
  assert.equal(t.rawCalls.length,0);
 } finally {abort.abort();await t.close();await f.close();}
});

async function nativeCache(f, statObserved=()=>{}) {
 const {stripTypeScriptTypes}=await import('node:module');
 const source=path.resolve(native,'../../official-source-tests-v1/packages/client/ui-sidebar-documentpreview/src/client/office/cache.ts');
 const {OfficePreviewCache}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(await readFile(source,'utf8'),{mode:'transform',sourceUrl:source})).toString('base64'));
 return new OfficePreviewCache(
  async(file,signal)=>{const read=await f.remote.workspaceFiles.readBytes(file.sessionId,file.path,{range:{offset:0,length:1}},signal);if(!read.ok)return read;const metadata=await f.remote.workspaceFiles.stat(file.sessionId,file.path,signal);statObserved(metadata);return metadata;},
  (file,signal,priority)=>f.remote.officeToPdf.render(file.sessionId,file.path,priority,signal),8,1024*1024,8,32,
  signal=>f.remote.officeToPdf.generation(signal),()=>Error('FIXTURE_BUSY'));
}
test('unavailable selected local Host cannot block healthy Home file in actual native OfficePreviewCache', async () => {
 const f=await fixture(),abort=fresh(),t=await binaryTransport(f);let cache;
 try{
  delete f.perHost.local; // A real missing carrier entry; selectedHost still local, Home scope remains authoritative.
  cache=await nativeCache(f);const home={sessionId:encodeCompositeId('home','same-session'),path:'report.docx'};
  const result=await cache.read(home,abort.signal);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(new TextDecoder().decode(result.value.data),'%PDF-1.4\nhome fixture\n%%EOF');
  assert.equal(result.value.generation,f.endpoints.home.ctx.get('officeToPdf').generation);
  assert.equal(f.calls.filter(x=>x.endpoint==='officeToPdf/generation').length,0);assert.ok(t.rawCalls.every(x=>x.hostId==='home'));
 }finally{abort.abort();await cache?.dispose();await t.close();await f.close();}
});
test('concurrent native cache callers share pending render but reopened PDF is transferred again without retained Client cache', async () => {
 const f=await fixture(),abort=fresh(),t=await binaryTransport(f),entered=Promise.withResolvers(),release=Promise.withResolvers(),secondStat=Promise.withResolvers();let cache,engine=0,stats=0;
 try{
  f.hub.setSelectedHost('home');
  cache=await nativeCache(f,()=>{if(++stats===2)secondStat.resolve();});
  const provider=f.endpoints.home.ctx.get('officeToPdf'),original=provider.convert.bind(provider);
  provider.convert=async(request,signal)=>{engine++;entered.resolve();await release.promise;return original(request,signal);};
  const home={sessionId:encodeCompositeId('home','same-session'),path:'report.docx'};
  const first=cache.read(home,abort.signal);await entered.promise;const next=cache.read(home,abort.signal);await secondStat.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(t.rawCalls.filter(x=>x.path==='/api/officeToPdf/render').length,1);release.resolve();
  const [a,b]=await Promise.all([first,next]);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a,b);assert.equal(engine,1);
  const reopened=await cache.read(home,abort.signal);assert.equal(reopened.ok,true);assert.notEqual(reopened,a);assert.deepEqual(reopened.value.data,a.value.data);
  assert.equal(t.rawCalls.filter(x=>x.path==='/api/officeToPdf/render').length,2);assert.equal(engine,2); // Fixture convert substitute, not an engine-cache assertion.
  assert.equal(f.calls.filter(x=>x.endpoint==='officeToPdf/generation').length,0);
 }finally{release.resolve();abort.abort();await cache?.dispose();await t.close();await f.close();}
});
test('generation decode and abort stay exact with zero Host calls and original BFF auth refusal', async () => {
 const f=await fixture(),abort=fresh(),t=await binaryTransport(f);
 try{
  for(const args of [undefined,null,{path:'private'},[]]) {const result=await f.hub.call('officeToPdf/generation',{args},abort.signal);assert.equal(result.ok,false);}
  const stopped=await f.hub.call('officeToPdf/generation',{args:{}},AbortSignal.abort());assert.equal(stopped.ok,false);
  const request=Object.assign(new EventEmitter(),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'denied',method:'officeToPdf/generation',payload:{args:{}}}),complete:true}),reply=new Reply();await handleBffRequest({authorizeRequest:()=>401},f.hub,'officeToPdf/generation',request,reply);assert.equal(reply.status,401);
  assert.equal(f.calls.filter(x=>x.endpoint==='officeToPdf/generation').length,0);assert.equal(t.rawCalls.length,0);
 }finally{abort.abort();await t.close();await f.close();}
});
test('native server queue independently reuses version/content conversions after Client retention is disabled', async () => {
 const {stripTypeScriptTypes}=await import('node:module');
 const original=path.resolve(native,'../../official-source-tests-v1/packages/document/office-to-pdf/src/queue.ts');
 const publicModule=pathToFileURL(requireNative.resolve('@deepseek-ai/dsh-office-to-pdf')).href;
 // Type-erasure plus dependency resolution only; the original queue algorithm is executed unchanged.
 const js=stripTypeScriptTypes(await readFile(original,'utf8'),{mode:'transform',sourceUrl:original}).replaceAll("from './errors.ts'",'from '+JSON.stringify(publicModule)).replaceAll("from './identity.ts'",'from '+JSON.stringify(publicModule));
 const {ConversionQueue}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 const {Config}=await load('@deepseek-ai/dsh-office-to-pdf');let engines=0,reads=0;
 const queue=new ConversionQueue(Config({}),'fixture-provider-generation',async()=>{engines++;return{pdf:new Uint8Array([37,80,68,70]),missingFonts:[]};});
 const request=(version='v1')=>({extension:'docx',priority:'foreground',source:{key:'synthetic-source',version,bytes:3,read:async()=>{reads++;return{bytes:new Uint8Array([1,2,3]),version};}}});
 try{
  const first=await queue.read(request()),again=await queue.read(request());assert.equal(engines,1);assert.equal(reads,1);assert.deepEqual(again.pdf,first.pdf);assert.notEqual(again.pdf,first.pdf);
  const sameContentNewVersion=await queue.read(request('v2'));assert.equal(engines,1);assert.equal(reads,2);assert.deepEqual(sameContentNewVersion.pdf,first.pdf);
 }finally{await queue.dispose();}
});
