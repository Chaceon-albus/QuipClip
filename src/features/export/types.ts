/**
 * Domain and wire types for media export rendering in QuipClip.
 *
 * Implements wire contract for `start_export`, `cancel_export`, and `export:progress` events.
 * See ADR 002, ADR 004, ADR 011, and ADR 014.
 */

import type { Preset } from "@/features/settings/types";
import type { Pts, Rational } from "@/types/project";

/**
 * Half-open interval [inPts, outPts) marking an export segment boundary
 * aligned to source video presentation timestamps (PTS).
 */
export type ExportSegmentBoundary = { inPts: Pts; outPts: Pts };

/**
 * One source of an export request (ADR 053).
 *
 * `id` names the source in the pieces. It is not empty, and it is unique in the request.
 * `expectedRevision` is the revision of the file that the segments were marked against. When the
 * export prepares, the backend refuses a file whose size or whole-second modification time
 * differs from it with `sourceRevisionMismatch`, and the detail of the error is this `id`. Null or
 * absent when the user chose to export a changed file anyway, and the backend then checks
 * nothing (ADR 024).
 */
export type ExportSource = {
  id: string;
  path: string;
  expectedRevision?: ExportSourceRevision | null;
};

/**
 * One piece of an export request: the half-open interval [inPts, outPts) of one source, in the
 * time base of that source (ADR 052, ADR 053).
 */
export type ExportPiece = ExportSegmentBoundary & { sourceId: string };

/**
 * The streams of the source that an export writes, as the user chooses them.
 *
 * The wire strings of the Rust `ExportStreams` enum, in its order. `types.test.ts` reads the
 * Rust enum and asserts that this list names the same strings.
 *
 * - `videoAndAudio`: the video, and the audio when the source has an audio stream.
 * - `videoOnly`: the video only.
 * - `audioOnly`: the audio only. A source without audio is refused with `sourceHasNoAudio`.
 *   The export writes no frames, so `expectedFrames` is absent and the progress is
 *   indeterminate (ADR 025).
 */
export const EXPORT_STREAMS = ["videoAndAudio", "videoOnly", "audioOnly"] as const;

export type ExportStreams = (typeof EXPORT_STREAMS)[number];

/**
 * How an export writes the audio of the source (ADR 048).
 *
 * The wire strings of the Rust `ExportAudioMode` enum, in its order. `types.test.ts` reads the
 * Rust enum and asserts that this list names the same strings.
 *
 * - `encode`: decode, cut and encode the audio with the settings of the preset.
 * - `copy`: copy the packets of the source audio. The backend copies only where its plan
 *   agrees: one segment, a source format, a sample rate and a codec that it measured, and audio
 *   that covers the segment. Otherwise it writes the audio as for `encode`, without an error.
 */
export const EXPORT_AUDIO_MODES = ["encode", "copy"] as const;

export type ExportAudioMode = (typeof EXPORT_AUDIO_MODES)[number];

/**
 * Request payload sent to the backend `start_export` command.
 */
export type ExportRequest = {
  /** The sources that the pieces name. Each source has at least one piece. */
  sources: ExportSource[];
  /**
   * The pieces in export order: each segment in array order, and the pieces of one segment in
   * sequence order (ADR 052). The backend refuses more than its limit of pieces with
   * `tooManySegments`.
   */
  pieces: ExportPiece[];
  /**
   * The number of segments that the pieces come from, from 1 to the number of pieces. The run
   * reports it as its segment count.
   */
  segmentCount: number;
  outputPath: string;
  /**
   * Required. The whole preset, as the setup step showed it when the user confirmed the
   * export. The run renders with this preset and never reads the presets of the settings file,
   * so an export that waits in the queue keeps the settings that the user saw (ADR 049).
   */
  preset: Preset;
  /** Required. The backend refuses a request without it, and has no default for it. */
  streams: ExportStreams;
  /** Required, as `streams` is. No report of the run repeats it. */
  audioMode: ExportAudioMode;
  /**
   * True when the queue store starts a new batch with this run. The backend journal then drops
   * the runs of the earlier batch that ended, so that the list of the queue for a page that
   * loads again shows only this batch. Absent or false for a run that joins the batch.
   */
  newBatch?: boolean;
};

/** The size and the modification time of a source file, as the import reports them (ADR 010). */
export type ExportSourceRevision = {
  size: number;
  mtime: number;
};

/**
 * The answer of `start_export`: the id of the run that the backend accepted.
 *
 * The backend answers before the run prepares. Every later report of the run, a failure of
 * preparation included, is an `export:progress` event that carries this id.
 */
export type ExportSubmission = {
  runId: string;
  /**
   * True when the run waits in the queue of the backend for the runs before it. The run then
   * reports `preparing` when it takes the slot, or `failed` with `canceled` when a cancel
   * withdraws it (ADR 049).
   */
  queued: boolean;
};

/**
 * Stable backend error codes returned by the Rust export commands verbatim
 * or emitted in `failed` export events.
 */
export const BACKEND_EXPORT_ERROR_CODES = [
  "appDataUnavailable",
  "invalidPreset",
  "ffmpegPairMissing",
  "ffprobeSpawnFailed",
  "ffprobeProcessFailed",
  "ffprobeParseFailed",
  "ffprobeTimedOut",
  "preparationTimedOut",
  "noSegments",
  "tooManySegments",
  "invalidSources",
  "invalidSegmentCount",
  "invalidSegment",
  "sourcePathInvalid",
  "sourceNotFound",
  "sourceNotFile",
  "sourceRevisionMismatch",
  "outputPathInvalid",
  "outputDirectoryMissing",
  "outputEqualsSource",
  "outputNotWritable",
  "outputReadOnly",
  "sourceFrameRateUnknown",
  "sourceAudioRateUnknown",
  "sourceHasNoAudio",
  "audioGapTooLong",
  "encoderUnavailable",
  "ffmpegSpawnFailed",
  "ffmpegProcessFailed",
  "frameCountMismatch",
  "audioDurationMismatch",
  "outputStreamsMismatch",
  "outputRenameFailed",
  "canceled",
  "commandExecutionFailed",
  "exportQueueClosed",
  "workDirectoryUnavailable",
  "graphFileUnsupported",
  "piecesOutOfOrder",
] as const;

export type BackendExportErrorCode = (typeof BACKEND_EXPORT_ERROR_CODES)[number];

/**
 * Frontend error codes generated by client-side operations such as dialog failures.
 *
 * These must NEVER enter `BACKEND_EXPORT_ERROR_CODES`: `types.test.ts` reads the Rust
 * `export_error_codes!` invocation and asserts that list is set-equal to the Rust vocabulary,
 * and the backend emits none of these.
 *
 * `sourceRevisionChanged` is a confirmation and not a terminal failure. The export flow raises
 * it when the file on disk is no longer the revision the segments were marked against, and the
 * export dialog renders it with three actions rather than as an error the user can only close.
 *
 * `presetNotFound` comes from the START step of the export flow, when the settings hold no
 * preset with the chosen id. The request carries the whole preset, so the backend never looks
 * a preset up (ADR 049).
 *
 * `outputAlreadyQueued` comes from the export queue store. It refuses an export whose output
 * path is the path of the live run or of a waiting run, without regard to letter case, so two
 * runs of one batch never write one file (ADR 049).
 */
export const FRONTEND_EXPORT_ERROR_CODES = [
  "dialogFailed",
  "sourceRevisionChanged",
  "presetNotFound",
  "outputAlreadyQueued",
] as const;

export type FrontendExportErrorCode = (typeof FRONTEND_EXPORT_ERROR_CODES)[number];

/**
 * Complete set of export error codes supported by the frontend,
 * including backend error codes, frontend dialog codes, and the fallback code "unknown".
 */
export const EXPORT_ERROR_CODES = [
  ...BACKEND_EXPORT_ERROR_CODES,
  ...FRONTEND_EXPORT_ERROR_CODES,
  "unknown",
] as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

/**
 * Options for constructing an ExportError instance.
 */
export type ExportErrorOptions = {
  code: ExportErrorCode;
  detail?: string;
  exitCode?: number;
  encoder?: string;
  measuredDurationUs?: number;
  expectedDurationUs?: number;
  pieceLimit?: number;
  inputLimit?: number;
};

/**
 * Normalized error structure returned when export operations fail.
 */
export class ExportError extends Error {
  /** Stable semantic error code for localization and error classification. */
  readonly code: ExportErrorCode;
  /** Optional raw diagnostic text from the operating system or ffmpeg stderr. */
  declare readonly detail?: string;
  /** Optional integer process exit code when ffmpeg execution fails. */
  declare readonly exitCode?: number;
  /** Optional encoder name if failure was related to a specific encoder. */
  declare readonly encoder?: string;
  /**
   * For `audioDurationMismatch`: the duration that ffprobe measured on the finished file, in
   * whole microseconds. Absent when ffprobe reported no duration.
   */
  declare readonly measuredDurationUs?: number;
  /** For `audioDurationMismatch`: the duration that the plan expected, in whole microseconds. */
  declare readonly expectedDurationUs?: number;
  /**
   * For `tooManySegments`: the most pieces that an export of the sources of the request joins
   * (`maxExportPieces`). The OPEN step of the export sets it. The backend sends no limit.
   */
  declare readonly pieceLimit?: number;
  /**
   * For `piecesOutOfOrder`: the most runs of pieces in source order that one export reads
   * (ADR 055). Only a check of the frontend sets it. The backend sends no limit.
   */
  declare readonly inputLimit?: number;

  constructor(options: ExportErrorOptions) {
    super(options.detail ? `${options.code}: ${options.detail}` : options.code);
    this.name = "ExportError";
    this.code = options.code;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
    if (options.exitCode !== undefined) {
      this.exitCode = options.exitCode;
    }
    if (options.encoder !== undefined) {
      this.encoder = options.encoder;
    }
    if (options.measuredDurationUs !== undefined) {
      this.measuredDurationUs = options.measuredDurationUs;
    }
    if (options.expectedDurationUs !== undefined) {
      this.expectedDurationUs = options.expectedDurationUs;
    }
    if (options.pieceLimit !== undefined) {
      this.pieceLimit = options.pieceLimit;
    }
    if (options.inputLimit !== undefined) {
      this.inputLimit = options.inputLimit;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Event emitted when a run takes the export slot and its export thread prepares it. A run that
 * started at once and a run that waited in the queue both send it first. A run that a cancel
 * withdrew from the queue, or whose thread the system refused, sends only `failed`.
 */
export type ExportPreparingEvent = {
  event: "preparing";
  runId: string;
};

/**
 * Event emitted when media export execution starts.
 */
export type ExportStartedEvent = {
  event: "started";
  runId: string;
  outputPath: string;
  segmentCount: number;
  totalDurationUs: number;
  expectedFrames?: number;
};

/**
 * Event emitted during media export execution to report frame progress.
 *
 * NOTE: There is deliberately NO out-time field on progress.
 * ADR 014 measurement 12 found ffmpeg's out_time_us wrong when -copyts is set,
 * so progress is frame-based. fps and speed are Rational numbers.
 */
export type ExportProgressUpdateEvent = {
  event: "progress";
  runId: string;
  frame: number;
  expectedFrames?: number;
  fps?: Rational;
  speed?: Rational;
  totalSize?: number;
};

/**
 * Event emitted when ffmpeg execution has completed and the output file is being published.
 *
 * This phase begins after ffmpeg has exited successfully, the success check has passed (the
 * frame count, or for an export without video the ffprobe check of the finished file), and the
 * cancel flag has been re-checked. Nothing is being encoded or processed at this stage.
 * All that remains is renaming the finished temporary file over the destination, which on
 * Windows can wait seconds while a virus scanner reads back a multi-gigabyte file.
 *
 * Note that `-movflags +faststart` is a genuine post-write pass: the flag is set for the MP4 and MOV
 * containers and not for Matroska, and where it is set it runs inside ffmpeg before the process
 * exits. That is why this phase is not called "finalizing" or "post-processing".
 *
 * The user interface must NOT show the word "publishing" -- it renders as "Finishing…".
 * That is the ADR 011 split: a stable code crosses the boundary, the frontend translates.
 */
export type ExportPublishingEvent = {
  event: "publishing";
  runId: string;
};

/**
 * Event emitted when media export completes successfully.
 *
 * NOTE: There is deliberately NO out-time field on finished.
 * ADR 014 measurement 12 found ffmpeg's out-time wrong under -copyts,
 * so an out-time field was deliberately omitted for the same reason as on progress.
 * A consumer wanting a duration must use the plan-derived totalDurationUs from started.
 */
export type ExportFinishedEvent = {
  event: "finished";
  runId: string;
  outputPath: string;
  frames: number;
};

/**
 * Event emitted when media export fails on the backend worker.
 */
export type ExportFailedEvent = {
  event: "failed";
  runId: string;
  code: BackendExportErrorCode;
  detail?: string;
  exitCode?: number;
  encoder?: string;
  measuredDurationUs?: number;
  expectedDurationUs?: number;
};

/**
 * Tagged union of all possible backend events emitted on `export:progress`.
 *
 * The backend gives each event a sequence number, `seq`. The numbers start at 1 and go up by 1
 * in the order in which the events go out. A reader that has a copy of the export journal can
 * drop each event whose number is not larger than the number of that copy. `seq` is optional
 * here, so that an event that a test or the frontend builds needs no number.
 */
export type ExportProgressEvent = (
  | ExportPreparingEvent
  | ExportStartedEvent
  | ExportProgressUpdateEvent
  | ExportPublishingEvent
  | ExportFinishedEvent
  | ExportFailedEvent
) & { seq?: number };

/**
 * The phases of a run in the export journal of the backend, as `export_queue_snapshot` spells
 * them. `canceled` is a run that a cancel ended after it left `waiting`. A run that a cancel
 * withdrew from the queue is not in the journal.
 */
export const EXPORT_QUEUE_RUN_PHASES = [
  "waiting",
  "preparing",
  "running",
  "publishing",
  "finished",
  "failed",
  "canceled",
] as const;

export type ExportQueueRunPhase = (typeof EXPORT_QUEUE_RUN_PHASES)[number];

/**
 * The error of a run in the snapshot: the shape of the rejection of `start_export`, and of the
 * body of a `failed` event.
 */
export type ExportQueueRunError = {
  code: BackendExportErrorCode;
  detail?: string;
  exitCode?: number;
  encoder?: string;
  measuredDurationUs?: number;
  expectedDurationUs?: number;
};

/** One run of the answer of `export_queue_snapshot`. An absent value is not on the wire. */
export type ExportQueueSnapshotRun = {
  runId: string;
  outputPath: string;
  presetName: string;
  segmentCount: number;
  streams: ExportStreams;
  phase: ExportQueueRunPhase;
  /** The last frame that a `progress` event reported, or the frame count of `finished`. */
  frame?: number;
  expectedFrames?: number;
  /** Present for a run that failed or that was canceled. */
  error?: ExportQueueRunError;
  /** The milliseconds since the run sent `preparing`. Only a run that did not end has it. */
  elapsedMs?: number;
  /**
   * The position of the run among the ended runs. Only an ended run has it. The counter runs for
   * the whole process, so the values of one batch have gaps and need not start at 1. Sort by
   * it, and never use it as an index.
   */
  endOrder?: number;
};

/**
 * The answer of `export_queue_snapshot`: the runs of the export journal, for a page that loaded
 * again.
 *
 * `seq` is the sequence number of the last event that the snapshot includes. Each event with a
 * number that is not larger is already in the snapshot. The runs come in this order: the ended
 * runs by `endOrder`, the run that left `waiting` and did not end, then the waiting runs in the
 * order of the queue of the backend.
 */
export type ExportQueueSnapshot = {
  seq: number;
  runs: ExportQueueSnapshotRun[];
};

/**
 * Output status states supported by the export store.
 */
export const EXPORT_STATUSES = [
  "idle",
  "preparing",
  "running",
  "publishing",
  "finished",
  "canceled",
  "failed",
] as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/**
 * Public serializable state of the export store.
 */
export type ExportState = {
  /** Current lifecycle status of the export operation. */
  status: ExportStatus;
  /** Identifier of the active export run, or null if idle or reset. */
  runId: string | null;
  /** Destination output file path, or null if unconfigured. */
  outputPath: string | null;
  /** Number of segments included in the active export request. */
  segmentCount: number;
  /**
   * Latest reported frame count from ffmpeg progress.
   */
  frame: number | null;
  /**
   * Expected total frame count computed during planning.
   */
  expectedFrames: number | null;
  /**
   * Latest encode rate that ffmpeg reported, or null if not reported yet.
   * ffmpeg reports the mean since the start of the encode.
   */
  fps: Rational | null;
  /**
   * Latest speed factor that ffmpeg reported, or null if not reported yet.
   */
  speed: Rational | null;
  /**
   * True while a cancel that this store asked for is outstanding.
   */
  cancelRequested: boolean;
  /**
   * True once the tracked run reported that the encode started: its `started` event, or its
   * first `progress` event. `startExport` and `reset` clear it. The status tells the phase
   * of an active run. A `failed` that the store still tracks hides the phase, and this field
   * tells whether the backend encodes or still prepares.
   */
  encodeStarted: boolean;
  /**
   * True while the store tracks a start or a run that the backend can still prepare or
   * encode. It becomes true at `startExport`. It becomes false at each of these:
   *
   * - `start_export` refuses the start.
   * - The `finished` or `failed` event of the run arrives.
   * - `reset`.
   * - `unsubscribe` while the store holds no run id. It invalidates the start in flight. A
   *   run that the store knows by its id stays tracked.
   *
   * `reportError` never ends the tracking. It does nothing while the store tracks a live run.
   *
   * The run id comes with the answer of `start_export`, so `tracking` is true while `runId`
   * is still null in `preparing`. The backend answers before the run prepares, so that
   * window is short. A new `startExport` drops the run that the store tracked before, and
   * tracks the new start.
   *
   * A `failed` status does not end the tracking by itself. The store also reports `failed`
   * when a `cancel_export` request rejects while the run continues, at the IPC layer. It keeps
   * the run: the backend did not confirm the stop, and the events still arrive. A reset in
   * that state drops the only record of a live run (`isExportRunLive`).
   */
  tracking: boolean;
  /** Last error encountered during export, or null if idle or succeeded. */
  error: ExportError | null;
};

/** The facts of a run that the export store shows before its `started` event. */
export type ExportRunFacts = {
  outputPath: string;
  segmentCount: number;
};

/**
 * A run that a page restores from the answer of `export_queue_snapshot`: the run that left
 * `waiting` and did not end. `frame` and `expectedFrames` are null when the snapshot has none.
 */
export type ExportRestoredRun = {
  runId: string;
  status: "preparing" | "running" | "publishing";
  outputPath: string;
  segmentCount: number;
  frame: number | null;
  expectedFrames: number | null;
};

/**
 * Actions provided by the export store.
 */
export type ExportActions = {
  /**
   * Subscribes to backend export progress events and starts the export.
   *
   * @param request The export parameters and segment boundaries.
   * @returns The answer of the backend with the run id, or null on failure.
   */
  startExport: (request: ExportRequest) => Promise<ExportSubmission | null>;
  /**
   * Makes the store track a run that waited in the queue of the backend and took the slot.
   * The export queue store calls it when the `preparing` event of that run arrives (ADR 049).
   *
   * It drops the start in flight, if any, and a Stop request that waits for its run id, which
   * it settles with false. The store then shows `preparing` for the run, with the facts that
   * the queue recorded when the user submitted it.
   *
   * @param runId The id that `start_export` answered for the run.
   * @param facts The output path and the segment count of the request of the run.
   * @param events Events of the run that came after its `preparing` event and before the
   *   queue knew its run id, in their order. The store applies them after the adoption.
   *   Events of other runs are ignored.
   */
  adoptRun: (
    runId: string,
    facts: ExportRunFacts,
    events?: readonly ExportProgressEvent[],
  ) => void;
  /**
   * Makes the store track a run that a page restores after a reload (`recovery.ts`). The
   * backend runs the run, and the page lost its copy of it.
   *
   * It drops the start in flight, if any, as `adoptRun` does. The store then shows the status
   * of the run, its facts, and its last frame. The encode started when the status is
   * `running` or `publishing`. The store tracks the run, with no error and no Stop request.
   */
  restoreRun: (run: ExportRestoredRun) => void;
  /**
   * Applies an event that the recovery held back while it read the snapshot. The store
   * applies it as it applies a live event, with the same test of the sequence floor.
   */
  replayEvent: (event: ExportProgressEvent) => void;
  /**
   * Signals the backend to cancel the active export run.
   *
   * @returns True if cancellation was requested, false otherwise.
   */
  cancelExport: () => Promise<boolean>;
  /**
   * Resets the store back to its initial idle state.
   */
  reset: () => void;
  /**
   * Ensures an active subscription to the `export:progress` event channel.
   */
  ensureSubscribed: () => Promise<void>;
  /**
   * Unsubscribes from backend export progress events.
   */
  unsubscribe: () => void;
  /**
   * Entry point for recording frontend-only errors (such as `dialogFailed`),
   * allowing client-side failures to render through exactly the same path as
   * a backend failure. The store normalizes the error through `normalizeExportError`,
   * matching the media and settings slices.
   *
   * It does nothing while the store tracks a live run (`isExportRunLive` and `tracking`): a
   * start that waits for its run id, or a run that the backend still prepares or encodes. A
   * frontend error does not describe that run, and a `failed` status over it would let a
   * reset drop it.
   *
   * @param error The raw error to normalize and record in the store.
   */
  reportError: (error: unknown) => void;
};

/**
 * Combined type of the export store state and actions.
 */
export type ExportStoreState = ExportState & ExportActions;
