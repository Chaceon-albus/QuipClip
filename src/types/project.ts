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
 * Project render settings defining output frame rate and canvas dimensions (ADR 010).
 */
export type RenderSettings = {
  /** Output / timeline frame rate as an exact rational timebase. */
  frameRate: Rational;
  /** Output video dimensions in pixels. */
  resolution: Resolution;
};

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
  /** Relative path from the project file directory to the source file when sharing a volume. */
  relPath: string;
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
  /** Reported stream duration in video time base ticks, or null if indeterminate. */
  videoDurationTicks: TickCount | null;
  /** Approximate duration in seconds for UI layout and seek estimates, or null if unavailable. */
  approximateDurationSeconds: number | null;
  /** Average frame rate as an exact rational, or null if unavailable. */
  avgFrameRate: Rational | null;
  /** Real / nominal container frame rate as an exact rational, or null if unavailable. */
  rFrameRate: Rational | null;
  /** Total reported frame count from stream metadata, or null if unstated. */
  reportedFrameCount: TickCount | null;
  /**
   * Proxies are machine-specific caches and must not be persisted to project files (ADR 010).
   */
  proxy?: never;
};

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
  videoDurationTicks: TickCount | null;
  approximateDurationSeconds: number | null;
  avgFrameRate: Rational | null;
  rFrameRate: Rational | null;
  reportedFrameCount: TickCount | null;
  /** Optional runtime proxy information for playback when native decoding is unavailable. */
  proxy?: SourceProxy;
};

/**
 * Explicit projection that constructs a new PersistedSource object by listing every persisted field.
 *
 * Does not use object spread and does not rely solely on `never` fields, guaranteeing that
 * runtime proxy paths, URLs, or other machine-specific caches never leak into persisted project documents.
 *
 * See ADR 007 and ADR 010.
 */
export function toPersistedSource(source: Source): PersistedSource {
  return {
    id: source.id,
    path: source.path,
    relPath: source.relPath,
    size: source.size,
    mtime: source.mtime,
    videoStreamIndex: source.videoStreamIndex,
    videoTimeBase: source.videoTimeBase,
    videoStartPts: source.videoStartPts,
    videoDurationTicks: source.videoDurationTicks,
    approximateDurationSeconds: source.approximateDurationSeconds,
    avgFrameRate: source.avgFrameRate,
    rFrameRate: source.rFrameRate,
    reportedFrameCount: source.reportedFrameCount,
  };
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
};

/**
 * QuipClip project document format (.qcproj).
 * Holds render settings, imported sources, ordered timeline segments, and active source selection (ADR 007, ADR 010).
 */
export type Project = {
  /** Format schema version, identifying the serialization structure (schemaVersion 1). */
  schemaVersion: 1;
  /** Render and export settings including output frame rate and resolution (ADR 010). */
  renderSettings: RenderSettings;
  /** List of imported media sources in their persisted document shape (ADR 010). */
  sources: PersistedSource[];
  /** Ordered list of timeline segments; array order determines export sequence (ADR 007). */
  segments: Segment[];
  /** Identifier of the source currently selected and displayed on the source ruler. */
  activeSourceId: string;
};
