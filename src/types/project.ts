/**
 * Shared project schema definitions and time representations for QuipClip.
 *
 * See ADR 002, ADR 007, and ADR 010.
 * The project file format (.qcproj) uses exact rational time for timebases
 * and integer frame indices for all edit points to ensure deterministic,
 * lossless round-trips between the frontend and the Rust export engine.
 */

/**
 * The canonical schema version for .qcproj project files.
 * Stored in every project file so older or newer formats can be detected,
 * migrated, or safely rejected if unsupported (ADR 010).
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
 * Represents an imported media source file and its identity metadata.
 * Path is stored both as absolute and relative to allow project portability
 * across directories and volumes (ADR 010).
 */
export type Source = {
  /** Unique identifier for the source within the project. */
  id: string;
  /** Absolute path to the source media file on disk. */
  path: string;
  /** Relative path from the project file directory to the source file when sharing a volume. */
  relPath: string;
  /** File size in bytes, used to verify file identity independently of path. */
  size: number;
  /** File modification timestamp (mtime), used to detect modified or replaced files. */
  mtime: number;
  /** Frame rate / timebase of the source media as an exact rational. */
  timebase: Rational;
  /** Total number of frames in the source media stream from ffprobe. */
  frameCount: number;
  /** Optional path to a generated ffmpeg proxy video for formats unsupported by native playback. */
  proxy?: string;
};

/**
 * An edit span marking a portion of a source media file to be included in the timeline.
 * Segments are single-track and aligned to source time (ADR 007).
 */
export type Segment = {
  /** Unique identifier for the segment. */
  id: string;
  /** Identifier of the source media clip this segment belongs to. */
  sourceId: string;
  /** Inclusive start frame index on the project frame grid. */
  inFrame: number;
  /**
   * Exclusive end frame index on the project frame grid.
   * Segment duration is exactly `outFrame - inFrame` frames (ADR 002 Rule 3).
   */
  outFrame: number;
};

/**
 * QuipClip project document format (.qcproj).
 * Holds all project settings, imported sources, and ordered timeline segments (ADR 007, ADR 010).
 */
export type Project = {
  /** Format schema version, identifying the serialization structure. */
  schemaVersion: number;
  /** Output / timeline frame rate as an exact rational timebase. */
  timebase: Rational;
  /** Output video dimensions in pixels. */
  resolution: {
    /** Canvas width in pixels. */
    w: number;
    /** Canvas height in pixels. */
    h: number;
  };
  /** List of imported media sources. */
  sources: Source[];
  /** Ordered list of timeline segments; array order determines export sequence. */
  segments: Segment[];
  /** Identifier of the source currently selected and displayed on the source ruler. */
  activeSourceId: string;
};
