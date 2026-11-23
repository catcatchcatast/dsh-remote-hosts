/**
 * HTTP Range interpretation, with no I/O so it is testable on its own.
 *
 * One range only: a media element seeking asks for one window, and a
 * multi-range answer (multipart/byteranges) would cost more code than the
 * behavior is worth. A header this module cannot satisfy comes back as
 * "unsatisfiable" and the route answers 416 with the current size.
 *
 * @module dsh-preview-media/range
 */

/**
 * @typedef {{ start: number, end: number }} ByteWindow - inclusive byte window.
 * @typedef {{ kind: 'absent' } | { kind: 'window', window: ByteWindow } | { kind: 'unsatisfiable' }} RangeAnswer
 */

/**
 * Interpret one request's Range header against the current file size.
 * @param header - the raw Range header, when present.
 * @param size - complete file size in bytes.
 * @returns what the route should send.
 */
export function resolveRange(header, size) {
  if (typeof header !== "string" || header.trim() === "") return { kind: "absent" };
  const total = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (match === null) return { kind: "unsatisfiable" };
  const spec = match[1].trim();
  // A comma means multiple windows; one window per response is the contract.
  if (spec.includes(",")) return { kind: "unsatisfiable" };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (parts === null) return { kind: "unsatisfiable" };
  const [, rawStart, rawEnd] = parts;
  const hasStart = rawStart !== "";
  const hasEnd = rawEnd !== "";

  if (!hasStart && !hasEnd) return { kind: "unsatisfiable" };

  if (!hasStart) {
    // bytes=-N asks for the final N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "unsatisfiable" };
    if (total === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, total - suffixLength);
    return { kind: "window", window: { start, end: total - 1 } };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: "unsatisfiable" };
  if (total === 0 || start >= total) return { kind: "unsatisfiable" };
  if (!hasEnd) return { kind: "window", window: { start, end: total - 1 } };

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "unsatisfiable" };
  return { kind: "window", window: { start, end: Math.min(end, total - 1) } };
}

/**
 * Byte count of a window, end included.
 * @param window - inclusive window.
 * @returns its length in bytes.
 */
export function windowLength(window) {
  return window.end - window.start + 1;
}

/**
 * The Content-Range value for a window.
 * @param window - inclusive window.
 * @param size - complete file size.
 * @returns the header value.
 */
export function contentRange(window, size) {
  return `bytes ${window.start}-${window.end}/${size}`;
}

/**
 * Split one window into chunk windows no larger than `chunkBytes`.
 * @param window - inclusive window.
 * @param chunkBytes - largest chunk.
 * @returns windows in ascending order covering exactly the input.
 */
export function splitWindow(window, chunkBytes) {
  const size = Math.max(1, Math.floor(chunkBytes));
  const chunks = [];
  for (let start = window.start; start <= window.end; start += size) {
    chunks.push({ start, end: Math.min(start + size - 1, window.end) });
  }
  return chunks;
}
