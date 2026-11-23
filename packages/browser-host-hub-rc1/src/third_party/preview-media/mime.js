/**
 * Media types for the suffixes the player handles. A short table beats a
 * dependency: the route only ever serves bytes a browser media element reads,
 * and everything else keeps the generic octet-stream type.
 *
 * @module dsh-preview-media/mime
 */

/** Lowercase suffix (no dot) to media type. */
const TYPES = new Map([
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["ogv", "video/ogg"],
  ["ogg", "video/ogg"],
  ["mkv", "video/x-matroska"],
  ["avi", "video/x-msvideo"],
  ["wmv", "video/x-ms-wmv"],
  ["flv", "video/x-flv"],
  ["3gp", "video/3gpp"],
  ["ts", "video/mp2t"],
  ["m2ts", "video/mp2t"],
  ["mts", "video/mp2t"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["weba", "audio/webm"],
  ["wma", "audio/x-ms-wma"],
  ["aiff", "audio/aiff"],
  ["aif", "audio/aiff"]
]);

/**
 * Read a path's final suffix.
 * @param path - decoded file path in either separator spelling.
 * @returns the lowercase suffix without a dot, or the empty string.
 */
export function suffixOf(path) {
  if (typeof path !== "string") return "";
  const name = path.replaceAll("\\", "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The media type for one path.
 * @param path - decoded file path.
 * @returns the media type, or application/octet-stream when unknown.
 */
export function mediaTypeOf(path) {
  return TYPES.get(suffixOf(path)) ?? "application/octet-stream";
}

/**
 * Whether the suffix belongs to the video player.
 * @param path - decoded file path.
 * @param extensions - configured video suffixes.
 * @returns true for a configured video suffix.
 */
export function isVideoPath(path, extensions) {
  return extensions.includes(suffixOf(path));
}

/**
 * Whether the suffix belongs to the audio player.
 * @param path - decoded file path.
 * @param extensions - configured audio suffixes.
 * @returns true for a configured audio suffix.
 */
export function isAudioPath(path, extensions) {
  return extensions.includes(suffixOf(path));
}
