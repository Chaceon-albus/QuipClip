import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmExportFlow,
  createExportFlowController,
  ExportFlowController,
  openExportFlow,
  runExportFlow,
  SOURCE_REVISION_CHECK_TIMEOUT_MS,
  type MediaFlowDescriptor,
} from "./exportFlowController";
import {
  cancelExport as clientCancelExport,
  createExportComposeStore,
  createExportQueueStore,
  createExportStore,
  ExportError,
  type ExportAudioMode,
  type ExportProgressEvent,
  type ExportQueueSubmitResult,
  type ExportRequest,
  type ExportSubmission,
  type ExportStatus,
  type ExportStreams,
  type OpenExportSaveDialogOptions,
} from "@/features/export";
import { mediaStore, type MediaSourceRevisionDescriptor } from "@/features/media";
import type { ImportMediaResult } from "@/features/media/types";
import { timelineStore } from "@/features/timeline";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Preset, Settings } from "@/features/settings/types";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import { createPresetDraft } from "@/features/settings/presetDocument";

/**
 * Builds the media facts the flow reads. `size` and `mtime` are part of the shape because the
 * flow compares them against the file on disk before it opens the save dialog: they are the
 * revision the marked segments belong to (ADR 010).
 */
function createMedia(
  path: string,
  fileName: string,
  revision: Partial<MediaSourceRevisionDescriptor> = {},
): MediaFlowDescriptor {
  return { path, fileName, size: 4096, mtime: 1_700_000_000, ...revision };
}

/**
 * A reader that answers the revision the media already holds, so the file on disk is
 * unchanged. Every test that loads media injects one: the default reader is the real IPC
 * client, and a test must never depend on what an absent backend answers.
 */
function createMatchingReader(
  media: MediaFlowDescriptor,
): (path: string) => Promise<MediaSourceRevisionDescriptor> {
  return vi.fn().mockResolvedValue({
    path: media.path,
    size: media.size,
    mtime: media.mtime,
  });
}

/**
 * Builds a timeline segment. `inPts` and `outPts` are canonical decimal strings
 * branded as `Pts` (ADR 002), matching `src/features/export/request.test.ts`.
 */
function createSegment(
  id: string,
  sourceId: string,
  inPts: string,
  outPts: string,
): Segment {
  return {
    id,
    sourceId,
    inPts: inPts as Pts,
    outPts: outPts as Pts,
  };
}

/**
 * Builds a complete export preset. Every field of the real `Preset` shape is set,
 * so the fixture needs no cast and stays honest about the wire schema.
 */
function createPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default",
    name: "Default",
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    pixelFormat: "yuv420p",
    videoOptions: [],
    audioOptions: [],
    ...overrides,
  };
}

/**
 * Builds a settings document whose active preset is the supplied preset or activePresetId.
 */
function createSettings(presets: Preset[], activePresetId?: string): Settings {
  return {
    schemaVersion: 2,
    revision: 7,
    activePresetId: activePresetId ?? presets[0]?.id,
    presets,
  };
}

/** The answer of a submission that started at once (ADR 049). */
const STARTED: ExportQueueSubmitResult = { kind: "started", runId: "run-1" };

describe("ExportFlowController", () => {
  describe("run (OPEN step)", () => {
    it("run never calls the save dialog, and it opens the modal on the good path", async () => {
      const setModalOpen = vi.fn();
      const openSaveDialog = vi.fn();
      const submit = vi.fn();
      const reportError = vi.fn();
      const media = createMedia("/media/video.mp4", "video.mp4");
      const preset = createPreset();

      const controller = createExportFlowController({
        setModalOpen,
        openSaveDialog,
        submit,
        reportError,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getMedia: () => media,
        readSourceRevision: createMatchingReader(media),
        getSourceId: () => "source-1",
        getSegments: () => [createSegment("s1", "source-1", "0", "100")],
        getSettings: () => createSettings([preset]),
      });

      const result = await controller.run();

      expect(result).toBe(true);
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("run reports sourceNotFound before any save dialog when media is absent", async () => {
      const setModalOpen = vi.fn();
      const openSaveDialog = vi.fn();
      const reportError = vi.fn();
      const readSourceRevision = vi.fn();

      const result = await runExportFlow({
        setModalOpen,
        openSaveDialog,
        reportError,
        readSourceRevision,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getMedia: () => null,
        getSourceId: () => null,
        getSegments: () => [],
        getSettings: () => createSettings([createPreset()]),
      });

      expect(result).toBe(false);
      expect(readSourceRevision).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "sourceNotFound" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
    });

    it("run reports noSegments before any save dialog when segments are absent", async () => {
      const setModalOpen = vi.fn();
      const openSaveDialog = vi.fn();
      const reportError = vi.fn();
      const media = createMedia("/media/sample.mp4", "sample.mp4");

      const result = await runExportFlow({
        setModalOpen,
        openSaveDialog,
        reportError,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getMedia: () => media,
        readSourceRevision: createMatchingReader(media),
        getSourceId: () => "source-1",
        getSegments: () => [],
        getSettings: () => createSettings([createPreset()]),
      });

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "noSegments" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
    });

    it("run reports tooManySegments for more segments than an export joins", async () => {
      const reportError = vi.fn();
      const media = createMedia("/media/sample.mp4", "sample.mp4");
      const readSourceRevision = createMatchingReader(media);

      const result = await runExportFlow({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn(),
        reportError,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getMedia: () => media,
        readSourceRevision,
        getSourceId: () => "source-1",
        getSegments: () =>
          Array.from({ length: 49 }, (_, index) =>
            createSegment(`s${index}`, "source-1", "0", "100"),
          ),
        getSettings: () => createSettings([createPreset()]),
      });

      expect(result).toBe(false);
      expect(readSourceRevision).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "tooManySegments" }),
      );
    });

    it("run accepts exactly as many segments as an export joins", async () => {
      const reportError = vi.fn();
      const media = createMedia("/media/sample.mp4", "sample.mp4");

      const result = await runExportFlow({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn(),
        reportError,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getMedia: () => media,
        readSourceRevision: createMatchingReader(media),
        getSourceId: () => "source-1",
        getSegments: () =>
          Array.from({ length: 48 }, (_, index) =>
            createSegment(`s${index}`, "source-1", "0", "100"),
          ),
        getSettings: () => createSettings([createPreset()]),
      });

      expect(result).toBe(true);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("run resets a terminal store status", async () => {
      for (const terminalStatus of ["finished", "failed", "canceled"] as const) {
        const setModalOpen = vi.fn();
        const reset = vi.fn();
        const media = createMedia("/media/video.mp4", "video.mp4");

        const result = await runExportFlow({
          setModalOpen,
          reset,
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getExportState: () => ({ status: terminalStatus, tracking: false }),
          getMedia: () => media,
          readSourceRevision: createMatchingReader(media),
          getSourceId: () => "source-1",
          getSegments: () => [createSegment("s1", "source-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
        });

        expect(reset).toHaveBeenCalledOnce();
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(result).toBe(true);
      }
    });

    it("awaits loadSettings fallback when settings are absent", async () => {
      const setModalOpen = vi.fn();
      let currentSettings: Settings | null = null;
      const loadSettings = vi.fn().mockImplementation(() => {
        currentSettings = createSettings([createPreset({ id: "loaded-preset" })]);
        return Promise.resolve(null);
      });
      const media = createMedia("/media/clip.mp4", "clip.mp4");

      const result = await runExportFlow({
        setModalOpen,
        loadSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getSettings: () => currentSettings,
        getMedia: () => media,
        readSourceRevision: createMatchingReader(media),
        getSourceId: () => "src-1",
        getSegments: () => [createSegment("s1", "src-1", "0", "100")],
      });

      expect(result).toBe(true);
      expect(loadSettings).toHaveBeenCalledOnce();
      expect(setModalOpen).toHaveBeenCalledWith(true);
    });

    it("opens modal and returns true when loadSettings resolves but getSettings still returns null", async () => {
      const setModalOpen = vi.fn();
      const loadSettings = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/clip.mp4", "clip.mp4");

      const result = await runExportFlow({
        setModalOpen,
        loadSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getSettings: () => null,
        getMedia: () => media,
        readSourceRevision: createMatchingReader(media),
        getSourceId: () => "src-1",
        getSegments: () => [createSegment("s1", "src-1", "0", "100")],
      });

      expect(result).toBe(true);
      expect(loadSettings).toHaveBeenCalledOnce();
      expect(setModalOpen).toHaveBeenCalledWith(true);
    });

    it("opens modal immediately without opening save dialog if an export is already active", async () => {
      for (const activeStatus of ["preparing", "running", "publishing"] as const) {
        const setModalOpen = vi.fn();
        const openSaveDialog = vi.fn();
        const submit = vi.fn();

        const result = await runExportFlow({
          setModalOpen,
          openSaveDialog,
          submit,
          getExportState: () => ({ status: activeStatus, tracking: false }),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(false);
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(openSaveDialog).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      }
    });

    it("opens the modal on a failed run that the store still tracks, and does not reset it", async () => {
      // A Stop request failed, and the backend still encodes. A reset would drop the only
      // record of that run.
      const setModalOpen = vi.fn();
      const reset = vi.fn();
      const reportError = vi.fn();
      const openSaveDialog = vi.fn();
      const media = createMedia("/media/video.mp4", "video.mp4");
      const readSourceRevision = createMatchingReader(media);

      const result = await runExportFlow({
        setModalOpen,
        reset,
        reportError,
        openSaveDialog,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "failed", tracking: true }),
        getMedia: () => media,
        readSourceRevision,
        getSourceId: () => "source-1",
        getSegments: () => [createSegment("s1", "source-1", "0", "100")],
        getSettings: () => createSettings([createPreset()]),
      });

      expect(result).toBe(false);
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(reset).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      expect(readSourceRevision).not.toHaveBeenCalled();
      expect(openSaveDialog).not.toHaveBeenCalled();
    });

    describe("run on a real store with a Stop that waited for the run id", () => {
      /**
       * Drives a real export store into a tracked start with a Stop that waits for its run
       * id. The `cancel_export` request that follows the answer fails at the IPC layer. The
       * flow reads and resets that store.
       */
      async function stopWhileTheStartWaits() {
        let emit!: (event: ExportProgressEvent) => void;
        let answerStart: (start: ExportSubmission) => void = () => {};
        const startFn = vi.fn(
          () =>
            new Promise<ExportSubmission>((resolve) => {
              answerStart = resolve;
            }),
        );
        const store = createExportStore({
          subscribeExportProgress: (handler) => {
            emit = handler;
            return Promise.resolve(() => {});
          },
          startExport: startFn,
          cancelExport: (runId) =>
            clientCancelExport(runId, {
              invoke: vi.fn().mockRejectedValue("IPC closed"),
            }),
        });
        const starting = store.getState().startExport({
          sources: [{ id: "source", path: "/media/video.mp4" }],
          outputPath: "/media/out.mp4",
          pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "100" as Pts }],
          segmentCount: 1,
          preset: createPresetDraft("default", "Test preset"),
          streams: "videoAndAudio",
          audioMode: "encode",
        });
        await vi.waitFor(() => {
          expect(startFn).toHaveBeenCalled();
        });
        const stopping = store.getState().cancelExport();
        expect(store.getState()).toMatchObject({
          status: "preparing",
          tracking: true,
          cancelRequested: true,
        });
        return {
          store,
          starting,
          stopping,
          emit: (event: ExportProgressEvent) => {
            emit(event);
          },
          answerStart: (start: ExportSubmission) => {
            answerStart(start);
          },
        };
      }

      function runOn(store: ReturnType<typeof createExportStore>) {
        const setModalOpen = vi.fn();
        const media = createMedia("/media/video.mp4", "video.mp4");
        const result = runExportFlow({
          setModalOpen,
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getExportState: () => store.getState(),
          reset: () => {
            store.getState().reset();
          },
          reportError: (err) => {
            store.getState().reportError(err);
          },
          getMedia: () => media,
          readSourceRevision: createMatchingReader(media),
          getSourceId: () => "source-1",
          getSegments: () => [createSegment("s1", "source-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
        });
        return { result, setModalOpen };
      }

      it("shows the waiting start, and the store still takes its answer", async () => {
        const { store, starting, stopping, answerStart } =
          await stopWhileTheStartWaits();

        const { result, setModalOpen } = runOn(store);

        await expect(result).resolves.toBe(false);
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(store.getState()).toMatchObject({ status: "preparing", tracking: true });

        answerStart({ runId: "run-kept", queued: false });
        await expect(starting).resolves.toMatchObject({ runId: "run-kept" });
        await expect(stopping).resolves.toBe(false);
        expect(store.getState()).toMatchObject({
          status: "failed",
          runId: "run-kept",
          tracking: true,
        });

        // The failed Stop keeps the run, so the flow still only shows it.
        const again = runOn(store);
        await expect(again.result).resolves.toBe(false);
        expect(store.getState()).toMatchObject({ runId: "run-kept", tracking: true });
      });

      it("resets and reaches the setup step once the kept run ended", async () => {
        const { store, starting, stopping, answerStart, emit } =
          await stopWhileTheStartWaits();
        answerStart({ runId: "run-kept", queued: false });
        await starting;
        await stopping;
        emit({ event: "failed", runId: "run-kept", code: "ffmpegProcessFailed" });

        const { result, setModalOpen } = runOn(store);

        await expect(result).resolves.toBe(true);
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(store.getState()).toMatchObject({ status: "idle", tracking: false });
      });
    });

    describe("the source replacement check in run", () => {
      it("a changed file raises the confirmation and never reaches the save dialog", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const openSaveDialog = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn().mockResolvedValue({
          path: media.path,
          size: media.size + 1,
          mtime: media.mtime + 60,
        });

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          openSaveDialog,
          readSourceRevision,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [createSegment("s1", "src-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(false);
        expect(readSourceRevision).toHaveBeenCalledWith("/media/source.mp4");
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "sourceRevisionChanged" }),
        );
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(openSaveDialog).not.toHaveBeenCalled();
      });

      it("an mtime change alone is a mismatch", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const openSaveDialog = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const touched = { ...media, mtime: media.mtime + 1 };

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          openSaveDialog,
          readSourceRevision: vi.fn().mockResolvedValue(touched),
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [createSegment("s1", "src-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(false);
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "sourceRevisionChanged" }),
        );
        expect(openSaveDialog).not.toHaveBeenCalled();
      });

      it("skipSourceRevisionCheck proceeds to the setup step without reading the file", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const openSaveDialog = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn();

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          openSaveDialog,
          readSourceRevision,
          skipSourceRevisionCheck: true,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [createSegment("s1", "src-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(true);
        expect(readSourceRevision).not.toHaveBeenCalled();
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(openSaveDialog).not.toHaveBeenCalled();
        expect(reportError).not.toHaveBeenCalled();
      });

      it("a read that FAILS is not a mismatch and the flow proceeds", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn().mockRejectedValue({ code: "pathNotFound" });

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          readSourceRevision,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [createSegment("s1", "src-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(true);
        expect(readSourceRevision).toHaveBeenCalledOnce();
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(reportError).not.toHaveBeenCalled();
      });

      it("a changed file with nothing marked reports noSegments and never confirms", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const submit = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn().mockResolvedValue({
          path: media.path,
          size: media.size + 1,
          mtime: media.mtime + 60,
        });

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          submit,
          readSourceRevision,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(false);
        expect(readSourceRevision).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledOnce();
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "noSegments" }),
        );
        expect(submit).not.toHaveBeenCalled();
      });

      it("segments marked against another source do not raise the confirmation", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn().mockResolvedValue({
          path: media.path,
          size: media.size + 1,
          mtime: media.mtime + 60,
        });

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          readSourceRevision,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [createSegment("s1", "src-other", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
        });

        expect(result).toBe(false);
        expect(readSourceRevision).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "noSegments" }),
        );
      });
    });

    describe("one open step at a time", () => {
      /**
       * A step whose settings load and source check wait until the test answers them.
       * `answerCheck` answers the revision of the media, or a changed size when `changed` is
       * true.
       */
      function startPendingStep(
        path = "/media/video.mp4",
        extra: { sourceRevisionTimeoutMs?: number } = {},
      ) {
        const media = createMedia(path, "video.mp4");
        let finishLoad: () => void = () => {};
        let answerCheck: (changed: boolean) => void = () => {};
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const loadSettings = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLoad = resolve;
            }),
        );
        const readSourceRevision = vi.fn(
          () =>
            new Promise<MediaSourceRevisionDescriptor>((resolve) => {
              answerCheck = (changed) => {
                resolve({
                  path: media.path,
                  size: changed ? media.size + 1 : media.size,
                  mtime: media.mtime,
                });
              };
            }),
        );
        let settings: Settings | null = null;
        const step = runExportFlow({
          setModalOpen,
          reportError,
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          readSourceRevision,
          getSourceId: () => "source-1",
          getSegments: () => [createSegment("s1", "source-1", "0", "100")],
          getSettings: () => settings,
          loadSettings,
          ...extra,
        });
        return {
          step,
          setModalOpen,
          reportError,
          loadSettings,
          readSourceRevision,
          finishLoad: () => {
            settings = createSettings([createPreset()]);
            finishLoad();
          },
          answerCheck: (changed = false) => {
            answerCheck(changed);
          },
        };
      }

      /** A second step with its own spies, which must not run while the first one is open. */
      function secondStepOptions(path = "/media/video.mp4") {
        const media = createMedia(path, "video.mp4");
        return {
          setModalOpen: vi.fn(),
          reportError: vi.fn(),
          reset: vi.fn(),
          loadSettings: vi.fn().mockResolvedValue(undefined),
          readSourceRevision: createMatchingReader(media),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getExportState: () => ({ status: "idle" as const, tracking: false }),
          getMedia: () => media,
          getSourceId: () => "source-1",
          getSegments: () => [createSegment("s1", "source-1", "0", "100")],
          getSettings: () => createSettings([createPreset()]),
        };
      }

      it("does nothing for a second call while the settings load", async () => {
        const first = startPendingStep();
        await vi.waitFor(() => {
          expect(first.loadSettings).toHaveBeenCalled();
        });

        const second = secondStepOptions();
        await expect(runExportFlow(second)).resolves.toBe(false);
        expect(second.setModalOpen).not.toHaveBeenCalled();
        expect(second.reportError).not.toHaveBeenCalled();
        expect(second.reset).not.toHaveBeenCalled();
        expect(second.readSourceRevision).not.toHaveBeenCalled();

        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });
        first.answerCheck();
        await expect(first.step).resolves.toBe(true);
        expect(first.setModalOpen).toHaveBeenCalledTimes(1);
      });

      it("does nothing for a second call while the source check runs", async () => {
        const first = startPendingStep();
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });

        const second = secondStepOptions();
        await expect(runExportFlow(second)).resolves.toBe(false);
        expect(second.setModalOpen).not.toHaveBeenCalled();
        expect(second.readSourceRevision).not.toHaveBeenCalled();

        first.answerCheck();
        await expect(first.step).resolves.toBe(true);
        expect(first.readSourceRevision).toHaveBeenCalledTimes(1);
        expect(first.setModalOpen).toHaveBeenCalledTimes(1);
      });

      it("runs the next call after the step settles", async () => {
        const first = startPendingStep();
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });
        first.answerCheck();
        await first.step;

        const second = secondStepOptions();
        await expect(runExportFlow(second)).resolves.toBe(true);
        expect(second.setModalOpen).toHaveBeenCalledWith(true);
      });

      it("runs the next call after a step that failed", async () => {
        const failing = secondStepOptions();
        const step = runExportFlow({
          ...failing,
          getSettings: () => null,
          loadSettings: vi.fn().mockRejectedValue(new Error("load failed")),
        });
        await expect(step).rejects.toThrow("load failed");

        const next = secondStepOptions();
        await expect(runExportFlow(next)).resolves.toBe(true);
      });

      it("opens the setup step when the source check does not answer in time", async () => {
        // A share that stopped answering: the check never answers. The step counts that as a
        // failed read, which is not a mismatch.
        const first = startPendingStep("/media/video.mp4", {
          sourceRevisionTimeoutMs: 20,
        });
        first.finishLoad();

        await expect(first.step).resolves.toBe(true);
        expect(first.readSourceRevision).toHaveBeenCalledTimes(1);
        expect(first.reportError).not.toHaveBeenCalled();
        expect(first.setModalOpen).toHaveBeenCalledWith(true);

        // The guard is free again, so Export works after the timeout.
        const next = secondStepOptions();
        await expect(runExportFlow(next)).resolves.toBe(true);
        expect(next.setModalOpen).toHaveBeenCalledWith(true);

        // An answer that arrives after the timeout changes nothing.
        first.answerCheck(true);
        await Promise.resolve();
        expect(first.reportError).not.toHaveBeenCalled();
        expect(first.setModalOpen).toHaveBeenCalledTimes(1);
      });

      it("waits SOURCE_REVISION_CHECK_TIMEOUT_MS by default", async () => {
        vi.useFakeTimers();
        try {
          const media = createMedia("/media/video.mp4", "video.mp4");
          const setModalOpen = vi.fn();
          let settled = false;
          const step = runExportFlow({
            setModalOpen,
            reportError: vi.fn(),
            filterName: "Video Files",
            audioFilterName: "Audio Files",
            getExportState: () => ({ status: "idle", tracking: false }),
            getMedia: () => media,
            readSourceRevision: () =>
              new Promise<MediaSourceRevisionDescriptor>(() => {}),
            getSourceId: () => "source-1",
            getSegments: () => [createSegment("s1", "source-1", "0", "100")],
            getSettings: () => createSettings([createPreset()]),
          }).then((opened) => {
            settled = true;
            return opened;
          });

          await vi.advanceTimersByTimeAsync(SOURCE_REVISION_CHECK_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          expect(setModalOpen).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await expect(step).resolves.toBe(true);
          expect(setModalOpen).toHaveBeenCalledWith(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it("stops the timer when the source check answers first", async () => {
        vi.useFakeTimers();
        try {
          const first = startPendingStep();
          first.finishLoad();
          await vi.advanceTimersByTimeAsync(0);
          expect(vi.getTimerCount()).toBe(1);

          first.answerCheck();
          await expect(first.step).resolves.toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("runs a call for another media path at once", async () => {
        const first = startPendingStep("/media/first.mp4");
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });

        // The user opened another file while the check of the first one waits.
        const second = secondStepOptions("/media/second.mp4");
        await expect(runExportFlow(second)).resolves.toBe(true);
        expect(second.readSourceRevision).toHaveBeenCalledWith("/media/second.mp4");
        expect(second.setModalOpen).toHaveBeenCalledWith(true);

        // The old step then answers that its file changed. That result is about a file that
        // is no longer open, so the step changes nothing.
        first.answerCheck(true);
        await expect(first.step).resolves.toBe(false);
        expect(first.reportError).not.toHaveBeenCalled();
        expect(first.setModalOpen).not.toHaveBeenCalled();
      });

      it("keeps the guard of the new step when the step it replaced settles", async () => {
        const first = startPendingStep("/media/first.mp4");
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });
        const second = startPendingStep("/media/second.mp4");
        second.finishLoad();
        await vi.waitFor(() => {
          expect(second.readSourceRevision).toHaveBeenCalled();
        });

        first.answerCheck();
        await expect(first.step).resolves.toBe(false);

        // The step for the second file still runs, so another call for it does nothing.
        const third = secondStepOptions("/media/second.mp4");
        await expect(runExportFlow(third)).resolves.toBe(false);
        expect(third.setModalOpen).not.toHaveBeenCalled();

        second.answerCheck();
        await expect(second.step).resolves.toBe(true);
        expect(second.setModalOpen).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("confirm (START step)", () => {
    it("confirm with a missing preset reports presetNotFound", async () => {
      const setModalOpen = vi.fn();
      const reportError = vi.fn();
      const openSaveDialog = vi.fn();
      const submit = vi.fn();
      const saveSettings = vi.fn();

      const controller = new ExportFlowController({
        setModalOpen,
        reportError,
        openSaveDialog,
        submit,
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm(
        "non-existent-preset",
        "videoAndAudio",
        "encode",
      );

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "presetNotFound" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm uses the SELECTED preset's container for the extension and default name, not active preset's container", async () => {
      const openSaveDialog = vi.fn().mockResolvedValue("/out/rendered.mov");
      const submit = vi.fn().mockResolvedValue(STARTED);
      const media = createMedia("/media/clip.mp4", "clip.mp4");

      const activePreset = createPreset({ id: "p-mp4", container: "mp4" });
      const selectedPreset = createPreset({ id: "p-mov", container: "mov" });
      const settings = createSettings([activePreset, selectedPreset], "p-mp4");

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog,
        submit,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p-mov", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(openSaveDialog).toHaveBeenCalledWith({
        extension: "mov",
        filterName: "Video Files",
        defaultName: "clip_export.mov",
        reportError: expect.any(Function) as unknown,
      });
    });

    it("confirm hands its own reporter to the save dialog", async () => {
      // An injected state, as a caller that does not use the export store has one. The
      // reporter and the state provider are injected together.
      let status: ExportStatus = "idle";
      const reportError = vi.fn(() => {
        status = "failed";
      });
      const setModalOpen = vi.fn();
      const failure = new ExportError({ code: "dialogFailed" });
      // The dialog reports its failure itself and then answers null (`openExportSaveDialog`).
      const openSaveDialog = vi.fn((options: OpenExportSaveDialogOptions) => {
        options.reportError?.(failure);
        return Promise.resolve(null);
      });
      const submit = vi.fn();
      const preset = createPreset({ id: "p1" });

      const controller = createExportFlowController({
        setModalOpen,
        reportError,
        getExportState: () => ({ status, tracking: false }),
        openSaveDialog,
        submit,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => createSettings([preset], "p1"),
        getMedia: () => createMedia("/media/clip.mp4", "clip.mp4"),
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p1", "videoAndAudio", "encode");

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
      // The failure reached the injected state, so the modal opens to show it.
      expect(setModalOpen).toHaveBeenCalledExactlyOnceWith(true);
      expect(submit).not.toHaveBeenCalled();
    });

    describe("the stream choice", () => {
      const media = createMedia("/media/clip.mov", "clip.mov");

      function confirmWith(
        preset: Preset,
        streams: ExportStreams,
        audioMode: ExportAudioMode = "encode",
      ) {
        const openSaveDialog = vi.fn().mockResolvedValue("/out/chosen.name");
        const submit = vi.fn().mockResolvedValue(STARTED);
        const controller = createExportFlowController({
          setModalOpen: vi.fn(),
          openSaveDialog,
          submit,
          saveSettings: vi.fn().mockResolvedValue(null),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getSettings: () => createSettings([preset]),
          getMedia: () => media,
          getSourceId: () => "s1",
          getSegments: () => [createSegment("seg1", "s1", "0", "100")],
        });
        return {
          result: controller.confirm(preset.id, streams, audioMode),
          openSaveDialog,
          submit,
        };
      }

      it.each([
        ["mp4", "videoAndAudio", "mp4", "Video Files"],
        ["mov", "videoAndAudio", "mov", "Video Files"],
        ["mkv", "videoAndAudio", "mkv", "Video Files"],
        ["mp4", "videoOnly", "mp4", "Video Files"],
        ["mov", "videoOnly", "mov", "Video Files"],
        ["mkv", "videoOnly", "mkv", "Video Files"],
        ["mp4", "audioOnly", "m4a", "Audio Files"],
        ["mov", "audioOnly", "m4a", "Audio Files"],
        ["mkv", "audioOnly", "mka", "Audio Files"],
      ] as const)(
        "a %s preset with %s names a .%s file with the filter %s",
        async (container, streams, extension, filterName) => {
          const preset = createPreset({ id: "p1", container });
          const { result, openSaveDialog, submit } = confirmWith(preset, streams);

          expect(await result).toBe(true);
          expect(openSaveDialog).toHaveBeenCalledWith({
            extension,
            filterName,
            defaultName: `clip_export.${extension}`,
            reportError: expect.any(Function) as unknown,
          });
          expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
              outputPath: "/out/chosen.name",
              preset,
              streams,
            }),
          );
        },
      );

      it.each(["encode", "copy"] as const)(
        "starts the export with the audio mode %s",
        async (audioMode) => {
          const preset = createPreset({ id: "p1", container: "mp4" });
          const { result, submit } = confirmWith(preset, "audioOnly", audioMode);

          expect(await result).toBe(true);
          expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({ streams: "audioOnly", audioMode }),
          );
        },
      );
    });

    it("confirm with the save dialog cancelled starts nothing and saves nothing", async () => {
      const setModalOpen = vi.fn();
      const reportError = vi.fn();
      const submit = vi.fn();
      const saveSettings = vi.fn();
      const openSaveDialog = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/clip.mp4", "clip.mp4");

      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");

      const controller = createExportFlowController({
        setModalOpen,
        reportError,
        openSaveDialog,
        submit,
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2", "videoAndAudio", "encode");

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
      expect(setModalOpen).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm when save dialog throws reports dialogFailed, keeps modal open, and returns false", async () => {
      const setModalOpen = vi.fn();
      const reportError = vi.fn();
      const submit = vi.fn();
      const openSaveDialog = vi.fn().mockRejectedValue(new Error("dialog crashed"));

      const controller = createExportFlowController({
        setModalOpen,
        reportError,
        openSaveDialog,
        submit,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm("p1", "videoAndAudio", "encode");

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "dialogFailed" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(submit).not.toHaveBeenCalled();
    });

    it("confirm when save dialog leaves status failed opens modal", async () => {
      const setModalOpen = vi.fn();
      let storeStatus: "idle" | "failed" = "idle";
      const openSaveDialog = vi.fn().mockImplementation(() => {
        storeStatus = "failed";
        return Promise.resolve(null);
      });

      const controller = createExportFlowController({
        setModalOpen,
        openSaveDialog,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getExportState: () => ({ status: storeStatus, tracking: false }),
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm("p1", "videoAndAudio", "encode");

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
      expect(setModalOpen).toHaveBeenCalledWith(true);
    });

    it("confirm passes the whole preset in the request and respects segment array order", async () => {
      const submit = vi.fn().mockResolvedValue(STARTED);
      const openSaveDialog = vi.fn().mockResolvedValue("/out/destination.mp4");
      const media = createMedia("/media/source.mp4", "source.mp4");
      const sourceId = "source-clip-1";

      const segments: Segment[] = [
        createSegment("seg-1", sourceId, "1000", "2000"),
        createSegment("seg-2", sourceId, "5000", "6000"),
        createSegment("seg-foreign", "other-source", "10", "20"),
        createSegment("seg-3", sourceId, "3000", "4000"),
      ];

      const preset = createPreset({ id: "custom-p" });
      const settings = createSettings([preset], "custom-p");

      const setModalOpen = vi.fn();
      const controller = createExportFlowController({
        setModalOpen,
        openSaveDialog,
        submit,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => sourceId,
        getSegments: () => segments,
      });

      const result = await controller.confirm("custom-p", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(submit).toHaveBeenCalledOnce();
      expect(setModalOpen.mock.invocationCallOrder[0]).toBeLessThan(
        submit.mock.invocationCallOrder[0],
      );
      const passedRequest = submit.mock.calls[0][0] as ExportRequest;
      // The request carries the stream choice and the audio mode that the setup step passed.
      expect(passedRequest).toStrictEqual({
        sources: [
          {
            id: sourceId,
            path: "/media/source.mp4",
            // The revision of the media, which the segments were marked against.
            expectedRevision: { size: 4096, mtime: 1_700_000_000 },
          },
        ],
        outputPath: "/out/destination.mp4",
        preset,
        streams: "videoAndAudio",
        audioMode: "encode",
        pieces: [
          { sourceId, inPts: "1000", outPts: "2000" },
          { sourceId, inPts: "5000", outPts: "6000" },
          { sourceId, inPts: "3000", outPts: "4000" },
        ],
        segmentCount: 3,
      });
    });

    it("confirm sends no expected revision after the user accepted a changed source", async () => {
      // "Export anyway" sets the option. The backend must not refuse the file that the user
      // accepted (ADR 024).
      const submit = vi.fn().mockResolvedValue(STARTED);
      const preset = createPreset({ id: "p1" });

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit,
        saveSettings: vi.fn().mockResolvedValue(null),
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        skipSourceRevisionCheck: true,
        getSettings: () => createSettings([preset], "p1"),
        getMedia: () => createMedia("/media/v.mp4", "v.mp4"),
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      expect(await controller.confirm("p1", "videoAndAudio", "encode")).toBe(true);
      const request = submit.mock.calls[0][0] as ExportRequest;
      expect(request.sources[0]).not.toHaveProperty("expectedRevision");
    });

    it("confirm saves activePresetId when it differs, and does not save when it is equal", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");
      const media = createMedia("/media/v.mp4", "v.mp4");

      // Case 1: differs -> saves
      const saveSettingsDiff = vi.fn().mockResolvedValue(null);
      const controllerDiff = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit: vi.fn().mockResolvedValue(STARTED),
        saveSettings: saveSettingsDiff,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      await controllerDiff.confirm("p2", "videoAndAudio", "encode");
      expect(saveSettingsDiff).toHaveBeenCalledOnce();
      expect(saveSettingsDiff).toHaveBeenCalledWith(
        expect.objectContaining({ activePresetId: "p2" }),
      );

      // Case 2: equal -> does not save
      const saveSettingsSame = vi.fn().mockResolvedValue(null);
      const controllerSame = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit: vi.fn().mockResolvedValue(STARTED),
        saveSettings: saveSettingsSame,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      await controllerSame.confirm("p1", "videoAndAudio", "encode");
      expect(saveSettingsSame).not.toHaveBeenCalled();
    });

    it("a rejected settings save still leaves the export started", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");
      const media = createMedia("/media/v.mp4", "v.mp4");

      const submit = vi.fn().mockResolvedValue(STARTED);
      const saveSettings = vi.fn().mockRejectedValue(new Error("conflict"));

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit,
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(submit).toHaveBeenCalledOnce();
      expect(saveSettings).toHaveBeenCalledOnce();
    });

    it("confirm reads the settings store again after the save dialog and persists the fresh document", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const initialSettings = createSettings([p1, p2], "p1");
      const updatedSettings = {
        ...createSettings([p1, p2], "p1"),
        revision: 12,
      };

      const getSettings = vi
        .fn()
        .mockReturnValueOnce(initialSettings)
        .mockReturnValue(updatedSettings);
      const saveSettings = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/v.mp4", "v.mp4");

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit: vi.fn().mockResolvedValue(STARTED),
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(saveSettings).toHaveBeenCalledOnce();
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: 12,
          activePresetId: "p2",
        }),
      );
    });

    it("confirm skips saving active preset when the fresh document is null after save dialog", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const initialSettings = createSettings([p1, p2], "p1");

      const getSettings = vi
        .fn()
        .mockReturnValueOnce(initialSettings)
        .mockReturnValue(null);
      const saveSettings = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/v.mp4", "v.mp4");

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit: vi.fn().mockResolvedValue(STARTED),
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm sends the preset that the setup step showed, not a later edit of it", async () => {
      // The user edits the preset in Settings while the save dialog is open. The export
      // renders the settings that the user confirmed (ADR 024).
      const shown = createPreset({ id: "p1", videoEncoder: "libx264" });
      const edited = { ...shown, videoEncoder: "libx265" };
      const getSettings = vi
        .fn()
        .mockReturnValueOnce(createSettings([shown], "p1"))
        .mockReturnValue(createSettings([edited], "p1"));
      const submit = vi.fn().mockResolvedValue(STARTED);

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit,
        saveSettings: vi.fn().mockResolvedValue(null),
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings,
        getMedia: () => createMedia("/media/v.mp4", "v.mp4"),
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      expect(await controller.confirm("p1", "videoAndAudio", "encode")).toBe(true);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ preset: shown }));
    });

    it("confirm skips saving active preset when the fresh document no longer contains the preset", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const initialSettings = createSettings([p1, p2], "p1");
      const updatedSettingsWithoutP2 = createSettings([p1], "p1");

      const getSettings = vi
        .fn()
        .mockReturnValueOnce(initialSettings)
        .mockReturnValue(updatedSettingsWithoutP2);
      const saveSettings = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/v.mp4", "v.mp4");

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        submit: vi.fn().mockResolvedValue(STARTED),
        saveSettings,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2", "videoAndAudio", "encode");

      expect(result).toBe(true);
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm reports sourceNotFound or noSegments if state became invalid after setup", async () => {
      const preset = createPreset({ id: "p1" });
      const settings = createSettings([preset], "p1");

      // No media
      const reportErrorNoMedia = vi.fn();
      const setModalNoMedia = vi.fn();
      const controllerNoMedia = createExportFlowController({
        setModalOpen: setModalNoMedia,
        reportError: reportErrorNoMedia,
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => null,
      });

      const resNoMedia = await controllerNoMedia.confirm(
        "p1",
        "videoAndAudio",
        "encode",
      );
      expect(resNoMedia).toBe(false);
      expect(reportErrorNoMedia).toHaveBeenCalledWith(
        expect.objectContaining({ code: "sourceNotFound" }),
      );
      expect(setModalNoMedia).toHaveBeenCalledWith(true);

      // No segments
      const media = createMedia("/media/v.mp4", "v.mp4");
      const reportErrorNoSeg = vi.fn();
      const setModalNoSeg = vi.fn();
      const controllerNoSeg = createExportFlowController({
        setModalOpen: setModalNoSeg,
        reportError: reportErrorNoSeg,
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [],
      });

      const resNoSeg = await controllerNoSeg.confirm("p1", "videoAndAudio", "encode");
      expect(resNoSeg).toBe(false);
      expect(reportErrorNoSeg).toHaveBeenCalledWith(
        expect.objectContaining({ code: "noSegments" }),
      );
      expect(setModalNoSeg).toHaveBeenCalledWith(true);
    });

    describe("the submission to the queue", () => {
      /**
       * Confirms preset p2 while p1 is active, so an accepted submission saves p2 as the
       * active preset. `submit` answers `answer`.
       */
      function confirmAnswering(answer: Promise<ExportQueueSubmitResult>) {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const saveSettings = vi.fn().mockResolvedValue(null);
        const submit = vi.fn(() => answer);
        const controller = createExportFlowController({
          setModalOpen,
          reportError,
          saveSettings,
          submit,
          openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getExportState: () => ({ status: "idle", tracking: false }),
          getSettings: () =>
            createSettings(
              [createPreset({ id: "p1" }), createPreset({ id: "p2" })],
              "p1",
            ),
          getMedia: () => createMedia("/media/v.mp4", "v.mp4"),
          getSourceId: () => "s1",
          getSegments: () => [createSegment("seg1", "s1", "0", "100")],
        });
        return {
          result: controller.confirm("p2", "videoAndAudio", "encode"),
          setModalOpen,
          reportError,
          saveSettings,
          submit,
        };
      }

      it.each([
        { kind: "started", runId: "run-1" },
        { kind: "queued", runId: "run-2" },
      ] as const)(
        "a $kind submission returns true and saves the preset",
        async (answer) => {
          const { result, reportError, saveSettings, submit, setModalOpen } =
            confirmAnswering(Promise.resolve(answer));

          expect(await result).toBe(true);
          expect(submit).toHaveBeenCalledOnce();
          expect(setModalOpen).toHaveBeenCalledWith(true);
          expect(reportError).not.toHaveBeenCalled();
          expect(saveSettings).toHaveBeenCalledWith(
            expect.objectContaining({ activePresetId: "p2" }),
          );
        },
      );

      it.each([{ kind: "failed" }, { kind: "superseded" }] as const)(
        "a $kind start returns false, reports nothing, and saves nothing, because the export store holds it",
        async (answer) => {
          const { result, reportError, saveSettings } = confirmAnswering(
            Promise.resolve(answer),
          );

          expect(await result).toBe(false);
          expect(reportError).not.toHaveBeenCalled();
          expect(saveSettings).not.toHaveBeenCalled();
        },
      );

      it("a refused submission reports its error, keeps the modal open, and saves nothing", async () => {
        const error = new ExportError({ code: "outputAlreadyQueued" });
        const { result, reportError, saveSettings, setModalOpen } = confirmAnswering(
          Promise.resolve({ kind: "refused", error }),
        );

        expect(await result).toBe(false);
        expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
        expect(setModalOpen).toHaveBeenLastCalledWith(true);
        expect(saveSettings).not.toHaveBeenCalled();
      });

      it("a rejected submission reports the rejection and saves nothing", async () => {
        const { result, reportError, saveSettings } = confirmAnswering(
          Promise.reject(new Error("IPC closed")),
        );

        expect(await result).toBe(false);
        expect(reportError).toHaveBeenCalledOnce();
        expect(saveSettings).not.toHaveBeenCalled();
      });

      it("waits for the answer of the submission before it saves the preset", async () => {
        let answer: (result: ExportQueueSubmitResult) => void = () => {};
        const { result, submit, saveSettings } = confirmAnswering(
          new Promise<ExportQueueSubmitResult>((resolve) => {
            answer = resolve;
          }),
        );
        await vi.waitFor(() => {
          expect(submit).toHaveBeenCalledOnce();
        });
        expect(saveSettings).not.toHaveBeenCalled();

        answer({ kind: "queued", runId: "run-2" });

        expect(await result).toBe(true);
        expect(saveSettings).toHaveBeenCalledOnce();
      });
    });

    it("confirmExportFlow helper invokes confirm with presetId and the streams", async () => {
      const openSaveDialog = vi.fn().mockResolvedValue(null);
      const preset = createPreset({ id: "p1", container: "mkv" });

      const result = await confirmExportFlow(
        {
          setModalOpen: vi.fn(),
          openSaveDialog,
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getSettings: () => createSettings([preset]),
        },
        "p1",
        "audioOnly",
        "encode",
      );

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
      expect(openSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ extension: "mka", filterName: "Audio Files" }),
      );
    });
  });
});

describe("openExportFlow", () => {
  const media = createMedia("/media/video.mp4", "video.mp4");

  /**
   * Real stores for the flow to read. `live` puts a tracked run in the export store, `waiting`
   * puts a run in the queue, and `submitting` puts a submission with no answer in flight.
   */
  function createStores(
    work: { live?: boolean; waiting?: boolean; submitting?: boolean } = {},
  ) {
    const exportStore = createExportStore();
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    if (work.live) {
      exportStore.setState({ status: "running", runId: "run-1", tracking: true });
    }
    if (work.waiting) {
      queueStore.setState({ waiting: ["run-2"] });
    }
    if (work.submitting) {
      queueStore.setState({ submitting: 1 });
    }
    return { exportStore, queueStore, composeStore };
  }

  function flowOptions(overrides: { media?: MediaFlowDescriptor | null } = {}) {
    const current = overrides.media === undefined ? media : overrides.media;
    return {
      setModalOpen: vi.fn(),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      getMedia: () => current,
      readSourceRevision: createMatchingReader(media),
      getSourceId: () => "source-1",
      getSegments: () => [createSegment("s1", "source-1", "0", "100")],
      getSettings: () => createSettings([createPreset()]),
    };
  }

  describe("the compose target", () => {
    it.each([
      ["a live run", { live: true }],
      ["a waiting run", { waiting: true }],
      ["a submission in flight", { submitting: true }],
    ] as const)(
      "with %s, reports a failure of the OPEN step to the compose store",
      async (_label, work) => {
        const stores = createStores(work);
        const before = stores.exportStore.getState();
        const options = flowOptions({ media: null });

        const result = await openExportFlow(options, stores);

        expect(result).toBe(false);
        expect(stores.composeStore.getState()).toMatchObject({
          composing: true,
          status: "failed",
          error: expect.objectContaining({ code: "sourceNotFound" }) as unknown,
        });
        // The export store keeps what it held: the live run, or idle with no error.
        expect(stores.exportStore.getState().status).toBe(before.status);
        expect(stores.exportStore.getState().error).toBeNull();
        expect(options.setModalOpen).toHaveBeenCalledWith(true);
      },
    );

    it("treats a failed run that the export store still tracks as live", async () => {
      const stores = createStores();
      stores.exportStore.setState({ status: "failed", runId: "run-1", tracking: true });
      const options = flowOptions({ media: null });

      await openExportFlow(options, stores);

      expect(stores.composeStore.getState().status).toBe("failed");
      expect(stores.exportStore.getState()).toMatchObject({
        status: "failed",
        runId: "run-1",
        tracking: true,
        error: null,
      });
    });

    it("does not re-open the live run, and runs the checks of the OPEN step", async () => {
      const stores = createStores({ live: true });
      const options = flowOptions();

      const result = await openExportFlow(options, stores);

      expect(result).toBe(true);
      expect(options.readSourceRevision).toHaveBeenCalledOnce();
      expect(options.setModalOpen).toHaveBeenCalledExactlyOnceWith(true);
      expect(stores.composeStore.getState()).toMatchObject({
        composing: true,
        status: "idle",
        error: null,
      });
      expect(stores.exportStore.getState()).toMatchObject({
        status: "running",
        runId: "run-1",
        tracking: true,
      });
    });

    it("reports a changed source to the compose store as the confirmation", async () => {
      const stores = createStores({ live: true });
      const options = {
        ...flowOptions(),
        readSourceRevision: vi.fn().mockResolvedValue({
          path: media.path,
          size: media.size + 1,
          mtime: media.mtime,
        }),
      };

      expect(await openExportFlow(options, stores)).toBe(false);
      expect(stores.composeStore.getState().error?.code).toBe("sourceRevisionChanged");
      expect(stores.exportStore.getState().status).toBe("running");
    });

    it("clears a failure of an earlier setup before it opens the setup step", async () => {
      const stores = createStores({ live: true });
      stores.composeStore
        .getState()
        .reportError(new ExportError({ code: "noSegments" }));

      expect(await openExportFlow(flowOptions(), stores)).toBe(true);
      expect(stores.composeStore.getState()).toMatchObject({
        composing: true,
        status: "idle",
        error: null,
      });
    });

    it("enters the compose state only when the modal opens", async () => {
      const stores = createStores({ live: true });
      let finishLoad: () => void = () => {};
      let settings: Settings | null = null;
      const options = {
        ...flowOptions(),
        getSettings: () => settings,
        loadSettings: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishLoad = resolve;
            }),
        ),
      };

      const step = openExportFlow(options, stores);
      await vi.waitFor(() => {
        expect(options.loadSettings).toHaveBeenCalled();
      });
      expect(stores.composeStore.getState().composing).toBe(false);

      // A second call while the first one waits does nothing, so it does not enter.
      const second = flowOptions();
      expect(await openExportFlow(second, stores)).toBe(false);
      expect(second.setModalOpen).not.toHaveBeenCalled();
      expect(stores.composeStore.getState().composing).toBe(false);

      settings = createSettings([createPreset()]);
      finishLoad();

      expect(await step).toBe(true);
      expect(stores.composeStore.getState().composing).toBe(true);
    });
  });

  describe("the default target", () => {
    it("reports a failure of the OPEN step to the export store", async () => {
      const stores = createStores();
      const options = flowOptions({ media: null });

      expect(await openExportFlow(options, stores)).toBe(false);
      expect(stores.exportStore.getState()).toMatchObject({
        status: "failed",
        error: expect.objectContaining({ code: "sourceNotFound" }) as unknown,
      });
      expect(stores.composeStore.getState()).toMatchObject({
        composing: false,
        status: "idle",
        error: null,
      });
    });

    it("resets a run that ended and opens the setup step on the export store", async () => {
      const stores = createStores();
      stores.exportStore.setState({ status: "finished", runId: "run-1" });
      const options = flowOptions();

      expect(await openExportFlow(options, stores)).toBe(true);
      expect(stores.exportStore.getState().status).toBe("idle");
      expect(options.setModalOpen).toHaveBeenCalledWith(true);
    });

    it("leaves the compose state that an earlier setup left when the modal opens", async () => {
      const stores = createStores();
      stores.composeStore.getState().enter();

      expect(await openExportFlow(flowOptions(), stores)).toBe(true);
      expect(stores.composeStore.getState().composing).toBe(false);
    });
  });
});

describe("ExportFlowController with several clips (ADR 052, ADR 053)", () => {
  // The flow reads the clips and the imported sources from the application stores. Each test
  // writes them, and this hook puts back the state of the module.
  const initialTimeline = timelineStore.getState();
  const initialMedia = mediaStore.getState();
  afterEach(() => {
    timelineStore.setState(initialTimeline, true);
    mediaStore.setState(initialMedia, true);
  });

  function facts(id: string, end: string): SequenceSource {
    return {
      id,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0" as Pts,
      videoEndPts: end as Pts,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    };
  }

  function imported(path: string, size: number, mtime: number): ImportMediaResult {
    return { path, fileName: path.slice(1), size, mtime } as ImportMediaResult;
  }

  /** Clips a1 (A), b1 (B) and a2 (A), with the given segments. */
  function loadSequence(segments: SequenceSegment[]): void {
    timelineStore.setState({
      clips: [
        { id: "a1", sourceId: "A" },
        { id: "b1", sourceId: "B" },
        { id: "a2", sourceId: "A" },
      ],
      sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
      sequenceSegments: segments,
    });
    mediaStore.setState({
      sources: { A: imported("/a.mp4", 10, 1), B: imported("/b.mp4", 20, 2) },
    });
  }

  function anchored(
    id: string,
    inClipId: string,
    inPts: string,
    outClipId: string,
    outPts: string,
  ): SequenceSegment {
    return { id, inClipId, inPts: inPts as Pts, outClipId, outPts: outPts as Pts };
  }

  const media = createMedia("/a.mp4", "a.mp4", { size: 10, mtime: 1 });

  function readerOf(
    revisions: Record<string, { size: number; mtime: number }>,
  ): (path: string) => Promise<MediaSourceRevisionDescriptor> {
    return vi.fn((path: string) => {
      const revision = revisions[path];
      return revision === undefined
        ? Promise.reject(new Error("missing"))
        : Promise.resolve({ path, ...revision });
    });
  }

  it("run reports noSegments when no segment is on the sequence", async () => {
    loadSequence([]);
    const reportError = vi.fn();
    const setModalOpen = vi.fn();

    const result = await runExportFlow({
      setModalOpen,
      reportError,
      openSaveDialog: vi.fn(),
      readSourceRevision: readerOf({}),
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "noSegments" }),
    );
    expect(setModalOpen).toHaveBeenCalledWith(true);
  });

  it("run reports tooManySegments for more pieces than an export joins", async () => {
    // Each segment from a1 into b1 gives two pieces: 49 pieces in all.
    loadSequence(
      Array.from({ length: 24 }, (_, index) =>
        anchored(`s${index}`, "a1", "100", "b1", "1000"),
      ).concat(anchored("last", "a1", "100", "a1", "200")),
    );
    const reportError = vi.fn();
    const readSourceRevision = readerOf({});

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError,
      openSaveDialog: vi.fn(),
      readSourceRevision,
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(false);
    expect(readSourceRevision).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "tooManySegments" }),
    );
  });

  it("run accepts exactly as many pieces as an export joins", async () => {
    // 23 segments of two pieces and two of one piece: 48 pieces.
    loadSequence([
      ...Array.from({ length: 23 }, (_, index) =>
        anchored(`s${index}`, "a1", "100", "b1", "1000"),
      ),
      anchored("last", "a1", "100", "a1", "200"),
      anchored("only", "b1", "100", "b1", "200"),
    ]);
    const reportError = vi.fn();

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError,
      openSaveDialog: vi.fn(),
      readSourceRevision: readerOf({
        "/a.mp4": { size: 10, mtime: 1 },
        "/b.mp4": { size: 20, mtime: 2 },
      }),
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("run reports sourceNotFound for a source of a piece without imported media", async () => {
    loadSequence([anchored("s1", "a1", "100", "b1", "1000")]);
    mediaStore.setState({ sources: { A: imported("/a.mp4", 10, 1) } });
    const reportError = vi.fn();

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError,
      openSaveDialog: vi.fn(),
      readSourceRevision: readerOf({ "/a.mp4": { size: 10, mtime: 1 } }),
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "sourceNotFound" }),
    );
  });

  it("run reads no file after the user accepted a changed source", async () => {
    loadSequence([anchored("s1", "a1", "100", "b1", "1000")]);
    const readSourceRevision = readerOf({});

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError: vi.fn(),
      openSaveDialog: vi.fn(),
      readSourceRevision,
      skipSourceRevisionCheck: true,
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(true);
    expect(readSourceRevision).not.toHaveBeenCalled();
  });

  it("run checks the revision of each source of a piece", async () => {
    loadSequence([anchored("s1", "a1", "100", "b1", "1000")]);
    const reportError = vi.fn();
    const readSourceRevision = readerOf({
      "/a.mp4": { size: 10, mtime: 1 },
      "/b.mp4": { size: 20, mtime: 99 },
    });

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError,
      openSaveDialog: vi.fn(),
      readSourceRevision,
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(false);
    expect(readSourceRevision).toHaveBeenCalledWith("/a.mp4");
    expect(readSourceRevision).toHaveBeenCalledWith("/b.mp4");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "sourceRevisionChanged" }),
    );
  });

  it("run reaches the setup step when every source matches or cannot be read", async () => {
    loadSequence([anchored("s1", "a1", "100", "b1", "1000")]);
    const reportError = vi.fn();

    const result = await runExportFlow({
      setModalOpen: vi.fn(),
      reportError,
      openSaveDialog: vi.fn(),
      // B cannot be read, which is no mismatch.
      readSourceRevision: readerOf({ "/a.mp4": { size: 10, mtime: 1 } }),
      getExportState: () => ({ status: "idle", tracking: false }),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
      getSettings: () => createSettings([createPreset()]),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
    });

    expect(result).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("confirm sends the pieces of each segment in array order, and each source once", async () => {
    loadSequence([
      anchored("late", "b1", "1000", "a2", "2000"),
      anchored("early", "a1", "100", "a1", "200"),
    ]);
    const submit = vi.fn().mockResolvedValue(STARTED);
    const preset = createPreset({ id: "p1" });

    const result = await createExportFlowController({
      setModalOpen: vi.fn(),
      openSaveDialog: vi.fn().mockResolvedValue("/out/joined.mp4"),
      submit,
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      getSettings: () => createSettings([preset], "p1"),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
    }).confirm("p1", "videoAndAudio", "encode");

    expect(result).toBe(true);
    expect(submit.mock.calls[0][0]).toStrictEqual({
      sources: [
        { id: "B", path: "/b.mp4", expectedRevision: { size: 20, mtime: 2 } },
        { id: "A", path: "/a.mp4", expectedRevision: { size: 10, mtime: 1 } },
      ],
      pieces: [
        { sourceId: "B", inPts: "1000", outPts: "5000" },
        { sourceId: "A", inPts: "0", outPts: "2000" },
        { sourceId: "A", inPts: "100", outPts: "200" },
      ],
      segmentCount: 2,
      outputPath: "/out/joined.mp4",
      preset,
      streams: "videoAndAudio",
      audioMode: "encode",
    });
  });

  it("confirm sends no revision after the user accepted a changed source", async () => {
    loadSequence([anchored("s1", "a1", "100", "b1", "1000")]);
    const submit = vi.fn().mockResolvedValue(STARTED);
    const preset = createPreset({ id: "p1" });

    await createExportFlowController({
      setModalOpen: vi.fn(),
      openSaveDialog: vi.fn().mockResolvedValue("/out/joined.mp4"),
      submit,
      skipSourceRevisionCheck: true,
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      getSettings: () => createSettings([preset], "p1"),
      getMedia: () => media,
      getSourceId: () => "sequence:1",
      getSegments: () => [],
    }).confirm("p1", "videoAndAudio", "encode");

    const request = submit.mock.calls[0][0] as ExportRequest;
    expect(request.sources).toStrictEqual([
      { id: "A", path: "/a.mp4" },
      { id: "B", path: "/b.mp4" },
    ]);
  });
});
