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
import { mediaStore } from "@/features/media";
import { settingsStore } from "@/features/settings";
import type { Settings } from "@/features/settings/types";
import { timelineStore } from "@/features/timeline";
import type { Segment } from "@/types/project";

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
   */
  getMedia?: () => { path: string; fileName?: string } | null;

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
  private readonly getMediaFn: () => { path: string; fileName?: string } | null;
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

    const activeSourceId = this.getSourceIdFn();
    const segments = this.getSegmentsFn();

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
