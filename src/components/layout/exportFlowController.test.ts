import { describe, expect, it, vi } from "vitest";
import {
  createExportFlowController,
  ExportFlowController,
  runExportFlow,
} from "./exportFlowController";
import type { ExportRequest } from "@/features/export";
import type { Preset, Settings } from "@/features/settings/types";
import type { Pts, Segment } from "@/types/project";

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
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    ...overrides,
  };
}

/**
 * Builds a settings document whose active preset is the supplied preset.
 *
 * `revision` is a distinctive non-zero value on purpose: this fixture stands for a document
 * loaded from disk, and zero is specifically what a document written before the field existed
 * reads as, so using it here would conflate the two cases.
 */
function createSettings(preset: Preset): Settings {
  return {
    schemaVersion: 1,
    revision: 7,
    activePresetId: preset.id,
    presets: [preset],
  };
}

describe("ExportFlowController", () => {
  it("cancelling the save dialog never opens the modal and never reports an error", async () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const startExport = vi.fn();
    const openSaveDialog = vi.fn().mockResolvedValue(null);
    // A cancel leaves the store status untouched.
    const getExportStatus = vi.fn().mockReturnValue("idle" as const);

    const controller = createExportFlowController({
      setModalOpen,
      reportError,
      startExport,
      openSaveDialog,
      getExportStatus,
      filterName: "Video Files",
      getSettings: () => createSettings(createPreset()),
      getMedia: () => ({ path: "/path/to/video.mp4", fileName: "video.mp4" }),
    });

    const result = await controller.run();

    expect(result).toBe(false);
    expect(openSaveDialog).toHaveBeenCalledOnce();
    expect(setModalOpen).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(startExport).not.toHaveBeenCalled();
  });

  it("a save-dialog FAILURE that left the store failed opens the modal", async () => {
    const setModalOpen = vi.fn();
    const startExport = vi.fn();

    // `openExportSaveDialog` never rethrows. It reports a dialogFailed ExportError to
    // the store and answers null, which leaves the store status "failed".
    let storeStatus: "idle" | "failed" = "idle";
    const openSaveDialog = vi.fn().mockImplementation(() => {
      storeStatus = "failed";
      return Promise.resolve(null);
    });

    const controller = new ExportFlowController({
      setModalOpen,
      startExport,
      openSaveDialog,
      getExportStatus: () => storeStatus,
      filterName: "Video Files",
      getSettings: () => createSettings(createPreset()),
      getMedia: () => ({ path: "/path/to/video.mp4", fileName: "video.mp4" }),
    });

    const result = await controller.run();

    expect(result).toBe(false);
    expect(openSaveDialog).toHaveBeenCalledOnce();
    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(startExport).not.toHaveBeenCalled();
  });

  it("a save-dialog that throws an unexpected error reports dialogFailed and opens the modal", async () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const startExport = vi.fn();
    const openSaveDialog = vi.fn().mockRejectedValue(new Error("Dialog crashed"));

    const result = await runExportFlow({
      setModalOpen,
      reportError,
      startExport,
      openSaveDialog,
      getExportStatus: () => "idle",
      filterName: "Video Files",
      getSettings: () => createSettings(createPreset()),
    });

    expect(result).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "dialogFailed" }),
    );
    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(startExport).not.toHaveBeenCalled();
  });

  it("a null request opens the modal carrying noSegments rather than vanishing", async () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const startExport = vi.fn();
    const openSaveDialog = vi.fn().mockResolvedValue("/path/to/export.mp4");

    // Media is loaded, but the timeline holds no segment for the active source.
    const controller = createExportFlowController({
      setModalOpen,
      reportError,
      startExport,
      openSaveDialog,
      getExportStatus: () => "idle",
      getMedia: () => ({ path: "/media/sample.mp4", fileName: "sample.mp4" }),
      getSegments: () => [],
      getSourceId: () => "source-1",
      filterName: "Video Files",
      getSettings: () => createSettings(createPreset()),
    });

    const result = await controller.run();

    expect(result).toBe(false);
    expect(openSaveDialog).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "noSegments" }),
    );
    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(startExport).not.toHaveBeenCalled();
  });

  it("a null request when media is absent opens the modal carrying sourceNotFound", async () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const startExport = vi.fn();
    const openSaveDialog = vi.fn().mockResolvedValue("/path/to/export.mp4");

    const controller = createExportFlowController({
      setModalOpen,
      reportError,
      startExport,
      openSaveDialog,
      getExportStatus: () => "idle",
      getMedia: () => null,
      filterName: "Video Files",
      getSegments: () => [],
      getSourceId: () => null,
      getSettings: () => createSettings(createPreset()),
    });

    const result = await controller.run();

    expect(result).toBe(false);
    expect(openSaveDialog).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "sourceNotFound" }),
    );
    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(startExport).not.toHaveBeenCalled();
  });

  it("the good path calls startExport with the segments in array order and the resolved preset id", async () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const startExport = vi.fn().mockResolvedValue({
      runId: "run-abc-123",
      presetId: "custom-preset-id",
      outputPath: "/destination/rendered.mp4",
      segmentCount: 3,
      totalDurationUs: 3_000_000,
    });
    const openSaveDialog = vi.fn().mockResolvedValue("/destination/rendered.mp4");

    const sourceId = "source-clip-1";

    // Three segments for the active source in deliberate non-chronological array
    // order, plus one segment for another source. Array order is export order (ADR 007).
    const segments: Segment[] = [
      createSegment("seg-1", sourceId, "1000", "2000"),
      createSegment("seg-2", sourceId, "5000", "6000"),
      createSegment("seg-foreign", "different-source", "10", "20"),
      createSegment("seg-3", sourceId, "3000", "4000"),
    ];

    const settings = createSettings(
      createPreset({
        id: "custom-preset-id",
        name: "Custom 1080p",
        container: "mp4",
        resolution: { w: 1920, h: 1080 },
      }),
    );

    const controller = createExportFlowController({
      setModalOpen,
      reportError,
      startExport,
      openSaveDialog,
      getExportStatus: () => "idle",
      getMedia: () => ({ path: "/media/source.mp4", fileName: "source.mp4" }),
      getSegments: () => segments,
      getSourceId: () => sourceId,
      getSettings: () => settings,
      filterName: "Video Files",
    });

    const result = await controller.run();

    expect(result).toBe(true);
    expect(openSaveDialog).toHaveBeenCalledWith({
      container: "mp4",
      filterName: "Video Files",
      defaultName: "source_export.mp4",
    });
    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(reportError).not.toHaveBeenCalled();

    expect(startExport).toHaveBeenCalledOnce();
    const passedRequest = startExport.mock.calls[0][0] as ExportRequest;
    expect(passedRequest).toStrictEqual({
      sourcePath: "/media/source.mp4",
      outputPath: "/destination/rendered.mp4",
      presetId: "custom-preset-id",
      segments: [
        { inPts: "1000", outPts: "2000" },
        { inPts: "5000", outPts: "6000" },
        { inPts: "3000", outPts: "4000" },
      ],
    });
  });

  it("re-reads store settings after awaiting loadSettings fallback", async () => {
    const setModalOpen = vi.fn();
    const startExport = vi.fn().mockResolvedValue(null);
    const openSaveDialog = vi.fn().mockResolvedValue("/out/test.mov");

    let currentSettings: Settings | null = null;
    const loadSettings = vi.fn().mockImplementation(() => {
      // The load populates the store. It answers null when superseded, so the
      // controller must re-read the store rather than trust the return value.
      currentSettings = createSettings(
        createPreset({
          id: "prores-preset",
          name: "ProRes",
          container: "mov",
          videoEncoder: "prores_ks",
          audioEncoder: "pcm_s16le",
          quality: { kind: "bitrate", value: 50_000 },
        }),
      );
      return Promise.resolve(null);
    });

    await runExportFlow({
      setModalOpen,
      startExport,
      openSaveDialog,
      loadSettings,
      filterName: "Video Files",
      getExportStatus: () => "idle",
      getSettings: () => currentSettings,
      getMedia: () => ({ path: "/in/clip.mov", fileName: "clip.mov" }),
      getSourceId: () => "src-1",
      getSegments: () => [createSegment("s1", "src-1", "0", "100")],
    });

    expect(loadSettings).toHaveBeenCalledOnce();
    expect(openSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        container: "mov",
        defaultName: "clip_export.mov",
      }),
    );
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
        getExportStatus: () => activeStatus,
        filterName: "Video Files",
      });

      expect(result).toBe(false);
      expect(setModalOpen).toHaveBeenCalledWith(true);
      expect(openSaveDialog).not.toHaveBeenCalled();
      expect(startExport).not.toHaveBeenCalled();
    }
  });
});
