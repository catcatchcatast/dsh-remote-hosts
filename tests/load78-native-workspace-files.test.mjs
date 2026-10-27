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
import { wrapHostCarrier } from '../packages/runtime-interface/src/index.js';
import { createCarrier } from '../packages/runtime-interface/src/http-carrier.js';
const own = process.env.DSH_TEST_DIRECTORY || path.join(workspace, '.tmp/synthetic-native-files-tests');
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
                call(_channel, endpoint, payload, signal) { return hub.call(endpoint, { ...payload, __hostId: 'local' }, signal); },
                open(_channel, endpoint, payload, signal) { return hub.openStream(endpoint, { ...payload, __hostId: 'local' }, signal); },
            }, openWebSocket() { throw Error('NO_SOCKET_EXPECTED'); } };
        browser.provide('connection', handle);
        await browser.plugin(ClientApi);
        await browser.get('remote').$mount(filesRemote);
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
test('actual generated client + Gateway/WorkspaceFiles route list/stat/read by Session scope to the selected resource Host', async () => {
    const f = await fixture(), abort = fresh();
    try {
        const id = encodeCompositeId('home', 'same-session'), dir = path.join(f.root, 'home');
        const listed = await f.remote.workspaceFiles.list(id, dir, abort.signal);
        assert.partialDeepStrictEqual(listed, { ok: true, value: { entries: [{ name: 'test.txt', type: 'file' }], truncated: false } });
        assert.partialDeepStrictEqual(await f.remote.workspaceFiles.stat(id, 'test.txt', abort.signal), { ok: true, value: { bytes: 9 } });
        assert.partialDeepStrictEqual(await f.remote.workspaceFiles.read(id, 'test.txt', {}, abort.signal), { ok: true, value: { text: 'home text', eof: true } });
        assert.deepEqual(f.calls.filter(x => x.endpoint).map(x => x.hostId), ['home', 'home', 'home']);
        assert.deepEqual(f.calls[0].payload, { args: { workspaceFileScopeId: 'same-session', path: dir } });
        assert.partialDeepStrictEqual(await f.remote.workspaceFiles.read(encodeCompositeId('local', 'same-session'), 'test.txt', {}, abort.signal), { ok: true, value: { text: 'local text' } });
    }
    finally {
        abort.abort();
        await f.close();
    }
});
test('actual generated changes stream keeps official ready shape and cancellation reaches the same Host watcher', async () => {
    const f = await fixture(), abort = fresh();
    let stream;
    try {
        stream = f.remote.workspaceFiles.changes(encodeCompositeId('home', 'same-session'), path.join(f.root, 'home'), abort.signal)[Symbol.asyncIterator]();
        assert.partialDeepStrictEqual(await stream.next(), { done: false, value: { kind: 'ready' } });
        assert.deepEqual(f.calls.filter(x => x.endpoint).map(x => x.hostId), ['home']);
        abort.abort();
        await stream.return();
        assert.equal(f.calls.find(x => x.endpoint === 'workspaceFiles/changes').signal.aborted, true);
    }
    finally {
        abort.abort();
        await stream?.return();
        await f.close();
    }
});
test('missing session and file preserve actual official error codes without cross-Host fallback', async () => {
    const f = await fixture(), abort = fresh();
    try {
        (result => {
            assert.equal(result.ok, false);
            assert.equal(result.error.code, 'gateway/lookup-not-found');
        })(await f.remote.workspaceFiles.stat(encodeCompositeId('home', 'missing'), 'test.txt', abort.signal));
        (result => {
            assert.equal(result.ok, false);
            assert.equal(result.error.code, 'workspace-file/not-found');
        })(await f.remote.workspaceFiles.read(encodeCompositeId('home', 'same-session'), 'missing', {}, abort.signal));
        assert.deepEqual(f.calls.filter(x => x.endpoint).map(x => x.hostId), ['home', 'home']);
    }
    finally {
        abort.abort();
        await f.close();
    }
});
test('finite text surface rejects unrelated workspaceFiles mutation, aliases and mixed resource arguments before carrier', async () => {
    const f = await fixture(), abort = fresh();
    try {
        assert.ok(!HOST_RPC_ALLOWLIST.includes('workspaceFiles/write'));
        await assert.rejects(f.hub.call('workspaceFiles/write', { args: {} }, abort.signal), { code: 'browser-host-hub-rc1/endpoint-not-allowed' });
        const result = await f.hub.call('workspaceFiles/list', { args: { workspaceFileScopeId: encodeCompositeId('home', 'same-session'), path: '.', sessionId: encodeCompositeId('local', 'same-session') } }, abort.signal);
        assert.equal(result.ok, false);
        assert.equal(f.calls.filter(x => x.endpoint).length, 0);
    }
    finally {
        abort.abort();
        await f.close();
    }
});
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
            await handleBffRequest({ authorizeRequest: () => undefined }, f.hub, 'workspaceFiles/readBytes', request, reply);
            if (!reply.writableFinished)
                throw Error('fixture-response-incomplete');
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
test('actual carrier.raw → BFF opaque multipart → original browser parser preserves PNG/PDF bytes and original rpcId', async () => {
    const f = await fixture(), abort = fresh(), t = await binaryTransport(f);
    try {
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 128, 255]), pdf = new TextEncoder().encode('%PDF-1.4\nfixture\n%%EOF');
        for (const [name, bytes] of [['a.png', png], ['a.pdf', pdf]]) {
            await writeFile(path.join(f.root, 'home', name), bytes);
            const result = await f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'same-session'), name, {}, abort.signal);
            assert.equal(result.ok, true);
            assert.deepEqual(result.value.data, bytes);
            const sent = t.rawCalls.at(-1), browser = t.browserCalls.at(-1);
            assert.equal(sent.hostId, 'home');
            assert.equal(sent.path, '/api/workspaceFiles/readBytes');
            assert.equal(sent.message.rpcId, browser.message.rpcId);
            assert.deepEqual(sent.message.payload, { args: { workspaceFileScopeId: 'same-session', path: name, options: {} } });
            assert.ok(browser.reply.headers['content-type'].includes('multipart/'));
            assert.deepEqual(Object.keys(browser.reply.headers).sort(), ['cache-control', 'content-type']);
        }
        const ranged = await f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'same-session'), 'a.png', { range: { offset: 8, length: 3 } }, abort.signal);
        assert.partialDeepStrictEqual(ranged, { ok: true, value: { offset: 8, eof: true, data: png.slice(8) } });
        const missing = await f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'missing'), 'a.png', {}, abort.signal);
        (result => {
            assert.equal(result.ok, false);
            assert.equal(result.error.code, 'gateway/lookup-not-found');
        })(missing);
        const absent = await f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'same-session'), 'absent', {}, abort.signal);
        (result => {
            assert.equal(result.ok, false);
            assert.equal(result.error.code, 'workspace-file/not-found');
        })(absent);
        assert.equal(t.rawCalls.length, 5);
    }
    finally {
        abort.abort();
        await t.close();
        await f.close();
    }
});
test('binary relay cancels upstream fetch/body on downstream close and cleans request listeners', async () => {
    const f = await fixture(), abort = fresh(), t = await binaryTransport(f, 'hold');
    try {
        const pending = f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'same-session'), 'test.txt', {}, abort.signal);
        for (let i = 0; i < 50 && !t.browserCalls.length; i++)
            await new Promise(r => setImmediate(r));
        const record = t.browserCalls[0];
        await record.reply.wrote.promise;
        abort.abort();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(t.upstreamSignals[0].aborted, true);
        assert.equal(t.cancelled, true);
        assert.equal(t.rawCalls.length, 1);
        assert.equal(record.request.listenerCount('aborted'), 0);
    }
    finally {
        abort.abort();
        await t.close();
        await f.close();
    }
});
test('binary failure after response headers destroys the stream without appending JSON or replay', async () => {
    const f = await fixture(), abort = fresh(), t = await binaryTransport(f, 'fail');
    try {
        const result = await f.remote.workspaceFiles.readBytes(encodeCompositeId('home', 'same-session'), 'test.txt', {}, abort.signal);
        assert.equal(result.ok, false);
        assert.equal(t.rawCalls.length, 1);
        const reply = t.browserCalls[0].reply;
        assert.equal(reply.headersSent, true);
        assert.equal(reply.writableFinished, false);
        assert.equal(reply.destroyed, true);
    }
    finally {
        abort.abort();
        await t.close();
        await f.close();
    }
});
test('actual browser mux admits only the file watch stream and releases its exact Host on cancel', async () => {
    const f = await fixture();
    let stop = () => { };
    class Socket extends EventEmitter {
        readyState = 1;
        sent = [];
        bufferedAmount = 0;
        delivery = Promise.withResolvers();
        send(text, done) { this.sent.push(JSON.parse(text)); this.delivery.resolve(); queueMicrotask(() => done?.()); }
        close() { this.readyState = 3; }
    }
    const socket = new Socket();
    try {
        stop = serveStreamSocket(socket, f.hub);
        socket.emit('message', JSON.stringify({ type: 'open', streamId: 'file:1', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: encodeCompositeId('home', 'same-session'), path: path.join(f.root, 'home') } } }));
        await socket.delivery.promise;
        assert.partialDeepStrictEqual(socket.sent.find(x => x.type === 'item'), { streamId: 'file:1', value: { kind: 'ready' } });
        socket.emit('message', JSON.stringify({ type: 'cancel', streamId: 'file:1' }));
        for (let i = 0; i < 30 && !f.calls.some(x => x.closed); i++)
            await new Promise(r => setImmediate(r));
        assert.deepEqual(f.calls.filter(x => x.endpoint).map(x => x.hostId), ['home']);
        assert.equal(f.calls.find(x => x.endpoint).signal.aborted, true);
    }
    finally {
        stop();
        socket.emit('close');
        await f.close();
    }
});
test('unsupported Host version fails closed for files without forwarding or modifying legacy session routes', async () => {
    let calls = 0;
    const carrier = wrapHostCarrier({ hostId: 'legacy', upstreamVersion: '0.2.0-rc.2', carrier: { async call() { calls++; return { ok: true, value: {} }; }, async *open() { calls++; yield { kind: 'ready' }; } } });
    await assert.rejects(carrier.call('workspaceFiles/list', { args: { workspaceFileScopeId: 'x', path: '.' } }, fresh().signal), { code: 'runtime-interface/capability-unavailable' });
    await assert.rejects(carrier.open('workspaceFiles/changes', { args: { workspaceFileScopeId: 'x', path: '.' } }, fresh().signal).next(), { code: 'runtime-interface/capability-unavailable' });
    assert.equal(calls, 0);
});
test('binary exact route keeps BFF authorization and raw method/content-type gates, and refuses JSON fallback', async () => {
    const f = await fixture(), abort = fresh(), t = await binaryTransport(f);
    try {
        const request = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', complete: true }), reply = new Reply();
        await handleBffRequest({ authorizeRequest: () => 401 }, f.hub, 'workspaceFiles/readBytes', request, reply);
        assert.equal(reply.status, 401);
        assert.equal(t.rawCalls.length, 0);
        await assert.rejects(f.hub.call('workspaceFiles/readBytes', { args: {} }, abort.signal), { code: 'browser-host-hub-rc1/binary-http-only' });
        await assert.rejects(f.perHost.home.raw('/api/workspaceFiles/readBytes', { method: 'GET', signal: abort.signal }), new RegExp('CARRIER_METHOD_INVALID'));
        await assert.rejects(f.perHost.home.raw('/api/workspaceFiles/readBytes', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, signal: abort.signal }), new RegExp('CARRIER_CONTENT_TYPE_INVALID'));
        await assert.rejects(f.perHost.home.raw('/api/workspaceFiles/readBytes/extra', { method: 'POST', signal: abort.signal }), new RegExp('CARRIER_ROUTE_INVALID'));
        assert.equal(t.rawCalls.length, 0);
    }
    finally {
        abort.abort();
        await t.close();
        await f.close();
    }
});
