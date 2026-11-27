/**
 * Shared project schema definitions and presentation timestamp (PTS) time representations for QuipClip.
 *
 * See ADR 002, ADR 003, ADR 007, and ADR 010.
 * Edit boundaries are stored as source video presentation timestamps (PTS) in canonical decimal string form.
 */

/**
 * The canonical schema version for .qcproj project files.
 * Stored in every project file (ADR 010).
 */
export const PROJECT_SCHEMA_VERSION = 1;

/**
 * Exact rational time representation matching the Rust `Rational` struct
 * and the `{ n: number; d: number }` wire format defined in ADR 002.
 * Used to avoid floating-point drift and boundary ambiguity in frame rates and timebases.
 */
export type Rational = {
  /** Numerator of the fraction. */
  n: number;
  /** Denominator of the fraction (must be non-zero and positive). */
  d: number;
};

/**
 * Branded presentation timestamp (PTS) string representation (ADR 002, ADR 010).
 * Stored as a canonical signed decimal string accepting the full signed i64 range.
 */
export type Pts = string & { readonly __brand: "Pts" };

/**
 * Branded tick count string representation (ADR 002, ADR 010).
 * Stored as a canonical non-negative decimal string accepting the non-negative i64 range.
 */
export type TickCount = string & { readonly __brand: "TickCount" };

/** Reported frame count as a canonical non-negative decimal i64 string. */
export type FrameCount = string & { readonly __brand: "FrameCount" };

/**
 * Output video dimensions in pixels.
 */
export type Resolution = {
  /** Canvas width in pixels. */
  w: number;
  /** Canvas height in pixels. */
  h: number;
};

/**
 * The most bytes in front of the size of a revision that the fingerprint of an FLV covers
 * (ADR 058). The Rust project module has the same bound.
 */
export const FINGERPRINT_MAX_LENGTH = 65_536;

/**
 * The text form of the fingerprint of an FLV in a project file (ADR 058, ADR 072): the FNV-1a hash
 * of the bytes from `start` to the size of the revision.
 */
export type SourceFingerprint = {
  /**
   * The offset of the first byte that the hash covers, as a canonical decimal string: digits
   * only, and no leading zero but `"0"` itself. It is smaller than the size of the revision, and
   * the size less `start` is `FINGERPRINT_MAX_LENGTH` at most.
   */
  start: string;
  /** The hash as exactly 16 lowercase hexadecimal digits. */
  fnv1a64: string;
};

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const FNV1A64_TEXT = /^[0-9a-f]{16}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * True when `value` is a fingerprint of the text form for a revision of `size` bytes, by the rule
 * of the Rust project module (ADR 072). The object has exactly the two fields. The values compare
 * as BigInt, so a start that a Number cannot hold is still compared exactly.
 */
export function isSourceFingerprint(
  value: unknown,
  size: number,
): value is SourceFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("start" in record) || !("fnv1a64" in record)) {
    return false;
  }
  const { start, fnv1a64 } = record;
  if (
    typeof start !== "string" ||
    !CANONICAL_DECIMAL.test(start) ||
    typeof fnv1a64 !== "string" ||
    !FNV1A64_TEXT.test(fnv1a64) ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return false;
  }
  const startValue = BigInt(start);
  const sizeValue = BigInt(size);
  return (
    startValue <= U64_MAX &&
    startValue < sizeValue &&
    sizeValue - startValue <= BigInt(FINGERPRINT_MAX_LENGTH)
  );
}

/**
 * Persisted media source entry stored in a .qcproj project file (ADR 002, ADR 007, ADR 010).
 * Holds durable source identity, file revision, and timing metadata without machine-specific
 * caches or proxy paths.
 */
export type PersistedSource = {
  /** Unique stable identifier for the source within the project (ADR 010). */
  id: string;
  /** Absolute path to the source media file on disk. */
  path: string;
  /**
   * The path of the source relative to the directory of the project file, with `/` between its
   * parts, or absent when the two paths have no common root (ADR 072). The backend writes it at
   * each save and ignores the value that the page sends.
   */
  relPath?: string;
  /** File size in bytes, used to verify file revision independently of path. */
  size: number;
  /** File modification timestamp (mtime), used to detect modified or replaced files. */
  mtime: number;
  /** Index of the probed video stream within the container. */
  videoStreamIndex: number;
  /** Rational time base of the video stream (seconds per tick). */
  videoTimeBase: Rational;
  /** Presentation timestamp of the initial presented frame, or null if unstated. */
  videoStartPts: Pts | null;
  /**
   * The PTS that follows the last presented frame, the end of the clip range, or null when the
   * probe could not read it (ADR 052).
   */
  videoEndPts: Pts | null;
  /** Reported stream duration in video time base ticks, or null if indeterminate. */
  videoDurationTicks: TickCount | null;
  /** Approximate duration in seconds for UI layout and seek estimates, or null if unavailable. */
  approximateDurationSeconds: number | null;
  /** Average frame rate as an exact rational, or null if unavailable. */
  avgFrameRate: Rational | null;
  /** Real / nominal container frame rate as an exact rational, or null if unavailable. */
  rFrameRate: Rational | null;
  /** Total reported frame count from stream metadata, or null if unstated. */
  reportedFrameCount: FrameCount | null;
  /**
   * The absolute index of the audio stream that the user chose for the source, or absent when the
   * source has no override and uses its preferred audio stream (ADR 070). The project file writes
   * the field only for a source with an override. The loader refuses `null` and a value that
   * `isValidAudioStreamIndex` refuses (`hasValidAudioStreamIndexField`).
   */
  audioStreamIndex?: number;
  /**
   * The fingerprint of an FLV that the import kept, or absent when it kept none (ADR 058, ADR
   * 072). The project file writes the field only for a source with one. The loader refuses `null`
   * and a value that `isSourceFingerprint` refuses.
   */
  fingerprint?: SourceFingerprint;
  /**
   * Proxies are machine-specific caches and must not be persisted to project files (ADR 010).
   */
  proxy?: never;
};

/** The largest absolute stream index: ffprobe reports it as a `u32`. */
const MAX_STREAM_INDEX = 4_294_967_295;

/**
 * True when `value` is an absolute audio stream index of the project file (ADR 070): an integer
 * from 0 to 4 294 967 295, as the Rust project module reads it.
 */
export function isValidAudioStreamIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_STREAM_INDEX
  );
}

/**
 * True when the persisted source `source` has no `audioStreamIndex` field, or one that holds a
 * valid index (ADR 070). A present `null` is refused, as for the name of a segment (ADR 065): only
 * an absent field means no override.
 */
export function hasValidAudioStreamIndexField(
  source: Readonly<Record<string, unknown>>,
): boolean {
  return (
    !("audioStreamIndex" in source) || isValidAudioStreamIndex(source.audioStreamIndex)
  );
}

/**
 * State of the background ffmpeg proxy generation for a source (ADR 003, ADR 007).
 */
export type SourceProxyState = "none" | "building" | "ready" | "failed";

/**
 * In-memory proxy information associated with a source (ADR 003, ADR 007).
 * Machine-specific and not persisted to .qcproj project files (ADR 010).
 */
export type SourceProxy = {
  /** Path to the generated proxy video file on disk. */
  path: string;
  /** Current state of the proxy media file. */
  state: SourceProxyState;
};

/**
 * In-memory runtime representation of an imported media source (ADR 007).
 * Extends persisted source metadata with transient runtime state such as proxy status (ADR 003).
 */
export type Source = {
  id: string;
  path: string;
  relPath: string;
  size: number;
  mtime: number;
  videoStreamIndex: number;
  videoTimeBase: Rational;
  videoStartPts: Pts | null;
  videoEndPts: Pts | null;
  videoDurationTicks: TickCount | null;
  approximateDurationSeconds: number | null;
  avgFrameRate: Rational | null;
  rFrameRate: Rational | null;
  reportedFrameCount: FrameCount | null;
  /** The audio stream override of the source (ADR 070), or absent for none. */
  audioStreamIndex?: number;
  /** The fingerprint of an FLV that the import kept (ADR 072), or absent for none. */
  fingerprint?: SourceFingerprint;
  /** Optional runtime proxy information for playback when native decoding is unavailable. */
  proxy?: SourceProxy;
};

/**
 * Explicit projection that constructs a new PersistedSource object by listing every persisted field.
 *
 * Does not use object spread and does not rely solely on `never` fields, guaranteeing that
 * runtime proxy paths, URLs, or other machine-specific caches never leak into persisted project documents.
 *
 * It writes no `relPath`: the backend writes that field at each save (ADR 072).
 *
 * See ADR 007, ADR 010 and ADR 072.
 */
export function toPersistedSource(source: Source): PersistedSource {
  const persisted: PersistedSource = {
    id: source.id,
    path: source.path,
    size: source.size,
    mtime: source.mtime,
    videoStreamIndex: source.videoStreamIndex,
    videoTimeBase: source.videoTimeBase,
    videoStartPts: source.videoStartPts,
    videoEndPts: source.videoEndPts,
    videoDurationTicks: source.videoDurationTicks,
    approximateDurationSeconds: source.approximateDurationSeconds,
    avgFrameRate: source.avgFrameRate,
    rFrameRate: source.rFrameRate,
    reportedFrameCount: source.reportedFrameCount,
  };
  // The file has the field only for a source with an override (ADR 070).
  if (source.audioStreamIndex !== undefined) {
    persisted.audioStreamIndex = source.audioStreamIndex;
  }
  // The file has the field only for a source with a fingerprint (ADR 072).
  if (source.fingerprint !== undefined) {
    persisted.fingerprint = {
      start: source.fingerprint.start,
      fnv1a64: source.fingerprint.fnv1a64,
    };
  }
  return persisted;
}

/**
 * An edit span marking a portion of a source media file to be included in the timeline.
 * Segments are half-open intervals [inPts, outPts) aligned to source video PTS (ADR 002, ADR 007).
 */
export type Segment = {
  /** Unique identifier for the segment. */
  id: string;
  /** Identifier of the source media clip this segment belongs to. */
  sourceId: string;
  /** Inclusive start presentation timestamp in source video time base (ADR 002). */
  inPts: Pts;
  /**
   * Exclusive end presentation timestamp in source video time base (ADR 002).
   * outPts is the PTS of the first excluded presented frame.
   */
  outPts: Pts;
  /**
   * The name of the segment, or absent for a segment with no name (ADR 065). A name is valid by
   * `isValidSegmentName`: 1 to 80 Unicode scalar values, no `White_Space` character at either
   * end, no control character, no U+2028 or U+2029, and no lone surrogate.
   */
  name?: string;
};

/**
 * One placement of a source on the sequence (ADR 052).
 * The array order of the clips is the sequence order. A clip stores no sequence time.
 */
export type Clip = {
  /** Unique stable identifier of the clip in the project. Never used again for another clip. */
  id: string;
  /** Identifier of the source that the clip places. */
  sourceId: string;
};

/**
 * An edit point on the sequence: a clip and a PTS of the video stream of that clip's source (ADR 052).
 */
export type EditPoint = {
  /** Identifier of the clip that owns the boundary. */
  clipId: string;
  /** PTS in the video time base of the clip's source (ADR 002). */
  pts: Pts;
};

/**
 * A segment on a sequence of clips: a half-open interval from its In point to its Out point (ADR 052).
 * The In and the Out can name two clips, so the segment can cross a junction.
 */
export type SequenceSegment = {
  /** Unique identifier for the segment. */
  id: string;
  /** Clip that holds the first included frame. */
  inClipId: string;
  /** Inclusive start PTS in the video time base of the source of `inClipId`. */
  inPts: Pts;
  /** Clip that holds the last included frame. */
  outClipId: string;
  /**
   * Exclusive end PTS in the video time base of the source of `outClipId`. It can equal the end of
   * that clip's range.
   */
  outPts: Pts;
  /**
   * The name of the segment, or absent for a segment with no name (ADR 065). The project file
   * writes the field only when the segment has a name. The loader refuses `null` and a name that
   * `isValidSegmentName` refuses.
   */
  name?: string;
};

/**
 * QuipClip project document format (.qcproj).
 * Holds the imported sources, the clips of the sequence, and the ordered segments (ADR 007,
 * ADR 010, ADR 052, ADR 072).
 */
export type Project = {
  /** Format schema version, identifying the serialization structure (schemaVersion 1). */
  schemaVersion: 1;
  /** List of imported media sources in their persisted document shape (ADR 010). */
  sources: PersistedSource[];
  /** The sequence: each clip places one source, in sequence order (ADR 052). */
  clips: Clip[];
  /** Ordered list of segments; array order determines export sequence (ADR 007, ADR 052). */
  segments: SequenceSegment[];
};
