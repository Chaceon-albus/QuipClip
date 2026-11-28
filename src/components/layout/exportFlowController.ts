/**
 * Pure export flow controller for QuipClip layout.
 *
 * Implements the two-step export flow per ADR 024:
 * 1. Open step (`run`): shows a live run, resets the store after a run that ended,
 *    verifies media presence, validates that marked segments exist for the active source,
 *    and runs the source disk revision check before opening the modal at the setup step.
 * 2. Start step (`confirm`): validates the chosen preset, opens the native save dialog
 *    with the extension of the output, builds the export request with the stream choice of the
 *    setup step (ADR 036), submits the export to the queue (ADR 049), and updates
 *    activePresetId in settings if the preset changed.
 *
 * The steps report a failure that comes before a run, and read and reset its state, through
 * a target: the export store, or the compose store while another export runs or waits
 * (`openExportFlow`, ADR 049).
 */

import {
  buildExportRequest,
  createComposeFlowTarget,
  exportComposeStore,
  exportFileName,
  exportOutputExtension,
  exportQueueStore,
  exportScopeStore,
  exportStore,
  hasPendingExportWork,
  isExportRunLive,
  narrowToExportScope,
  normalizeExportError,
  openExportSaveDialog,
  resolveExportScope,
  segmentFileName,
  ExportError,
  WHOLE_EXPORT_SCOPE,
  type ExportAudioMode,
  type ExportComposeStore,
  type ExportErrorCode,
  type ExportFlowTarget,
  type ExportQueueStore,
  type ExportQueueSubmitResult,
  type ExportRequest,
  type ExportScope,
  type ExportScopeInput,
  type ExportScopeStore,
  type ExportScopeTarget,
  type ExportStore,
  type ExportStreams,
  type ExportRunLiveState,
  type OpenExportSaveDialogOptions,
} from "@/features/export";
import {
  audioOverrideStore,
  effectiveAudioStreamOf,
  mayHoldSourceRevision,
  mediaStore,
  readSourceRevision,
  type AudioStreamOverride,
  type MediaSourceRevisionDescriptor,
} from "@/features/media";
import { settingsStore } from "@/features/settings";
import { setActivePreset } from "@/features/settings/presetDocument";
import type { Settings } from "@/features/settings/types";
import { attachedMediaStore } from "@/features/sequence/attachedMedia";
import {
  buildSequenceExportRequest,
  exportLimitError,
  sequenceExportPieces,
} from "@/features/export/sequenceRequest";
import { isSequenceExport, timelineStore } from "@/features/timeline";
import type { TimelineTruth } from "@/features/timeline/types";
import type { AudioProbe, ImportMediaResult } from "@/features/media/types";
import { loudnessRequestId } from "@/features/loudness/store";
import type { LoudnessScope } from "@/features/loudness/types";
import type { Preset } from "@/features/settings/types";
import type { Clip, Segment } from "@/types/project";

/**
 * The media facts the export flow reads: the source path, the name the default output name is
 * derived from, and the revision the marked segments belong to.
 */
export type MediaFlowDescriptor = MediaSourceRevisionDescriptor & {
  fileName?: string;
  /** The probe of the import. Its format names tell an FLV, which can grow (ADR 058). */
  probe?: { readonly formatNames: readonly string[] };
};

/** The facts of the session that an export request reads. */
export interface ExportRequestParts {
  /** The clips, the segments and the sources of the sequence. */
  readonly timeline: Pick<
    TimelineTruth,
    "clips" | "sequenceSegments" | "sequenceSources"
  >;
  /** The imported media of the sources, by source ID. */
  readonly sources: Readonly<Record<string, ImportMediaResult>>;
  /** The media of the attached clip, for a sequence of one clip. */
  readonly media: MediaFlowDescriptor | null;
  /** The segments of the attached clip, for a sequence of one clip. */
  readonly segments: readonly Segment[];
  /** The source of the attached clip, for a sequence of one clip. */
  readonly sourceId: string | null;
  readonly outputPath: string;
  readonly preset: Preset;
  readonly streams: ExportStreams;
  readonly audioMode: ExportAudioMode;
  /** True after "Export anyway": the request carries no revision (ADR 024). */
  readonly skipSourceRevisionCheck: boolean;
  /** The gain of the Adjust switch (ADR 061), or undefined while it is off. */
  readonly adjustedAudioGainTenthsDb?: number;
  /**
   * The audio stream overrides of the session, by source id (ADR 070). A source with an override
   * carries it as `audioStream`, so the export and the measurement read its effective stream.
   */
  readonly audioOverrides: Readonly<Record<string, AudioStreamOverride>>;
  /** The builder of the request of one clip. Defaults to `buildExportRequest`. */
  readonly buildRequest?: typeof buildExportRequest;
  /**
   * The scope of the export (ADR 067). The request takes only the segments of the scope
   * (`narrowToExportScope`). Defaults to the whole export.
   */
  readonly scope?: ExportScope;
}

/** The parts of the timeline that the segments of a scope read, from the parts of a request. */
function scopeInputOfParts(
  parts: Pick<ExportRequestParts, "timeline" | "segments" | "sourceId">,
): ExportScopeInput {
  return {
    clips: parts.timeline.clips,
    sequenceSegments: parts.timeline.sequenceSegments,
    sequenceSources: parts.timeline.sequenceSources,
    segments: parts.segments,
    sourceId: parts.sourceId,
  };
}

/**
 * The export request of the session: of the pieces of the sequence when it has several clips
 * (`buildSequenceExportRequest`), and of the segments of the attached clip otherwise
 * (`buildExportRequest`). Null when the request cannot be built. The export and the measurement
 * of its audio (ADR 061) both build their request here, so both read the same audio.
 */
export function composeExportRequest(parts: ExportRequestParts): ExportRequest | null {
  const { timeline, media, preset, streams, audioMode, outputPath } = parts;
  // The builders read only the segments of the scope (ADR 067). A list that is not valid builds
  // no request, so it never gives other frames than the user selected.
  const scope = parts.scope ?? WHOLE_EXPORT_SCOPE;
  const input = scopeInputOfParts(parts);
  if (!resolveExportScope(input, scope).valid) {
    return null;
  }
  const scoped = narrowToExportScope(input, scope);
  // `exportSegmentIds` chooses its array by the same rule (ADR 066).
  if (isSequenceExport(timeline.clips)) {
    return buildSequenceExportRequest({
      clips: timeline.clips,
      segments: scoped.sequenceSegments,
      sources: new Map(Object.entries(timeline.sequenceSources)),
      media: parts.sources,
      outputPath,
      preset,
      streams,
      audioMode,
      adjustedAudioGainTenthsDb: parts.adjustedAudioGainTenthsDb,
      checkRevisions: !parts.skipSourceRevisionCheck,
      audioOverrides: parts.audioOverrides,
    });
  }
  return (parts.buildRequest ?? buildExportRequest)({
    media,
    outputPath,
    segments: scoped.segments,
    activeSourceId: parts.sourceId,
    preset,
    streams,
    audioMode,
    adjustedAudioGainTenthsDb: parts.adjustedAudioGainTenthsDb,
    expectedSourceRevision:
      parts.skipSourceRevisionCheck || !media
        ? null
        : { size: media.size, mtime: media.mtime },
    // The request names the virtual source of the sequence, and the override belongs to the real
    // source of the one clip.
    audioStream:
      timeline.clips.length === 1
        ? parts.audioOverrides[timeline.clips[0].sourceId]
        : undefined,
  });
}

/**
 * The ids of the real sources that `request` reads: the sources of the request for a sequence of
 * several clips, and the source of the one clip otherwise, whose request names the virtual source
 * of the sequence.
 */
export function exportSourceIds(
  clips: readonly Clip[],
  request: Pick<ExportRequest, "sources">,
): string[] {
  if (isSequenceExport(clips)) {
    return request.sources.map((source) => source.id);
  }
  return clips.map((clip) => clip.sourceId);
}

/**
 * The absolute index of the effective audio stream of each of `sourceIds` (ADR 070), resolved
 * from `probes` and `overrides` at the call, or null for a source with no audio. A source that
 * `probes` does not hold resolves from its override alone.
 */
export function resolveEffectiveStreams(
  sourceIds: readonly string[],
  probes: Readonly<Record<string, Pick<ImportMediaResult, "probe">>>,
  overrides: Readonly<Record<string, AudioStreamOverride>>,
): Record<string, number | null> {
  const resolved: Record<string, number | null> = {};
  for (const id of sourceIds) {
    const probe = probes[id]?.probe ?? { audio: null, formatNames: [] };
    resolved[id] = effectiveAudioStreamOf(probe, overrides[id])?.index ?? null;
  }
  return resolved;
}

/**
 * True when one of `sourceIds` has no stream in `before`, or another stream in `after`: the
 * effective streams that the confirm step recorded before the save panel are not the streams of
 * the export after it (ADR 070).
 */
export function effectiveStreamsDiffer(
  sourceIds: readonly string[],
  before: Readonly<Record<string, number | null>>,
  after: Readonly<Record<string, number | null>>,
): boolean {
  return sourceIds.some((id) => before[id] === undefined || before[id] !== after[id]);
}

/**
 * The output path that `measurementScope` gives `composeExportRequest`. A measurement writes no
 * file, and the builders need a path; the scope drops it.
 */
const MEASUREMENT_OUTPUT_PATH = "measurement";

/**
 * The scope of the measurement of the audio of the export that the setup step would start now
 * (ADR 061): the request of `composeExportRequest`, with no output path and no audio mode. Null
 * when the request cannot be built.
 */
export function measurementScope(
  parts: Omit<
    ExportRequestParts,
    "outputPath" | "audioMode" | "adjustedAudioGainTenthsDb"
  >,
): LoudnessScope | null {
  const request = composeExportRequest({
    ...parts,
    outputPath: MEASUREMENT_OUTPUT_PATH,
    audioMode: "encode",
  });
  return request === null ? null : scopeOfRequest(request, parts);
}

/**
 * The effective audio stream of each source of `request`, by the id that the request names it by
 * (ADR 070). With one clip the request names the virtual source of the sequence, and the stream is
 * the one of the real source of that clip.
 */
function effectiveAudioOfRequest(
  request: ExportRequest,
  parts: Pick<ExportRequestParts, "timeline" | "sources" | "audioOverrides">,
): Record<string, AudioProbe | null> {
  const { clips } = parts.timeline;
  const sequence = isSequenceExport(clips);
  const effective: Record<string, AudioProbe | null> = {};
  for (const source of request.sources) {
    const id = sequence ? source.id : clips[0]?.sourceId;
    const probe =
      (id === undefined ? undefined : parts.sources[id]?.probe) ??
      ({ audio: null, formatNames: [] } as const);
    effective[source.id] = effectiveAudioStreamOf(
      probe,
      id === undefined ? undefined : parts.audioOverrides[id],
    );
  }
  return effective;
}

/** The scope of the measurement of the audio of `request`. */
function scopeOfRequest(
  request: ExportRequest,
  parts: Pick<ExportRequestParts, "timeline" | "sources" | "audioOverrides">,
): LoudnessScope {
  return {
    sources: request.sources,
    pieces: request.pieces,
    segmentCount: request.segmentCount,
    preset: request.preset,
    streams: request.streams,
    effectiveAudio: effectiveAudioOfRequest(request, parts),
  };
}

/**
 * The Adjust switch while it is active (ADR 061): the gain of the Gain field, and the identity of
 * the request that the step measured for it (`loudnessRequestId`). A null request means that the
 * step could not build a request, so it measured nothing, and the request carries the gain of the
 * preset.
 */
export type AdjustedGain =
  { readonly request: string; readonly tenthsDb: number } | { readonly request: null };

/** True when the probe of `media` names the FLV container. */
function isFlvMedia(media: MediaFlowDescriptor): boolean {
  return media.probe?.formatNames.includes("flv") ?? false;
}

/**
 * True when Back follows a run that ended with `error`, and the OPEN step must then compare each
 * source revision exactly (`strictSourceRevisionCheck`). That is the case after
 * `sourceRevisionMismatch`: the backend refused a file that the check had let pass as an FLV
 * that a recorder still writes (ADR 058).
 */
export function needsStrictRevisionCheck(
  error: { readonly code?: string } | null | undefined,
): boolean {
  return error?.code === "sourceRevisionMismatch";
}

/**
 * How long the replacement check of the OPEN step waits for the revision of the source file,
 * in milliseconds.
 *
 * A local disk answers in far less. A network share that stopped answering can hold the read
 * for much longer, and the OPEN step, and with it the Export action (`runExportFlow`), would
 * wait all that time. After this time the check counts the read as failed, which is not a
 * mismatch, so the setup step opens. The backend preflight of the export itself still reports
 * a file that it cannot read, with a code of its own.
 */
export const SOURCE_REVISION_CHECK_TIMEOUT_MS = 3000;

/** The rejection of a source check that did not answer within its time. */
class SourceRevisionCheckTimeout extends Error {
  constructor() {
    super("the source revision check did not answer in time");
    this.name = "SourceRevisionCheckTimeout";
  }
}

/**
 * Settles like `promise`, or rejects with `SourceRevisionCheckTimeout` when `promise` has not
 * settled after `timeoutMs`. The timer stops when `promise` settles first.
 */
function withinTime<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SourceRevisionCheckTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Dependency injection options for configuring export flow execution.
 */
export interface ExportFlowControllerOptions {
  /**
   * Callback to open or close the export modal dialog.
   */
  setModalOpen: (open: boolean) => void;

  /**
   * Localized filter name displayed in the native save dialog for an output with video.
   *
   * Required, with no default: the value is user-facing text and must come from a catalog
   * key (ADR 011). A default here would be an English literal with no key.
   */
  filterName: string;

  /**
   * Localized filter name displayed in the native save dialog for an audio-only output
   * (ADR 036). Required for the reason that `filterName` gives.
   */
  audioFilterName: string;

  /**
   * Dialog opener function. Defaults to `openExportSaveDialog`.
   */
  openSaveDialog?: (options: OpenExportSaveDialogOptions) => Promise<string | null>;

  /**
   * Provider for current media state. Defaults to the media of the attached clip.
   *
   * `size` and `mtime` are part of the shape because the replacement check compares them:
   * they are the revision of the file the segments were marked against (ADR 010).
   */
  getMedia?: () => MediaFlowDescriptor | null;

  /**
   * Reads the revision of the source file as it is on disk right now.
   * Defaults to the `read_source_revision` client.
   */
  readSourceRevision?: (path: string) => Promise<MediaSourceRevisionDescriptor>;

  /**
   * How long the replacement check waits for `readSourceRevision`, in milliseconds. Defaults
   * to `SOURCE_REVISION_CHECK_TIMEOUT_MS`.
   */
  sourceRevisionTimeoutMs?: number;

  /**
   * Skips the replacement check for this run.
   *
   * Set by the "Export anyway" action of the confirmation the check raises. The user has
   * already been told the file changed, so asking again would be a loop. The START step then
   * sends no expected revision, and the backend does not check the revision of the file.
   */
  skipSourceRevisionCheck?: boolean;

  /**
   * Compares each source revision exactly, also for an FLV that grew (ADR 058).
   *
   * Set by Back after a run that the backend refused with `sourceRevisionMismatch`
   * (`needsStrictRevisionCheck`). The replacement check let that file pass as an FLV that a
   * recorder still writes, and the backend found other bytes in front of the old size. The check
   * then raises the confirmation again, which offers "Export anyway", as before ADR 058.
   */
  strictSourceRevisionCheck?: boolean;

  /**
   * Provider for timeline segments. Defaults to `timelineStore.getState().segments`.
   */
  getSegments?: () => readonly Segment[];

  /**
   * Provider for active source ID. Defaults to `timelineStore.getState().sourceId`.
   */
  getSourceId?: () => string | null;

  /**
   * Provider for settings. Defaults to `settingsStore.getState().settings`.
   */
  getSettings?: () => Settings | null;

  /**
   * Provider for the audio stream overrides of the session (ADR 070). Defaults to
   * `audioOverrideStore.getState().overrides`.
   */
  getAudioOverrides?: () => Readonly<Record<string, AudioStreamOverride>>;

  /**
   * Asynchronous settings loader. Defaults to `settingsStore.getState().loadSettings`.
   */
  loadSettings?: () => Promise<unknown>;

  /**
   * Provider for the status and the `tracking` field of the state of the flow target, read
   * together. The target is the export store, or the compose store (`openExportFlow`).
   * Defaults to the two fields of `exportStore.getState()`. Together they decide whether the
   * target holds a live run (`isExportRunLive`). One provider gives both, so a caller cannot
   * mix an injected status with the tracking of the production store.
   */
  getExportState?: () => ExportRunLiveState;

  /**
   * Submits the assembled request to the export queue (ADR 049). Defaults to
   * `exportQueueStore.getState().submit`.
   */
  submit?: (request: ExportRequest) => Promise<ExportQueueSubmitResult>;

  /**
   * Reports an export error to the state of the flow target: the export store, or the compose
   * store. Defaults to `exportStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;

  /**
   * Request assembler function. Defaults to `buildExportRequest`.
   */
  buildRequest?: typeof buildExportRequest;

  /**
   * Resets the state of the flow target, the export store or the compose store, back to idle.
   * Defaults to `exportStore.getState().reset`.
   */
  reset?: () => void;

  /**
   * Asynchronous settings saver. Defaults to the store's `saveSettings` action to preserve
   * write queue serialization. Never defaults to raw IPC saveSettings (ADR 013, ADR 024).
   */
  saveSettings?: (settings: Settings) => Promise<unknown>;

  /**
   * The scope of the action that starts the OPEN step (ADR 067): the whole export for the Export
   * action, or the list of Export Selected Segments with its record. Defaults to the whole export.
   * The START step does not read it: it reads the scope of the setup step of its target
   * (`scopeStore`, `scopeTarget`).
   */
  scope?: ExportScope;

  /**
   * Sets the scope of the setup step of `scopeTarget`. The OPEN step calls it with `scope` only
   * when its target shows its setup step or the error of its checks. Defaults to `publishSetup`
   * of `scopeStore` for `scopeTarget`.
   */
  publishScope?: (scope: ExportScope) => void;

  /**
   * The store of the scopes of the flow (ADR 067). The START step reads the scope of the setup
   * step of its target there, and keeps the scope of its request there with the answer. Defaults
   * to `exportScopeStore`.
   */
  scopeStore?: ExportScopeStore;

  /**
   * The setup scope of the flow target (ADR 067): `export` for the export store, `compose` for the
   * compose store. Each target has its own setup scope, because the dialog can hold a step on each
   * at the same time. Defaults to `export`, the target of the defaults of this controller.
   */
  scopeTarget?: ExportScopeTarget;

  /**
   * The failure that the export store holds after a start that the backend refused with no run
   * id (`failed`). The START step keeps the scope of its request with it. Defaults to the error of
   * `exportStore`.
   */
  getStartFailure?: () => ExportError | null;

  /**
   * The failure that the state of the flow target holds now, or null: the export store, or the
   * compose store (`openExportFlow`). The OPEN step reads it after it reported the error of a
   * check, to know whether the dialog shows that error (ADR 067). Defaults to the error of
   * `exportStore`.
   */
  getError?: () => ExportError | null;
}

/**
 * Controller orchestrating the two-step export flow (ADR 024).
 */
export class ExportFlowController {
  private readonly setModalOpen: (open: boolean) => void;
  private readonly filterName: string;
  private readonly audioFilterName: string;
  private readonly openSaveDialogFn: (
    options: OpenExportSaveDialogOptions,
  ) => Promise<string | null>;
  private readonly getMediaFn: () => MediaFlowDescriptor | null;
  private readonly readSourceRevisionFn: (
    path: string,
  ) => Promise<MediaSourceRevisionDescriptor>;
  private readonly sourceRevisionTimeoutMs: number;
  private readonly skipSourceRevisionCheck: boolean;
  private readonly strictSourceRevisionCheck: boolean;
  private readonly getSegmentsFn: () => readonly Segment[];
  private readonly getSourceIdFn: () => string | null;
  private readonly getSettingsFn: () => Settings | null;
  private readonly getAudioOverridesFn: () => Readonly<
    Record<string, AudioStreamOverride>
  >;
  private readonly loadSettingsFn: () => Promise<unknown>;
  private readonly getExportStateFn: () => ExportRunLiveState;
  private readonly submitFn: (
    request: ExportRequest,
  ) => Promise<ExportQueueSubmitResult>;
  private readonly reportErrorFn: (error: unknown) => void;
  private readonly buildRequestFn: typeof buildExportRequest;
  private readonly resetFn: () => void;
  private readonly saveSettingsFn: (settings: Settings) => Promise<unknown>;
  private readonly scope: ExportScope;
  private readonly publishScopeFn: (scope: ExportScope) => void;
  private readonly scopeStore: ExportScopeStore;
  private readonly getStartFailureFn: () => ExportError | null;
  private readonly getErrorFn: () => ExportError | null;
  private readonly scopeTarget: ExportScopeTarget;

  constructor(options: ExportFlowControllerOptions) {
    this.setModalOpen = options.setModalOpen;
    this.filterName = options.filterName;
    this.audioFilterName = options.audioFilterName;
    this.openSaveDialogFn = options.openSaveDialog ?? openExportSaveDialog;
    this.getMediaFn = options.getMedia ?? (() => attachedMediaStore.getState().media);
    this.readSourceRevisionFn = options.readSourceRevision ?? readSourceRevision;
    this.sourceRevisionTimeoutMs =
      options.sourceRevisionTimeoutMs ?? SOURCE_REVISION_CHECK_TIMEOUT_MS;
    this.skipSourceRevisionCheck = options.skipSourceRevisionCheck ?? false;
    this.strictSourceRevisionCheck = options.strictSourceRevisionCheck ?? false;
    this.getSegmentsFn =
      options.getSegments ?? (() => timelineStore.getState().segments);
    this.getSourceIdFn =
      options.getSourceId ?? (() => timelineStore.getState().sourceId);
    this.getSettingsFn =
      options.getSettings ?? (() => settingsStore.getState().settings);
    this.getAudioOverridesFn =
      options.getAudioOverrides ?? (() => audioOverrideStore.getState().overrides);
    this.loadSettingsFn =
      options.loadSettings ?? (() => settingsStore.getState().loadSettings());
    this.getExportStateFn =
      options.getExportState ??
      (() => {
        const { status, tracking } = exportStore.getState();
        return { status, tracking };
      });
    this.submitFn =
      options.submit ?? ((req) => exportQueueStore.getState().submit(req));
    this.reportErrorFn =
      options.reportError ?? ((err) => exportStore.getState().reportError(err));
    this.buildRequestFn = options.buildRequest ?? buildExportRequest;
    this.resetFn = options.reset ?? (() => exportStore.getState().reset());
    this.saveSettingsFn =
      options.saveSettings ??
      ((settings) => settingsStore.getState().saveSettings(settings));
    this.scope = options.scope ?? WHOLE_EXPORT_SCOPE;
    this.scopeStore = options.scopeStore ?? exportScopeStore;
    this.scopeTarget = options.scopeTarget ?? "export";
    const scopeStore = this.scopeStore;
    const scopeTarget = this.scopeTarget;
    this.publishScopeFn =
      options.publishScope ??
      ((scope) => {
        scopeStore.getState().publishSetup(scopeTarget, scope);
      });
    this.getStartFailureFn =
      options.getStartFailure ?? (() => exportStore.getState().error);
    this.getErrorFn = options.getError ?? (() => exportStore.getState().error);
  }

  /**
   * The parts of the timeline that the segments of a scope read now: the timeline store, with
   * the segments and the active source of the providers of this controller.
   */
  private scopeInputNow(): ExportScopeInput {
    const timeline = timelineStore.getState();
    return {
      clips: timeline.clips,
      sequenceSegments: timeline.sequenceSegments,
      sequenceSources: timeline.sequenceSources,
      segments: this.getSegmentsFn(),
      sourceId: this.getSourceIdFn(),
    };
  }

  /** True when `scope` is valid now (`resolveExportScope`). The whole export is always valid. */
  private isScopeValidNow(scope: ExportScope): boolean {
    return (
      scope.kind === "export" || resolveExportScope(this.scopeInputNow(), scope).valid
    );
  }

  /**
   * Executes the OPEN step of the export flow (ADR 024).
   *
   * 1. If the store holds a live run (`isExportRunLive`), re-opens modal immediately on that run
   *    and returns false. A live run is preparing, running, or publishing, or failed while the
   *    store still tracks it: a Stop request failed, and the backend still encodes (ADR 025).
   *    The compose store never holds a run, so this step never fires for it (ADR 049).
   * 2. If the store is in a terminal state (finished, failed, or canceled) with no live run,
   *    resets it so the dialog can display the setup step.
   * 3. Resolves current settings, awaiting loadSettings if absent.
   * 4. If no media is loaded, reports `sourceNotFound`, opens the modal, and returns false.
   * 5. If no segment has the active source id, reports `noSegments`, opens the modal, and returns false.
   *    This check runs ahead of the setup step and save dialog.
   * 6. Stats the source file and compares its revision against the one segments were marked against.
   *    On a mismatch, reports `sourceRevisionChanged` confirmation, opens the modal, and returns false.
   *    Before the check, the limits of ADR 055 apply to the segments of the active source, one
   *    piece each (`exportLimitError`): more pieces than `MAX_EXPORT_PIECES` report
   *    `tooManySegments`, and pieces that need more runs than `MAX_EXPORT_INPUTS` report
   *    `piecesOutOfOrder`. A sequence of several clips does steps 5 and 6 on the pieces of its
   *    segments instead: no piece reports `noSegments`, the limits of ADR 055 report
   *    `tooManySegments`, `tooManySources` and `piecesOutOfOrder` in that order, a source of a
   *    piece without imported media reports `sourceNotFound`, and each source of a piece gets the
   *    revision check (ADR 053). Each limit refusal names its limit, and all come before the
   *    save dialog.
   * 7. On good path: calls `setModalOpen(true)` with the store at `idle` and returns true.
   *    It must NOT open the save dialog.
   *
   * The checks of steps 5 and 6 read the segments of `scope`, the scope of the action that
   * started this step (ADR 067). When the step shows the setup step or the error of a check, it
   * first tests that a list is still valid, and shows `selectedSegmentsChanged` when it is not.
   * It then sets the scope of the setup step to its scope (`publishScope`). A step that shows a
   * live run, or that shows nothing, sets no scope.
   */
  async run(): Promise<boolean> {
    const exportState = this.getExportStateFn();
    const currentStatus = exportState.status;
    // The reset below would drop the only record of a live run, so a live run shows instead.
    if (isExportRunLive(exportState)) {
      this.setModalOpen(true);
      return false;
    }

    if (
      currentStatus === "finished" ||
      currentStatus === "failed" ||
      currentStatus === "canceled"
    ) {
      this.resetFn();
    }

    if (!this.getSettingsFn()) {
      await this.loadSettingsFn();
    }

    const media = this.getMediaFn();
    if (!media) {
      return this.show(new ExportError({ code: "sourceNotFound" }));
    }

    const activeSourceId = this.getSourceIdFn();
    // The checks read the segments of the scope of the action (ADR 067).
    const scoped = narrowToExportScope(this.scopeInputNow(), this.scope);

    // A sequence of several clips exports its segments as pieces of several sources (ADR 053).
    if (timelineStore.getState().clips.length > 1) {
      const { pieces, sourceIds } = sequenceExportPieces(
        scoped.clips,
        scoped.sequenceSegments,
        new Map(Object.entries(scoped.sequenceSources)),
      );
      if (pieces.length === 0) {
        return this.show(new ExportError({ code: "noSegments" }));
      }
      const limitError = exportLimitError(pieces, sourceIds.length);
      if (limitError !== null) {
        return this.show(limitError);
      }
      // The request names the file of each source, so a source without imported media cannot
      // export.
      const imported = mediaStore.getState().sources;
      if (sourceIds.some((id) => imported[id] === undefined)) {
        return this.show(new ExportError({ code: "sourceNotFound" }));
      }
      if (!(await this.sourcesStillMatch(sourceIds))) {
        return this.show(new ExportError({ code: "sourceRevisionChanged" }));
      }
      return this.show(null);
    }

    const segments = scoped.segments;
    // The same match buildExportRequest and sourceRevisionStillMatches use
    if (
      !activeSourceId ||
      !segments.some((segment) => segment.sourceId === activeSourceId)
    ) {
      return this.show(new ExportError({ code: "noSegments" }));
    }
    // With one clip, each segment is one piece of the one source, in array order, as
    // buildExportRequest sends it.
    const limitError = exportLimitError(
      segments
        .filter((segment) => segment.sourceId === activeSourceId)
        .map((segment) => ({
          sourceId: activeSourceId,
          inPts: segment.inPts,
          outPts: segment.outPts,
        })),
      1,
    );
    if (limitError !== null) {
      return this.show(limitError);
    }

    if (!(await this.sourceRevisionStillMatches(media, activeSourceId, segments))) {
      // A confirmation, not a terminal failure. The dialog offers Export anyway, Re-import,
      // and Cancel, and "Export anyway" re-runs this flow with the check skipped.
      return this.show(new ExportError({ code: "sourceRevisionChanged" }));
    }

    return this.show(null);
  }

  /**
   * Shows the result of the checks of the OPEN step: the setup step for null, and else the error
   * of the check. Returns true when it shows the setup step.
   *
   * Before it shows anything for a list, it tests that the list is still valid. A list that is not
   * valid shows `selectedSegmentsChanged` in place of the result of the checks (ADR 067). It
   * reports the error and opens the modal. It then sets the scope of the setup step to the scope
   * of this step only when the dialog shows the step: the target is idle for the setup step, or
   * holds the error of this step. Otherwise it sets nothing. The result does not read that test:
   * it stays true when the checks passed, as before.
   */
  private show(error: ExportError | null): boolean {
    const shown = this.isScopeValidNow(this.scope)
      ? error
      : new ExportError({ code: "selectedSegmentsChanged" });
    if (shown !== null) {
      this.reportErrorFn(shown);
    }
    this.setModalOpen(true);
    // The dialog shows the state of the target. It shows the setup step of this step only while
    // the target is idle, and the error of this step only while the target holds that error
    // instance. The target can keep showing something else: a refusal of an earlier request
    // that arrived while this step waited, a live run that ignores the report, or the report of
    // a step that another step replaced. This step then shows nothing and sets no scope.
    const showsStep =
      shown === null
        ? this.getExportStateFn().status === "idle"
        : this.getErrorFn() === shown;
    if (showsStep) {
      this.publishScopeFn(this.scope);
    }
    return shown === null;
  }

  /**
   * Executes the START step of the export flow (ADR 024).
   *
   * 1. Reads settings through `getSettings` and finds the preset by id.
   *    When missing, reports `presetNotFound` and returns false.
   * 2. Opens the native save dialog with the extension of the output and the default name
   *    `<source name>_export.<extension>`. The extension is the `container` of the preset, or
   *    `m4a` or `mka` for an audio-only export (`exportOutputExtension`). The filter label of
   *    an audio-only export is `audioFilterName`, and `filterName` otherwise. The dialog
   *    reports a failure through the `reportError` of this controller.
   * 3. When the save dialog throws, reports `dialogFailed`, keeps the modal open, and returns false.
   * 4. When the user cancels (the dialog returns null), returns false and changes nothing (the dialog
   *    stays on the setup step).
   * 5. Re-reads media, segments, and the active source id, and builds the request with the
   *    preset of step 1, whole, and with `streams` and `audioMode`. The preset is the one that
   *    the setup step showed when the user confirmed, and the export renders with it even when
   *    the settings change later (ADR 049). The request also carries the revision of the media,
   *    which the segments were marked against, unless `skipSourceRevisionCheck` is set. A null
   *    request reports `noSegments` or `sourceNotFound`. A sequence of several clips builds the
   *    request from the pieces of its segments, with the path and the revision of each source
   *    (`buildSequenceExportRequest`). With `adjusted`, the request carries its gain when the
   *    request measures the same audio as the setup step measured for it. Otherwise the audio
   *    changed while the save panel was open, also from no request to a request, and the step
   *    returns false and keeps the modal open, where the setup step measures the new audio
   *    (ADR 061). The step records the effective audio stream of each source before the save
   *    panel opens. When the effective stream of a source of the request differs after the panel
   *    closes, the step sends nothing, returns false and keeps the modal open on the setup step
   *    (ADR 070). Each source with an override carries it as `audioStream`.
   * 6. Calls `setModalOpen(true)` and awaits `submit(request)`.
   *    - `refused`: no run exists. Reports the error of the result, for example
   *      `outputAlreadyQueued`, keeps the modal open, and returns false.
   *    - A rejection of `submit`: reports it the same way and returns false.
   *    - `failed`: the backend refused the start, for example with `invalidPreset`. The export
   *      store holds that failure, so this step reports nothing. Returns false.
   *    - `superseded`: a reset or an adoption replaced the start in the export store. The
   *      export store holds the state that replaced it, so this step reports nothing. Returns
   *      false.
   *    - `started`: the export store tracks the run, and the run shows there. `queued`: the
   *      run waits in the queue. Only these two results go on to the steps below.
   * 7. Re-reads settings. When non-null and still containing `presetId` where
   *    `presetId !== settings.activePresetId`, persists the choice via `saveSettings`.
   *    The save is fire-and-forget. Rejections are caught and ignored (ADR 024).
   * 8. Returns true.
   *
   * The step reads the scope of the setup step one time, when it starts (ADR 067). The default
   * name, the save dialog, the request and the answer use that scope. For a list, the step tests
   * that the list is valid before the save dialog opens and again after it closes, also after a
   * cancel but not after a failure of the dialog, and reports
   * `selectedSegmentsChanged` and sends nothing when it is not. A list that gives exactly one
   * segment gets the default name of `segmentFileName`. Each failure that the step reports, and a
   * start failure that the export store holds, keeps the scope (`keepFailure`). A run that the
   * queue takes keeps it by its run id (`keepRun`).
   */
  async confirm(
    presetId: string,
    streams: ExportStreams,
    audioMode: ExportAudioMode,
    adjusted?: AdjustedGain,
  ): Promise<boolean> {
    // ADR 067: the scope of the setup step of the target, read one time. Everything below uses it: the default
    // name, the save dialog, the request, and the answer to the request. Each failure that this
    // step reports keeps it (`fail`).
    const scope = this.scopeStore.getState().setup[this.scopeTarget];
    const fail = (error: unknown): void => {
      const normalized = normalizeExportError(error);
      this.scopeStore.getState().keepFailure(normalized, scope);
      this.reportErrorFn(normalized);
    };

    const settings = this.getSettingsFn();
    const preset = settings?.presets.find((p) => p.id === presetId);
    if (!settings || !preset) {
      fail(new ExportError({ code: "presetNotFound" }));
      this.setModalOpen(true);
      return false;
    }

    // A list that is no longer valid sends nothing (ADR 067).
    if (!this.isScopeValidNow(scope)) {
      fail(new ExportError({ code: "selectedSegmentsChanged" }));
      this.setModalOpen(true);
      return false;
    }

    const media = this.getMediaFn();
    // ADR 070: the effective audio streams of the step, resolved and recorded with its other facts
    // before the save panel opens. The sources of every clip hold the sources of the export.
    const streamsBefore = resolveEffectiveStreams(
      timelineStore.getState().clips.map((clip) => clip.sourceId),
      mediaStore.getState().sources,
      this.getAudioOverridesFn(),
    );
    const extension = exportOutputExtension(preset.container, streams);
    const defaultName = this.defaultNameOf(scope, media, extension);

    let outputPath: string | null;
    // True when the save dialog reported its own failure through `reportError`.
    let dialogReported = false;
    try {
      // The dialog reports its own failure, through the reporter of this controller and not
      // through the default of the dialog. The check of a null answer below reads
      // `getExportState`, so a caller that injects one of the two injects the other for the
      // same state.
      outputPath = await this.openSaveDialogFn({
        extension,
        filterName: streams === "audioOnly" ? this.audioFilterName : this.filterName,
        defaultName,
        reportError: (error) => {
          dialogReported = true;
          fail(error);
        },
      });
    } catch (err) {
      fail(
        err instanceof ExportError ? err : new ExportError({ code: "dialogFailed" }),
      );
      this.setModalOpen(true);
      return false;
    }

    // The timeline can change while the save dialog is open, as when an import ends (ADR 067).
    // The test runs before anything else, also when the user cancelled the dialog. A failure
    // that the dialog reported keeps its own report.
    if (!(!outputPath && dialogReported) && !this.isScopeValidNow(scope)) {
      fail(new ExportError({ code: "selectedSegmentsChanged" }));
      this.setModalOpen(true);
      return false;
    }

    if (!outputPath) {
      // If the dialog failed and reported through `reportError`, ensure the modal shows it;
      // otherwise on cancel leave the modal as-is on the setup step.
      if (this.getExportStateFn().status === "failed") {
        this.setModalOpen(true);
      }
      return false;
    }

    const currentMedia = this.getMediaFn();
    const currentSegments = this.getSegmentsFn();
    const currentSourceId = this.getSourceIdFn();
    const overrides = this.getAudioOverridesFn();
    const importedSources = mediaStore.getState().sources;

    const request = composeExportRequest({
      timeline: timelineStore.getState(),
      sources: importedSources,
      media: currentMedia,
      segments: currentSegments,
      sourceId: currentSourceId,
      outputPath,
      preset,
      streams,
      audioMode,
      skipSourceRevisionCheck: this.skipSourceRevisionCheck,
      adjustedAudioGainTenthsDb:
        adjusted?.request === null ? undefined : adjusted?.tenthsDb,
      audioOverrides: overrides,
      buildRequest: this.buildRequestFn,
      scope,
    });

    if (!request) {
      const code: ExportErrorCode = currentMedia ? "noSegments" : "sourceNotFound";
      fail(new ExportError({ code }));
      this.setModalOpen(true);
      return false;
    }
    const exportSources = exportSourceIds(timelineStore.getState().clips, request);
    if (
      effectiveStreamsDiffer(
        exportSources,
        streamsBefore,
        resolveEffectiveStreams(exportSources, importedSources, overrides),
      )
    ) {
      // The effective audio stream of a source of the export changed while the save panel was
      // open, as when the user chose another audio track. The setup step shows the facts of the
      // new stream, so the export starts from there.
      this.setModalOpen(true);
      return false;
    }
    if (
      adjusted !== undefined &&
      (adjusted.request === null ||
        loudnessRequestId(
          scopeOfRequest(request, {
            timeline: timelineStore.getState(),
            sources: importedSources,
            audioOverrides: overrides,
          }),
        ) !== adjusted.request)
    ) {
      // The gain belongs to the audio that the step measured, and the audio of the export
      // changed while the save panel was open.
      this.setModalOpen(true);
      return false;
    }

    this.setModalOpen(true);
    let result: ExportQueueSubmitResult;
    try {
      result = await this.submitFn(request);
    } catch (err) {
      fail(err);
      this.setModalOpen(true);
      return false;
    }
    if (result.kind === "refused") {
      // A refusal can arrive after another setup step opened (ADR 049). It keeps the scope of
      // this request with it, and the scope of the setup step does not change.
      fail(result.error);
      this.setModalOpen(true);
      return false;
    }
    if (result.kind === "failed") {
      // The export store holds the failure, so nothing is reported here. The scope of this
      // request stays with that failure.
      const failure = this.getStartFailureFn();
      if (failure !== null) {
        this.scopeStore.getState().keepFailure(failure, scope);
      }
      return false;
    }
    if (result.kind === "superseded") {
      // The export store holds the outcome, so nothing is reported here.
      return false;
    }
    // The run keeps the scope of its request by its id (ADR 067).
    this.scopeStore.getState().keepRun(result.runId, scope);

    const freshSettings = this.getSettingsFn();
    if (
      freshSettings &&
      freshSettings.presets.some((p) => p.id === presetId) &&
      presetId !== freshSettings.activePresetId
    ) {
      // Keep the catch because an injected saver can reject without failing the export.
      void this.saveSettingsFn(setActivePreset(freshSettings, presetId)).catch(
        () => {},
      );
    }

    return true;
  }

  /**
   * The name that the save dialog proposes (ADR 024, ADR 067). For a list that gives exactly one
   * segment, it is the name of `segmentFileName`, from the file that the first piece of that
   * segment reads. For the whole export, and for a list of two or more segments, it is
   * `<source name>_export.<extension>`. Undefined when the name of the file is not known.
   */
  private defaultNameOf(
    scope: ExportScope,
    media: MediaFlowDescriptor | null,
    extension: string,
  ): string | undefined {
    if (scope.kind === "list") {
      const { segments } = resolveExportScope(this.scopeInputNow(), scope);
      const only = segments.length === 1 ? segments[0] : undefined;
      if (only !== undefined) {
        const sourceId = only.pieces[0]?.sourceId;
        // With one clip, the attached media is the file of the one clip.
        const fileName =
          timelineStore.getState().clips.length > 1
            ? sourceId === undefined
              ? undefined
              : mediaStore.getState().sources[sourceId]?.fileName
            : media?.fileName;
        return fileName
          ? segmentFileName({
              sourceFileName: fileName,
              number: only.number,
              name: only.name,
              extension,
            })
          : undefined;
      }
    }
    return media?.fileName ? exportFileName(media.fileName, extension) : undefined;
  }

  /**
   * Reports whether the source file on disk is still the revision the segments were marked
   * against.
   *
   * Answers true whenever no mismatch was actually observed. With no media loaded there is
   * nothing to compare, and a read that FAILS is not a mismatch: a deleted file, a path that
   * is no longer a regular file, and a share that stopped answering are all reported by the
   * backend preflight with a translated code of their own, and claiming "the file changed" for
   * one of them would be a positive claim this check never made. A read that does not answer
   * within `sourceRevisionTimeoutMs` counts as a failed read, so a share that stopped answering
   * cannot hold the OPEN step, and the guard of `runExportFlow` with it, for longer than that.
   *
   * It also answers true when no segment carries the active source id. The confirmation says
   * the marked segments may no longer name the same frames, and nothing marked against this
   * revision is nothing a replacement can invalidate. Such a run has to end at `noSegments`
   * from the request builder, and the user must reach that in one dialog rather than name an
   * output file on the way to it.
   *
   * An FLV that a recorder still writes is no mismatch either: the same path, at least the bytes
   * of the import, and a modification time that is not earlier (ADR 058). The backend reads only
   * those bytes and compares their fingerprint, and a file that a recorder started again fails
   * there with `sourceRevisionMismatch`.
   */
  private async sourceRevisionStillMatches(
    media: MediaFlowDescriptor | null,
    activeSourceId: string | null,
    segments: readonly Segment[],
  ): Promise<boolean> {
    if (this.skipSourceRevisionCheck || !media) {
      return true;
    }
    // The same match the request builder applies, so the two agree on what "marked against
    // the active source" means.
    if (
      !activeSourceId ||
      !segments.some((segment) => segment.sourceId === activeSourceId)
    ) {
      return true;
    }
    let actual: MediaSourceRevisionDescriptor;
    try {
      actual = await withinTime(
        this.readSourceRevisionFn(media.path),
        this.sourceRevisionTimeoutMs,
      );
    } catch {
      // A failed read and a read that did not answer in time: neither is a mismatch.
      return true;
    }
    return mayHoldSourceRevision(media, actual, this.mayGrow(media));
  }

  /** True when the check accepts a larger, newer file for `media`: an FLV, unless strict. */
  private mayGrow(media: MediaFlowDescriptor): boolean {
    return !this.strictSourceRevisionCheck && isFlvMedia(media);
  }

  /**
   * The revision check of a sequence of several clips: each source that a piece uses must still
   * have the size and the modification time of its import, or be an FLV that a recorder only
   * added to (ADR 058). A read that fails or does not answer in time is no mismatch, as for one
   * source. The reads run together, so the OPEN step waits at most one
   * `sourceRevisionTimeoutMs`, whatever the number of sources.
   */
  private async sourcesStillMatch(sourceIds: readonly string[]): Promise<boolean> {
    if (this.skipSourceRevisionCheck) {
      return true;
    }
    const media = mediaStore.getState().sources;
    const matches = await Promise.all(
      sourceIds.map(async (id) => {
        const source = media[id];
        if (source === undefined) {
          return true;
        }
        let actual: MediaSourceRevisionDescriptor;
        try {
          actual = await withinTime(
            this.readSourceRevisionFn(source.path),
            this.sourceRevisionTimeoutMs,
          );
        } catch {
          return true;
        }
        return mayHoldSourceRevision(source, actual, this.mayGrow(source));
      }),
    );
    return matches.every(Boolean);
  }
}

/**
 * True when `scope` is valid with the timeline of the store now (`resolveExportScope`), as the
 * flow tests it with its default providers. The whole export is always valid. Back tests the
 * scope that it restores with it (ADR 067).
 */
export function isExportScopeValidNow(scope: ExportScope): boolean {
  return (
    scope.kind === "export" || resolveExportScope(timelineStore.getState(), scope).valid
  );
}

/**
 * Creates an instance of `ExportFlowController`.
 */
export function createExportFlowController(
  options: ExportFlowControllerOptions,
): ExportFlowController {
  return new ExportFlowController(options);
}

/** One OPEN step of `runExportFlow` that has not settled, and the media path it started for. */
interface OpenStep {
  readonly mediaPath: string | null;
}

/** The newest OPEN step of `runExportFlow` that has not settled, or null. Only `setOpenStep` sets it. */
let openStep: OpenStep | null = null;

/** The listeners of `subscribeExportOpenStep`. */
const openStepListeners = new Set<() => void>();

function setOpenStep(next: OpenStep | null): void {
  if (openStep === next) {
    return;
  }
  openStep = next;
  for (const listener of [...openStepListeners]) {
    listener();
  }
}

/**
 * True while an OPEN step of `runExportFlow` waits, before it opens the modal: it reads the
 * settings or checks the source. A step that `staleExportOpenStep` made stale does not count,
 * because it opens nothing. The recovery prompt (ADR 073) waits for it, so the export dialog
 * never opens over the prompt.
 */
export function isExportOpenStepWaiting(): boolean {
  return openStep !== null;
}

/**
 * Calls `listener` after each change of `isExportOpenStepWaiting`: a step that starts, and a step
 * that settles or goes stale. Answers the function that removes the listener.
 */
export function subscribeExportOpenStep(listener: () => void): () => void {
  openStepListeners.add(listener);
  return () => {
    openStepListeners.delete(listener);
  };
}

/**
 * Convenience helper to run the export flow OPEN step.
 *
 * One OPEN step runs at a time for one media path. The step awaits `loadSettings` and
 * `readSourceRevision` before it opens the modal, and on a network share the second one can
 * take seconds. A second call in that time, such as a second press of Export or of its key, or
 * the Export item of the macOS menu, does nothing and resolves to false. Without this, both
 * steps would run their checks, and each one would report its result and open the modal.
 *
 * The wait is bounded. The source check gives up after `sourceRevisionTimeoutMs`, so a share
 * that stopped answering cannot lock Export.
 *
 * A call for another media path runs at once: the user opened another file, and the step that
 * waits is about the file that is no longer open. That new step takes the place of the old
 * one. The old step then changes nothing when it settles: it does not open the modal and does
 * not report an error, because its result is about the old file.
 *
 * The guard is for every caller, the dialog included. A Back step of the dialog that became
 * stale because the dialog closed therefore also holds it until its check answers.
 */
export async function runExportFlow(
  options: ExportFlowControllerOptions,
): Promise<boolean> {
  // The default of the controller, read here because the guard compares the media path
  // before a controller exists.
  const getMedia = options.getMedia ?? (() => attachedMediaStore.getState().media);
  const mediaPath = getMedia()?.path ?? null;
  if (openStep !== null && openStep.mediaPath === mediaPath) {
    return false;
  }
  const step: OpenStep = { mediaPath };
  setOpenStep(step);
  const isCurrent = () => openStep === step;

  const reportError =
    options.reportError ??
    ((error: unknown) => exportStore.getState().reportError(error));
  const scopeStore = options.scopeStore ?? exportScopeStore;
  const scopeTarget = options.scopeTarget ?? "export";
  const publishScope =
    options.publishScope ??
    ((scope: ExportScope) => {
      scopeStore.getState().publishSetup(scopeTarget, scope);
    });
  const controller = new ExportFlowController({
    ...options,
    getMedia,
    setModalOpen: (open) => {
      if (isCurrent()) {
        options.setModalOpen(open);
      }
    },
    reportError: (error) => {
      if (isCurrent()) {
        reportError(error);
      }
    },
    // A step that another step replaced shows nothing, so it sets no scope (ADR 067).
    publishScope: (scope) => {
      if (isCurrent()) {
        publishScope(scope);
      }
    },
  });
  try {
    const opened = await controller.run();
    // A step that another step replaced changed nothing, so it did not open the setup step.
    return isCurrent() && opened;
  } finally {
    if (isCurrent()) {
      setOpenStep(null);
    }
  }
}

/**
 * Makes the OPEN step of `runExportFlow` that waits stale (ADR 072, open step 2). That step then
 * opens no modal, reports no error and publishes no scope when it settles, and a new step can
 * start at once. The open of a project calls it before it changes the session. Does nothing when
 * no step waits.
 */
export function staleExportOpenStep(): void {
  setOpenStep(null);
}

/**
 * Convenience helper to run the export flow START step with a chosen preset, the streams that
 * the export writes, and how it writes the audio.
 */
export function confirmExportFlow(
  options: ExportFlowControllerOptions,
  presetId: string,
  streams: ExportStreams,
  audioMode: ExportAudioMode,
  adjusted?: AdjustedGain,
): Promise<boolean> {
  return new ExportFlowController(options).confirm(
    presetId,
    streams,
    audioMode,
    adjusted,
  );
}

/** The stores that `openExportFlow` reads. Each one defaults to its production store. */
export interface OpenExportFlowDependencies {
  /** The export store, which holds the live run. Defaults to `exportStore`. */
  exportStore?: ExportStore;
  /** The export queue store, which holds the waiting runs. Defaults to `exportQueueStore`. */
  queueStore?: ExportQueueStore;
  /** The compose store. Defaults to `exportComposeStore`. */
  composeStore?: ExportComposeStore;
}

/**
 * The options of `openExportFlow`. The flow chooses the target options itself, so a caller
 * cannot pass them.
 */
export type OpenExportFlowOptions = Omit<
  ExportFlowControllerOptions,
  keyof ExportFlowTarget
>;

/** Binds the three target options of the controller to an export store. */
function exportStoreFlowTarget(store: ExportStore): ExportFlowTarget {
  return {
    getExportState: () => {
      const { status, tracking } = store.getState();
      return { status, tracking };
    },
    reportError: (error) => {
      store.getState().reportError(error);
    },
    reset: () => {
      store.getState().reset();
    },
    getError: () => store.getState().error,
    scopeTarget: "export",
  };
}

/**
 * Runs the OPEN step of the Export action: the button of the title bar, the Export item of
 * the File menu, and its keyboard shortcut (ADR 049).
 *
 * The flow decides the target of the step when it is called:
 *
 * - While the export store holds a live run (`isExportRunLive`), or runs wait in the queue,
 *   or a submission has no answer yet (`hasPendingExportWork`), a new export joins the queue.
 *   The step then reads, reports to, and resets the compose store. A failure of the step
 *   therefore never replaces the live run in the export store. The compose store never holds
 *   a run, so its state is never live (`isExportRunLive`), and the early return of the OPEN
 *   step that shows a live run never fires for it. The step runs its checks instead. When
 *   the step opens the modal, it first calls `enter` of the compose store.
 * - Otherwise the step uses the export store, as `runExportFlow` does by default. When the
 *   step opens the modal, it first calls `exit` of the compose store, because no export runs
 *   or waits and the dialog shows the export store.
 *
 * The guard of `runExportFlow` applies. A step that does nothing, or that another step
 * replaced, does not open the modal, and so it does not change the compose state.
 *
 * @returns What `runExportFlow` returns: true when the setup step opened.
 */
export function openExportFlow(
  options: OpenExportFlowOptions,
  dependencies: OpenExportFlowDependencies = {},
): Promise<boolean> {
  const exportStoreApi = dependencies.exportStore ?? exportStore;
  const queueStoreApi = dependencies.queueStore ?? exportQueueStore;
  const composeStoreApi = dependencies.composeStore ?? exportComposeStore;

  const composes =
    isExportRunLive(exportStoreApi.getState()) ||
    hasPendingExportWork(queueStoreApi.getState());

  if (composes) {
    return runExportFlow({
      ...options,
      ...createComposeFlowTarget(composeStoreApi),
      setModalOpen: (open) => {
        if (open) {
          composeStoreApi.getState().enter();
        }
        options.setModalOpen(open);
      },
    });
  }
  return runExportFlow({
    ...options,
    ...exportStoreFlowTarget(exportStoreApi),
    setModalOpen: (open) => {
      if (open) {
        composeStoreApi.getState().exit();
      }
      options.setModalOpen(open);
    },
  });
}
