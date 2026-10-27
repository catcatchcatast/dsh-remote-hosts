// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                             
                                                                                                                                                     
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
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
const [{ Context }, { default: Typert }, { default: Access }, { default: Gateway }, ClientApi, { HostConnectionService }, { LocalFileSystem }, { default: WorkspaceFiles }, { default: filesRemote }, ConnectionClient] = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-api-workspace-files', '@deepseek-ai/dsh-api-workspace-files/remote', '@deepseek-ai/dsh-client-connection/client'].map(load));
const savedFetch = globalThis.fetch;
const vi = { stubGlobal(name, value) { assert.equal(name, 'fetch'); globalThis.fetch = value; }, unstubAllGlobals() { globalThis.fetch = savedFetch; } };
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { BrowserHostHub, encodeCompositeId, HOST_RPC_ALLOWLIST, handleBffRequest, serveStreamSocket } from '../packages/browser-host-hub-rc1/src/index.js';
import { lazyCarrier } from '../packages/rc1-host-carriers/src/lazy-carrier.js';
import { wrapHostCarrier, readHostRuntimeVersion } from '../packages/runtime-interface/src/index.js';
import { createCarrier } from '../packages/runtime-interface/src/http-carrier.js';
const own = process.env.DSH_TEST_DIRECTORY || path.join(workspace, '.tmp/synthetic-native-files-tests');
await mkdir(own, { recursive: true });
const fresh = () => new AbortController();
async function fixture(initialVersion) {
    let actualVersion=initialVersion,descriptions=0,entries=0; const lifetime=new AbortController();
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
            const fetch = connection.createSharedFetchHandler('/api');
            endpoints[hostId] = { fetch, connection, ctx };
            const carrier = {
                async call(endpoint, payload, signal) {
                    calls.push({ hostId, endpoint, payload, signal });
                    if(endpoint==='host.describe'){descriptions++;return actualVersion===undefined?{ok:false,error:{code:'AUXILIARY_FAILED'}}:{ok:true,value:{version:actualVersion}};}
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
            perHost[hostId] = hostId==='home' ? lazyCarrier(async()=>{
                entries++; const version=await readHostRuntimeVersion(carrier,lifetime.signal);
                return{carrier:wrapHostCarrier({hostId,carrier,upstreamVersion:version??'0.1.2-rc.1',versionConfirmed:version!==undefined,versionSignal:lifetime.signal}),entryId:'synthetic-entry',closed:new Promise(()=>{}),close(){}};
            },lifetime.signal) : {hostId,carrier:wrapHostCarrier({hostId,carrier,upstreamVersion:'0.2.1-rc.2'})};
            if(hostId==='home')perHost[hostId].runtimeInterfaceCarrier=true; // 与原rc1 attach的真实标记一致，禁止Hub重复包装canonical carrier。
        }
        const hub = new BrowserHostHub({ perHost, selectedHost: 'local', browserVersion: '0.2.1-rc.2' });
        await browser.plugin(Typert);
        const handle = { interactions: 'none', isLoopback: true, generation: { getSnapshot: () => undefined }, rpc: {
                call(_channel, endpoint, payload, signal) { return hub.call(endpoint, { ...payload, __hostId: 'local' }, signal); },
                open(_channel, endpoint, payload, signal) { return hub.openStream(endpoint, { ...payload, __hostId: 'local' }, signal); },
            }, openWebSocket() { throw Error('NO_SOCKET_EXPECTED'); } };
        browser.provide('connection', handle);
        await browser.plugin(ClientApi);
        await browser.get('remote').$mount(filesRemote);
        return { setVersion(v){actualVersion=v},get descriptions(){return descriptions},get entries(){return entries},root, hosts, browser, hub, calls, perHost, endpoints, handle, remote: browser.get('remote'), async close() { lifetime.abort(); await browser.fiber.dispose(); for (const ctx of hosts.reverse())
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

for(const initialVersion of ['0.2.0-rc.2',undefined])test('actual official filesystem + gateway + generated browser consumer after '+String(initialVersion)+' metadata becomes 021',async()=>{
 const f=await fixture(initialVersion),abort=fresh();try{
  await f.perHost.home.connect(abort.signal);assert.equal(f.descriptions,1);assert.equal(f.entries,1);
  f.setVersion('0.2.1-rc.2');const id=encodeCompositeId('home','same-session');
  const result=await f.remote.workspaceFiles.read(id,'test.txt',{},abort.signal);
  assert.partialDeepStrictEqual(result,{ok:true,value:{text:'home text',bytes:9,eof:true}});
  assert.equal(f.descriptions,2);assert.equal(f.entries,1);assert.equal(f.calls.filter(x=>x.endpoint==='workspaceFiles/read').length,1);
  assert.equal(f.calls.find(x=>x.endpoint==='workspaceFiles/read').payload.args.workspaceFileScopeId,'same-session');
  assert.equal(f.perHost.home.upstreamVersion,'0.2.1-rc.2');
 }finally{abort.abort();await f.close()}
});
