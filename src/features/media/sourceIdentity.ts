/**
 * Media source identity helpers for QuipClip.
 *
 * Computes canonical identity tokens used across the preview layer, playback store,
 * and ref-ownership bindings to detect source changes and guard against stale events.
 */

/**
 * Minimal media descriptor required to construct a unique source identity token.
 */
export interface MediaSourceDescriptor {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Computes a unique source identity string based on canonical path, file size, and modification time.
 * If media is reimported at the same path after modification (size or mtime changed), the identity token changes.
 *
 * @param media Media descriptor or null if no media is loaded.
 * @returns Canonical identity token string, or empty string when media is null.
 */
export function getMediaSourceIdentity(
  media: MediaSourceDescriptor | null | undefined,
): string {
  if (!media || typeof media.path !== "string") {
    return "";
  }
  return `${media.path}:${media.size}:${media.mtime}`;
}
