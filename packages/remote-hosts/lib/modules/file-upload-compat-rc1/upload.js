// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                                                                   
// Upload HTTP surface.
//
// The v2 surface is deliberately a small, client-neutral resumable protocol:
// metadata is created with POST, consecutive chunks are written with PATCH,
// and commit hashes the completed stream before an atomic move into the
// session's `.dsh-uploads/<sessionId>` directory. The old POST/DELETE
// `/api/upload` surface remains available for older clients, but it also uses
// a temporary file and never buffers a complete upload in memory.
                                                                                                                                                   
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sniff } from "./detect.js";
export const V2_MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const V2_CHUNK_BYTES = 4 * 1024 * 1024;
export const PARTIAL_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_SOURCE_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
export const IMAGE_SOURCE_MAX_DIMENSION = 65_535;
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const DEFAULT_IMAGE_TARGET = Object.freeze({
    maxImageBytes: 3.5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 2000
});
function positiveIntegerOr(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function imageMediaTypesOr(value) {
    if (value === undefined)
        return [...IMAGE_MEDIA_TYPES];
    const accepted = value.filter((item) => typeof item === 'string' && IMAGE_MEDIA_TYPES.includes(item));
    return accepted.length > 0 ? Array.from(new Set(accepted)) : [];
}
/** Create a deterministic, opaque fingerprint for client policy caching. */
export function createImageIntakePolicy(modelAcceptsImages, limits) {
    const target = {
        maxImageBytes: positiveIntegerOr(limits?.maxImageBytes, DEFAULT_IMAGE_TARGET.maxImageBytes),
        maxImagesPerMessage: positiveIntegerOr(limits?.maxImagesPerMessage, DEFAULT_IMAGE_TARGET.maxImagesPerMessage),
        maxMessageImageBytes: positiveIntegerOr(limits?.maxMessageImageBytes, DEFAULT_IMAGE_TARGET.maxMessageImageBytes),
        maxImagePixels: positiveIntegerOr(limits?.maxImagePixels, DEFAULT_IMAGE_TARGET.maxImagePixels),
        maxImageDimension: positiveIntegerOr(limits?.maxImageDimension, DEFAULT_IMAGE_TARGET.maxImageDimension)
    };
    const acceptedMediaTypes = imageMediaTypesOr(limits?.mediaTypes);
    const fingerprintSource = JSON.stringify({ modelAcceptsImages, acceptedMediaTypes, target });
    const policyFingerprint = `img1-${createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 24)}`;
    return {
        version: 1,
        mode: 'auto-fit',
        modelAcceptsImages,
        acceptedMediaTypes,
        sourceMaxMessageBytes: IMAGE_SOURCE_MAX_MESSAGE_BYTES,
        sourceMaxDimension: IMAGE_SOURCE_MAX_DIMENSION,
        target,
        policyFingerprint
    };
}
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const SAFE_UPLOAD_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/iu;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024 * 1024;
function isLoopbackAddress(value) {
    if (value === undefined)
        return false;
    const address = value.toLowerCase().replace(/^\[|\]$/gu, '');
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
/** Validate the upload transport peer as well as its loopback Host authority. */
export function isLoopbackUploadRequest(request) {
    if (!isLoopbackAddress(request.socket?.remoteAddress))
        return false;
    const host = request.headers.host;
    return host !== undefined && LOOPBACK_HOST.test(host);
}
/** Control chars, path separators, dot segments and leading dots stripped. */
export function sanitizeFileName(raw) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
    const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    const name = segments.join('_').replace(/^\.+/, '').trim().slice(0, 120);
    return name === '' ? 'upload.bin' : name;
}
/** Sanitize a relative path for display: strip absolute prefixes, dot segments, control chars. */
export function sanitizeRelativePath(raw) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
    const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    if (segments.length === 0)
        return '';
    return segments.join('/').slice(0, 240);
}
/** Session ids are opaque tokens; still constrain them to a safe alphabet. */
export function sanitizeSessionId(id) {
    const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    return cleaned === '' ? 'anonymous' : cleaned;
}
/**
 * Map an opaque session id to one filesystem-safe, collision-free component.
 * Keep the historical spelling for already-safe ids so old attachments remain
 * addressable; encode every other id instead of lossy sanitization.
 */
export function sessionStorageId(sessionId) {
    if (/^[A-Za-z0-9_-]{1,80}$/u.test(sessionId))
        return sessionId;
    return `~${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
}
/** Accept the Hub's local composite id without granting access to remote Hosts. */
export function resolveLocalSessionId(id) {
    if (!id.startsWith('rh1.'))
        return id;
    const parts = id.split('.');
    if (parts.length !== 3 || parts[1] === '' || parts[2] === '')
        return null;
    if (!parts[1].match(/^[A-Za-z0-9_-]+$/u) || !parts[2].match(/^[A-Za-z0-9_-]+$/u))
        return null;
    try {
        const hostId = Buffer.from(parts[1], 'base64url').toString('utf8');
        if (hostId !== 'local')
            return null;
        const sessionId = Buffer.from(parts[2], 'base64url').toString('utf8');
        return sessionId === '' ? null : sessionId;
    }
    catch {
        return null;
    }
}
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function isContained(base, target) {
    const rel = relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function normalizeHeader(value) {
    if (Array.isArray(value))
        return undefined;
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function decodeHeader(value, fallback) {
    const raw = normalizeHeader(value);
    if (raw === undefined)
        return fallback;
    try {
        return decodeURIComponent(raw);
    }
    catch {
        return fallback;
    }
}
function validDigest(value) {
    if (typeof value !== 'string' || !SHA256.test(value))
        return undefined;
    return value.toLowerCase();
}
function headerDigest(req, ...names) {
    for (const name of names) {
        const value = req.headers[name.toLowerCase()];
        const digest = validDigest(normalizeHeader(value));
        if (digest !== undefined)
            return digest;
    }
    return undefined;
}
function headerInteger(req, ...names) {
    for (const name of names) {
        const value = normalizeHeader(req.headers[name.toLowerCase()]);
        if (value === undefined)
            continue;
        if (!/^\d+$/u.test(value))
            return undefined;
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed))
            return parsed;
        return undefined;
    }
    return undefined;
}
async function readJsonBody(req, maxBytes = 128 * 1024) {
    let text = '';
    let bytes = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > maxBytes)
            return null;
        text += buf.toString('utf8');
    }
    if (text.trim() === '')
        return {};
    try {
        const value = JSON.parse(text);
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
async function hashFile(filePath) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filePath)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        hash.update(buf);
    }
    return { sha256: hash.digest('hex'), bytes };
}
async function readPrefix(filePath, maxBytes = 65536) {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const result = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, result.bytesRead);
    }
    finally {
        await handle.close();
    }
}
async function writeJsonAtomic(filePath, value) {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, filePath);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}
function transferPaths(storage, uploadId) {
    // Callers validate uploadId before constructing these paths.
    return {
        part: join(storage.partial, `${uploadId}.part`),
        state: join(storage.partial, `${uploadId}.json`)
    };
}
function completedPath(storage, uploadId) {
    return join(storage.partial, `${uploadId}.done.json`);
}
function sessionHeaderId(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const candidate = value;
    const id = candidate.id;
    if (typeof id === 'string')
        return id;
    if (typeof id === 'number')
        return String(id);
    return undefined;
}
function sessionHeaderCwd(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const candidate = value;
    return typeof candidate.cwd === 'string' && candidate.cwd !== '' ? candidate.cwd : undefined;
}
async function persistedSessionCwd(persistence, sessionId) {
    if (persistence === undefined || typeof persistence.list !== 'function')
        return undefined;
    try {
        const entries = await persistence.list();
        for (const entry of entries) {
            const candidate = typeof entry === 'object' && entry !== null && 'header' in entry
                ? entry.header
                : entry;
            if (sessionHeaderId(candidate) === sessionId)
                return sessionHeaderCwd(candidate);
        }
    }
    catch {
        // A persistence failure is indistinguishable from an unavailable session;
        // never fall back to a client-supplied path.
    }
    return undefined;
}
/** Resolve and create a storage directory while rejecting symlink escapes. */
async function secureStorage(cwd, sessionId) {
    try {
        const absoluteCwd = resolve(cwd);
        await mkdir(absoluteCwd, { recursive: true });
        const realCwd = await realpath(absoluteCwd);
        const uploadRoot = join(realCwd, '.dsh-uploads');
        await mkdir(uploadRoot, { recursive: true });
        const realUploadRoot = await realpath(uploadRoot);
        if (!isContained(realCwd, realUploadRoot) || resolve(realUploadRoot) !== resolve(uploadRoot))
            return null;
        const storageId = sessionStorageId(sessionId);
        const sessionDir = join(realUploadRoot, storageId);
        await mkdir(sessionDir, { recursive: true });
        const realSessionDir = await realpath(sessionDir);
        if (!isContained(realUploadRoot, realSessionDir) || resolve(realSessionDir) !== resolve(sessionDir))
            return null;
        const partial = join(realSessionDir, '.partial');
        await mkdir(partial, { recursive: true });
        const realPartial = await realpath(partial);
        if (!isContained(realSessionDir, realPartial) || resolve(realPartial) !== resolve(partial))
            return null;
        return { dir: realSessionDir, partial: realPartial, sessionId, storageId, cwd: realCwd };
    }
    catch {
        return null;
    }
}
function classifyHandling(sniffResult, bytes, maxFileBytes) {
    if (sniffResult.type === 'image' && bytes <= maxFileBytes)
        return 'image';
    const readable = sniffResult.type === 'text' || sniffResult.type === 'pdf' || sniffResult.type === 'docx' || sniffResult.type === 'xlsx' || sniffResult.type === 'archive';
    return readable && bytes <= maxFileBytes ? 'readable' : 'generic';
}
function genericHint(relativePath, reason) {
    const detail = reason === 'too-large' ? '文件超过可直接解析的大小上限' : '该格式当前不能直接解析';
    return `附件：@${relativePath}\n${detail}。请先将它复制到项目文件夹中合适的可见位置，再按用户要求处理，并在回复中说明复制后的路径。`;
}
function responsePath(storage, filePath) {
    return relative(storage.cwd, filePath).split(sep).join('/');
}
async function findExistingByDigest(storage, digest) {
    const prefixes = [`${digest}-`, `${digest.slice(0, 16)}-`];
    const entries = await readdir(storage.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isFile() || !prefixes.some((prefix) => entry.name.startsWith(prefix)))
            continue;
        const candidate = join(storage.dir, entry.name);
        const info = await stat(candidate).catch(() => null);
        if (info !== null && info.isFile()) {
            const existingDigest = await hashFile(candidate).catch(() => null);
            if (existingDigest?.sha256 === digest)
                return candidate;
        }
    }
    return undefined;
}
async function imageMetadata(options, sessionId, filePath, name) {
    if (options.imageMode === undefined)
        return {};
    try {
        const imageMode = await options.imageMode(sessionId);
        if (imageMode === 'ocr' && options.vision !== undefined) {
            return { imageMode, imageDescription: await options.vision(filePath, name) };
        }
        return { imageMode };
    }
    catch (err) {
        console.warn(`[dsh-file-upload] image description failed for ${name}:`, err instanceof Error ? err.message : String(err));
        return { imageMode: 'ocr' };
    }
}
function makeTransferResponse(storage, state, filePath, digest, sniffResult, options, extra = {}) {
    const relativePath = responsePath(storage, filePath);
    const handling = classifyHandling(sniffResult, state.size, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    const tooLarge = handling === 'generic' && state.size > (options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    const hint = handling === 'generic' ? genericHint(relativePath, tooLarge ? 'too-large' : 'unsupported') : undefined;
    return {
        path: filePath,
        relativePath,
        name: state.name,
        bytes: state.size,
        sessionId: state.sessionId,
        sha256: digest,
        handling,
        sniffedType: sniffResult.type,
        label: sniffResult.label,
        ...(hint !== undefined ? { hint, genericPrompt: hint } : {}),
        ...(extra.imageMode !== undefined ? { imageMode: extra.imageMode } : {}),
        ...(extra.imageDescription !== undefined ? { imageDescription: extra.imageDescription } : {}),
        ...(extra.deduplicated === true ? { deduplicated: true } : {})
    };
}
export function createUploadHandler(options) {
    const { maxBytes, allowedExtensions, maxConcurrent, sessionCwd, sessionPersistence, defaultDir, inlineTextLimit: _inlineTextLimit, previewTextLimit: _previewTextLimit, now = () => Date.now() } = options;
    const v2MaxBytes = Math.min(Math.max(0, options.v2MaxBytes ?? V2_MAX_FILE_BYTES), V2_MAX_FILE_BYTES);
    const locks = new Map();
    let inflight = 0;
    async function withLock(key, fn) {
        const previous = locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolveRelease) => { release = resolveRelease; });
        locks.set(key, current);
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
            if (locks.get(key) === current)
                locks.delete(key);
        }
    }
    async function storageDirFor(req) {
        const raw = normalizeHeader(req.headers['x-session-id']);
        if (raw === undefined)
            return null;
        const resolved = resolveLocalSessionId(raw);
        if (resolved === null || resolved === '')
            return null;
        let cwd;
        if (sessionCwd !== undefined) {
            try {
                cwd = await sessionCwd(resolved);
            }
            catch {
                cwd = undefined;
            }
        }
        if (cwd === undefined)
            cwd = await persistedSessionCwd(sessionPersistence, resolved);
        if (cwd === undefined && sessionCwd === undefined && sessionPersistence === undefined)
            cwd = defaultDir;
        if (cwd === undefined)
            return null;
        return secureStorage(cwd, resolved);
    }
    async function handleLegacyPost(req, res) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        if (inflight >= maxConcurrent) {
            json(res, 429, { error: 'too many concurrent uploads' });
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            json(res, 413, { error: 'payload too large' });
            return;
        }
        let rawName = decodeHeader(req.headers['x-file-name'], 'upload.bin');
        let relPath = decodeHeader(req.headers['x-file-relpath'], '');
        rawName = rawName === '' ? 'upload.bin' : rawName;
        relPath = sanitizeRelativePath(relPath);
        const name = sanitizeFileName(rawName);
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        if (allowedExtensions.length > 0 && !allowedExtensions.includes(ext)) {
            json(res, 415, { error: `extension ".${ext}" not allowed` });
            return;
        }
        inflight += 1;
        const temporary = join(storage.partial, `legacy-${randomUUID()}.part`);
        let handle;
        try {
            await mkdir(storage.partial, { recursive: true });
            handle = await open(temporary, 'wx');
            const hash = createHash('sha256');
            let total = 0;
            for await (const chunk of req) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > maxBytes) {
                    await handle.close();
                    handle = undefined;
                    await rm(temporary, { force: true });
                    json(res, 413, { error: 'payload too large' });
                    return;
                }
                await handle.write(buf);
                hash.update(buf);
            }
            await handle.close();
            handle = undefined;
            if (total === 0) {
                await rm(temporary, { force: true });
                json(res, 400, { error: 'empty upload' });
                return;
            }
            const digest = hash.digest('hex');
            const existing = await findExistingByDigest(storage, digest);
            let destination = existing ?? join(storage.dir, `${digest}-${name}`);
            let deduplicated = existing !== undefined;
            if (!deduplicated) {
                await withLock(storage.dir, async () => {
                    const raced = await findExistingByDigest(storage, digest);
                    if (raced !== undefined) {
                        destination = raced;
                        deduplicated = true;
                        await rm(temporary, { force: true });
                    }
                    else {
                        await rename(temporary, destination);
                    }
                });
            }
            else {
                await rm(temporary, { force: true });
            }
            const prefix = await readPrefix(destination);
            const sniffResult = sniff(prefix, name);
            const meta = {
                path: destination,
                name,
                bytes: total,
                sessionId: storage.sessionId,
                sniff: sniffResult,
                ...(deduplicated ? { deduplicated: true } : {})
            };
            if (sniffResult.type === 'image' && classifyHandling(sniffResult, total, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) === 'image')
                Object.assign(meta, await imageMetadata(options, storage.sessionId, destination, name));
            const actualRelative = responsePath(storage, destination);
            const handling = classifyHandling(meta.sniff, total, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
            const generic = handling === 'generic'
                ? genericHint(actualRelative, total > (options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) ? 'too-large' : 'unsupported')
                : undefined;
            json(res, 200, {
                path: meta.path,
                relativePath: actualRelative,
                name: meta.name,
                bytes: meta.bytes,
                sessionId: meta.sessionId,
                sniffedType: meta.sniff.type,
                label: meta.sniff.label,
                handling,
                ...(generic !== undefined ? { hint: generic, genericPrompt: generic } : {}),
                ...(meta.imageMode !== undefined ? { imageMode: meta.imageMode } : {}),
                ...(meta.imageDescription !== undefined ? { imageDescription: meta.imageDescription } : {}),
                ...(meta.deduplicated ? { deduplicated: true } : {})
            });
        }
        catch (err) {
            if (handle !== undefined)
                await handle.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            console.error('[dsh-file-upload] upload persist failed:', err);
            json(res, 500, { error: 'write failed' });
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleLegacyDelete(req, res) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        const filePath = decodeHeader(req.headers['x-file-path'], '');
        const candidate = filePath === '' ? '' : resolve(filePath);
        const rel = candidate === '' ? '..' : relative(storage.dir, candidate);
        if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            json(res, 400, { error: 'invalid path' });
            return;
        }
        try {
            const parent = await realpath(resolve(candidate, '..'));
            if (!isContained(storage.dir, parent)) {
                json(res, 400, { error: 'invalid path' });
                return;
            }
            // Legacy POST publishes directly into the session upload directory and
            // has no public unfinished-transfer identifier. Treat DELETE as the
            // old client's local-card cleanup acknowledgement while retaining the
            // published file for later model reads.
            json(res, 200, { ok: true });
        }
        catch (err) {
            console.error('[dsh-file-upload] delete validation failed:', err);
            json(res, 500, { error: 'delete failed' });
        }
    }
    async function findTransfer(storage, uploadId) {
        if (!SAFE_UPLOAD_ID.test(uploadId))
            return null;
        const paths = transferPaths(storage, uploadId);
        try {
            const parsed = JSON.parse(await readFile(paths.state, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return null;
            const state = parsed;
            if (state.version !== 2 || state.uploadId !== uploadId || state.sessionId !== storage.sessionId)
                return null;
            if (!Number.isSafeInteger(state.size) || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > state.size)
                return null;
            return { state, part: paths.part, statePath: paths.state };
        }
        catch {
            return null;
        }
    }
    async function findCompleted(storage, uploadId) {
        if (!SAFE_UPLOAD_ID.test(uploadId))
            return null;
        try {
            const parsed = JSON.parse(await readFile(completedPath(storage, uploadId), 'utf8'));
            if (typeof parsed !== 'object' || parsed === null)
                return null;
            const done = parsed;
            if (done.version !== 2 || done.status !== 'completed' || done.uploadId !== uploadId || done.sessionId !== storage.sessionId)
                return null;
            if (typeof done.path !== 'string' || typeof done.sha256 !== 'string' || done.result === undefined)
                return null;
            const result = done.result;
            if (typeof result.path !== 'string' || result.path !== done.path)
                return null;
            const candidate = resolve(done.path);
            const parent = await realpath(resolve(candidate, '..'));
            if (!isContained(storage.dir, parent) || !isContained(storage.dir, candidate))
                return null;
            return done;
        }
        catch {
            return null;
        }
    }
    async function handleDescribe(req, res) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        let imageIntake = createImageIntakePolicy(false, options.imageLimits);
        if (options.imageIntake !== undefined) {
            try {
                const resolved = await options.imageIntake(storage.sessionId);
                if (resolved !== undefined)
                    imageIntake = resolved;
            }
            catch {
                // Capability discovery is advisory; never turn a healthy file-transfer
                // endpoint into an error because model metadata is temporarily absent.
            }
        }
        json(res, 200, {
            protocol: 'file-transfer-v2',
            protocolVersion: 2,
            version: 2,
            maxFileBytes: v2MaxBytes,
            chunkSize: V2_CHUNK_BYTES,
            chunkSizeBytes: V2_CHUNK_BYTES,
            chunkBytes: V2_CHUNK_BYTES,
            accepts: '*/*',
            supportsResume: true,
            imageIntake
        });
    }
    async function handleTransferInit(req, res) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        if (inflight >= maxConcurrent) {
            json(res, 429, { error: 'too many concurrent uploads' });
            return;
        }
        const body = await readJsonBody(req);
        if (body === null) {
            json(res, 400, { error: 'invalid JSON metadata' });
            return;
        }
        const nameValue = body.fileName ?? body.name;
        const name = sanitizeFileName(typeof nameValue === 'string' ? nameValue : 'upload.bin');
        const size = typeof body.size === 'number' && Number.isSafeInteger(body.size) ? body.size : Number(body.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > v2MaxBytes) {
            json(res, 413, { error: 'file size exceeds the 1 GiB limit' });
            return;
        }
        const suppliedSha = body.sha256 ?? body.fileSha256;
        const expectedSha256 = validDigest(suppliedSha);
        if (suppliedSha !== undefined && expectedSha256 === undefined) {
            json(res, 400, { error: 'invalid sha256' });
            return;
        }
        const mediaType = typeof body.mediaType === 'string' ? body.mediaType.slice(0, 200) : undefined;
        const relativePath = sanitizeRelativePath(typeof body.relativePath === 'string' ? body.relativePath : '');
        const uploadId = randomUUID();
        const stamp = now();
        const state = {
            version: 2,
            uploadId,
            sessionId: storage.sessionId,
            name,
            size,
            ...(mediaType !== undefined ? { mediaType } : {}),
            ...(relativePath !== '' ? { relativePath } : {}),
            ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
            offset: 0,
            createdAt: stamp,
            updatedAt: stamp
        };
        const paths = transferPaths(storage, uploadId);
        inflight += 1;
        try {
            await mkdir(storage.partial, { recursive: true });
            const handle = await open(paths.part, 'wx');
            await handle.close();
            await writeJsonAtomic(paths.state, state);
            json(res, 201, {
                uploadId,
                fileName: name,
                name,
                size,
                chunkSize: V2_CHUNK_BYTES,
                chunkBytes: V2_CHUNK_BYTES,
                offset: 0,
                receivedBytes: 0,
                maxBytes: v2MaxBytes,
                maxFileBytes: v2MaxBytes,
                supportsResume: true
            });
        }
        catch (err) {
            await rm(paths.part, { force: true }).catch(() => undefined);
            await rm(paths.state, { force: true }).catch(() => undefined);
            console.error('[dsh-file-upload] transfer init failed:', err);
            json(res, 500, { error: 'transfer init failed' });
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleTransferStatus(req, res, uploadId) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        const found = await findTransfer(storage, uploadId);
        if (found === null) {
            const done = await findCompleted(storage, uploadId);
            if (done === null) {
                json(res, 404, { error: 'transfer not found' });
            }
            else {
                json(res, 200, { ...done.result, status: 'completed', uploadId });
            }
            return;
        }
        json(res, 200, {
            uploadId: found.state.uploadId,
            fileName: found.state.name,
            name: found.state.name,
            size: found.state.size,
            chunkSize: V2_CHUNK_BYTES,
            chunkBytes: V2_CHUNK_BYTES,
            offset: found.state.offset,
            receivedBytes: found.state.offset,
            maxBytes: v2MaxBytes,
            maxFileBytes: v2MaxBytes,
            status: 'uploading'
        });
    }
    async function handleTransferPatch(req, res, uploadId) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        if (inflight >= maxConcurrent) {
            json(res, 429, { error: 'too many concurrent uploads' });
            return;
        }
        inflight += 1;
        try {
            await withLock(`${storage.dir}:${uploadId}`, async () => {
                const found = await findTransfer(storage, uploadId);
                if (found === null) {
                    json(res, 404, { error: 'transfer not found' });
                    return;
                }
                const requestedOffset = headerInteger(req, 'upload-offset', 'x-upload-offset');
                if (requestedOffset === undefined) {
                    json(res, 400, { error: 'Upload-Offset is required' });
                    return;
                }
                if (requestedOffset !== found.state.offset) {
                    json(res, 409, { error: 'non-contiguous upload offset', offset: found.state.offset });
                    return;
                }
                const declaredLength = headerInteger(req, 'content-length', 'upload-length', 'x-upload-length', 'chunk-length', 'x-chunk-length');
                if (declaredLength !== undefined && declaredLength > V2_CHUNK_BYTES) {
                    json(res, 413, { error: 'chunk exceeds 4 MiB' });
                    return;
                }
                const chunkDigest = headerDigest(req, 'x-chunk-sha256', 'chunk-sha256');
                if (chunkDigest === undefined) {
                    json(res, 400, { error: 'X-Chunk-SHA256 is required' });
                    return;
                }
                const handle = await open(found.part, 'r+');
                const hash = createHash('sha256');
                let total = 0;
                let errorStatus;
                try {
                    await handle.truncate(found.state.offset);
                    for await (const chunk of req) {
                        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        total += buf.length;
                        if (total > V2_CHUNK_BYTES || found.state.offset + total > found.state.size) {
                            errorStatus = 413;
                            continue;
                        }
                        await handle.write(buf, 0, buf.length, found.state.offset + total - buf.length);
                        hash.update(buf);
                    }
                    if (declaredLength !== undefined && declaredLength !== total)
                        errorStatus = 400;
                    if (errorStatus === undefined && hash.digest('hex') !== chunkDigest)
                        errorStatus = 422;
                    if (errorStatus !== undefined) {
                        await handle.truncate(found.state.offset);
                        json(res, errorStatus, {
                            error: errorStatus === 422 ? 'chunk sha256 mismatch' : 'invalid chunk length',
                            offset: found.state.offset
                        });
                        return;
                    }
                    found.state.offset += total;
                    found.state.updatedAt = now();
                    await writeJsonAtomic(found.statePath, found.state);
                    json(res, 200, {
                        uploadId,
                        offset: found.state.offset,
                        receivedBytes: found.state.offset,
                        chunkSize: V2_CHUNK_BYTES,
                        chunkBytes: V2_CHUNK_BYTES
                    });
                }
                finally {
                    await handle.close().catch(() => undefined);
                }
            });
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleTransferCommit(req, res, uploadId) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        if (inflight >= maxConcurrent) {
            json(res, 429, { error: 'too many concurrent uploads' });
            return;
        }
        inflight += 1;
        try {
            await withLock(`${storage.dir}:${uploadId}`, async () => {
                const body = await readJsonBody(req);
                if (body === null) {
                    json(res, 400, { error: 'invalid JSON commit body' });
                    return;
                }
                const found = await findTransfer(storage, uploadId);
                if (found === null) {
                    const done = await findCompleted(storage, uploadId);
                    if (done === null)
                        json(res, 404, { error: 'transfer not found' });
                    else
                        json(res, 200, { ...done.result, status: 'completed', uploadId });
                    return;
                }
                const suppliedRaw = body.sha256;
                const supplied = validDigest(suppliedRaw) ?? headerDigest(req, 'x-file-sha256', 'file-sha256');
                if (suppliedRaw !== undefined && supplied === undefined) {
                    json(res, 400, { error: 'invalid sha256' });
                    return;
                }
                if (found.state.offset !== found.state.size) {
                    json(res, 409, { error: 'upload is incomplete', offset: found.state.offset, size: found.state.size });
                    return;
                }
                let digestResult;
                try {
                    digestResult = await hashFile(found.part);
                }
                catch {
                    json(res, 404, { error: 'partial file not found' });
                    return;
                }
                if (digestResult.bytes !== found.state.size) {
                    json(res, 409, { error: 'partial file size mismatch', offset: found.state.offset, size: found.state.size });
                    return;
                }
                if (supplied !== undefined && supplied !== digestResult.sha256 || found.state.expectedSha256 !== undefined && found.state.expectedSha256 !== digestResult.sha256) {
                    json(res, 422, { error: 'file sha256 mismatch', sha256: digestResult.sha256 });
                    return;
                }
                const prefix = await readPrefix(found.part);
                const sniffResult = sniff(prefix, found.state.name);
                const digest = digestResult.sha256;
                let destination = await findExistingByDigest(storage, digest);
                let deduplicated = destination !== undefined;
                await withLock(storage.dir, async () => {
                    if (destination === undefined)
                        destination = await findExistingByDigest(storage, digest);
                    if (destination !== undefined) {
                        deduplicated = true;
                        await rm(found.part, { force: true });
                    }
                    else {
                        destination = join(storage.dir, `${digest}-${found.state.name}`);
                        await rename(found.part, destination);
                    }
                });
                if (destination === undefined)
                    throw new Error('transfer commit destination missing');
                const image = sniffResult.type === 'image' && classifyHandling(sniffResult, found.state.size, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) === 'image'
                    ? await imageMetadata(options, storage.sessionId, destination, found.state.name)
                    : {};
                const result = makeTransferResponse(storage, found.state, destination, digest, sniffResult, options, {
                    ...(deduplicated ? { deduplicated: true } : {}),
                    ...image
                });
                const completed = {
                    version: 2,
                    status: 'completed',
                    uploadId,
                    sessionId: storage.sessionId,
                    path: result.path,
                    sha256: result.sha256,
                    result,
                    completedAt: now()
                };
                // Keep a small tombstone so a late status, commit, or DELETE remains
                // idempotent. Once the stream is published, its path is durable; DELETE
                // only cancels the unfinished transfer state below.
                await writeJsonAtomic(completedPath(storage, uploadId), completed);
                await rm(found.statePath, { force: true });
                json(res, 200, result);
            });
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleTransferDelete(req, res, uploadId) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            json(res, 403, { error: 'unknown session' });
            return;
        }
        await withLock(`${storage.dir}:${uploadId}`, async () => {
            const found = await findTransfer(storage, uploadId);
            if (found === null) {
                const done = await findCompleted(storage, uploadId);
                if (done === null) {
                    json(res, 404, { error: 'transfer not found' });
                    return;
                }
                // A completed transfer is a published attachment, even if the
                // composer still shows its draft card or a stale client retries the
                // cancellation request. Keep both the file and tombstone so a retry
                // remains harmless and a later model read can still resolve the path.
                res.writeHead(204);
                res.end();
                return;
            }
            await rm(found.part, { force: true });
            await rm(found.statePath, { force: true });
            res.writeHead(204);
            res.end();
        });
    }
    async function dispatchV2(req, res, pathname) {
        const prefix = '/api/upload/v2';
        if (pathname === `${prefix}/describe`) {
            if (req.method !== 'GET')
                json(res, 405, { error: 'method not allowed' });
            else
                await handleDescribe(req, res);
            return;
        }
        const transferPrefix = `${prefix}/transfers/`;
        if (pathname === `${prefix}/transfers`) {
            if (req.method !== 'POST')
                json(res, 405, { error: 'method not allowed' });
            else
                await handleTransferInit(req, res);
            return;
        }
        if (!pathname.startsWith(transferPrefix)) {
            json(res, 404, { error: 'not found' });
            return;
        }
        const tail = pathname.slice(transferPrefix.length);
        const parts = tail.split('/').filter((part) => part !== '');
        let uploadId = '';
        try {
            uploadId = decodeURIComponent(parts[0] ?? '');
        }
        catch {
            json(res, 400, { error: 'invalid upload id' });
            return;
        }
        if (parts.length === 1) {
            if (req.method === 'GET')
                await handleTransferStatus(req, res, uploadId);
            else if (req.method === 'PATCH')
                await handleTransferPatch(req, res, uploadId);
            else if (req.method === 'DELETE')
                await handleTransferDelete(req, res, uploadId);
            else
                json(res, 405, { error: 'method not allowed' });
            return;
        }
        if (parts.length === 2 && parts[1] === 'commit') {
            if (req.method === 'POST')
                await handleTransferCommit(req, res, uploadId);
            else
                json(res, 405, { error: 'method not allowed' });
            return;
        }
        json(res, 404, { error: 'not found' });
    }
    return async function handler(req, res) {
        if (!isLoopbackUploadRequest(req)) {
            json(res, 403, { error: 'loopback only' });
            return;
        }
        let pathname = '/';
        try {
            pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        }
        catch {
            json(res, 400, { error: 'invalid URL' });
            return;
        }
        if (pathname.startsWith('/api/upload/v2')) {
            await dispatchV2(req, res, pathname);
            return;
        }
        if (pathname !== '/api/upload' && pathname !== '/api/upload/') {
            json(res, 404, { error: 'not found' });
            return;
        }
        if (req.method === 'POST')
            await handleLegacyPost(req, res);
        else if (req.method === 'DELETE')
            await handleLegacyDelete(req, res);
        else
            json(res, 405, { error: 'method not allowed' });
    };
}
/** Remove only abandoned partial transfer files; completed uploads persist. */
export async function sweepUploadRoots(roots, ttlMs = PARTIAL_TTL_MS, now = Date.now) {
    const resolvedRoots = [];
    for (const rootEntry of roots) {
        const value = typeof rootEntry === 'function' ? await rootEntry() : rootEntry;
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
        resolvedRoots.push(...values);
    }
    const seen = new Set();
    for (const root of resolvedRoots) {
        const absoluteRoot = resolve(root);
        if (seen.has(absoluteRoot))
            continue;
        seen.add(absoluteRoot);
        const uploadRoot = join(absoluteRoot, '.dsh-uploads');
        const sessionDirs = await readdir(uploadRoot, { withFileTypes: true }).catch(() => []);
        for (const sessionDir of sessionDirs) {
            if (!sessionDir.isDirectory())
                continue;
            const partial = join(uploadRoot, sessionDir.name, '.partial');
            const entries = await readdir(partial, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (entry.name.endsWith('.done.json'))
                    continue;
                const path = join(partial, entry.name);
                const info = await stat(path).catch(() => null);
                if (info !== null && now() - info.mtimeMs > ttlMs)
                    await rm(path, { recursive: entry.isDirectory(), force: true });
            }
        }
    }
}
/** Periodically sweep abandoned partial files across live/cold workspace roots. */
export function createSweeper(roots, ttlMs, intervalMs, now = Date.now) {
    if (intervalMs <= 0)
        return () => undefined;
    const timer = setInterval(() => {
        void sweepUploadRoots(roots, ttlMs, now).catch((err) => {
            console.error('[dsh-file-upload] sweep failed:', err);
        });
    }, intervalMs);
    if (typeof timer.unref === 'function')
        timer.unref();
    return () => clearInterval(timer);
}
