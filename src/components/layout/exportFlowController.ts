/**
 * Pure export flow controller for QuipClip layout.
 *
 * Coordinates checking running export state, resolving settings with container
 * extension, opening the save dialog, assembling the export request from media
 * and timeline store states, and dispatching export initiation or reporting errors.
 */

import {
  buildExportRequest,
  exportStore,
  openExportSaveDialog,
  ExportError,
  type ExportErrorCode,
  type ExportRequest,
  type ExportStart,
  type ExportStatus,
  type OpenExportSaveDialogOptions,
} from "@/features/export";
import {
  isSameSourceRevision,
  mediaStore,
  readSourceRevision,
  type MediaSourceRevisionDescriptor,
} from "@/features/media";
import { settingsStore } from "@/features/settings";
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
   * Provider for current export status. Defaults to `exportStore.getState().status`.
   */
  getExportStatus?: () => ExportStatus;

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
}

/**
 * Controller orchestrating the full export flow.
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
  private readonly skipSourceRevisionCheck: boolean;
  private readonly getSegmentsFn: () => readonly Segment[];
  private readonly getSourceIdFn: () => string | null;
  private readonly getSettingsFn: () => Settings | null;
  private readonly loadSettingsFn: () => Promise<unknown>;
  private readonly getExportStatusFn: () => ExportStatus;
  private readonly startExportFn: (
    request: ExportRequest,
  ) => Promise<ExportStart | null>;
  private readonly reportErrorFn: (error: unknown) => void;
  private readonly buildRequestFn: typeof buildExportRequest;

  constructor(options: ExportFlowControllerOptions) {
    this.setModalOpen = options.setModalOpen;
    this.filterName = options.filterName;
    this.openSaveDialogFn = options.openSaveDialog ?? openExportSaveDialog;
    this.getMediaFn = options.getMedia ?? (() => mediaStore.getState().media);
    this.readSourceRevisionFn = options.readSourceRevision ?? readSourceRevision;
    this.skipSourceRevisionCheck = options.skipSourceRevisionCheck ?? false;
    this.getSegmentsFn =
      options.getSegments ?? (() => timelineStore.getState().segments);
    this.getSourceIdFn =
      options.getSourceId ?? (() => timelineStore.getState().sourceId);
    this.getSettingsFn =
      options.getSettings ?? (() => settingsStore.getState().settings);
    this.loadSettingsFn =
      options.loadSettings ?? (() => settingsStore.getState().loadSettings());
    this.getExportStatusFn =
      options.getExportStatus ?? (() => exportStore.getState().status);
    this.startExportFn =
      options.startExport ?? ((req) => exportStore.getState().startExport(req));
    this.reportErrorFn =
      options.reportError ?? ((err) => exportStore.getState().reportError(err));
    this.buildRequestFn = options.buildRequest ?? buildExportRequest;
  }

  /**
   * Executes the export flow.
   *
   * 1. If an export is already preparing, running, or publishing, re-opens modal immediately.
   * 2. Resolves current settings, awaiting loadSettings if absent and re-reading the STORE afterwards.
   * 2a. Reads the active source id and the segments, then, if any segment is marked against
   *    that source, stats the source file and compares its revision against the one those
   *    segments were marked against. On a mismatch it raises the `sourceRevisionChanged`
   *    confirmation and stops. This runs BEFORE the save dialog, so the user is never asked to
   *    name a file for an export that may then be refused.
   * 3. Opens native save dialog with preset container and filterName.
   * 4. If save dialog returns null, checks store status: if "failed", re-opens modal with dialogFailed;
   *    if not failed (cancel), leaves modal closed and reports nothing.
   * 5. Builds ExportRequest using timeline store's active sourceId and segments in array order.
   * 6. If request is null: reports "noSegments" (if media loaded) or "sourceNotFound" (if no media),
   *    and opens modal so the error is displayed.
   * 7. On good path: opens modal and starts export.
   */
  async run(): Promise<boolean> {
    const currentStatus = this.getExportStatusFn();
    if (
      currentStatus === "preparing" ||
      currentStatus === "running" ||
      currentStatus === "publishing"
    ) {
      this.setModalOpen(true);
      return false;
    }

    let settings = this.getSettingsFn();
    if (!settings) {
      await this.loadSettingsFn();
      settings = this.getSettingsFn();
    }

    const activePreset = settings?.presets.find(
      (preset) => preset.id === settings?.activePresetId,
    );
    const container = activePreset?.container ?? "mp4";

    const media = this.getMediaFn();
    const activeSourceId = this.getSourceIdFn();
    const segments = this.getSegmentsFn();

    if (!(await this.sourceRevisionStillMatches(media, activeSourceId, segments))) {
      // A confirmation, not a terminal failure. The dialog offers Export anyway, Re-import,
      // and Cancel, and "Export anyway" re-runs this flow with the check skipped.
      this.reportErrorFn(new ExportError({ code: "sourceRevisionChanged" }));
      this.setModalOpen(true);
      return false;
    }

    const defaultName = media?.fileName
      ? `${media.fileName.replace(/\.[^/.]+$/, "")}_export.${container}`
      : undefined;

    let outputPath: string | null;
    try {
      outputPath = await this.openSaveDialogFn({
        container,
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
      // BLOCKING 3: Distinguish cancel from failure.
      // A cancel leaves status untouched (e.g. "idle"); a dialog failure leaves status "failed".
      if (this.getExportStatusFn() === "failed") {
        this.setModalOpen(true);
      }
      return false;
    }

    const request = this.buildRequestFn({
      media,
      outputPath,
      segments,
      activeSourceId,
      presetId: settings?.activePresetId,
    });

    if (!request) {
      // BLOCKING 1: Report rejected request rather than silent no-op.
      const code: ExportErrorCode = media ? "noSegments" : "sourceNotFound";
      this.reportErrorFn(new ExportError({ code }));
      this.setModalOpen(true);
      return false;
    }

    this.setModalOpen(true);
    void this.startExportFn(request);
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
   * one of them would be a positive claim this check never made.
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
      actual = await this.readSourceRevisionFn(media.path);
    } catch {
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

/**
 * Convenience helper to run the export flow end-to-end.
 */
export function runExportFlow(options: ExportFlowControllerOptions): Promise<boolean> {
  return new ExportFlowController(options).run();
}
