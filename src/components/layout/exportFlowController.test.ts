import { describe, expect, it, vi } from "vitest";
import {
  confirmExportFlow,
  createExportFlowController,
  ExportFlowController,
  runExportFlow,
  SOURCE_REVISION_CHECK_TIMEOUT_MS,
  type MediaFlowDescriptor,
} from "./exportFlowController";
import {
  cancelActiveExport as clientCancelActiveExport,
  createExportStore,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportStart,
} from "@/features/export";
import type { MediaSourceRevisionDescriptor } from "@/features/media";
import type { Preset, Settings } from "@/features/settings/types";
import type { Pts, Segment } from "@/types/project";

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
    ...overrides,
  };
}

/**
 * Builds a settings document whose active preset is the supplied preset or activePresetId.
 */
function createSettings(presets: Preset[], activePresetId?: string): Settings {
  return {
    schemaVersion: 1,
    revision: 7,
    activePresetId: activePresetId ?? presets[0]?.id,
    presets,
  };
}

describe("ExportFlowController", () => {
  describe("run (OPEN step)", () => {
    it("run never calls the save dialog, and it opens the modal on the good path", async () => {
      const setModalOpen = vi.fn();
      const openSaveDialog = vi.fn();
      const startExport = vi.fn();
      const reportError = vi.fn();
      const media = createMedia("/media/video.mp4", "video.mp4");
      const preset = createPreset();

      const controller = createExportFlowController({
        setModalOpen,
        openSaveDialog,
        startExport,
        reportError,
        filterName: "Video Files",
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
      expect(startExport).not.toHaveBeenCalled();
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

    it("run resets a terminal store status", async () => {
      for (const terminalStatus of ["finished", "failed", "canceled"] as const) {
        const setModalOpen = vi.fn();
        const reset = vi.fn();
        const media = createMedia("/media/video.mp4", "video.mp4");

        const result = await runExportFlow({
          setModalOpen,
          reset,
          filterName: "Video Files",
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
        const startExport = vi.fn();

        const result = await runExportFlow({
          setModalOpen,
          openSaveDialog,
          startExport,
          getExportState: () => ({ status: activeStatus, tracking: false }),
          filterName: "Video Files",
        });

        expect(result).toBe(false);
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(openSaveDialog).not.toHaveBeenCalled();
        expect(startExport).not.toHaveBeenCalled();
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

    describe("run on a real store after a slot cancel that the IPC layer rejected", () => {
      /**
       * Drives a real export store to `failed` with a tracked start: the Stop request fails
       * while the start waits for its run id. The flow reads and resets that store.
       */
      async function failTheStopWhileTheStartWaits() {
        let emit!: (event: ExportProgressEvent) => void;
        let answerStart: (start: ExportStart) => void = () => {};
        const startFn = vi.fn(
          () =>
            new Promise<ExportStart>((resolve) => {
              answerStart = resolve;
            }),
        );
        const store = createExportStore({
          subscribeExportProgress: (handler) => {
            emit = handler;
            return Promise.resolve(() => {});
          },
          startExport: startFn,
          cancelActiveExport: () =>
            clientCancelActiveExport({
              invoke: vi.fn().mockRejectedValue("IPC closed"),
            }),
        });
        const starting = store.getState().startExport({
          sourcePath: "/media/video.mp4",
          outputPath: "/media/out.mp4",
          segments: [{ inPts: "0" as Pts, outPts: "100" as Pts }],
          presetId: "default",
        });
        await vi.waitFor(() => {
          expect(startFn).toHaveBeenCalled();
        });
        await store.getState().cancelExport();
        expect(store.getState()).toMatchObject({ status: "failed", tracking: true });
        return {
          store,
          starting,
          emit: (event: ExportProgressEvent) => {
            emit(event);
          },
          answerStart: (start: ExportStart) => {
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

      it("shows the kept start, and the store still takes its answer", async () => {
        const { store, starting, answerStart } = await failTheStopWhileTheStartWaits();

        const { result, setModalOpen } = runOn(store);

        await expect(result).resolves.toBe(false);
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(store.getState()).toMatchObject({ status: "failed", tracking: true });

        answerStart({
          runId: "run-kept",
          presetId: "default",
          outputPath: "/media/out.mp4",
          segmentCount: 1,
          totalDurationUs: 1_000_000,
        });
        await expect(starting).resolves.toMatchObject({ runId: "run-kept" });
        expect(store.getState()).toMatchObject({ runId: "run-kept", tracking: true });
      });

      it("resets and reaches the setup step once the kept run ended", async () => {
        const { store, starting, answerStart, emit } =
          await failTheStopWhileTheStartWaits();
        answerStart({
          runId: "run-kept",
          presetId: "default",
          outputPath: "/media/out.mp4",
          segmentCount: 1,
          totalDurationUs: 1_000_000,
        });
        await starting;
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
        });

        expect(result).toBe(true);
        expect(readSourceRevision).toHaveBeenCalledOnce();
        expect(setModalOpen).toHaveBeenCalledWith(true);
        expect(reportError).not.toHaveBeenCalled();
      });

      it("a changed file with nothing marked reports noSegments and never confirms", async () => {
        const setModalOpen = vi.fn();
        const reportError = vi.fn();
        const startExport = vi.fn();
        const media = createMedia("/media/source.mp4", "source.mp4");
        const readSourceRevision = vi.fn().mockResolvedValue({
          path: media.path,
          size: media.size + 1,
          mtime: media.mtime + 60,
        });

        const result = await runExportFlow({
          setModalOpen,
          reportError,
          startExport,
          readSourceRevision,
          getExportState: () => ({ status: "idle", tracking: false }),
          getMedia: () => media,
          getSourceId: () => "src-1",
          getSegments: () => [],
          getSettings: () => createSettings([createPreset()]),
          filterName: "Video Files",
        });

        expect(result).toBe(false);
        expect(readSourceRevision).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledOnce();
        expect(reportError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "noSegments" }),
        );
        expect(startExport).not.toHaveBeenCalled();
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

      it("runs a replacing call for the same media path at once", async () => {
        const first = startPendingStep();
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });

        // The export dialog opens again after the settings dialog, while a stale step waits.
        const second = secondStepOptions();
        await expect(runExportFlow(second, { replace: true })).resolves.toBe(true);
        expect(second.readSourceRevision).toHaveBeenCalledWith("/media/video.mp4");
        expect(second.setModalOpen).toHaveBeenCalledWith(true);

        // The replaced step then answers that the file changed. Only the new step reports.
        first.answerCheck(true);
        await expect(first.step).resolves.toBe(false);
        expect(first.reportError).not.toHaveBeenCalled();
        expect(first.setModalOpen).not.toHaveBeenCalled();
      });

      it("keeps the guard of a replacing step while it runs", async () => {
        const first = startPendingStep();
        first.finishLoad();
        await vi.waitFor(() => {
          expect(first.readSourceRevision).toHaveBeenCalled();
        });
        const media = createMedia("/media/video.mp4", "video.mp4");
        let answer: () => void = () => {};
        const replacing = runExportFlow(
          {
            ...secondStepOptions(),
            readSourceRevision: () =>
              new Promise<MediaSourceRevisionDescriptor>((resolve) => {
                answer = () => {
                  resolve({ path: media.path, size: media.size, mtime: media.mtime });
                };
              }),
          },
          { replace: true },
        );
        first.answerCheck();
        await expect(first.step).resolves.toBe(false);

        // A plain call for the same file waits for the replacing step, as for any step.
        const third = secondStepOptions();
        await expect(runExportFlow(third)).resolves.toBe(false);
        expect(third.readSourceRevision).not.toHaveBeenCalled();

        answer();
        await expect(replacing).resolves.toBe(true);
        await expect(runExportFlow(secondStepOptions())).resolves.toBe(true);
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
      const startExport = vi.fn();
      const saveSettings = vi.fn();

      const controller = new ExportFlowController({
        setModalOpen,
        reportError,
        openSaveDialog,
        startExport,
        saveSettings,
        filterName: "Video Files",
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm("non-existent-preset");

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "presetNotFound" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
      expect(startExport).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm uses the SELECTED preset's container for the extension and default name, not active preset's container", async () => {
      const openSaveDialog = vi.fn().mockResolvedValue("/out/rendered.mov");
      const startExport = vi.fn().mockResolvedValue(null);
      const media = createMedia("/media/clip.mp4", "clip.mp4");

      const activePreset = createPreset({ id: "p-mp4", container: "mp4" });
      const selectedPreset = createPreset({ id: "p-mov", container: "mov" });
      const settings = createSettings([activePreset, selectedPreset], "p-mp4");

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog,
        startExport,
        filterName: "Video Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p-mov");

      expect(result).toBe(true);
      expect(openSaveDialog).toHaveBeenCalledWith({
        container: "mov",
        filterName: "Video Files",
        defaultName: "clip_export.mov",
      });
    });

    it("confirm with the save dialog cancelled starts nothing and saves nothing", async () => {
      const setModalOpen = vi.fn();
      const reportError = vi.fn();
      const startExport = vi.fn();
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
        startExport,
        saveSettings,
        filterName: "Video Files",
        getExportState: () => ({ status: "idle", tracking: false }),
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2");

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
      expect(setModalOpen).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      expect(startExport).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it("confirm when save dialog throws reports dialogFailed, keeps modal open, and returns false", async () => {
      const setModalOpen = vi.fn();
      const reportError = vi.fn();
      const startExport = vi.fn();
      const openSaveDialog = vi.fn().mockRejectedValue(new Error("dialog crashed"));

      const controller = createExportFlowController({
        setModalOpen,
        reportError,
        openSaveDialog,
        startExport,
        filterName: "Video Files",
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm("p1");

      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "dialogFailed" }),
      );
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(startExport).not.toHaveBeenCalled();
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
        getExportState: () => ({ status: storeStatus, tracking: false }),
        getSettings: () => createSettings([createPreset({ id: "p1" })]),
      });

      const result = await controller.confirm("p1");

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
      expect(setModalOpen).toHaveBeenCalledWith(true);
    });

    it("confirm passes presetId in the request and respects segment array order", async () => {
      const startExport = vi.fn().mockResolvedValue(null);
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
        startExport,
        filterName: "Video Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => sourceId,
        getSegments: () => segments,
      });

      const result = await controller.confirm("custom-p");

      expect(result).toBe(true);
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(startExport).toHaveBeenCalledOnce();
      expect(setModalOpen.mock.invocationCallOrder[0]).toBeLessThan(
        startExport.mock.invocationCallOrder[0],
      );
      const passedRequest = startExport.mock.calls[0][0] as ExportRequest;
      expect(passedRequest).toStrictEqual({
        sourcePath: "/media/source.mp4",
        outputPath: "/out/destination.mp4",
        presetId: "custom-p",
        segments: [
          { inPts: "1000", outPts: "2000" },
          { inPts: "5000", outPts: "6000" },
          { inPts: "3000", outPts: "4000" },
        ],
      });
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
        startExport: vi.fn().mockResolvedValue(null),
        saveSettings: saveSettingsDiff,
        filterName: "Video Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      await controllerDiff.confirm("p2");
      expect(saveSettingsDiff).toHaveBeenCalledOnce();
      expect(saveSettingsDiff).toHaveBeenCalledWith(
        expect.objectContaining({ activePresetId: "p2" }),
      );

      // Case 2: equal -> does not save
      const saveSettingsSame = vi.fn().mockResolvedValue(null);
      const controllerSame = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        startExport: vi.fn().mockResolvedValue(null),
        saveSettings: saveSettingsSame,
        filterName: "Video Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      await controllerSame.confirm("p1");
      expect(saveSettingsSame).not.toHaveBeenCalled();
    });

    it("a rejected settings save still leaves the export started", async () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");
      const media = createMedia("/media/v.mp4", "v.mp4");

      const startExport = vi.fn().mockResolvedValue(null);
      const saveSettings = vi.fn().mockRejectedValue(new Error("conflict"));

      const controller = createExportFlowController({
        setModalOpen: vi.fn(),
        openSaveDialog: vi.fn().mockResolvedValue("/out/v.mp4"),
        startExport,
        saveSettings,
        filterName: "Video Files",
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2");

      expect(result).toBe(true);
      expect(startExport).toHaveBeenCalledOnce();
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
        startExport: vi.fn().mockResolvedValue(null),
        saveSettings,
        filterName: "Video Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2");

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
        startExport: vi.fn().mockResolvedValue(null),
        saveSettings,
        filterName: "Video Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2");

      expect(result).toBe(true);
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(saveSettings).not.toHaveBeenCalled();
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
        startExport: vi.fn().mockResolvedValue(null),
        saveSettings,
        filterName: "Video Files",
        getSettings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [createSegment("seg1", "s1", "0", "100")],
      });

      const result = await controller.confirm("p2");

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
        getSettings: () => settings,
        getMedia: () => null,
      });

      const resNoMedia = await controllerNoMedia.confirm("p1");
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
        getSettings: () => settings,
        getMedia: () => media,
        getSourceId: () => "s1",
        getSegments: () => [],
      });

      const resNoSeg = await controllerNoSeg.confirm("p1");
      expect(resNoSeg).toBe(false);
      expect(reportErrorNoSeg).toHaveBeenCalledWith(
        expect.objectContaining({ code: "noSegments" }),
      );
      expect(setModalNoSeg).toHaveBeenCalledWith(true);
    });

    it("confirmExportFlow helper invokes confirm with presetId", async () => {
      const openSaveDialog = vi.fn().mockResolvedValue(null);
      const preset = createPreset({ id: "p1" });

      const result = await confirmExportFlow(
        {
          setModalOpen: vi.fn(),
          openSaveDialog,
          filterName: "Video Files",
          getSettings: () => createSettings([preset]),
        },
        "p1",
      );

      expect(result).toBe(false);
      expect(openSaveDialog).toHaveBeenCalledOnce();
    });
  });
});
