// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
                                                                                                                                                   
                                                                                                                                                                     
import { constants, createReadStream } from 'node:fs';
import { access, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile, } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PARTIAL_TTL_MS, resolveLocalSessionId, V2_CHUNK_BYTES, V2_MAX_FILE_BYTES, } from "./upload.js";
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu;
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/iu;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST_PAGE = 200;
const MAX_MANIFEST_ENTRIES = 100_000;
const DEFAULT_MANIFEST_PATH_BUDGET_BYTES = 4 * 1024 * 1024;
const DEFAULT_MANIFEST_SERIALIZED_BUDGET_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_PATH_BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_SERIALIZED_BUDGET_BYTES = 128 * 1024 * 1024;
const DELETE_CONFIRMATION_TTL_MS = 60_000;
class HttpError extends Error {
    statusCode;
    reasonCode;
    constructor(statusCode, message, reasonCode) {
        super(message);
        this.statusCode = statusCode;
        this.reasonCode = reasonCode;
    }
}
function normalizeHeader(value) {
    if (Array.isArray(value))
        return undefined;
    return value;
}
function errorCode(error) {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
}
/** Ensure every existing component is a real directory, never a symlink. */
async function ensureDirectoryNoSymlink(path, createMissing = true) {
    const absolute = resolve(path);
    const missing = [];
    let current = absolute;
    while (true) {
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink())
                throw new HttpError(409, 'directory path contains a symbolic link', 'unsafe-path');
            if (!info.isDirectory())
                throw new HttpError(409, 'directory path is not a directory', 'invalid-type');
            break;
        }
        catch (error) {
            if (error instanceof HttpError)
                throw error;
            if (errorCode(error) !== 'ENOENT' || !createMissing)
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw new HttpError(409, 'directory path is unavailable', 'invalid-path');
            missing.push(current);
            current = parent;
        }
    }
    for (let index = missing.length - 1; index >= 0; index -= 1) {
        const directory = missing[index];
        try {
            await mkdir(directory);
        }
        catch (error) {
            if (errorCode(error) !== 'EEXIST')
                throw error;
        }
        const info = await lstat(directory);
        if (info.isSymbolicLink())
            throw new HttpError(409, 'directory path contains a symbolic link', 'unsafe-path');
        if (!info.isDirectory())
            throw new HttpError(409, 'directory path is not a directory', 'invalid-type');
    }
}
function isLoopbackAddress(value) {
    if (value === undefined)
        return false;
    const address = value.toLowerCase().replace(/^\[|\]$/gu, '');
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function isWriteMethod(method) {
    return method !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
/** Validate both the transport peer and the loopback Host/Origin authority. */
export function isLoopbackRequest(request) {
    if (!isLoopbackAddress(request.socket?.remoteAddress))
        return false;
    const host = normalizeHeader(request.headers.host);
    if (host === undefined || !LOOPBACK_HOST.test(host))
        return false;
    const originHeader = request.headers.origin;
    if (!isWriteMethod(request.method) || originHeader === undefined)
        return true;
    const origin = normalizeHeader(originHeader);
    if (origin === undefined)
        return false;
    try {
        return new URL(origin).origin === new URL(`http://${host}`).origin;
    }
    catch {
        return false;
    }
}
function json(response, statusCode, body) {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(encoded.length),
        'cache-control': 'no-store',
    });
    response.end(encoded);
}
async function readJson(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_JSON_BYTES)
            throw new HttpError(413, 'JSON body is too large', 'payload-too-large');
        chunks.push(bytes);
    }
    if (total === 0)
        return {};
    try {
        const value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('expected object');
        }
        return value;
    }
    catch (error) {
        throw new HttpError(400, `invalid JSON: ${error.message}`, 'invalid-json');
    }
}
function stringField(body, name, required = true) {
    const value = body[name];
    if (typeof value === 'string' && value.trim() !== '')
        return value;
    if (!required && (value === undefined || value === null || value === ''))
        return undefined;
    throw new HttpError(400, `${name} must be a non-empty string`, 'invalid-request');
}
function numberField(body, name) {
    const value = body[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new HttpError(400, `${name} must be a non-negative integer`, 'invalid-request');
    }
    return value;
}
function safeLeafName(raw) {
    const value = raw.trim();
    if (value === '' || value === '.' || value === '..' || value.includes('\0') ||
        value.includes('/') || value.includes('\\') || value.length > 255) {
        throw new HttpError(400, 'name must be one file-system component', 'invalid-name');
    }
    return value;
}
function absolutePath(raw) {
    if (raw.includes('\0'))
        throw new HttpError(400, 'path contains a NUL byte', 'invalid-path');
    if (raw === '~')
        return homedir();
    if (raw.startsWith(`~${sep}`) || raw.startsWith('~/') || raw.startsWith('~\\')) {
        return resolve(homedir(), raw.slice(2));
    }
    if (!isAbsolute(raw))
        throw new HttpError(400, 'path must be absolute', 'invalid-path');
    return resolve(raw);
}
function entryKind(info) {
    if (info.isSymbolicLink())
        return 'symlink';
    if (info.isDirectory())
        return 'directory';
    if (info.isFile())
        return 'file';
    return 'other';
}
function fingerprint(info) {
    return {
        device: Number(info.dev),
        inode: Number(info.ino),
        size: info.size,
        modifiedAt: info.mtimeMs,
        kind: entryKind(info),
    };
}
function sameFingerprint(left, right) {
    return left.device === right.device && left.inode === right.inode && left.size === right.size &&
        left.modifiedAt === right.modifiedAt && left.kind === right.kind;
}
function sameFileIdentity(left, right) {
    return left.device === right.device && left.inode === right.inode && left.kind === right.kind;
}
function pathComparisonValue(path) {
    const resolved = resolve(path);
    return platform() === 'win32' ? resolved.toLowerCase() : resolved;
}
function isAncestorOrSamePath(ancestor, descendant) {
    const relativePath = relative(pathComparisonValue(ancestor), pathComparisonValue(descendant));
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
function processUserName() {
    try {
        const username = userInfo().username;
        return typeof username === 'string' && username.length > 0 ? username : null;
    }
    catch {
        return null;
    }
}
async function directorySnapshot(path) {
    await ensureDirectoryNoSymlink(path, false);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new HttpError(409, 'partial parent is not a real directory', 'unsafe-path');
    }
    return { canonicalPath: await realpath(path), fingerprint: fingerprint(info) };
}
function assertSameDirectory(before, after) {
    if (!sameFingerprint(before.fingerprint, after.fingerprint) ||
        pathComparisonValue(before.canonicalPath) !== pathComparisonValue(after.canonicalPath)) {
        throw new HttpError(409, 'directory changed while operating on a partial', 'directory-changed');
    }
}
const PARTIAL_OPEN_FLAGS = constants.O_RDWR | Number(constants.O_NOFOLLOW ?? 0);
async function openPartialFile(path) {
    const parent = await directorySnapshot(dirname(path));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new HttpError(409, 'upload partial is not a regular file', 'unsafe-path');
    }
    let handle;
    try {
        handle = await open(path, PARTIAL_OPEN_FLAGS);
    }
    catch (error) {
        if (errorCode(error) === 'ELOOP') {
            throw new HttpError(409, 'upload partial is a symbolic link', 'unsafe-path');
        }
        throw error;
    }
    try {
        const opened = await handle.stat();
        if (!sameFileIdentity(fingerprint(before), fingerprint(opened))) {
            throw new HttpError(409, 'upload partial changed while opening', 'file-changed');
        }
        const afterParent = await directorySnapshot(dirname(path));
        assertSameDirectory(parent, afterParent);
        return { handle, parent, file: fingerprint(opened) };
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
async function withOpenPartial(path, operation, hook, phase = 'partial-before-operation') {
    const opened = await openPartialFile(path);
    let result;
    let operationError;
    let verificationError;
    try {
        if (hook !== undefined)
            await hook(phase, path);
        const beforeOperationParent = await directorySnapshot(dirname(path));
        assertSameDirectory(opened.parent, beforeOperationParent);
        result = await operation(opened.handle);
    }
    catch (error) {
        operationError = error;
    }
    try {
        const after = await opened.handle.stat();
        if (!sameFileIdentity(opened.file, fingerprint(after))) {
            throw new HttpError(409, 'upload partial changed while operating', 'file-changed');
        }
        const afterParent = await directorySnapshot(dirname(path));
        assertSameDirectory(opened.parent, afterParent);
    }
    catch (error) {
        verificationError = error;
    }
    try {
        await opened.handle.close();
    }
    catch (error) {
        if (operationError === undefined && verificationError === undefined)
            verificationError = error;
    }
    if (operationError !== undefined)
        throw operationError;
    if (verificationError !== undefined)
        throw verificationError;
    return result;
}
async function canAccess(path, mode) {
    try {
        await access(path, mode);
        return true;
    }
    catch {
        return false;
    }
}
async function toEntry(path, name = basename(path), maxFileBytes = V2_MAX_FILE_BYTES) {
    const info = await lstat(path);
    const kind = entryKind(info);
    const [readable, writable] = await Promise.all([
        canAccess(path, constants.R_OK),
        canAccess(path, constants.W_OK),
    ]);
    return {
        name,
        path: resolve(path),
        kind,
        size: kind === 'file' ? info.size : null,
        modifiedAt: info.mtimeMs,
        readable,
        writable,
        transferable: kind === 'directory' || (kind === 'file' && info.size <= maxFileBytes),
    };
}
async function persistedSessionCwd(persistence, sessionId) {
    if (persistence === undefined)
        return undefined;
    let entries;
    try {
        const listed = await persistence.list();
        entries = Array.isArray(listed) ? listed : [];
    }
    catch {
        return undefined;
    }
    for (const entry of entries) {
        if (entry === null || typeof entry !== 'object')
            continue;
        const candidate = entry;
        const headerValue = candidate.header;
        const header = headerValue !== null && typeof headerValue === 'object'
            ? headerValue
            : candidate;
        const id = typeof candidate.id === 'string' ? candidate.id
            : typeof header.id === 'string' ? header.id
                : typeof header.sessionId === 'string' ? header.sessionId
                    : undefined;
        if (id !== sessionId || typeof header.cwd !== 'string' || header.cwd === '')
            continue;
        return header.cwd;
    }
    return undefined;
}
async function hashFile(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest('hex');
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function keepBothPath(requestedPath, exists) {
    const extension = extname(requestedPath);
    const stem = basename(requestedPath, extension);
    const parent = dirname(requestedPath);
    return (async () => {
        for (let index = 1; index <= 10_000; index += 1) {
            const candidate = join(parent, `${stem} (${index})${extension}`);
            if (!await exists(candidate))
                return candidate;
        }
        throw new HttpError(409, 'unable to allocate a conflict-free name', 'name-conflict');
    })();
}
async function readRegularJson(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new HttpError(409, 'state file is not a regular file', 'unsafe-path');
    }
    return JSON.parse(await readFile(path, 'utf8'));
}
async function readJsonWithRecovery(path) {
    await ensureDirectoryNoSymlink(dirname(path), false);
    let primaryError;
    try {
        return await readRegularJson(path);
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        primaryError = error;
    }
    let entries;
    try {
        entries = await readdir(dirname(path));
    }
    catch {
        throw primaryError;
    }
    const prefix = `${basename(path)}.`;
    const candidates = [];
    for (const name of entries) {
        if (!name.startsWith(prefix) || (!name.endsWith('.tmp') && !name.endsWith('.bak')))
            continue;
        const candidatePath = join(dirname(path), name);
        try {
            const info = await lstat(candidatePath);
            if (!info.isFile() || info.isSymbolicLink())
                continue;
            candidates.push({ path: candidatePath, modifiedAt: info.mtimeMs });
        }
        catch {
            // A concurrently removed recovery candidate is harmless.
        }
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const candidate of candidates) {
        try {
            const recovered = await readRegularJson(candidate.path);
            try {
                await rename(candidate.path, path);
            }
            catch (error) {
                if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'EPERM')
                    throw error;
                return await readRegularJson(path);
            }
            return recovered;
        }
        catch {
            // Ignore malformed or raced candidates and continue with the next one.
        }
    }
    throw primaryError;
}
async function writeJsonAtomic(path, value) {
    await ensureDirectoryNoSymlink(dirname(path));
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const backup = `${path}.${randomBytes(6).toString('hex')}.bak`;
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    let movedExisting = false;
    try {
        try {
            const existing = await lstat(path);
            if (!existing.isFile() || existing.isSymbolicLink()) {
                throw new HttpError(409, 'state file is not a regular file', 'unsafe-path');
            }
            await rename(path, backup);
            movedExisting = true;
        }
        catch (error) {
            if (error instanceof HttpError || errorCode(error) !== 'ENOENT')
                throw error;
        }
        await rename(temporary, path);
        if (movedExisting)
            await rm(backup, { force: true });
    }
    catch (error) {
        if (movedExisting && !await pathExists(path) && await pathExists(backup)) {
            await rename(backup, path).catch(() => undefined);
        }
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function reconcileUploadPartial(state, hook) {
    if (state.direction !== 'upload' || state.status === 'completed' || state.status === 'skipped' || state.status === 'cancelled')
        return;
    if (state.partialPath === undefined || state.destinationDirectory === undefined || state.requestedFileName === undefined) {
        throw new HttpError(409, 'upload partial metadata is missing', 'transfer-corrupt');
    }
    if (state.confirmedOffset < 0 || state.confirmedOffset > state.size) {
        throw new HttpError(409, 'upload confirmed offset is invalid', 'transfer-corrupt');
    }
    const expectedPath = resolve(join(state.destinationDirectory, '.dsh-transfer-partials', `${state.transferId}.part`));
    if (pathComparisonValue(state.partialPath) !== pathComparisonValue(expectedPath)) {
        throw new HttpError(409, 'upload partial path is invalid', 'unsafe-path');
    }
    await ensureDirectoryNoSymlink(dirname(expectedPath), false);
    let info;
    try {
        info = await lstat(expectedPath);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT' && state.destinationPath !== undefined && state.sha256 !== undefined && state.confirmedOffset === state.size) {
            return;
        }
        if (errorCode(error) === 'ENOENT')
            throw new HttpError(409, 'upload partial is missing', 'transfer-corrupt');
        throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new HttpError(409, 'upload partial is not a regular file', 'unsafe-path');
    }
    info = await withOpenPartial(expectedPath, async (handle) => {
        const opened = await handle.stat();
        if (opened.size < state.confirmedOffset) {
            throw new HttpError(409, 'upload partial is shorter than the confirmed offset', 'transfer-corrupt');
        }
        if (opened.size > state.confirmedOffset) {
            await handle.truncate(state.confirmedOffset);
            await handle.sync();
        }
        const reconciled = await handle.stat();
        if (reconciled.size !== state.confirmedOffset) {
            throw new HttpError(409, 'upload partial could not be reconciled', 'transfer-corrupt');
        }
        return reconciled;
    }, hook, 'reconcile-before-truncate');
    if (info.size !== state.confirmedOffset) {
        throw new HttpError(409, 'upload partial could not be reconciled', 'transfer-corrupt');
    }
}
function parseRange(value, size) {
    if (value === undefined)
        return null;
    const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
    if (match === null)
        throw new HttpError(416, 'unsupported byte range', 'invalid-range');
    const start = Number(match[1]);
    const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
        throw new HttpError(416, 'byte range is outside the file', 'invalid-range');
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
}
function errorStatus(error) {
    if (error instanceof HttpError)
        return error;
    const code = error.code;
    if (code === 'ENOENT')
        return { statusCode: 404, message: 'file or directory not found', reasonCode: 'not-found' };
    if (code === 'EACCES' || code === 'EPERM')
        return { statusCode: 403, message: 'permission denied', reasonCode: 'permission-denied' };
    if (code === 'EEXIST' || code === 'ENOTEMPTY')
        return { statusCode: 409, message: 'target already exists', reasonCode: 'name-conflict' };
    if (code === 'ENOSPC')
        return { statusCode: 507, message: 'insufficient storage', reasonCode: 'insufficient-storage' };
    if (code === 'ENOTDIR' || code === 'EISDIR')
        return { statusCode: 400, message: 'unexpected file type', reasonCode: 'invalid-type' };
    return { statusCode: 500, message: 'file operation failed', reasonCode: 'io-error' };
}
/** Loopback-only file browser and bidirectional transfer surface. */
export function createFileBrowserHandler(options) {
    const maxFileBytes = Math.min(Math.max(0, options.maxFileBytes ?? V2_MAX_FILE_BYTES), V2_MAX_FILE_BYTES);
    const chunkBytes = Math.min(Math.max(64 * 1024, options.chunkBytes ?? V2_CHUNK_BYTES), V2_CHUNK_BYTES);
    const partialTtlMs = options.partialTtlMs ?? PARTIAL_TTL_MS;
    const now = options.now ?? Date.now;
    const manifestPathBudget = Number.isSafeInteger(options.manifestPathBudgetBytes)
        ? Math.min(Math.max(0, options.manifestPathBudgetBytes), MAX_MANIFEST_PATH_BUDGET_BYTES)
        : DEFAULT_MANIFEST_PATH_BUDGET_BYTES;
    const manifestSerializedBudget = Number.isSafeInteger(options.manifestSerializedBytes)
        ? Math.min(Math.max(0, options.manifestSerializedBytes), MAX_MANIFEST_SERIALIZED_BUDGET_BYTES)
        : DEFAULT_MANIFEST_SERIALIZED_BUDGET_BYTES;
    const homePath = resolve(options.homeDir ?? homedir());
    const stateRoot = resolve(options.defaultDir, '.file-browser-v1');
    const transfersRoot = join(stateRoot, 'transfers');
    const manifestsRoot = join(stateRoot, 'manifests');
    const confirmations = new Map();
    const locks = new Map();
    let lastSweep = 0;
    async function withLock(key, operation) {
        const predecessor = locks.get(key) ?? Promise.resolve();
        let release = () => undefined;
        const current = new Promise((resolvePromise) => { release = resolvePromise; });
        const chain = predecessor.then(() => current);
        locks.set(key, chain);
        await predecessor;
        try {
            return await operation();
        }
        finally {
            release();
            if (locks.get(key) === chain)
                locks.delete(key);
        }
    }
    async function sessionContext(request) {
        const raw = normalizeHeader(request.headers['x-session-id']);
        if (raw === undefined)
            throw new HttpError(403, 'missing session id', 'unknown-session');
        const sessionId = resolveLocalSessionId(raw);
        if (sessionId === null || sessionId === '')
            throw new HttpError(403, 'invalid session id', 'unknown-session');
        let cwd;
        try {
            cwd = await options.sessionCwd?.(sessionId);
        }
        catch {
            cwd = undefined;
        }
        cwd ??= await persistedSessionCwd(options.sessionPersistence, sessionId);
        if (cwd === undefined && options.sessionCwd === undefined && options.sessionPersistence === undefined)
            cwd = options.defaultDir;
        if (cwd === undefined)
            throw new HttpError(403, 'unknown session', 'unknown-session');
        const workspacePath = resolve(cwd);
        const info = await stat(workspacePath);
        if (!info.isDirectory())
            throw new HttpError(409, 'session workspace is not a directory', 'invalid-workspace');
        return { sessionId, workspacePath };
    }
    function transferStatePath(transferId) {
        if (!SAFE_ID.test(transferId))
            throw new HttpError(400, 'invalid transfer id', 'invalid-transfer-id');
        return join(transfersRoot, `${transferId}.json`);
    }
    function manifestStatePath(manifestId) {
        if (!SAFE_ID.test(manifestId))
            throw new HttpError(400, 'invalid manifest id', 'invalid-manifest-id');
        return join(manifestsRoot, `${manifestId}.json`);
    }
    async function loadTransfer(context, transferId) {
        let state;
        try {
            state = await readJsonWithRecovery(transferStatePath(transferId));
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                throw new HttpError(404, 'transfer not found', 'not-found');
            if (error instanceof SyntaxError)
                throw new HttpError(409, 'transfer state is corrupt', 'transfer-corrupt');
            throw error;
        }
        if (state.sessionId !== context.sessionId || state.transferId !== transferId) {
            throw new HttpError(404, 'transfer not found', 'not-found');
        }
        await reconcileUploadPartial(state, options.beforePartialOperation);
        return state;
    }
    async function saveTransfer(state) {
        state.updatedAt = now();
        await writeJsonAtomic(transferStatePath(state.transferId), state);
    }
    async function loadManifest(context, manifestId) {
        let state;
        try {
            state = await readJsonWithRecovery(manifestStatePath(manifestId));
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                throw new HttpError(404, 'manifest not found', 'not-found');
            if (error instanceof SyntaxError)
                throw new HttpError(409, 'manifest state is corrupt', 'manifest-corrupt');
            throw error;
        }
        if (state.sessionId !== context.sessionId || state.manifestId !== manifestId) {
            throw new HttpError(404, 'manifest not found', 'not-found');
        }
        return state;
    }
    async function lazySweep() {
        const timestamp = now();
        if (timestamp - lastSweep < Math.min(partialTtlMs, 60 * 60 * 1000))
            return;
        lastSweep = timestamp;
        confirmations.forEach((value, key) => {
            if (value.expiresAt <= timestamp)
                confirmations.delete(key);
        });
        for (const root of [transfersRoot, manifestsRoot]) {
            let entries = [];
            try {
                await ensureDirectoryNoSymlink(root, false);
                entries = await readdir(root, { withFileTypes: true });
            }
            catch {
                entries = [];
            }
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.json'))
                    continue;
                const path = join(root, entry.name);
                const info = await stat(path).catch(() => null);
                if (info === null || timestamp - info.mtimeMs <= partialTtlMs)
                    continue;
                if (root === transfersRoot) {
                    const state = await readJsonWithRecovery(path).catch(() => null);
                    if (state?.status === 'completed' || state?.status === 'skipped')
                        continue;
                    const expectedPartial = state?.direction === 'upload' && state.destinationDirectory !== undefined && state.requestedFileName !== undefined
                        ? resolve(join(state.destinationDirectory, '.dsh-transfer-partials', `${state.transferId}.part`))
                        : undefined;
                    if (state?.partialPath !== undefined && expectedPartial !== undefined &&
                        pathComparisonValue(state.partialPath) === pathComparisonValue(expectedPartial)) {
                        await rm(expectedPartial, { force: true }).catch(() => undefined);
                    }
                }
                await rm(path, { force: true }).catch(() => undefined);
            }
        }
    }
    async function handleDescribe(request, response) {
        const context = await sessionContext(request);
        json(response, 200, {
            protocol: 'file-browser-v1',
            protocolVersion: 1,
            platform: platform(),
            permissionScope: 'dsh-process-user',
            processUser: processUserName(),
            workspacePath: context.workspacePath,
            homePath,
            maxFileBytes,
            chunkBytes,
            capabilities: {
                list: true,
                mkdir: true,
                rename: true,
                permanentDelete: true,
                upload: true,
                download: true,
                recursiveManifest: true,
                symlinkTransfer: false,
            },
        });
    }
    async function handleList(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const requested = stringField(body, 'path', false) ?? context.workspacePath;
        const canonical = await realpath(absolutePath(requested));
        const info = await lstat(canonical);
        if (!info.isDirectory())
            throw new HttpError(400, 'path is not a directory', 'invalid-type');
        const cursorValue = body.cursor ?? 0;
        const limitValue = body.limit ?? 100;
        const cursor = typeof cursorValue === 'number' && Number.isSafeInteger(cursorValue) && cursorValue >= 0 ? cursorValue : 0;
        const limit = typeof limitValue === 'number' && Number.isSafeInteger(limitValue)
            ? Math.max(1, Math.min(MAX_LIST_PAGE, limitValue))
            : 100;
        const children = (await readdir(canonical, { withFileTypes: true }))
            .sort((left, right) => {
            const leftDirectory = left.isDirectory() ? 0 : 1;
            const rightDirectory = right.isDirectory() ? 0 : 1;
            return leftDirectory - rightDirectory || left.name.localeCompare(right.name);
        });
        const page = children.slice(cursor, cursor + limit);
        const entries = await Promise.all(page.map((child) => toEntry(join(canonical, child.name), child.name, maxFileBytes)));
        const nextCursor = cursor + page.length < children.length ? cursor + page.length : null;
        json(response, 200, {
            path: canonical,
            parentPath: dirname(canonical) === canonical ? null : dirname(canonical),
            entries,
            nextCursor,
            totalEntries: children.length,
        });
    }
    async function handleStat(request, response) {
        await sessionContext(request);
        const body = await readJson(request);
        json(response, 200, await toEntry(absolutePath(stringField(body, 'path')), undefined, maxFileBytes));
    }
    async function handleMkdir(request, response) {
        await sessionContext(request);
        const body = await readJson(request);
        const parent = await realpath(absolutePath(stringField(body, 'parentPath')));
        const name = safeLeafName(stringField(body, 'name'));
        const path = join(parent, name);
        await mkdir(path, { recursive: false });
        json(response, 201, await toEntry(path, name, maxFileBytes));
    }
    async function handleRename(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const source = absolutePath(stringField(body, 'path'));
        await lstat(source);
        if (protectedDeletePath(context, source))
            throw new HttpError(403, 'protected root cannot be renamed', 'protected-path');
        const target = join(dirname(source), safeLeafName(stringField(body, 'name')));
        if (await pathExists(target))
            throw new HttpError(409, 'target already exists', 'name-conflict');
        await rename(source, target);
        json(response, 200, await toEntry(target, basename(target), maxFileBytes));
    }
    function protectedDeletePath(context, path) {
        const resolvedPath = resolve(path);
        return [homePath, context.workspacePath, stateRoot].some((protectedRoot) => isAncestorOrSamePath(resolvedPath, protectedRoot));
    }
    async function handleDeletePrepare(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const rawPaths = body.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > 1_000 || rawPaths.some((value) => typeof value !== 'string')) {
            throw new HttpError(400, 'paths must be a non-empty string array', 'invalid-request');
        }
        const unique = Array.from(new Set(rawPaths.map(absolutePath)))
            .sort((left, right) => left.length - right.length)
            .filter((candidate, index, all) => !all.slice(0, index).some((parent) => isAncestorOrSamePath(parent, candidate)));
        const candidates = [];
        for (const path of unique) {
            if (protectedDeletePath(context, path))
                throw new HttpError(403, 'protected root cannot be deleted', 'protected-path');
            candidates.push({ path, fingerprint: fingerprint(await lstat(path)) });
        }
        const token = randomUUID().replaceAll('-', '');
        const confirmation = {
            token,
            sessionId: context.sessionId,
            workspacePath: context.workspacePath,
            expiresAt: now() + DELETE_CONFIRMATION_TTL_MS,
            candidates,
        };
        confirmations.set(token, confirmation);
        json(response, 200, {
            confirmationToken: token,
            expiresAt: confirmation.expiresAt,
            count: candidates.length,
            containsDirectories: candidates.some((candidate) => candidate.fingerprint.kind === 'directory'),
        });
    }
    async function handleDeleteCommit(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const token = stringField(body, 'confirmationToken');
        const confirmation = confirmations.get(token);
        if (confirmation === undefined || confirmation.sessionId !== context.sessionId) {
            throw new HttpError(409, 'delete confirmation is missing or already used', 'confirmation-invalid');
        }
        confirmations.delete(token);
        if (confirmation.expiresAt <= now())
            throw new HttpError(409, 'delete confirmation expired', 'confirmation-expired');
        for (const candidate of confirmation.candidates) {
            await withLock(`delete:${candidate.path}`, async () => {
                if (protectedDeletePath(context, candidate.path)) {
                    throw new HttpError(403, 'protected root cannot be deleted', 'protected-path');
                }
                const current = fingerprint(await lstat(candidate.path));
                if (!sameFingerprint(candidate.fingerprint, current)) {
                    throw new HttpError(409, 'delete target changed after confirmation', 'target-changed');
                }
                const quarantinePath = join(dirname(candidate.path), `.dsh-delete-${randomUUID()}`);
                try {
                    await rename(candidate.path, quarantinePath);
                    const quarantined = fingerprint(await lstat(quarantinePath));
                    if (!sameFingerprint(candidate.fingerprint, quarantined)) {
                        throw new HttpError(409, 'delete target changed during confirmation', 'target-changed');
                    }
                    await rm(quarantinePath, {
                        recursive: candidate.fingerprint.kind === 'directory',
                        force: false,
                    });
                }
                catch (error) {
                    if (await pathExists(quarantinePath) && !await pathExists(candidate.path)) {
                        await rename(quarantinePath, candidate.path).catch(() => undefined);
                    }
                    if (error instanceof HttpError)
                        throw error;
                    throw new HttpError(500, 'delete could not be completed safely', 'partial-delete');
                }
            });
        }
        json(response, 200, { deleted: confirmation.candidates.length });
    }
    async function enumerateManifest(rootPath) {
        const rootInfo = await lstat(rootPath);
        if (!rootInfo.isDirectory())
            throw new HttpError(400, 'manifest root is not a directory', 'invalid-type');
        const rootSnapshot = {
            canonicalPath: await realpath(rootPath),
            fingerprint: fingerprint(rootInfo),
        };
        const entries = [];
        const stack = [{ path: rootPath, snapshot: rootSnapshot }];
        let totalBytes = 0;
        let skippedSymlinks = 0;
        let pathBytes = 0;
        let serializedBytes = 0;
        while (stack.length > 0) {
            const item = stack.pop();
            if (options.onManifestDirectoryPop !== undefined)
                await options.onManifestDirectoryPop(item.path);
            let current;
            try {
                current = await directorySnapshot(item.path);
            }
            catch {
                throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
            }
            if (!sameFingerprint(item.snapshot.fingerprint, current.fingerprint) ||
                pathComparisonValue(item.snapshot.canonicalPath) !== pathComparisonValue(current.canonicalPath) ||
                !isAncestorOrSamePath(rootSnapshot.canonicalPath, current.canonicalPath)) {
                throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
            }
            const directory = item.path;
            if (options.onManifestDirectoryBeforeRead !== undefined)
                await options.onManifestDirectoryBeforeRead(item.path);
            let children;
            try {
                children = (await readdir(current.canonicalPath, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
            }
            catch {
                throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
            }
            let afterRead;
            try {
                afterRead = await directorySnapshot(item.path);
            }
            catch {
                throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
            }
            if (!sameFingerprint(current.fingerprint, afterRead.fingerprint) ||
                pathComparisonValue(current.canonicalPath) !== pathComparisonValue(afterRead.canonicalPath) ||
                !isAncestorOrSamePath(rootSnapshot.canonicalPath, afterRead.canonicalPath)) {
                throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
            }
            const nested = [];
            for (const child of children) {
                const path = join(directory, child.name);
                const info = await lstat(path);
                const kind = entryKind(info);
                if (kind === 'symlink') {
                    skippedSymlinks += 1;
                    continue;
                }
                if (kind !== 'file' && kind !== 'directory')
                    continue;
                const relativePath = relative(rootPath, path).split(sep).join('/');
                const entry = {
                    relativePath,
                    path,
                    kind,
                    size: kind === 'file' ? info.size : null,
                    modifiedAt: info.mtimeMs,
                    transferable: kind === 'directory' || info.size <= maxFileBytes,
                };
                pathBytes += Buffer.byteLength(relativePath, 'utf8');
                if (pathBytes > manifestPathBudget) {
                    throw new HttpError(413, 'manifest paths exceed the byte budget', 'manifest-path-budget');
                }
                serializedBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
                if (serializedBytes > manifestSerializedBudget) {
                    throw new HttpError(413, 'manifest entries exceed the serialized byte budget', 'manifest-size-budget');
                }
                entries.push(entry);
                if (kind === 'file')
                    totalBytes += info.size;
                else {
                    let nestedSnapshot;
                    try {
                        nestedSnapshot = await directorySnapshot(path);
                    }
                    catch {
                        throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
                    }
                    if (!isAncestorOrSamePath(rootSnapshot.canonicalPath, nestedSnapshot.canonicalPath)) {
                        throw new HttpError(409, 'manifest directory changed while enumerating', 'directory-changed');
                    }
                    nested.push({ path, snapshot: nestedSnapshot });
                }
                if (entries.length > MAX_MANIFEST_ENTRIES) {
                    throw new HttpError(413, 'directory contains too many entries', 'manifest-too-large');
                }
            }
            for (let index = nested.length - 1; index >= 0; index -= 1)
                stack.push(nested[index]);
        }
        entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        return { entries, totalBytes, skippedSymlinks, pathBytes, serializedBytes };
    }
    async function handleManifestCreate(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const rootPath = await realpath(absolutePath(stringField(body, 'path')));
        const enumerated = await enumerateManifest(rootPath);
        const manifestId = randomUUID().replaceAll('-', '');
        const timestamp = now();
        const state = {
            version: 1,
            manifestId,
            sessionId: context.sessionId,
            rootPath,
            rootName: basename(rootPath),
            createdAt: timestamp,
            updatedAt: timestamp,
            ...enumerated,
        };
        let serialized = Buffer.byteLength(JSON.stringify(state), 'utf8');
        while (state.serializedBytes !== serialized) {
            state.serializedBytes = serialized;
            serialized = Buffer.byteLength(JSON.stringify(state), 'utf8');
        }
        if (serialized > manifestSerializedBudget) {
            throw new HttpError(413, 'manifest exceeds the serialized byte budget', 'manifest-size-budget');
        }
        await writeJsonAtomic(manifestStatePath(manifestId), state);
        json(response, 201, {
            manifestId,
            rootPath,
            rootName: state.rootName,
            entryCount: state.entries.length,
            totalBytes: state.totalBytes,
            skippedSymlinks: state.skippedSymlinks,
        });
    }
    async function handleManifestGet(request, response, manifestId, url) {
        const context = await sessionContext(request);
        const state = await loadManifest(context, manifestId);
        const rawCursor = Number(url.searchParams.get('cursor') ?? 0);
        const rawLimit = Number(url.searchParams.get('limit') ?? 100);
        const cursor = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
        const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(MAX_LIST_PAGE, rawLimit)) : 100;
        const entries = state.entries.slice(cursor, cursor + limit);
        json(response, 200, {
            manifestId,
            rootPath: state.rootPath,
            rootName: state.rootName,
            entries,
            nextCursor: cursor + entries.length < state.entries.length ? cursor + entries.length : null,
            entryCount: state.entries.length,
            totalBytes: state.totalBytes,
            skippedSymlinks: state.skippedSymlinks,
        });
    }
    async function handleManifestDelete(request, response, manifestId) {
        const context = await sessionContext(request);
        await loadManifest(context, manifestId);
        await rm(manifestStatePath(manifestId), { force: true });
        response.writeHead(204);
        response.end();
    }
    function transferPublic(state) {
        return {
            transferId: state.transferId,
            direction: state.direction,
            status: state.status,
            size: state.size,
            confirmedOffset: state.confirmedOffset,
            chunkBytes,
            maxFileBytes,
            ...(state.sha256 !== undefined ? { sha256: state.sha256 } : {}),
            ...(state.sourcePath !== undefined ? { sourcePath: state.sourcePath } : {}),
            ...(state.destinationPath !== undefined ? { destinationPath: state.destinationPath } : {}),
            ...(state.direction === 'upload' && state.destinationPath !== undefined ? { path: state.destinationPath } : {}),
            updatedAt: state.updatedAt,
        };
    }
    function conflictPolicy(value) {
        if (value === 'overwrite' || value === 'keep-both' || value === 'skip' || value === 'error')
            return value;
        return 'error';
    }
    async function handleTransferCreate(request, response) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        const direction = stringField(body, 'direction');
        const transferId = randomUUID().replaceAll('-', '');
        const timestamp = now();
        if (direction === 'upload') {
            const destinationDirectory = await realpath(absolutePath(stringField(body, 'destinationDirectory')));
            const directoryInfo = await lstat(destinationDirectory);
            if (!directoryInfo.isDirectory())
                throw new HttpError(400, 'destination is not a directory', 'invalid-type');
            const requestedFileName = safeLeafName(stringField(body, 'fileName'));
            const size = numberField(body, 'size');
            if (size > maxFileBytes)
                throw new HttpError(413, 'file exceeds the 1 GiB limit', 'file-too-large');
            const policy = conflictPolicy(body.conflictPolicy);
            const requestedPath = join(destinationDirectory, requestedFileName);
            const partialDirectory = join(destinationDirectory, '.dsh-transfer-partials');
            await ensureDirectoryNoSymlink(partialDirectory);
            const partialPath = join(partialDirectory, `${transferId}.part`);
            await writeFile(partialPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
            const state = {
                version: 1,
                transferId,
                sessionId: context.sessionId,
                direction: 'upload',
                status: 'ready',
                createdAt: timestamp,
                updatedAt: timestamp,
                size,
                confirmedOffset: 0,
                destinationDirectory,
                requestedFileName,
                partialPath,
                conflictPolicy: policy,
            };
            await saveTransfer(state);
            json(response, 201, transferPublic(state));
            return;
        }
        if (direction === 'download') {
            const sourcePath = await realpath(absolutePath(stringField(body, 'sourcePath')));
            const info = await lstat(sourcePath);
            if (!info.isFile() || info.isSymbolicLink())
                throw new HttpError(400, 'source is not a regular file', 'invalid-type');
            if (info.size > maxFileBytes)
                throw new HttpError(413, 'file exceeds the 1 GiB limit', 'file-too-large');
            const digest = await hashFile(sourcePath);
            const state = {
                version: 1,
                transferId,
                sessionId: context.sessionId,
                direction: 'download',
                status: 'ready',
                createdAt: timestamp,
                updatedAt: timestamp,
                size: info.size,
                confirmedOffset: 0,
                sha256: digest,
                sourcePath,
                fingerprint: fingerprint(info),
            };
            await saveTransfer(state);
            json(response, 201, transferPublic(state));
            return;
        }
        throw new HttpError(400, 'direction must be upload or download', 'invalid-request');
    }
    async function readChunk(request) {
        const chunks = [];
        let total = 0;
        for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.length;
            if (total > chunkBytes)
                throw new HttpError(413, 'chunk exceeds the negotiated limit', 'chunk-too-large');
            chunks.push(bytes);
        }
        return Buffer.concat(chunks, total);
    }
    async function handleTransferPatch(request, response, transferId) {
        const context = await sessionContext(request);
        await withLock(`transfer:${transferId}`, async () => {
            const state = await loadTransfer(context, transferId);
            if (state.direction !== 'upload' || state.partialPath === undefined) {
                throw new HttpError(405, 'transfer does not accept upload chunks', 'wrong-direction');
            }
            if (state.status === 'cancelled' || state.status === 'completed' || state.status === 'skipped') {
                throw new HttpError(409, 'transfer is no longer writable', 'transfer-closed');
            }
            const offsetHeader = normalizeHeader(request.headers['upload-offset']);
            const offset = Number(offsetHeader);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset !== state.confirmedOffset) {
                throw new HttpError(409, 'upload offset does not match the confirmed offset', 'offset-mismatch');
            }
            const chunk = await readChunk(request);
            if (offset + chunk.length > state.size)
                throw new HttpError(413, 'chunk exceeds declared file size', 'size-mismatch');
            const expected = normalizeHeader(request.headers['x-chunk-sha256']);
            if (expected === undefined || !SHA256.test(expected) || sha256Buffer(chunk) !== expected.toLowerCase()) {
                throw new HttpError(400, 'chunk sha256 mismatch', 'chunk-corrupt');
            }
            const nextOffset = offset + chunk.length;
            await withOpenPartial(state.partialPath, async (handle) => {
                const info = await handle.stat();
                if (info.size !== offset)
                    throw new HttpError(409, 'partial file offset changed', 'offset-mismatch');
                const written = await handle.write(chunk, 0, chunk.length, offset);
                if (written.bytesWritten !== chunk.length) {
                    throw new HttpError(500, 'partial file write was incomplete', 'io-error');
                }
                await handle.sync();
                const finalInfo = await handle.stat();
                if (finalInfo.size !== nextOffset) {
                    throw new HttpError(409, 'partial file offset changed during write', 'offset-mismatch');
                }
                return finalInfo;
            }, options.beforePartialOperation, 'patch-before-write');
            state.confirmedOffset = nextOffset;
            state.status = 'transferring';
            await saveTransfer(state);
            json(response, 200, transferPublic(state));
        });
    }
    function sha256Buffer(value) {
        return createHash('sha256').update(value).digest('hex');
    }
    async function recoverInstalledUpload(state) {
        if (state.destinationPath === undefined || state.sha256 === undefined || state.destinationDirectory === undefined)
            return false;
        if (!SHA256.test(state.sha256))
            throw new HttpError(409, 'upload digest metadata is invalid', 'transfer-corrupt');
        if (pathComparisonValue(dirname(state.destinationPath)) !== pathComparisonValue(state.destinationDirectory)) {
            throw new HttpError(409, 'upload destination path is invalid', 'unsafe-path');
        }
        if (state.backupPath !== undefined && (pathComparisonValue(dirname(state.backupPath)) !== pathComparisonValue(dirname(state.destinationPath)) ||
            !basename(state.backupPath).startsWith('.dsh-replace-') || !basename(state.backupPath).endsWith('.bak'))) {
            throw new HttpError(409, 'upload backup path is invalid', 'unsafe-path');
        }
        let partialPresent = false;
        if (state.partialPath !== undefined) {
            try {
                const partialInfo = await lstat(state.partialPath);
                partialPresent = partialInfo.isFile() && !partialInfo.isSymbolicLink();
            }
            catch (error) {
                if (errorCode(error) !== 'ENOENT')
                    throw error;
            }
        }
        let info;
        try {
            info = await lstat(state.destinationPath);
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT')
                return false;
            throw error;
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size !== state.size) {
            if (partialPresent)
                return false;
            throw new HttpError(409, 'completed upload destination changed', 'target-changed');
        }
        const digest = await hashFile(state.destinationPath);
        if (digest !== state.sha256) {
            if (partialPresent)
                return false;
            throw new HttpError(409, 'completed upload destination changed', 'target-changed');
        }
        if (state.partialPath !== undefined)
            await rm(state.partialPath, { force: true });
        if (state.backupPath !== undefined)
            await rm(state.backupPath, { force: true });
        state.status = 'completed';
        state.confirmedOffset = state.size;
        await saveTransfer(state);
        return true;
    }
    async function moveNoReplace(sourcePath, destinationPath) {
        await ensureDirectoryNoSymlink(dirname(destinationPath), false);
        try {
            await link(sourcePath, destinationPath);
        }
        catch (error) {
            if (errorCode(error) === 'EEXIST') {
                throw new HttpError(409, 'destination already exists', 'name-conflict');
            }
            throw error;
        }
        try {
            await rm(sourcePath, { force: false });
        }
        catch (error) {
            throw new HttpError(500, 'uploaded file was installed but its partial could not be removed', 'partial-delete');
        }
    }
    async function installUploadedFile(state) {
        const requestedPath = join(state.destinationDirectory, state.requestedFileName);
        const policy = state.conflictPolicy ?? 'error';
        let destinationPath = requestedPath;
        const exists = await pathExists(requestedPath);
        if (exists && policy === 'skip')
            return { path: requestedPath, skipped: true };
        if (exists && policy === 'error')
            throw new HttpError(409, 'destination already exists', 'name-conflict');
        if (exists && policy === 'keep-both') {
            while (true) {
                destinationPath = await keepBothPath(requestedPath, pathExists);
                state.destinationPath = destinationPath;
                await saveTransfer(state);
                try {
                    await moveNoReplace(state.partialPath, destinationPath);
                    return { path: destinationPath, skipped: false };
                }
                catch (error) {
                    if (!(error instanceof HttpError) || error.reasonCode !== 'name-conflict')
                        throw error;
                }
            }
        }
        if (exists && policy === 'overwrite') {
            const existing = await lstat(requestedPath);
            if (!existing.isFile() || existing.isSymbolicLink()) {
                throw new HttpError(409, 'only regular files can be overwritten', 'invalid-type');
            }
            const backupPath = join(dirname(requestedPath), `.dsh-replace-${randomUUID()}.bak`);
            state.backupPath = backupPath;
            state.destinationPath = requestedPath;
            await saveTransfer(state);
            await rename(requestedPath, backupPath);
            try {
                await moveNoReplace(state.partialPath, requestedPath);
                await rm(backupPath, { force: true });
                state.backupPath = undefined;
            }
            catch (error) {
                if (await pathExists(backupPath) && !await pathExists(requestedPath)) {
                    await rename(backupPath, requestedPath).catch(() => undefined);
                }
                throw error;
            }
            return { path: requestedPath, skipped: false };
        }
        const staleBackupPath = state.backupPath;
        state.destinationPath = destinationPath;
        await saveTransfer(state);
        await moveNoReplace(state.partialPath, destinationPath);
        if (staleBackupPath !== undefined)
            await rm(staleBackupPath, { force: true });
        state.backupPath = undefined;
        return { path: destinationPath, skipped: false };
    }
    async function handleTransferCommit(request, response, transferId) {
        const context = await sessionContext(request);
        const body = await readJson(request);
        await withLock(`transfer:${transferId}`, async () => {
            const state = await loadTransfer(context, transferId);
            const expectedSha = stringField(body, 'sha256', false)?.toLowerCase();
            if (expectedSha !== undefined && !SHA256.test(expectedSha)) {
                throw new HttpError(400, 'sha256 must be a 64-character hex digest', 'invalid-sha256');
            }
            if (state.status === 'completed' || state.status === 'skipped') {
                if (expectedSha !== undefined && state.sha256 !== undefined && expectedSha !== state.sha256.toLowerCase()) {
                    throw new HttpError(400, 'final sha256 mismatch', 'file-corrupt');
                }
                json(response, 200, transferPublic(state));
                return;
            }
            if (state.status === 'cancelled') {
                throw new HttpError(409, 'transfer has been cancelled', 'transfer-closed');
            }
            if (state.direction === 'upload') {
                if (await recoverInstalledUpload(state)) {
                    json(response, 200, transferPublic(state));
                    return;
                }
                if (state.partialPath === undefined)
                    throw new HttpError(409, 'upload partial is missing', 'transfer-corrupt');
                let info;
                try {
                    info = await lstat(state.partialPath);
                }
                catch (error) {
                    if (errorCode(error) === 'ENOENT')
                        throw new HttpError(409, 'upload partial is missing', 'transfer-corrupt');
                    throw error;
                }
                if (!info.isFile() || info.isSymbolicLink()) {
                    throw new HttpError(409, 'upload partial is not a regular file', 'unsafe-path');
                }
                if (info.size !== state.size || state.confirmedOffset !== state.size) {
                    throw new HttpError(409, 'upload is incomplete', 'upload-incomplete');
                }
                const digest = await hashFile(state.partialPath);
                if (expectedSha !== undefined && digest !== expectedSha) {
                    throw new HttpError(400, 'final sha256 mismatch', 'file-corrupt');
                }
                state.sha256 = digest;
                await saveTransfer(state);
                const destinationKey = pathComparisonValue(resolve(join(state.destinationDirectory, state.requestedFileName)));
                const installed = await withLock(`destination:${destinationKey}`, () => installUploadedFile(state));
                if (installed.skipped)
                    await rm(state.partialPath, { force: true });
                state.destinationPath = installed.path;
                state.sha256 = digest;
                state.status = installed.skipped ? 'skipped' : 'completed';
                state.confirmedOffset = state.size;
                await saveTransfer(state);
                json(response, 200, transferPublic(state));
                return;
            }
            if (state.direction === 'download') {
                const clientBytes = body.bytes;
                if (typeof clientBytes !== 'number' || !Number.isSafeInteger(clientBytes) || clientBytes !== state.size) {
                    throw new HttpError(409, 'download byte count does not match', 'size-mismatch');
                }
                if (expectedSha === undefined || expectedSha !== state.sha256) {
                    throw new HttpError(400, 'download sha256 mismatch', 'file-corrupt');
                }
                await assertDownloadSourceUnchanged(state);
                state.status = 'completed';
                state.confirmedOffset = state.size;
                await saveTransfer(state);
                json(response, 200, transferPublic(state));
                return;
            }
        });
    }
    async function assertDownloadSourceUnchanged(state) {
        if (state.sourcePath === undefined || state.fingerprint === undefined) {
            throw new HttpError(409, 'download source metadata is missing', 'transfer-corrupt');
        }
        const current = fingerprint(await lstat(state.sourcePath));
        if (!sameFingerprint(current, state.fingerprint))
            throw new HttpError(409, 'download source changed', 'source-changed');
    }
    async function handleTransferContent(request, response, transferId) {
        const context = await sessionContext(request);
        const state = await loadTransfer(context, transferId);
        if (state.direction !== 'download' || state.sourcePath === undefined) {
            throw new HttpError(405, 'transfer does not provide downloadable content', 'wrong-direction');
        }
        await assertDownloadSourceUnchanged(state);
        if (state.size === 0) {
            response.writeHead(200, { 'content-length': '0', etag: `"sha256-${state.sha256}"`, 'cache-control': 'no-store' });
            response.end();
            return;
        }
        const range = parseRange(normalizeHeader(request.headers.range), state.size);
        const start = range?.start ?? 0;
        const end = range?.end ?? state.size - 1;
        response.writeHead(range === null ? 200 : 206, {
            'content-type': 'application/octet-stream',
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
            ...(range === null ? {} : { 'content-range': `bytes ${start}-${end}/${state.size}` }),
            etag: `"sha256-${state.sha256}"`,
            'cache-control': 'no-store',
        });
        await pipeline(createReadStream(state.sourcePath, { start, end }), response);
    }
    async function handleTransferDelete(request, response, transferId) {
        const context = await sessionContext(request);
        await withLock(`transfer:${transferId}`, async () => {
            const state = await loadTransfer(context, transferId);
            if (state.status !== 'completed' && state.status !== 'skipped' && state.partialPath !== undefined) {
                await rm(state.partialPath, { force: true });
            }
            state.status = 'cancelled';
            await saveTransfer(state);
            response.writeHead(204);
            response.end();
        });
    }
    async function dispatch(request, response, url) {
        const path = url.pathname.replace(/\/$/u, '') || '/';
        const prefix = '/api/file-browser/v1';
        if (path === `${prefix}/describe`) {
            if (request.method !== 'GET')
                throw new HttpError(405, 'method not allowed');
            await handleDescribe(request, response);
            return;
        }
        const simplePost = new Map([
            [`${prefix}/list`, handleList],
            [`${prefix}/stat`, handleStat],
            [`${prefix}/mkdir`, handleMkdir],
            [`${prefix}/rename`, handleRename],
            [`${prefix}/delete/prepare`, handleDeletePrepare],
            [`${prefix}/delete/commit`, handleDeleteCommit],
        ]);
        const simple = simplePost.get(path);
        if (simple !== undefined) {
            if (request.method !== 'POST')
                throw new HttpError(405, 'method not allowed');
            await simple(request, response);
            return;
        }
        if (path === `${prefix}/manifests`) {
            if (request.method !== 'POST')
                throw new HttpError(405, 'method not allowed');
            await handleManifestCreate(request, response);
            return;
        }
        if (path.startsWith(`${prefix}/manifests/`)) {
            const manifestId = decodeURIComponent(path.slice(`${prefix}/manifests/`.length));
            if (request.method === 'GET')
                await handleManifestGet(request, response, manifestId, url);
            else if (request.method === 'DELETE')
                await handleManifestDelete(request, response, manifestId);
            else
                throw new HttpError(405, 'method not allowed');
            return;
        }
        if (path === `${prefix}/transfers`) {
            if (request.method !== 'POST')
                throw new HttpError(405, 'method not allowed');
            await handleTransferCreate(request, response);
            return;
        }
        if (path.startsWith(`${prefix}/transfers/`)) {
            const tail = path.slice(`${prefix}/transfers/`.length).split('/').filter(Boolean);
            const transferId = decodeURIComponent(tail[0] ?? '');
            if (tail.length === 1) {
                if (request.method === 'GET') {
                    const context = await sessionContext(request);
                    json(response, 200, transferPublic(await loadTransfer(context, transferId)));
                }
                else if (request.method === 'PATCH')
                    await handleTransferPatch(request, response, transferId);
                else if (request.method === 'DELETE')
                    await handleTransferDelete(request, response, transferId);
                else
                    throw new HttpError(405, 'method not allowed');
                return;
            }
            if (tail.length === 2 && tail[1] === 'content') {
                if (request.method !== 'GET')
                    throw new HttpError(405, 'method not allowed');
                await handleTransferContent(request, response, transferId);
                return;
            }
            if (tail.length === 2 && tail[1] === 'commit') {
                if (request.method !== 'POST')
                    throw new HttpError(405, 'method not allowed');
                await handleTransferCommit(request, response, transferId);
                return;
            }
        }
        throw new HttpError(404, 'not found', 'not-found');
    }
    return async function fileBrowserHandler(request, response) {
        try {
            if (!isLoopbackRequest(request))
                throw new HttpError(403, 'loopback only', 'loopback-only');
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (!url.pathname.startsWith('/api/file-browser/v1'))
                throw new HttpError(404, 'not found', 'not-found');
            await lazySweep();
            await dispatch(request, response, url);
        }
        catch (error) {
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            const failure = errorStatus(error);
            json(response, failure.statusCode, {
                error: failure.message,
                ...(failure.reasonCode === undefined ? {} : { reasonCode: failure.reasonCode }),
            });
        }
    };
}
