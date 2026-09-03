/**
 * Domain and wire types for ffmpeg executable discovery and capability probing in QuipClip.
 *
 * Implements wire contract for `start_capability_probe` and `ffmpeg:capability-probe` events.
 * See ADR 005, ADR 006, and ADR 011.
 */

/**
 * Origin location class that supplied the discovered ffmpeg executable pair.
 */
export const EXECUTABLE_ORIGINS = ["configured", "path", "appData"] as const;

export type Origin = (typeof EXECUTABLE_ORIGINS)[number];

/**
 * Licensing flags parsed from the configuration line of `ffmpeg -version`.
 */
export type LicenseFlags = {
  gpl: boolean;
  nonfree: boolean;
  version3: boolean;
};

/**
 * Media kind of a codec reported by ffmpeg.
 */
export const CODEC_KINDS = ["video", "audio", "subtitle"] as const;

export type CodecKind = (typeof CODEC_KINDS)[number];

/**
 * Smoke-test status outcome for a candidate encoder.
 */
export const ENCODER_STATUSES = ["works", "notListed", "failed", "timedOut"] as const;

export type EncoderStatus = (typeof ENCODER_STATUSES)[number];

/**
 * Smoke-test outcome details for one candidate encoder.
 */
export type EncoderResult = {
  name: string;
  kind: CodecKind;
  listed: boolean;
  status: EncoderStatus;
  exitCode?: number;
  detail?: string;
};

/**
 * Aggregated report of probed ffmpeg capabilities.
 */
export type CapabilityReport = {
  version: string;
  license: LicenseFlags;
  hwaccels: string[];
  encoders: EncoderResult[];
  /** Probe completion timestamp in unix seconds. */
  probedAt: number;
};

/**
 * One candidate executable pair inspected during discovery.
 */
export type InspectedCandidate = {
  ffmpeg: string;
  ffprobe: string;
  origin: Origin;
};

/**
 * Immediate payload returned when `start_capability_probe` starts.
 */
export type CapabilityProbeStart = {
  runId: string;
  ffmpeg: string;
  ffprobe: string;
  origin: Origin;
};

/**
 * Stable backend error codes returned by the Rust `start_capability_probe` command
 * or emitted in `failed` probe events.
 */
export const BACKEND_CAPABILITY_PROBE_ERROR_CODES = [
  "appDataUnavailable",
  "ffmpegPairMissing",
  "ffmpegSpawnFailed",
  "ffmpegProcessFailed",
  "versionParseFailed",
  "encoderListParseFailed",
  "cacheUnavailable",
  "commandExecutionFailed",
] as const;

export type BackendCapabilityProbeErrorCode =
  (typeof BACKEND_CAPABILITY_PROBE_ERROR_CODES)[number];

/**
 * Complete set of capability probe error codes supported by the frontend,
 * including backend error codes and the fallback code "unknown".
 */
export const CAPABILITY_PROBE_ERROR_CODES = [
  ...BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  "unknown",
] as const;

export type CapabilityProbeErrorCode = (typeof CAPABILITY_PROBE_ERROR_CODES)[number];

/**
 * Normalized error structure returned when capability discovery or probing fails.
 */
export class CapabilityProbeError extends Error {
  /** Stable semantic error code for localization and error classification. */
  readonly code: CapabilityProbeErrorCode;
  /** Optional raw diagnostic text from the operating system or ffmpeg stderr. */
  readonly detail?: string;
  /** Optional integer process exit code when ffmpeg execution fails. */
  readonly exitCode?: number;
  /** Optional list of candidate locations inspected before discovery failed. */
  readonly inspected?: InspectedCandidate[];

  constructor(options: {
    code: CapabilityProbeErrorCode;
    detail?: string;
    exitCode?: number;
    inspected?: InspectedCandidate[];
  }) {
    super(options.detail ? `${options.code}: ${options.detail}` : options.code);
    this.name = "CapabilityProbeError";
    this.code = options.code;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
    if (options.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options.inspected !== undefined) {
      this.inspected = options.inspected;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Source mechanism for a capability report.
 */
export type CapabilityProbeSource = "probe" | "cache";

/**
 * Event emitted when matching ffmpeg and ffprobe executables have been located.
 */
export type CapabilityProbeLocatedEvent = {
  event: "located";
  runId: string;
  ffmpeg: string;
  ffprobe: string;
  origin: Origin;
  version: string;
  license: LicenseFlags;
};

/**
 * Event emitted when an encoder candidate has completed its smoke test.
 */
export type CapabilityProbeResultEvent = {
  event: "result";
  runId: string;
  result: EncoderResult;
  done: number;
  total: number;
};

/**
 * Event emitted when the full capability probe finishes successfully.
 */
export type CapabilityProbeFinishedEvent = {
  event: "finished";
  runId: string;
  report: CapabilityReport;
  source: CapabilityProbeSource;
};

/**
 * Event emitted when capability probing fails on the worker thread.
 */
export type CapabilityProbeFailedEvent = {
  event: "failed";
  runId: string;
  code: BackendCapabilityProbeErrorCode;
  detail?: string;
  exitCode?: number;
  inspected?: InspectedCandidate[];
};

/**
 * Tagged union of all possible backend events emitted on `ffmpeg:capability-probe`.
 */
export type CapabilityProbeEvent =
  | CapabilityProbeLocatedEvent
  | CapabilityProbeResultEvent
  | CapabilityProbeFinishedEvent
  | CapabilityProbeFailedEvent;

/**
 * Pair of canonical paths to located ffmpeg and ffprobe executables.
 */
export type FfmpegExecutablePaths = {
  ffmpeg: string;
  ffprobe: string;
};

/**
 * Lifecycle status of the ffmpeg capability probe store.
 */
export type FfmpegStatus =
  "idle" | "locating" | "probing" | "ready" | "missing" | "failed";

/**
 * Public serializable state of the ffmpeg capability probe store.
 */
export type FfmpegState = {
  /** Current lifecycle status. */
  status: FfmpegStatus;
  /** Identifier of the active probe run, or null if idle or reset. */
  runId: string | null;
  /** Canonical paths to located ffmpeg and ffprobe binaries, or null if unlocated. */
  paths: FfmpegExecutablePaths | null;
  /** Origin location where binaries were discovered, or null if unlocated. */
  origin: Origin | null;
  /** Full version string reported by `ffmpeg -version`, or null if unknown. */
  version: string | null;
  /** License flags parsed from ffmpeg configuration, or null if unknown. */
  license: LicenseFlags | null;
  /** Hardware acceleration methods supported by the ffmpeg build. */
  hwaccels: string[];
  /** Accumulator of encoder smoke-test results. */
  results: EncoderResult[];
  /** Number of encoder candidates tested so far. */
  done: number;
  /** Total number of encoder candidates to test. */
  total: number;
  /** Origin source of the capability report (probe execution vs disk cache), or null. */
  source: CapabilityProbeSource | null;
  /** Last error encountered during discovery or probing, or null. */
  error: CapabilityProbeError | null;
  /** Locations inspected when discovery failed, or null. */
  inspected: InspectedCandidate[] | null;
};

/**
 * Actions provided by the ffmpeg capability probe store.
 */
export type FfmpegActions = {
  /**
   * Subscribes to backend capability probe events and starts the probe.
   *
   * @param force When true, bypasses any cached capability report and forces a full re-probe.
   * @returns The initial probe start payload, or null on failure/superseded run.
   */
  startProbe: (force?: boolean) => Promise<CapabilityProbeStart | null>;
  /**
   * Resets the store back to its initial idle state and invalidates pending runs.
   */
  reset: () => void;
  /**
   * Ensures an active subscription to the `ffmpeg:capability-probe` event channel.
   * Idempotent and memoized. The store deliberately holds a Tauri listener for the process lifetime.
   */
  ensureSubscribed: () => Promise<void>;
  /**
   * Unsubscribes from backend capability probe events and clears the subscription memo.
   */
  unsubscribe: () => void;
};

/**
 * Combined type of the ffmpeg capability store state and actions.
 */
export type FfmpegStoreState = FfmpegState & FfmpegActions;
