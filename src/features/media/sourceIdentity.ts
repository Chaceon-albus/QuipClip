/**
 * Media source identity and revision helpers for QuipClip.
 *
 * See ADR 007 and ADR 010.
 * Separates stable project source IDs from machine-specific source revision keys based on
 * canonical path, file size, and modification timestamp.
 */

/**
 * Descriptor of media file revision attributes.
 */
export interface MediaSourceRevisionDescriptor {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Generates a stable source identifier within a project document (ADR 010).
 * Stable IDs do not depend on file path, size, or modification time.
 *
 * @param prefix Optional prefix for the generated identifier. Defaults to "s".
 */
export function generateSourceId(prefix = "s"): string {
  return `${prefix}${globalThis.crypto.randomUUID()}`;
}

/**
 * Computes a unique source revision key string based on path, size, and modification time (ADR 010).
 * Used to detect when a file has been replaced or modified on disk independently of its stable ID.
 *
 * @param media Media revision descriptor or null/undefined.
 * @returns Canonical revision key string, or empty string when media is unavailable.
 */
export function getSourceRevisionKey(
  media: MediaSourceRevisionDescriptor | null | undefined,
): string {
  if (!media || typeof media.path !== "string") {
    return "";
  }
  return `${media.path}:${media.size}:${media.mtime}`;
}
