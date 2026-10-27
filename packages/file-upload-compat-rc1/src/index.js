// 公开打包追溯：docs/PUBLIC-CHANGES.md                                                                                                               
// dsh-file-upload — a dual-face DeepSeek Harness plugin: one cordis row, one
// apply, three capabilities:
//   1. Claude-style upload surface (webServer + web client): paperclip button
//      and drag-and-drop into the composer; files land per-session inside the
//      session workspace (.dsh-uploads/<sessionId>) where the agent's fs
//      backend can always resolve them; small text files are inlined straight
//      into the composer.
//   2. Content sniffing + document→Markdown conversion, fully bundled:
//      the markitdown-node engine (Microsoft MarkItDown TypeScript port,
//      20+ formats incl. image OCR) ships as a regular dependency — zero
//      downloads, zero Python, works offline out of the box; an official
//      MarkItDown CLI is used only when already present on the machine.
//   3. read_document tool (host): paged Markdown reading with a byte-budgeted
//      LRU conversion cache.
                                                                                                                                                   
                                                                                                                                                   
                                                                                                                                                   
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileUploadConfig as Config } from 'dsh-runtime-interface/file-upload';
export { Config };
import { describeImage } from "./vision.js";
import { defineReadDocumentTool, ParseCache } from "./tool.js";
import { createImageIntakePolicy, createUploadHandler, createSweeper, PARTIAL_TTL_MS } from "./upload.js";
import { createFileBrowserHandler } from "./file-browser.js";
import { probeMarkitdown } from "./convert.js";
const execFileAsync = promisify(execFile);
const execFileAsyncSafe = execFileAsync;
/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-file-upload';
/** Services required by this plugin. */
export const inject = ['fileUploadInterface'];
function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`dsh-file-upload: ${label} must be a positive integer`);
}
/**
 * Resolve an optional official MarkItDown CLI, in order:
 *   1. explicitly configured `markitdownBin`;
 *   2. a `markitdown` already on PATH.
 * The bundled markitdown-node engine is the always-available backend; the
 * CLI (when present on the machine) simply upgrades conversions further.
 */
async function resolveMarkitdownBin(configured) {
    if (configured !== '')
        return (await probeMarkitdown(configured)) ? configured : '';
    try {
        await execFileAsyncSafe('markitdown', ['--help'], { timeout: 10000 });
        return 'markitdown';
    }
    catch {
        return '';
    }
}
export function apply(ctx, config) {
    const runtimeInterface = ctx.fileUploadInterface;
    if (typeof runtimeInterface?.createInstallation !== 'function')
        throw new Error('dsh-file-upload: fileUploadInterface is unavailable');
    for (const [label, value] of [
        ['uploadMaxBytes', config.uploadMaxBytes],
        ['uploadTtlMs', config.uploadTtlMs],
        ['sweepIntervalMs', config.sweepIntervalMs],
        ['maxConcurrentUploads', config.maxConcurrentUploads],
        ['inlineTextLimit', config.inlineTextLimit],
        ['previewTextLimit', config.previewTextLimit],
        ['maxFileBytes', config.maxFileBytes],
        ['readLimit', config.readLimit],
        ['sheetRowLimit', config.sheetRowLimit],
        ['maxSheets', config.maxSheets],
        ['cacheEntries', config.cacheEntries],
        ['cacheMaxBytes', config.cacheMaxBytes],
        ['markitdownTimeoutMs', config.markitdownTimeoutMs],
        ['visionMaxBytes', config.visionMaxBytes]
    ]) {
        assertPositiveInteger(value, label);
    }
    const installation = runtimeInterface.createInstallation();
    const runtime = installation.port;
    try {
        if (typeof ctx.effect !== 'function') throw new Error('dsh-file-upload: plugin lifecycle is unavailable');
        ctx.effect(() => installation.release);
        const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes);
        // Shared mutable tool configuration: the MarkItDown probe below writes the
        // resolved binary back here, so read_document picks it up without a restart
        // even when the CLI was found on PATH (auto-detect mode).
        const toolConfig = {
            readLimit: config.readLimit,
            maxFileBytes: config.maxFileBytes,
            sheetRowLimit: config.sheetRowLimit,
            maxSheets: config.maxSheets,
            markitdownBin: config.markitdownBin,
            markitdownTimeoutMs: config.markitdownTimeoutMs
        };
        // MarkItDown probe is async; resolve lazily once at startup. The bundled
        // markitdown-node engine is always available (works out of the box, fully
        // packaged — no downloads, no Python); an official CLI already present on
        // the machine (config or PATH) upgrades conversions further.
        let markitdownReady = null;
        const markitdown = () => {
            markitdownReady ??= resolveMarkitdownBin(config.markitdownBin).then((bin) => {
                toolConfig.markitdownBin = bin;
                if (bin !== '') {
                    console.log(`[dsh-file-upload] MarkItDown CLI detected: ${bin} — official engine takes over conversions`);
                }
                else {
                    console.log('[dsh-file-upload] Document → Markdown ready: bundled MarkItDown engine (20+ formats, image OCR) — fully packaged, no downloads, no Python.');
                }
                return bin;
            });
            return markitdownReady;
        };
        runtime.systemPrompt.register({
            name: 'tool:read-document',
            order: 110,
            text: 'Files uploaded by the user live under .dsh-uploads/<sessionId>/ inside the workspace. Read them with the read_document tool, which converts PDF/DOCX/XLSX and text files to Markdown and pages through long documents with offset and limit. Prefer read_document over read for these files. For uploaded image files: if the official read_image tool is available (current model supports image input — including vision bridges like dsh-vision-proxy), use it to see the image directly; otherwise the image is a path reference the user can view, and you can still read it via read_document (bundled OCR).'
        });
        // Image description ("讲解图片"), zero-config discovery chain:
        // explicit endpoint → local Ollama (VL model) → OpenAI standard with a key
        // from the dsh credentials seam. Text-only routes get the description so
        // the text-only model can reason about the image.
    const resolveVisionKey = async () => {
            return runtime.resolveCredential(config.visionApiKeyEnv);
        };
        const vision = async (filePath, name) => {
            return describeImage(filePath, {
                endpoint: config.visionEndpoint,
                model: config.visionModel,
                apiKeyEnv: config.visionApiKeyEnv,
                resolveKey: resolveVisionKey,
                timeoutMs: 60000,
                maxBytes: config.visionMaxBytes
            });
        };
        // Detect whether a session's routed model accepts image input, so the
        // agent is told to use the official read_image tool (native) or OCR
        // (read_document). Mirrors the official read_image route gate.
        const resolveImageMode = async (sessionId) => {
            try {
                return (await runtime.imageCapabilities(sessionId)).modelAcceptsImages ? 'native' : 'ocr';
            }
            catch {
                return 'ocr';
            }
        };
        // Keep the browser's visual-image policy tied to the real attachment store
        // and the session's routed model. The service is optional so this plugin
        // still loads on older hosts; in that case the safe projection advertises
        // file upload but never claims native image support.
        const resolveImageIntake = async (sessionId) => {
            const capabilities = await runtime.imageCapabilities(sessionId);
            return createImageIntakePolicy(capabilities.modelAcceptsImages && capabilities.imageLimits !== undefined, capabilities.imageLimits);
        };
        runtime.tools.register(defineReadDocumentTool(runtime, toolConfig, cache));
        const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads');
        const sessionCwd = async (sessionId) => runtime.sessions.cwd(sessionId) ?? await runtime.sessions.persistedCwd(sessionId);
        runtime.routes.registerPrefix('/api/upload', createUploadHandler({
                maxBytes: config.uploadMaxBytes,
                allowedExtensions: config.allowedExtensions,
                ttlMs: config.uploadTtlMs,
                sweepIntervalMs: config.sweepIntervalMs,
                maxConcurrent: config.maxConcurrentUploads,
                inlineTextLimit: config.inlineTextLimit,
                previewTextLimit: config.previewTextLimit,
                maxFileBytes: config.maxFileBytes,
                partialTtlMs: PARTIAL_TTL_MS,
                defaultDir,
                imageMode: resolveImageMode,
                imageIntake: resolveImageIntake,
                vision,
                sessionCwd,
            }));
        runtime.routes.registerPrefix('/api/file-browser/v1', createFileBrowserHandler({
                defaultDir,
                sessionCwd,
            }));
        // Sweep every upload root: the fallback dir plus each live session's
        // workspace `.dsh-uploads` (session cwds resolved per sweep, so files under
        // session workspaces age out too — not just the no-session fallback root).
        runtime.registerEffect(() => createSweeper([
            defaultDir,
            async () => {
                return [...runtime.sessions.liveCwds(), ...await runtime.sessions.persistedCwds()];
            }
        ], PARTIAL_TTL_MS, config.sweepIntervalMs));
        // Kick the MarkItDown probe in the background so the first read_document
        // call does not pay the probe latency.
        void markitdown();
    }
    catch (error) {
        try {
            installation.release();
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'dsh-file-upload: installation failed and cleanup reported errors');
        }
        throw error;
    }
}
