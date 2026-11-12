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

/**
 * Reports whether two revision descriptors name the same revision of the same file.
 *
 * The comparison is the canonical revision key itself, so "same source" has exactly one
 * definition across the generated source ID, the export-time replacement check, and the
 * architecture document. An unavailable descriptor on either side is never "the same": an
 * empty key states that nothing is known, not that the two agree.
 */
export function isSameSourceRevision(
  expected: MediaSourceRevisionDescriptor | null | undefined,
  actual: MediaSourceRevisionDescriptor | null | undefined,
): boolean {
  const expectedKey = getSourceRevisionKey(expected);
  return expectedKey !== "" && expectedKey === getSourceRevisionKey(actual);
}

/**
 * Reports whether the file that `actual` describes can still hold the revision `expected`: the
 * same revision, or, for an FLV, a file that a recorder still writes (ADR 058). Such a file has
 * the same path, at least as many bytes, and a modification time that is not earlier. The
 * backend reads only the first `size` bytes of an FLV and compares a fingerprint of them, so it
 * decides. Another container must be the same revision.
 *
 * This is not the identity of a source: a grown file opened again is a new revision, and
 * `isSameSourceRevision` stays the one definition of "the same source".
 */
export function mayHoldSourceRevision(
  expected: MediaSourceRevisionDescriptor | null | undefined,
  actual: MediaSourceRevisionDescriptor | null | undefined,
  isFlv: boolean,
): boolean {
  if (isSameSourceRevision(expected, actual)) {
    return true;
  }
  return (
    isFlv &&
    !!expected &&
    !!actual &&
    getSourceRevisionKey(expected) !== "" &&
    expected.path === actual.path &&
    actual.size >= expected.size &&
    actual.mtime >= expected.mtime
  );
}

/**
 * Session-scoped generated source IDs, keyed by the FULL revision key.
 *
 * Keyed by the revision key and not by the path, deliberately. A stale entry keyed by path
 * handed a re-opened, re-encoded file the ID its old segments carry, so those segments still
 * matched the active source and the next export cut them from frames they no longer name. A
 * changed file is therefore a new source here, and its marks stop belonging to the active
 * source: they stay in the project array (ADR 007 forbids erasing them), and the timeline
 * renders empty. A touch, a copy to another disk, or a restore from a backup change the key
 * without changing a byte and strand the marks the same way.
 *
 * It is a map and not a one-slot memo, so opening A, then B, then A again restores A's ID.
 */
const generatedSourceIdsByRevisionKey = new Map<string, string>();

/**
 * Returns the generated source ID for one revision of one file, creating it on first sight.
 *
 * @param media Media revision descriptor or null/undefined.
 * @returns The ID held for that revision, or null when no media is available.
 */
export function getGeneratedSourceId(
  media: MediaSourceRevisionDescriptor | null | undefined,
): string | null {
  const revisionKey = getSourceRevisionKey(media);
  if (revisionKey === "") {
    return null;
  }
  const existing = generatedSourceIdsByRevisionKey.get(revisionKey);
  if (existing) {
    return existing;
  }
  const generated = generateSourceId();
  generatedSourceIdsByRevisionKey.set(revisionKey, generated);
  return generated;
}
