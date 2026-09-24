/**
 * Pure export flow controller for QuipClip layout.
 *
 * Implements the two-step export flow per ADR 024:
 * 1. Open step (`run`): shows a live run, resets the store after a run that ended,
 *    verifies media presence, validates that marked segments exist for the active source,
 *    and runs the source disk revision check before opening the modal at the setup step.
 * 2. Start step (`confirm`): validates the chosen preset, opens the native save dialog
 *    with that preset's container extension, builds the export request, starts export rendering,
 *    and updates activePresetId in settings if the preset changed.
 */

import {
  buildExportRequest,
  exportStore,
  isExportRunLive,
  openExportSaveDialog,
  ExportError,
  type ExportErrorCode,
  type ExportRequest,
  type ExportStart,
  type ExportRunLiveState,
  type OpenExportSaveDialogOptions,
} from "@/features/export";
import {
  isSameSourceRevision,
  mediaStore,
  readSourceRevision,
  type MediaSourceRevisionDescriptor,
} from "@/features/media";
import { settingsStore } from "@/features/settings";
import { setActivePreset } from "@/features/settings/presetDocument";
import type { Settings } from "@/features/settings/types";
import { timelineStore } from "@/features/timeline";
import type { Segment } from "@/types/project";

/**
 * The media facts the export flow reads: the source path, the name the default output name is
 * derived from, and the revision the marked segments belong to.
 */
export type MediaFlowDescriptor = MediaSourceRevisionDescriptor & {
  fileName?: string;
};

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
   * Localized filter name displayed in the native save dialog.
   *
   * Required, with no default: the value is user-facing text and must come from a catalog
   * key (ADR 011). A default here would be an English literal with no key.
   */
  filterName: string;

  /**
   * Dialog opener function. Defaults to `openExportSaveDialog`.
   */
  openSaveDialog?: (options: OpenExportSaveDialogOptions) => Promise<string | null>;

  /**
   * Provider for current media state. Defaults to `mediaStore.getState().media`.
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
   * already been told the file changed, so asking again would be a loop.
   */
  skipSourceRevisionCheck?: boolean;

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
   * Asynchronous settings loader. Defaults to `settingsStore.getState().loadSettings`.
   */
  loadSettings?: () => Promise<unknown>;

  /**
   * Provider for the status and the `tracking` field of the export store, read together.
   * Defaults to the two fields of `exportStore.getState()`. Together they decide whether the
   * store holds a live run (`isExportRunLive`). One provider gives both, so a caller cannot
   * mix an injected status with the tracking of the production store.
   */
  getExportState?: () => ExportRunLiveState;

  /**
   * Starts media export with the assembled request. Defaults to `exportStore.getState().startExport`.
   */
  startExport?: (request: ExportRequest) => Promise<ExportStart | null>;

  /**
   * Reports an export error to the store. Defaults to `exportStore.getState().reportError`.
   */
  reportError?: (error: unknown) => void;

  /**
   * Request assembler function. Defaults to `buildExportRequest`.
   */
  buildRequest?: typeof buildExportRequest;

  /**
   * Resets the export store back to idle state. Defaults to `exportStore.getState().reset`.
   */
  reset?: () => void;

  /**
   * Asynchronous settings saver. Defaults to the store's `saveSettings` action to preserve
   * write queue serialization. Never defaults to raw IPC saveSettings (ADR 013, ADR 024).
   */
  saveSettings?: (settings: Settings) => Promise<unknown>;
}

/**
 * Controller orchestrating the two-step export flow (ADR 024).
 */
export class ExportFlowController {
  private readonly setModalOpen: (open: boolean) => void;
  private readonly filterName: string;
  private readonly openSaveDialogFn: (
    options: OpenExportSaveDialogOptions,
  ) => Promise<string | null>;
  private readonly getMediaFn: () => MediaFlowDescriptor | null;
  private readonly readSourceRevisionFn: (
    path: string,
  ) => Promise<MediaSourceRevisionDescriptor>;
  private readonly sourceRevisionTimeoutMs: number;
  private readonly skipSourceRevisionCheck: boolean;
  private readonly getSegmentsFn: () => readonly Segment[];
  private readonly getSourceIdFn: () => string | null;
  private readonly getSettingsFn: () => Settings | null;
  private readonly loadSettingsFn: () => Promise<unknown>;
  private readonly getExportStateFn: () => ExportRunLiveState;
  private readonly startExportFn: (
    request: ExportRequest,
  ) => Promise<ExportStart | null>;
  private readonly reportErrorFn: (error: unknown) => void;
  private readonly buildRequestFn: typeof buildExportRequest;
  private readonly resetFn: () => void;
  private readonly saveSettingsFn: (settings: Settings) => Promise<unknown>;

  constructor(options: ExportFlowControllerOptions) {
    this.setModalOpen = options.setModalOpen;
    this.filterName = options.filterName;
    this.openSaveDialogFn = options.openSaveDialog ?? openExportSaveDialog;
    this.getMediaFn = options.getMedia ?? (() => mediaStore.getState().media);
    this.readSourceRevisionFn = options.readSourceRevision ?? readSourceRevision;
    this.sourceRevisionTimeoutMs =
      options.sourceRevisionTimeoutMs ?? SOURCE_REVISION_CHECK_TIMEOUT_MS;
    this.skipSourceRevisionCheck = options.skipSourceRevisionCheck ?? false;
    this.getSegmentsFn =
      options.getSegments ?? (() => timelineStore.getState().segments);
    this.getSourceIdFn =
      options.getSourceId ?? (() => timelineStore.getState().sourceId);
    this.getSettingsFn =
      options.getSettings ?? (() => settingsStore.getState().settings);
    this.loadSettingsFn =
      options.loadSettings ?? (() => settingsStore.getState().loadSettings());
    this.getExportStateFn =
      options.getExportState ??
      (() => {
        const { status, tracking } = exportStore.getState();
        return { status, tracking };
      });
    this.startExportFn =
      options.startExport ?? ((req) => exportStore.getState().startExport(req));
    this.reportErrorFn =
      options.reportError ?? ((err) => exportStore.getState().reportError(err));
    this.buildRequestFn = options.buildRequest ?? buildExportRequest;
    this.resetFn = options.reset ?? (() => exportStore.getState().reset());
    this.saveSettingsFn =
      options.saveSettings ??
      ((settings) => settingsStore.getState().saveSettings(settings));
  }

  /**
   * Executes the OPEN step of the export flow (ADR 024).
   *
   * 1. If the store holds a live run (`isExportRunLive`), re-opens modal immediately on that run
   *    and returns false. A live run is preparing, running, or publishing, or failed while the
   *    store still tracks it: a Stop request failed, and the backend still encodes (ADR 025).
   * 2. If the export store is in a terminal state (finished, failed, or canceled) with no live run,
   *    resets it so the dialog can display the setup step.
   * 3. Resolves current settings, awaiting loadSettings if absent.
   * 4. If no media is loaded, reports `sourceNotFound`, opens the modal, and returns false.
   * 5. If no segment has the active source id, reports `noSegments`, opens the modal, and returns false.
   *    This check runs ahead of the setup step and save dialog.
   * 6. Stats the source file and compares its revision against the one segments were marked against.
   *    On a mismatch, reports `sourceRevisionChanged` confirmation, opens the modal, and returns false.
   * 7. On good path: calls `setModalOpen(true)` with the store at `idle` and returns true.
   *    It must NOT open the save dialog.
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
      this.reportErrorFn(new ExportError({ code: "sourceNotFound" }));
      this.setModalOpen(true);
      return false;
    }

    const activeSourceId = this.getSourceIdFn();
    const segments = this.getSegmentsFn();

    // The same match buildExportRequest and sourceRevisionStillMatches use
    if (
      !activeSourceId ||
      !segments.some((segment) => segment.sourceId === activeSourceId)
    ) {
      this.reportErrorFn(new ExportError({ code: "noSegments" }));
      this.setModalOpen(true);
      return false;
    }

    if (!(await this.sourceRevisionStillMatches(media, activeSourceId, segments))) {
      // A confirmation, not a terminal failure. The dialog offers Export anyway, Re-import,
      // and Cancel, and "Export anyway" re-runs this flow with the check skipped.
      this.reportErrorFn(new ExportError({ code: "sourceRevisionChanged" }));
      this.setModalOpen(true);
      return false;
    }

    this.setModalOpen(true);
    return true;
  }

  /**
   * Executes the START step of the export flow (ADR 024).
   *
   * 1. Reads settings through `getSettings` and finds the preset by id.
   *    When missing, reports `presetNotFound` and returns false.
   * 2. Opens the native save dialog with that preset's `container` and default name
   *    `<source name>_export.<container>`.
   * 3. When the save dialog throws, reports `dialogFailed`, keeps the modal open, and returns false.
   * 4. When the user cancels (the dialog returns null), returns false and changes nothing (the dialog
   *    stays on the setup step).
   * 5. Re-reads media, segments, and the active source id, and builds the request with `presetId`.
   *    A null request reports `noSegments` or `sourceNotFound`.
   * 6. Calls `setModalOpen(true)` and `startExport(request)` without awaiting it.
   * 7. Re-reads settings. When non-null and still containing `presetId` where
   *    `presetId !== settings.activePresetId`, persists the choice via `saveSettings`.
   *    The save is fire-and-forget; rejections are caught and ignored (ADR 024).
   * 8. Returns true.
   */
  async confirm(presetId: string): Promise<boolean> {
    const settings = this.getSettingsFn();
    const preset = settings?.presets.find((p) => p.id === presetId);
    if (!settings || !preset) {
      this.reportErrorFn(new ExportError({ code: "presetNotFound" }));
      this.setModalOpen(true);
      return false;
    }

    const media = this.getMediaFn();
    const defaultName = media?.fileName
      ? `${media.fileName.replace(/\.[^/.]+$/, "")}_export.${preset.container}`
      : undefined;

    let outputPath: string | null;
    try {
      outputPath = await this.openSaveDialogFn({
        container: preset.container,
        filterName: this.filterName,
        defaultName,
      });
    } catch (err) {
      this.reportErrorFn(
        err instanceof ExportError ? err : new ExportError({ code: "dialogFailed" }),
      );
      this.setModalOpen(true);
      return false;
    }

    if (!outputPath) {
      // If openExportSaveDialog failed and reported to the store, ensure modal shows it;
      // otherwise on cancel leave modal as-is on the setup step.
      if (this.getExportStateFn().status === "failed") {
        this.setModalOpen(true);
      }
      return false;
    }

    const currentMedia = this.getMediaFn();
    const currentSegments = this.getSegmentsFn();
    const currentSourceId = this.getSourceIdFn();

    const request = this.buildRequestFn({
      media: currentMedia,
      outputPath,
      segments: currentSegments,
      activeSourceId: currentSourceId,
      presetId,
    });

    if (!request) {
      const code: ExportErrorCode = currentMedia ? "noSegments" : "sourceNotFound";
      this.reportErrorFn(new ExportError({ code }));
      this.setModalOpen(true);
      return false;
    }

    this.setModalOpen(true);
    void this.startExportFn(request);

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
    return isSameSourceRevision(media, actual);
  }
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

/** The newest OPEN step of `runExportFlow` that has not settled, or null. */
let openStep: OpenStep | null = null;

/** How `runExportFlow` treats an OPEN step that has not settled. */
export interface OpenStepGuardOptions {
  /**
   * Runs the step at once, also while a step for the same media path has not settled. The new
   * step takes the place of that step, which then changes nothing when it settles.
   *
   * The export dialog sets it when it opens again on the setup step after the settings dialog
   * (`exportSettingsReturn.ts`). The step that waits can then be a Back step that the dialog
   * made stale when it closed, and a refusal would show the setup step with no source check
   * of its own.
   */
  readonly replace?: boolean;
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
 * stale because the dialog closed therefore also holds it until its check answers. A caller
 * that must have a check of its own passes `replace` (`OpenStepGuardOptions`).
 */
export async function runExportFlow(
  options: ExportFlowControllerOptions,
  guard: OpenStepGuardOptions = {},
): Promise<boolean> {
  // The default of the controller, read here because the guard compares the media path
  // before a controller exists.
  const getMedia = options.getMedia ?? (() => mediaStore.getState().media);
  const mediaPath = getMedia()?.path ?? null;
  if (guard.replace !== true && openStep !== null && openStep.mediaPath === mediaPath) {
    return false;
  }
  const step: OpenStep = { mediaPath };
  openStep = step;
  const isCurrent = () => openStep === step;

  const reportError =
    options.reportError ??
    ((error: unknown) => exportStore.getState().reportError(error));
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
  });
  try {
    const opened = await controller.run();
    // A step that another step replaced changed nothing, so it did not open the setup step.
    return isCurrent() && opened;
  } finally {
    if (isCurrent()) {
      openStep = null;
    }
  }
}

/**
 * Convenience helper to run the export flow START step with a chosen preset.
 */
export function confirmExportFlow(
  options: ExportFlowControllerOptions,
  presetId: string,
): Promise<boolean> {
  return new ExportFlowController(options).confirm(presetId);
}
