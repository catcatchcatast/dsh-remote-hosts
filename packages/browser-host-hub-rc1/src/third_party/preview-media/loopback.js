// Public change history: docs/PUBLIC-CHANGES.md
/**
 * A loopback HTTP origin that streams media with real HTTP Range semantics.
 *
 * Why this exists: the DSH desktop shell serves the page from `dsh-app://app`
 * and proxies every other path through `protocol.handle`. Chromium's media
 * stack cannot seek a response produced by a custom-protocol handler (it reports
 * `video.seekable` as `[0, 0]`), so dragging the timeline in the desktop app
 * jumps straight back to the start. A normal `http://127.0.0.1` origin has no
 * such limitation, so the browser half asks the Host for this origin and points
 * the player at it directly.
 *
 * The listener is bound to 127.0.0.1 only and every request must carry the
 * per-boot capability token in its path; a request without it gets a bare 404,
 * so another local process cannot use this socket to read files. Bytes still go
 * through the composed `fs` provider, so the deployment's filesystem policy
 * applies exactly as it does on the authenticated `/api` route.
 *
 * @module dsh-preview-media/loopback
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mediaTypeOf } from "./mime.js";
import { contentRange, resolveRange, splitWindow, windowLength } from "./range.js";

/** Path prefix; the token is appended so the URL is unguessable. */
const PREFIX = "/media";

/** Bytes of entropy in one capability token. */
const TOKEN_BYTES = 24;

/** Headers shared by every answer. */
const BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "cross-origin"
  ,"Access-Control-Allow-Origin": "*"
};

/**
 * Start one loopback media server.
 * @param options - filesystem provider, resolved config, optional fixed token.
 * @returns an object with `listen()`, `close()`, `origin` and `token`.
 */
export function createLoopbackServer(options) {
  const token = typeof options.token === "string" ? options.token : randomBytes(TOKEN_BYTES).toString("base64url");
  const state = { token, origin: undefined };
  const server = createServer((request, response) => {
    Promise.resolve().then(async () => {
      if (await options.handle?.(request, response, token)) return;
      await serve(request, response, { ...options, token });
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      plain(response, statusOf(error), error && typeof error.code === "string" ? error.code : "read failed");
    });
  });
  server.keepAliveTimeout = 5_000;

  return {
    get token() {
      return state.token;
    },
    get origin() {
      return state.origin;
    },
    /**
     * Bind an ephemeral port on the loopback interface.
     * @returns the `http://127.0.0.1:<port>` origin.
     */
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      state.origin = `http://127.0.0.1:${address.port}`;
      return state.origin;
    },
    /** Stop accepting connections and close the listener. */
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  };
}

/**
 * Answer one loopback request.
 * @param request - node request.
 * @param response - node response.
 * @param options - fs provider, config, the capability token and an optional logger.
 */
async function serve(request, response, options) {
  const { fs, config, token } = options;
  const log = typeof options.log === "function" ? options.log : () => {};
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // No token, no answer: an unauthorised caller learns nothing here.
  if (url.pathname !== `${PREFIX}/${token}`) {
    plain(response, 404, "not found");
    return;
  }
  const method = request.method === "HEAD" ? "HEAD" : request.method === "GET" ? "GET" : undefined;
  if (method === undefined) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const path = url.searchParams.get("path");
  log("loopback-request", { method, range: request.headers.range ?? null, path });
  if (path === null || path === "" || path.includes("\0") || !isAbsolutePath(path)) {
    plain(response, 400, "absolute path required");
    return;
  }

  const abort = new AbortController();
  response.on("close", () => abort.abort());

  const target = await fs.resolve(path, { signal: abort.signal });
  const info = await fs.stat(target, abort.signal);
  if (info === undefined) {
    plain(response, 404, "not found");
    return;
  }
  if (info.type !== "file") {
    plain(response, 403, "not a regular file");
    return;
  }
  const size = typeof info.size === "number" ? info.size : 0;
  if (size > config.maxBytes) {
    plain(response, 413, "file exceeds the configured byte limit");
    return;
  }
  if (size === 0) {
    response.writeHead(416, { ...BASE_HEADERS, "Content-Range": "bytes */0" }).end();
    return;
  }

  const range = resolveRange(request.headers.range, size);
  if (range.kind === "unsatisfiable") {
    response.writeHead(416, { ...BASE_HEADERS, "Content-Range": `bytes */${size}` }).end();
    return;
  }
  const window = range.kind === "window" ? range.window : { start: 0, end: size - 1 };
  const headers = {
    ...BASE_HEADERS,
    "Accept-Ranges": "bytes",
    "Content-Type": mediaTypeOf(path),
    "Content-Length": String(windowLength(window))
  };
  if (range.kind === "window") headers["Content-Range"] = contentRange(window, size);
  response.writeHead(range.kind === "window" ? 206 : 200, headers);
  log("loopback-response", {
    status: range.kind === "window" ? 206 : 200,
    window,
    size,
    length: windowLength(window)
  });
  if (method === "HEAD") {
    response.end();
    return;
  }

  for (const chunk of splitWindow(window, config.chunkBytes)) {
    if (abort.signal.aborted) return;
    const bytes = await fs.readByteRange(
      target,
      { offset: chunk.start, length: windowLength(chunk) },
      abort.signal
    );
    if (abort.signal.aborted) return;
    if (bytes.byteLength === 0) break;
    if (!response.write(bytes)) await drain(response);
  }
  response.end();
}

/**
 * Wait until the socket drains, or until the peer goes away.
 * @param response - node response under backpressure.
 */
function drain(response) {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

/**
 * One small text answer.
 * @param response - node response.
 * @param status - HTTP status.
 * @param message - body text.
 */
function plain(response, status, message) {
  response.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" }).end(message);
}

/**
 * Map a filesystem failure onto an HTTP status.
 * @param error - whatever the provider threw.
 * @returns the status the client should see.
 */
function statusOf(error) {
  const code = error !== null && typeof error === "object" ? error.code : undefined;
  switch (code) {
    case "FS_NOT_FOUND":
      return 404;
    case "FS_NOT_REGULAR_FILE":
    case "FS_PERMISSION_DENIED":
    case "FS_SANDBOX_DENIED":
      return 403;
    case "FS_TOO_LARGE":
      return 413;
    case "FS_ABORTED":
      return 499;
    default:
      return 500;
  }
}

/** Absolute in either spelling the Host accepts. */
function isAbsolutePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
}

/** The URL path a client must use for one capability token. */
export function loopbackPath(token) {
  return `${PREFIX}/${token}`;
}
