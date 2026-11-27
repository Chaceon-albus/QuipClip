/**
 * The scope of an export through the steps of the flow (ADR 067): the open step, "Export anyway",
 * the confirm step, the answers to the request, and Back. The tests run the flow controller on
 * the production timeline and media stores, and on stores of the export feature of their own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportAnywayScope,
  goBackToSetup,
  takeBackScope,
} from "@/components/export/exportBackToSetup";
import {
  createComposeFlowTarget,
  createExportComposeStore,
  createExportQueueStore,
  createExportScopeStore,
  createExportStore,
  createSegmentListScope,
  ExportError,
  showExportStoreTarget,
  WHOLE_EXPORT_SCOPE,
  type ExportFlowTarget,
  type ExportQueueSubmitResult,
  type ExportRequest,
  type ExportScope,
  type ExportScopeStore,
  type ExportStore,
  type OpenExportSaveDialogOptions,
} from "@/features/export";
import { mediaStore, type MediaSourceRevisionDescriptor } from "@/features/media";
import type { ImportMediaResult } from "@/features/media/types";
import type { Preset, Settings } from "@/features/settings/types";
import { timelineStore } from "@/features/timeline";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Pts, Segment, SequenceSegment } from "@/types/project";
import {
  confirmExportFlow,
  createExportFlowController,
  isExportScopeValidNow,
  measurementScope,
  openExportFlow,
  runExportFlow,
  type ExportFlowControllerOptions,
  type MediaFlowDescriptor,
} from "./exportFlowController";

const pts = (value: string) => value as Pts;

function createPreset(): Preset {
  return {
    id: "default",
    name: "Default",
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    audioGainTenthsDb: 0,
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    pixelFormat: "yuv420p",
    videoOptions: [],
    audioOptions: [],
  };
}

const SETTINGS: Settings = {
  schemaVersion: 3,
  revision: 7,
  activePresetId: "default",
  presets: [createPreset()],
};

function facts(id: string, end: string): SequenceSource {
  return {
    id,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: pts("0"),
    videoEndPts: pts(end),
    videoDurationTicks: null,
    approximateDurationSeconds: null,
  };
}

function imported(path: string, size: number, mtime: number): ImportMediaResult {
  return { path, fileName: path.slice(1), size, mtime } as ImportMediaResult;
}

function anchored(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
  name?: string,
): SequenceSegment {
  return {
    id,
    inClipId,
    inPts: pts(inPts),
    outClipId,
    outPts: pts(outPts),
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Clips a1 (A) and b1 (B). `x` lies on a1 and has a name, `y` lies on b1. The export takes x and
 * y, in that order.
 */
function loadSequence(
  segments: SequenceSegment[] = [
    anchored("x", "a1", "1000", "a1", "2000", "Intro: part 1"),
    anchored("y", "b1", "1000", "b1", "3000"),
  ],
): void {
  timelineStore.setState({
    clips: [
      { id: "a1", sourceId: "A" },
      { id: "b1", sourceId: "B" },
    ],
    sequenceSources: { A: facts("A", "10000"), B: facts("B", "5000") },
    sequenceSegments: segments,
  });
  mediaStore.setState({
    sources: { A: imported("/a.mp4", 10, 1), B: imported("/b.mov", 20, 2) },
  });
}

/** Moves the Out of `x`, as an edit while an open step waits, or an import that ends. */
function moveX(): void {
  timelineStore.setState({
    sequenceSegments: timelineStore
      .getState()
      .sequenceSegments.map((segment) =>
        segment.id === "x" ? { ...segment, outPts: pts("2500") } : segment,
      ),
  });
}

/** A list of the segments `ids` of the sequence now, with its record. */
function listOf(ids: readonly string[]): ExportScope {
  return createSegmentListScope(timelineStore.getState(), ids);
}

const MEDIA: MediaFlowDescriptor = {
  path: "/a.mp4",
  fileName: "a.mp4",
  size: 10,
  mtime: 1,
};

/** A reader of the revisions of both files, unchanged. */
function matchingReader(): (path: string) => Promise<MediaSourceRevisionDescriptor> {
  const revisions: Record<string, { size: number; mtime: number }> = {
    "/a.mp4": { size: 10, mtime: 1 },
    "/b.mov": { size: 20, mtime: 2 },
  };
  return vi.fn((path: string) => {
    const revision = revisions[path];
    return revision === undefined
      ? Promise.reject(new Error("missing"))
      : Promise.resolve({ path, ...revision });
  });
}

/** Binds the target options of the controller to an export store, as `openExportFlow` does. */
function exportTarget(store: ExportStore): ExportFlowTarget {
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

interface Harness {
  readonly exportStore: ExportStore;
  readonly scopeStore: ExportScopeStore;
  readonly options: ExportFlowControllerOptions;
  readonly setModalOpen: ReturnType<typeof vi.fn>;
  readonly openSaveDialog: ReturnType<
    typeof vi.fn<(options: OpenExportSaveDialogOptions) => Promise<string | null>>
  >;
  readonly submit: ReturnType<
    typeof vi.fn<(request: ExportRequest) => Promise<ExportQueueSubmitResult>>
  >;
}

/** The options of a flow on its own stores, for a sequence of several clips. */
function harness(overrides: Partial<ExportFlowControllerOptions> = {}): Harness {
  const exportStore = createExportStore();
  const scopeStore = createExportScopeStore({ shownRunIds: () => [] });
  const setModalOpen = vi.fn();
  const openSaveDialog = vi.fn<
    (options: OpenExportSaveDialogOptions) => Promise<string | null>
  >(() => Promise.resolve("/out/file.mp4"));
  const submit = vi.fn<(request: ExportRequest) => Promise<ExportQueueSubmitResult>>(
    () => Promise.resolve({ kind: "started", runId: "run-1" }),
  );
  const options: ExportFlowControllerOptions = {
    ...exportTarget(exportStore),
    setModalOpen,
    filterName: "Video Files",
    audioFilterName: "Audio Files",
    openSaveDialog,
    submit,
    getMedia: () => MEDIA,
    getSegments: () => [],
    getSourceId: () => "sequence:1",
    getSettings: () => SETTINGS,
    getAudioOverrides: () => ({}),
    readSourceRevision: matchingReader(),
    saveSettings: () => Promise.resolve(),
    scopeStore,
    getStartFailure: () => exportStore.getState().error,
    ...overrides,
  };
  return { exportStore, scopeStore, options, setModalOpen, openSaveDialog, submit };
}

/** The ids of the segments that a request takes, by the In of each piece. */
function piecesOf(request: ExportRequest | undefined): string[] {
  return (request?.pieces ?? []).map((piece) => `${piece.sourceId}:${piece.inPts}`);
}

const initialTimeline = timelineStore.getState();
const initialMedia = mediaStore.getState();
afterEach(() => {
  timelineStore.setState(initialTimeline, true);
  mediaStore.setState(initialMedia, true);
});

describe("the open step (ADR 067)", () => {
  it("checks the segments of its scope only", async () => {
    loadSequence();
    // B has no imported media, so the whole export cannot export.
    mediaStore.setState({ sources: { A: imported("/a.mp4", 10, 1) } });
    const whole = harness();
    expect(await runExportFlow(whole.options)).toBe(false);
    expect(whole.exportStore.getState().error?.code).toBe("sourceNotFound");

    const list = harness();
    const reader = matchingReader();
    expect(
      await runExportFlow({
        ...list.options,
        readSourceRevision: reader,
        scope: listOf(["x"]),
      }),
    ).toBe(true);
    // The check of the revisions reads only the file of the scope.
    expect(reader).toHaveBeenCalledExactlyOnceWith("/a.mp4");
    expect(list.scopeStore.getState().setup.export).toStrictEqual(listOf(["x"]));
  });

  it("checks the segments of its scope with one clip", async () => {
    const segments: Segment[] = [
      { id: "p", sourceId: "s", inPts: pts("0"), outPts: pts("100") },
      { id: "q", sourceId: "s", inPts: pts("200"), outPts: pts("300") },
    ];
    const flow = harness({ getSegments: () => segments, getSourceId: () => "s" });
    const scope = createSegmentListScope(
      { ...timelineStore.getState(), segments, sourceId: "s" },
      ["q"],
    );
    expect(await runExportFlow({ ...flow.options, scope })).toBe(true);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });

  it("sets the scope of the setup step only when it shows, after it waited for its check", async () => {
    loadSequence();
    const flow = harness();
    flow.scopeStore.getState().publishSetup("export", WHOLE_EXPORT_SCOPE);
    let answer: (value: MediaSourceRevisionDescriptor) => void = () => {};
    const readSourceRevision = vi.fn(
      () =>
        new Promise<MediaSourceRevisionDescriptor>((resolve) => {
          answer = resolve;
        }),
    );
    const scope = listOf(["x"]);
    const step = runExportFlow({ ...flow.options, readSourceRevision, scope });
    await vi.waitFor(() => {
      expect(readSourceRevision).toHaveBeenCalled();
    });
    // The step waits: it shows nothing yet, so it set nothing.
    expect(flow.scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
    expect(flow.setModalOpen).not.toHaveBeenCalled();
    answer({ path: "/a.mp4", size: 10, mtime: 1 });
    expect(await step).toBe(true);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
    expect(flow.setModalOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("sets the scope of the setup step when it shows the error of its checks", async () => {
    loadSequence();
    const flow = harness({
      readSourceRevision: vi
        .fn()
        .mockResolvedValue({ path: "/a.mp4", size: 11, mtime: 1 }),
    });
    const scope = listOf(["x"]);
    expect(await runExportFlow({ ...flow.options, scope })).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("sourceRevisionChanged");
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });

  it("sets nothing when it shows nothing", async () => {
    loadSequence();
    const flow = harness();
    let answer: (value: MediaSourceRevisionDescriptor) => void = () => {};
    const waiting = runExportFlow({
      ...flow.options,
      scope: listOf(["x"]),
      readSourceRevision: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    // A second step for the same file while the first waits does nothing (ADR 024).
    const second = vi.fn();
    expect(
      await runExportFlow({
        ...flow.options,
        publishScope: second,
        scope: listOf(["y"]),
      }),
    ).toBe(false);
    expect(second).not.toHaveBeenCalled();
    // A step for another file replaces the first, which then shows nothing and sets nothing.
    const replacing = vi.fn();
    const next = runExportFlow({
      ...flow.options,
      getMedia: () => ({ ...MEDIA, path: "/other.mp4" }),
      publishScope: replacing,
    });
    answer({ path: "/a.mp4", size: 10, mtime: 1 });
    expect(await waiting).toBe(false);
    expect(await next).toBe(true);
    expect(replacing).toHaveBeenCalledExactlyOnceWith(WHOLE_EXPORT_SCOPE);
    // The list of the replaced step never reached the store.
    expect(flow.scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);

    // A store with a live run shows that run and not the setup step, so it sets nothing.
    const live = harness();
    live.exportStore.setState({ status: "running", runId: "run-9", tracking: true });
    const publishScope = vi.fn();
    const controller = createExportFlowController({
      ...live.options,
      publishScope,
      scope: listOf(["x"]),
    });
    expect(await controller.run()).toBe(false);
    expect(publishScope).not.toHaveBeenCalled();
  });

  it("shows selectedSegmentsChanged for a list that changed while it waited", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    let answer: (value: MediaSourceRevisionDescriptor) => void = () => {};
    const readSourceRevision = vi.fn(
      () =>
        new Promise<MediaSourceRevisionDescriptor>((resolve) => {
          answer = resolve;
        }),
    );
    const step = runExportFlow({ ...flow.options, scope, readSourceRevision });
    await vi.waitFor(() => {
      expect(readSourceRevision).toHaveBeenCalled();
    });
    // An edit of the selected segment while the step waits for its check.
    moveX();
    answer({ path: "/a.mp4", size: 10, mtime: 1 });
    expect(await step).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("selectedSegmentsChanged");
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
    expect(flow.setModalOpen).toHaveBeenCalledWith(true);
    expect(flow.submit).not.toHaveBeenCalled();
  });

  it("shows selectedSegmentsChanged in place of the error of a check", async () => {
    loadSequence();
    const flow = harness({
      readSourceRevision: vi
        .fn()
        .mockResolvedValue({ path: "/a.mp4", size: 11, mtime: 1 }),
    });
    const scope = listOf(["x"]);
    moveX();
    expect(await runExportFlow({ ...flow.options, scope })).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("selectedSegmentsChanged");
  });

  it("opens the setup step of a new export for the queue while a run is live", async () => {
    loadSequence();
    const exportStore = createExportStore();
    exportStore.setState({ status: "running", runId: "run-1", tracking: true });
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    const scopeStore = createExportScopeStore();
    const scope = listOf(["y"]);
    const setModalOpen = vi.fn();
    expect(
      await openExportFlow(
        {
          setModalOpen,
          filterName: "Video Files",
          audioFilterName: "Audio Files",
          getMedia: () => MEDIA,
          getSegments: () => [],
          getSourceId: () => "sequence:1",
          getSettings: () => SETTINGS,
          readSourceRevision: matchingReader(),
          scopeStore,
          scope,
        },
        { exportStore, queueStore, composeStore },
      ),
    ).toBe(true);
    expect(composeStore.getState().composing).toBe(true);
    // The step ran on the compose target, so it set the scope of that target only.
    expect(scopeStore.getState().setup.compose).toBe(scope);
    expect(scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
    expect(exportStore.getState().status).toBe("running");
  });
});

describe('"Export anyway" (ADR 067)', () => {
  const changed = () =>
    vi.fn().mockResolvedValue({ path: "/a.mp4", size: 11, mtime: 1 });

  it("keeps the scope in the ordinary state", async () => {
    loadSequence();
    const flow = harness({ readSourceRevision: changed() });
    const scope = listOf(["x"]);
    expect(await runExportFlow({ ...flow.options, scope })).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("sourceRevisionChanged");
    // The dialog closes and resets the confirmation, and runs the open step again.
    flow.exportStore.getState().reset();
    const reader = changed();
    expect(
      await runExportFlow({
        ...flow.options,
        readSourceRevision: reader,
        skipSourceRevisionCheck: true,
        scope: exportAnywayScope(flow.scopeStore, "export"),
      }),
    ).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });

  it("keeps the scope in the compose state", async () => {
    loadSequence();
    const exportStore = createExportStore();
    exportStore.setState({ status: "running", runId: "run-1", tracking: true });
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    const scopeStore = createExportScopeStore();
    const scope = listOf(["y"]);
    const base = {
      setModalOpen: vi.fn(),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      getMedia: () => MEDIA,
      getSegments: () => [],
      getSourceId: () => "sequence:1",
      getSettings: () => SETTINGS,
      scopeStore,
    };
    expect(
      await openExportFlow(
        { ...base, readSourceRevision: changed(), scope },
        { exportStore, queueStore, composeStore },
      ),
    ).toBe(false);
    expect(composeStore.getState().error?.code).toBe("sourceRevisionChanged");
    // In the compose state the dialog stays open, resets the compose store, and runs the open
    // step again on it.
    const target = createComposeFlowTarget(composeStore);
    target.reset();
    expect(
      await runExportFlow({
        ...base,
        ...target,
        readSourceRevision: changed(),
        skipSourceRevisionCheck: true,
        scope: exportAnywayScope(scopeStore, "compose"),
      }),
    ).toBe(true);
    expect(scopeStore.getState().setup.compose).toBe(scope);
    expect(composeStore.getState()).toMatchObject({ composing: true, status: "idle" });
  });
});

describe("the confirm step (ADR 067)", () => {
  it("captures the scope of the setup step once, and uses it for every later thing", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    flow.openSaveDialog.mockImplementation(() => {
      // Another step sets another scope while the save dialog is open.
      flow.scopeStore.getState().publishSetup("export", WHOLE_EXPORT_SCOPE);
      return Promise.resolve("/out/file.mp4");
    });
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(true);
    expect(flow.openSaveDialog).toHaveBeenCalledOnce();
    expect(flow.openSaveDialog.mock.calls[0]?.[0].defaultName).toBe(
      "a_01 Intro_ part 1.mp4",
    );
    const request = flow.submit.mock.calls[0]?.[0];
    expect(request?.segmentCount).toBe(1);
    expect(piecesOf(request)).toStrictEqual(["A:1000"]);
    expect(request?.sources.map((source) => source.id)).toStrictEqual(["A"]);
    expect(flow.scopeStore.getState().runScope("run-1")).toBe(scope);
  });

  it("proposes the name of the one segment with its number among all segments", async () => {
    loadSequence();
    const flow = harness();
    flow.scopeStore.getState().publishSetup("export", listOf(["y"]));
    await confirmExportFlow(flow.options, "default", "audioOnly", "encode");
    // `y` is the second segment of the export, reads b.mov, and has no name.
    expect(flow.openSaveDialog.mock.calls[0]?.[0].defaultName).toBe("b_02.m4a");
  });

  it("proposes the name of the whole export for a list of several segments, and for the whole export", async () => {
    loadSequence();
    const several = harness();
    several.scopeStore.getState().publishSetup("export", listOf(["x", "y"]));
    await confirmExportFlow(several.options, "default", "videoAndAudio", "encode");
    expect(several.openSaveDialog.mock.calls[0]?.[0].defaultName).toBe("a_export.mp4");
    expect(several.submit.mock.calls[0]?.[0].segmentCount).toBe(2);

    const whole = harness();
    await confirmExportFlow(whole.options, "default", "videoAndAudio", "encode");
    expect(whole.openSaveDialog.mock.calls[0]?.[0].defaultName).toBe("a_export.mp4");
    expect(piecesOf(whole.submit.mock.calls[0]?.[0])).toStrictEqual([
      "A:1000",
      "B:1000",
    ]);
  });

  it("proposes the name of the one segment with one clip", async () => {
    const segments: Segment[] = [
      { id: "p", sourceId: "s", inPts: pts("0"), outPts: pts("100") },
      { id: "q", sourceId: "s", inPts: pts("200"), outPts: pts("300"), name: "Goal" },
    ];
    const flow = harness({
      getSegments: () => segments,
      getSourceId: () => "s",
      getMedia: () => ({ ...MEDIA, fileName: "match.mkv" }),
    });
    flow.scopeStore
      .getState()
      .publishSetup(
        "export",
        createSegmentListScope(
          { ...timelineStore.getState(), segments, sourceId: "s" },
          ["q"],
        ),
      );
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(true);
    expect(flow.openSaveDialog.mock.calls[0]?.[0].defaultName).toBe(
      "match_02 Goal.mp4",
    );
    const request = flow.submit.mock.calls[0]?.[0];
    expect(request?.pieces).toStrictEqual([
      { sourceId: "s", inPts: "200", outPts: "300" },
    ]);
  });

  it("sends nothing for a list that is not valid before the save dialog", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    moveX();
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    expect(flow.openSaveDialog).not.toHaveBeenCalled();
    expect(flow.submit).not.toHaveBeenCalled();
    const error = flow.exportStore.getState().error;
    expect(error?.code).toBe("selectedSegmentsChanged");
    expect(flow.scopeStore.getState().failureScope(error)).toBe(scope);
    expect(flow.setModalOpen).toHaveBeenCalledWith(true);
  });

  it("sends nothing for a list that is not valid after the save dialog", async () => {
    loadSequence();
    const flow = harness();
    flow.scopeStore.getState().publishSetup("export", listOf(["x"]));
    flow.openSaveDialog.mockImplementation(() => {
      moveX();
      return Promise.resolve("/out/file.mp4");
    });
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    expect(flow.openSaveDialog).toHaveBeenCalledOnce();
    expect(flow.submit).not.toHaveBeenCalled();
    expect(flow.exportStore.getState().error?.code).toBe("selectedSegmentsChanged");
  });

  it("keeps the scope when the user cancels the save dialog", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    flow.openSaveDialog.mockResolvedValue(null);
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    expect(flow.submit).not.toHaveBeenCalled();
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
    expect(flow.exportStore.getState().status).toBe("idle");
  });
});

describe("the answers to the request (ADR 067)", () => {
  it("keeps the scope with a refusal that arrives after another setup step opened", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    let refuse: (result: ExportQueueSubmitResult) => void = () => {};
    flow.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          refuse = resolve;
        }),
    );
    const confirming = confirmExportFlow(
      flow.options,
      "default",
      "videoAndAudio",
      "encode",
    );
    await vi.waitFor(() => {
      expect(flow.submit).toHaveBeenCalled();
    });
    // Another action opens another setup step, for the whole export.
    const other = listOf(["y"]);
    flow.scopeStore.getState().publishSetup("export", other);
    const refusal = new ExportError({ code: "outputAlreadyQueued" });
    refuse({ kind: "refused", error: refusal });
    expect(await confirming).toBe(false);
    expect(flow.exportStore.getState().error).toBe(refusal);
    // The scope of the setup step that shows does not change.
    expect(flow.scopeStore.getState().setup.export).toBe(other);
    expect(flow.scopeStore.getState().failureScope(refusal)).toBe(scope);
    // Back from the refusal sets the scope of the request.
    expect(
      takeBackScope(
        { runId: null, error: flow.exportStore.getState().error },
        flow.scopeStore,
        "export",
      ),
    ).toBe(scope);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });

  it("keeps the scope of a refusal in the compose store that holds it", async () => {
    loadSequence();
    const composeStore = createExportComposeStore();
    const flow = harness();
    const scope = listOf(["y"]);
    // The confirm step of the compose target reads the scope of that target.
    flow.scopeStore.getState().publishSetup("compose", scope);
    flow.submit.mockResolvedValue({
      kind: "refused",
      error: new ExportError({ code: "outputAlreadyQueued" }),
    });
    expect(
      await confirmExportFlow(
        { ...flow.options, ...createComposeFlowTarget(composeStore) },
        "default",
        "videoAndAudio",
        "encode",
      ),
    ).toBe(false);
    const error = composeStore.getState().error;
    expect(error?.code).toBe("outputAlreadyQueued");
    expect(flow.exportStore.getState().error).toBeNull();
    expect(flow.scopeStore.getState().failureScope(error)).toBe(scope);
  });

  it("keeps the scope with a start failure that has no run id", async () => {
    loadSequence();
    const exportStore = createExportStore({
      startExport: () => Promise.reject(new ExportError({ code: "invalidPreset" })),
      subscribeExportProgress: () => Promise.resolve(() => {}),
    });
    const queueStore = createExportQueueStore({
      exportStore,
      subscribeExportProgress: () => Promise.resolve(() => {}),
    });
    const flow = harness({
      ...exportTarget(exportStore),
      submit: (request) => queueStore.getState().submit(request),
      getStartFailure: () => exportStore.getState().error,
    });
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    const state = exportStore.getState();
    expect(state).toMatchObject({ status: "failed", runId: null, tracking: false });
    expect(state.error?.code).toBe("invalidPreset");
    expect(flow.scopeStore.getState().failureScope(state.error)).toBe(scope);
    expect(
      takeBackScope(
        { runId: state.runId, error: state.error },
        flow.scopeStore,
        "export",
      ),
    ).toBe(scope);
  });
});

describe("Back (ADR 067)", () => {
  it("restores the scope of an admitted run after another action, and checks it again", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(true);
    // Another action opens a setup step for the whole export.
    flow.scopeStore.getState().publishSetup("export", WHOLE_EXPORT_SCOPE);
    // The run fails in the export store, which shows it with its id.
    flow.exportStore.setState({
      status: "failed",
      runId: "run-1",
      tracking: false,
      error: new ExportError({ code: "ffmpegProcessFailed" }),
    });
    const state = flow.exportStore.getState();
    const backScope = takeBackScope(
      { runId: state.runId, error: state.error },
      flow.scopeStore,
      "export",
    );
    // From the moment of the press.
    expect(backScope).toBe(scope);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
    flow.exportStore.getState().reset();
    expect(await runExportFlow({ ...flow.options, scope: backScope })).toBe(true);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });

  it("shows selectedSegmentsChanged when the timeline changed while the run was in the background", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode");
    moveX();
    flow.exportStore.setState({
      status: "failed",
      runId: "run-1",
      tracking: false,
      error: new ExportError({ code: "ffmpegProcessFailed" }),
    });
    const state = flow.exportStore.getState();
    const backScope = takeBackScope(
      { runId: state.runId, error: state.error },
      flow.scopeStore,
      "export",
    );
    flow.exportStore.getState().reset();
    expect(await runExportFlow({ ...flow.options, scope: backScope })).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("selectedSegmentsChanged");
    expect(flow.submit).toHaveBeenCalledOnce();
  });

  it("gives a run with no kept scope the whole export", () => {
    const scopeStore = createExportScopeStore();
    scopeStore.getState().publishSetup("export", listOf(["x"]));
    // A run from before the page loaded again (ADR 051).
    expect(
      takeBackScope(
        {
          runId: "restored-run",
          error: new ExportError({ code: "ffmpegProcessFailed" }),
        },
        scopeStore,
        "export",
      ),
    ).toBe(WHOLE_EXPORT_SCOPE);
    expect(scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
  });

  it("keeps the scope after the error of an open step", async () => {
    loadSequence([]);
    const flow = harness();
    const scope = createSegmentListScope(timelineStore.getState(), ["gone"]);
    expect(await runExportFlow({ ...flow.options, scope })).toBe(false);
    const state = flow.exportStore.getState();
    expect(state.error?.code).toBe("selectedSegmentsChanged");
    expect(
      takeBackScope(
        { runId: state.runId, error: state.error },
        flow.scopeStore,
        "export",
      ),
    ).toBe(scope);
    expect(flow.scopeStore.getState().setup.export).toBe(scope);
  });
});

describe("Back tests the list that it restores (ADR 067)", () => {
  /** A failed run-1 of a list of `x`, after an edit of `x` while the run was in the background. */
  async function failedListRun() {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(true);
    moveX();
    // The Export button opened a step for the whole export, whose source check waits, so the
    // guard of `runExportFlow` holds the file.
    let answer: () => void = () => {};
    const waiting = runExportFlow({
      ...flow.options,
      publishScope: () => {},
      reportError: () => {},
      setModalOpen: () => {},
      readSourceRevision: (path) =>
        new Promise<MediaSourceRevisionDescriptor>((resolve) => {
          answer = () => {
            resolve({ path, size: 10, mtime: 1 });
          };
        }),
    });
    /** Lets the waiting step end, so the guard holds no file for a later test. */
    const release = async () => {
      answer();
      await waiting;
    };
    flow.exportStore.setState({
      status: "failed",
      runId: "run-1",
      tracking: false,
      error: new ExportError({ code: "ffmpegProcessFailed" }),
    });
    return { flow, scope, release };
  }

  it("shows selectedSegmentsChanged while another open step holds the guard, and starts no step", async () => {
    const { flow, scope, release } = await failedListRun();
    try {
      // The guard alone would return before an open step tests the list.
      const guarded = vi.fn();
      expect(
        await runExportFlow({ ...flow.options, scope, reportError: guarded }),
      ).toBe(false);
      expect(guarded).not.toHaveBeenCalled();

      const state = flow.exportStore.getState();
      const openStep = vi.fn();
      expect(
        goBackToSetup({
          target: { runId: state.runId, error: state.error },
          scopeStore: flow.scopeStore,
          scopeTarget: "export",
          isScopeValid: isExportScopeValidNow,
          reset: () => {
            flow.exportStore.getState().reset();
          },
          reportError: (error) => {
            flow.exportStore.getState().reportError(error);
          },
          openStep,
        }),
      ).toBe(scope);
      expect(openStep).not.toHaveBeenCalled();
      expect(flow.exportStore.getState()).toMatchObject({
        status: "failed",
        runId: null,
      });
      expect(flow.exportStore.getState().error?.code).toBe("selectedSegmentsChanged");
      expect(flow.scopeStore.getState().setup.export).toBe(scope);
    } finally {
      // The guard must hold no file for a later test.
      await release();
    }
  });

  it("reports to the compose store in the compose state", () => {
    loadSequence();
    const scopeStore = createExportScopeStore();
    const composeStore = createExportComposeStore();
    const scope = listOf(["y"]);
    const refusal = new ExportError({ code: "outputAlreadyQueued" });
    scopeStore.getState().keepFailure(refusal, scope);
    composeStore.getState().reportError(refusal);
    timelineStore.setState({ sequenceSegments: [] });
    const target = createComposeFlowTarget(composeStore);
    const openStep = vi.fn();
    goBackToSetup({
      target: { runId: null, error: composeStore.getState().error },
      scopeStore,
      scopeTarget: "compose",
      isScopeValid: isExportScopeValidNow,
      reset: target.reset,
      reportError: target.reportError,
      openStep,
    });
    expect(openStep).not.toHaveBeenCalled();
    expect(composeStore.getState()).toMatchObject({
      composing: true,
      status: "failed",
    });
    expect(composeStore.getState().error?.code).toBe("selectedSegmentsChanged");
    expect(scopeStore.getState().setup.compose).toBe(scope);
  });

  it("runs the open step with a list that is still valid", () => {
    loadSequence();
    const scopeStore = createExportScopeStore({ shownRunIds: () => [] });
    const scope = listOf(["x"]);
    scopeStore.getState().keepRun("run-1", scope);
    const reset = vi.fn();
    const reportError = vi.fn();
    const openStep = vi.fn();
    goBackToSetup({
      target: {
        runId: "run-1",
        error: new ExportError({ code: "ffmpegProcessFailed" }),
      },
      scopeStore,
      scopeTarget: "export",
      isScopeValid: isExportScopeValidNow,
      reset,
      reportError,
      openStep,
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
    expect(openStep).toHaveBeenCalledExactlyOnceWith(scope);
  });
});

describe("an open step that the dialog does not show (ADR 067)", () => {
  function liveStores() {
    const exportStore = createExportStore();
    exportStore.setState({ status: "running", runId: "run-1", tracking: true });
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    const scopeStore = createExportScopeStore();
    return { exportStore, queueStore, composeStore, scopeStore };
  }

  function waitingStep(
    stores: ReturnType<typeof liveStores>,
    scope: ExportScope,
    revision: { size: number; mtime: number },
  ) {
    let answer: () => void = () => {};
    const readSourceRevision = vi.fn(
      (path: string) =>
        new Promise<MediaSourceRevisionDescriptor>((resolve) => {
          answer = () => {
            resolve({ path, ...revision });
          };
        }),
    );
    const setModalOpen = vi.fn();
    const step = openExportFlow(
      {
        setModalOpen,
        filterName: "Video Files",
        audioFilterName: "Audio Files",
        getMedia: () => MEDIA,
        getSegments: () => [],
        getSourceId: () => "sequence:1",
        getSettings: () => SETTINGS,
        readSourceRevision,
        scopeStore: stores.scopeStore,
        scope,
      },
      stores,
    );
    return { step, setModalOpen, readSourceRevision, answer: () => answer() };
  }

  it("sets no scope when a refusal of an earlier request shows while its check waits", async () => {
    loadSequence();
    const stores = liveStores();
    const b = waitingStep(stores, listOf(["y"]), { size: 20, mtime: 2 });
    await vi.waitFor(() => {
      expect(b.readSourceRevision).toHaveBeenCalled();
    });
    // The refusal of list export A arrives, and the compose store shows it.
    const refusal = new ExportError({ code: "outputAlreadyQueued" });
    stores.composeStore.getState().reportError(refusal);
    b.answer();
    await b.step;
    // The panel keeps the failure of A, and the scope of the setup step does not change.
    expect(stores.composeStore.getState()).toMatchObject({
      composing: true,
      status: "failed",
    });
    expect(stores.composeStore.getState().error).toBe(refusal);
    expect(stores.scopeStore.getState().setup.compose).toBe(WHOLE_EXPORT_SCOPE);
    expect(b.setModalOpen).toHaveBeenCalledWith(true);
  });

  it("sets its scope when its own check error replaces that failure", async () => {
    loadSequence();
    const stores = liveStores();
    const scope = listOf(["y"]);
    const b = waitingStep(stores, scope, { size: 21, mtime: 2 });
    await vi.waitFor(() => {
      expect(b.readSourceRevision).toHaveBeenCalled();
    });
    stores.composeStore
      .getState()
      .reportError(new ExportError({ code: "outputAlreadyQueued" }));
    b.answer();
    expect(await b.step).toBe(false);
    expect(stores.composeStore.getState().error?.code).toBe("sourceRevisionChanged");
    expect(stores.scopeStore.getState().setup.compose).toBe(scope);
  });
});

describe("the second test of the confirm step after a cancel (ADR 067)", () => {
  it("reports selectedSegmentsChanged when the list changed while the save dialog was open", async () => {
    loadSequence();
    const flow = harness();
    const scope = listOf(["x"]);
    flow.scopeStore.getState().publishSetup("export", scope);
    flow.openSaveDialog.mockImplementation(() => {
      moveX();
      return Promise.resolve(null);
    });
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    expect(flow.submit).not.toHaveBeenCalled();
    const error = flow.exportStore.getState().error;
    expect(error?.code).toBe("selectedSegmentsChanged");
    expect(flow.scopeStore.getState().failureScope(error)).toBe(scope);
    expect(flow.setModalOpen).toHaveBeenCalledWith(true);
  });

  it("keeps the report of a failure of the save dialog", async () => {
    loadSequence();
    const flow = harness();
    flow.scopeStore.getState().publishSetup("export", listOf(["x"]));
    flow.openSaveDialog.mockImplementation((options) => {
      moveX();
      options.reportError?.(new ExportError({ code: "dialogFailed" }));
      return Promise.resolve(null);
    });
    expect(
      await confirmExportFlow(flow.options, "default", "videoAndAudio", "encode"),
    ).toBe(false);
    expect(flow.exportStore.getState().error?.code).toBe("dialogFailed");
  });
});

describe("the readers of a list (ADR 067)", () => {
  function measurementOf(scope: ExportScope) {
    return measurementScope({
      timeline: timelineStore.getState(),
      sources: mediaStore.getState().sources,
      media: MEDIA,
      segments: [],
      sourceId: "sequence:1",
      preset: createPreset(),
      streams: "videoAndAudio",
      skipSourceRevisionCheck: false,
      audioOverrides: {},
      scope,
    });
  }

  it("measures only the pieces of a list", () => {
    loadSequence();
    const whole = measurementOf(WHOLE_EXPORT_SCOPE);
    expect(whole?.segmentCount).toBe(2);
    expect(whole?.pieces.map((piece) => piece.sourceId)).toStrictEqual(["A", "B"]);
    const list = measurementOf(listOf(["y"]));
    expect(list?.segmentCount).toBe(1);
    expect(list?.pieces).toStrictEqual([
      { sourceId: "B", inPts: "1000", outPts: "3000" },
    ]);
    expect(list?.sources.map((source) => source.id)).toStrictEqual(["B"]);
    // A list that is not valid builds no request, so nothing is measured.
    const scope = listOf(["x"]);
    moveX();
    expect(measurementOf(scope)).toBeNull();
  });

  it("opens a small list when the whole timeline passes the limit of the parts", async () => {
    // 129 segments from a1 into b1 give 258 parts, two more than an export joins.
    loadSequence([
      anchored("x", "a1", "1000", "a1", "2000"),
      ...Array.from({ length: 129 }, (_, index) =>
        anchored(`s${index}`, "a1", "100", "b1", "1000"),
      ),
    ]);
    const whole = harness();
    expect(await runExportFlow(whole.options)).toBe(false);
    expect(whole.exportStore.getState().error).toMatchObject({
      code: "tooManySegments",
      pieceLimit: 256,
    });
    const small = harness();
    expect(await runExportFlow({ ...small.options, scope: listOf(["x", "s0"]) })).toBe(
      true,
    );
    const large = harness();
    const all = Array.from({ length: 129 }, (_, index) => `s${index}`);
    expect(await runExportFlow({ ...large.options, scope: listOf(all) })).toBe(false);
    expect(large.exportStore.getState().error).toMatchObject({
      code: "tooManySegments",
      pieceLimit: 256,
    });
  });

  it("opens a small list when the whole timeline passes the limit of the input runs", async () => {
    // 43 segments from a1 into b1 repeat two ranges: 86 parts that need 86 runs.
    loadSequence(
      Array.from({ length: 43 }, (_, index) =>
        anchored(`s${index}`, "a1", "100", "b1", "1000"),
      ),
    );
    const whole = harness();
    expect(await runExportFlow(whole.options)).toBe(false);
    expect(whole.exportStore.getState().error).toMatchObject({
      code: "piecesOutOfOrder",
      inputLimit: 85,
    });
    const small = harness();
    expect(await runExportFlow({ ...small.options, scope: listOf(["s0", "s1"]) })).toBe(
      true,
    );
    const large = harness();
    const all = Array.from({ length: 43 }, (_, index) => `s${index}`);
    expect(await runExportFlow({ ...large.options, scope: listOf(all) })).toBe(false);
    expect(large.exportStore.getState().error).toMatchObject({
      code: "piecesOutOfOrder",
      inputLimit: 85,
    });
  });
});

describe("one setup scope for each flow target (ADR 067)", () => {
  /** A flow on its own stores with a live run, as `openExportFlow` and the dialog run it. */
  function dialogStores() {
    const exportStore = createExportStore();
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    const scopeStore = createExportScopeStore({ shownRunIds: () => [] });
    return { exportStore, queueStore, composeStore, scopeStore };
  }

  function baseOptions(stores: ReturnType<typeof dialogStores>) {
    return {
      setModalOpen: vi.fn(),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      openSaveDialog: vi.fn(() => Promise.resolve("/out/file.mp4")),
      getMedia: () => MEDIA,
      getSegments: () => [],
      getSourceId: () => "sequence:1",
      getSettings: () => SETTINGS,
      getAudioOverrides: () => ({}),
      saveSettings: () => Promise.resolve(),
      scopeStore: stores.scopeStore,
      getStartFailure: () => stores.exportStore.getState().error,
    };
  }

  /** A reader whose answer the test gives, for a file that changed or not. */
  function deferredReader() {
    let answer: (changed: boolean) => void = () => {};
    const read = vi.fn(
      (path: string) =>
        new Promise<MediaSourceRevisionDescriptor>((resolve) => {
          answer = (changed) => {
            const revision =
              path === "/a.mp4" ? { size: 10, mtime: 1 } : { size: 20, mtime: 2 };
            resolve({ path, ...revision, size: revision.size + (changed ? 1 : 0) });
          };
        }),
    );
    return { read, answer: (changed: boolean) => answer(changed) };
  }

  it("goes on with A after the confirmation of A, when Back of B set the scope of B", async () => {
    loadSequence();
    const stores = dialogStores();
    const base = baseOptions(stores);
    const ordinary = exportTarget(stores.exportStore);
    const compose = createComposeFlowTarget(stores.composeStore);
    const listA = listOf(["x"]);
    const listB = listOf(["y"]);

    // List export A runs.
    stores.scopeStore.getState().publishSetup("export", listA);
    const submitA = vi.fn(() =>
      Promise.resolve<ExportQueueSubmitResult>({ kind: "started", runId: "run-A" }),
    );
    expect(
      await confirmExportFlow(
        { ...base, ...ordinary, submit: submitA },
        "default",
        "videoAndAudio",
        "encode",
      ),
    ).toBe(true);
    stores.exportStore.setState({ status: "running", runId: "run-A", tracking: true });

    // 1. The user sets up list export B in the compose state, confirms it, and cancels while the
    //    reply of the queue is pending.
    expect(
      await openExportFlow(
        { ...base, readSourceRevision: matchingReader(), scope: listB },
        stores,
      ),
    ).toBe(true);
    expect(stores.composeStore.getState().composing).toBe(true);
    let replyB: (result: ExportQueueSubmitResult) => void = () => {};
    const submitB = vi.fn(
      () =>
        new Promise<ExportQueueSubmitResult>((resolve) => {
          replyB = resolve;
        }),
    );
    const confirmingB = confirmExportFlow(
      { ...base, ...compose, submit: submitB },
      "default",
      "videoAndAudio",
      "encode",
    );
    await vi.waitFor(() => {
      expect(submitB).toHaveBeenCalled();
    });
    stores.composeStore.getState().exit();

    // 2. A fails. Back on A, while the source check of A is slow.
    stores.exportStore.setState({
      status: "failed",
      runId: "run-A",
      tracking: false,
      error: new ExportError({ code: "ffmpegProcessFailed" }),
    });
    const readerA = deferredReader();
    let backA: Promise<boolean> = Promise.resolve(false);
    goBackToSetup({
      target: {
        runId: stores.exportStore.getState().runId,
        error: stores.exportStore.getState().error,
      },
      scopeStore: stores.scopeStore,
      scopeTarget: "export",
      isScopeValid: isExportScopeValidNow,
      reset: ordinary.reset,
      reportError: ordinary.reportError,
      openStep: (scope) => {
        backA = runExportFlow({
          ...base,
          ...ordinary,
          readSourceRevision: readerA.read,
          scope,
        });
      },
    });
    await vi.waitFor(() => {
      expect(readerA.read).toHaveBeenCalled();
    });
    // The submission of B gets a refusal, and the dialog shows the failure of B.
    const refusalB = new ExportError({ code: "outputAlreadyQueued" });
    replyB({ kind: "refused", error: refusalB });
    expect(await confirmingB).toBe(false);
    expect(stores.composeStore.getState()).toMatchObject({
      composing: true,
      error: refusalB,
    });
    // The check of A finds a changed file, and writes the confirmation to the export store.
    readerA.answer(true);
    expect(await backA).toBe(false);
    expect(stores.exportStore.getState().error?.code).toBe("sourceRevisionChanged");
    expect(stores.scopeStore.getState().setup.export).toBe(listA);

    // 3. Back on the failure of B, then Cancel of the setup step of B.
    let backB: Promise<boolean> = Promise.resolve(false);
    goBackToSetup({
      target: { runId: null, error: stores.composeStore.getState().error },
      scopeStore: stores.scopeStore,
      scopeTarget: "compose",
      isScopeValid: isExportScopeValidNow,
      reset: compose.reset,
      reportError: compose.reportError,
      openStep: (scope) => {
        backB = runExportFlow({
          ...base,
          ...compose,
          readSourceRevision: matchingReader(),
          scope,
        });
      },
    });
    expect(await backB).toBe(true);
    expect(stores.scopeStore.getState().setup.compose).toBe(listB);
    stores.composeStore.getState().exit();

    // The dialog shows the confirmation of A. "Export anyway" goes on with A.
    const scope = exportAnywayScope(stores.scopeStore, "export");
    expect(scope).toBe(listA);
    ordinary.reset();
    expect(
      await runExportFlow({
        ...base,
        ...ordinary,
        readSourceRevision: matchingReader(),
        skipSourceRevisionCheck: true,
        scope,
      }),
    ).toBe(true);
    expect(stores.scopeStore.getState().setup.export).toBe(listA);
    const submitAgain = vi.fn(() =>
      Promise.resolve<ExportQueueSubmitResult>({ kind: "started", runId: "run-A2" }),
    );
    expect(
      await confirmExportFlow(
        { ...base, ...ordinary, submit: submitAgain, skipSourceRevisionCheck: true },
        "default",
        "videoAndAudio",
        "encode",
      ),
    ).toBe(true);
    const calls = submitAgain.mock.calls as unknown as [ExportRequest][];
    expect(piecesOf(calls[0]?.[0])).toStrictEqual(["A:1000"]);
  });

  it("writes the scope of a step on the export store while the dialog shows a compose failure", async () => {
    loadSequence();
    const stores = dialogStores();
    const base = baseOptions(stores);
    const listA = listOf(["x"]);
    const listB = listOf(["y"]);
    stores.scopeStore.getState().publishSetup("compose", listB);
    stores.composeStore
      .getState()
      .reportError(new ExportError({ code: "outputAlreadyQueued" }));
    expect(
      await runExportFlow({
        ...base,
        ...exportTarget(stores.exportStore),
        readSourceRevision: vi
          .fn()
          .mockResolvedValue({ path: "/a.mp4", size: 11, mtime: 1 }),
        scope: listA,
      }),
    ).toBe(false);
    expect(stores.exportStore.getState().error?.code).toBe("sourceRevisionChanged");
    expect(stores.scopeStore.getState().setup).toStrictEqual({
      export: listA,
      compose: listB,
    });
  });

  it.each(["export", "compose"] as const)(
    "reads the right scope for a whole export after a list export, and the reverse, on the %s target",
    async (scopeTarget) => {
      loadSequence();
      const stores = dialogStores();
      const base = baseOptions(stores);
      if (scopeTarget === "compose") {
        stores.exportStore.setState({
          status: "running",
          runId: "run-0",
          tracking: true,
        });
      }
      const sent: ExportRequest[] = [];
      const submit = vi.fn((request: ExportRequest) => {
        sent.push(request);
        return Promise.resolve<ExportQueueSubmitResult>({
          kind: "queued",
          runId: `run-${String(sent.length)}`,
        });
      });
      const target =
        scopeTarget === "compose"
          ? createComposeFlowTarget(stores.composeStore)
          : exportTarget(stores.exportStore);
      for (const scope of [listOf(["y"]), WHOLE_EXPORT_SCOPE, listOf(["x"])]) {
        expect(
          await openExportFlow(
            { ...base, readSourceRevision: matchingReader(), scope },
            stores,
          ),
        ).toBe(true);
        expect(stores.scopeStore.getState().setup[scopeTarget]).toBe(scope);
        expect(
          await confirmExportFlow(
            { ...base, ...target, submit },
            "default",
            "videoAndAudio",
            "encode",
          ),
        ).toBe(true);
        if (scopeTarget === "export") {
          stores.exportStore.getState().reset();
        }
      }
      expect(sent.map(piecesOf)).toStrictEqual([
        ["B:1000"],
        ["A:1000", "B:1000"],
        ["A:1000"],
      ]);
    },
  );
});

describe("a setup step that no step opened (ADR 067)", () => {
  function dialogStores() {
    const exportStore = createExportStore();
    const queueStore = createExportQueueStore({ exportStore });
    const composeStore = createExportComposeStore();
    const scopeStore = createExportScopeStore({ shownRunIds: () => [] });
    return { exportStore, queueStore, composeStore, scopeStore };
  }

  function baseOptions(stores: ReturnType<typeof dialogStores>) {
    return {
      setModalOpen: vi.fn(),
      filterName: "Video Files",
      audioFilterName: "Audio Files",
      openSaveDialog: vi.fn(() => Promise.resolve("/out/file.mp4")),
      getMedia: () => MEDIA,
      getSegments: () => [],
      getSourceId: () => "sequence:1",
      getSettings: () => SETTINGS,
      getAudioOverrides: () => ({}),
      saveSettings: () => Promise.resolve(),
      scopeStore: stores.scopeStore,
    };
  }

  it("gives the setup step that the indicator shows on an idle export store the whole export", async () => {
    loadSequence();
    const stores = dialogStores();
    const base = baseOptions(stores);
    const ordinary = exportTarget(stores.exportStore);
    // 1. A one-segment export A runs on the export store.
    const listA = listOf(["x"]);
    stores.scopeStore.getState().publishSetup("export", listA);
    expect(
      await confirmExportFlow(
        {
          ...base,
          ...ordinary,
          submit: () => Promise.resolve({ kind: "started", runId: "run-A" }),
        },
        "default",
        "videoAndAudio",
        "encode",
      ),
    ).toBe(true);
    expect(stores.scopeStore.getState().runScope("run-A")).toBe(listA);
    // 2. A finishes, and Done resets the export store. The submission of B is still pending.
    stores.exportStore.getState().reset();
    stores.queueStore.setState({ submitting: 1 });
    // 3. The Export button again: its open step on the compose target waits for its check.
    let answer: () => void = () => {};
    const waiting = openExportFlow(
      {
        ...base,
        readSourceRevision: (path) =>
          new Promise<MediaSourceRevisionDescriptor>((resolve) => {
            answer = () => {
              resolve({
                path,
                size: path === "/a.mp4" ? 10 : 20,
                mtime: path === "/a.mp4" ? 1 : 2,
              });
            };
          }),
      },
      stores,
    );
    try {
      // The indicator shows the dialog on the idle export store.
      showExportStoreTarget({ dialogOpen: false }, stores);
      expect(stores.scopeStore.getState().setup.export).toBe(WHOLE_EXPORT_SCOPE);
      const submit = vi.fn<
        (request: ExportRequest) => Promise<ExportQueueSubmitResult>
      >(() => Promise.resolve({ kind: "queued", runId: "run-C" }));
      expect(
        await confirmExportFlow(
          { ...base, ...ordinary, submit },
          "default",
          "videoAndAudio",
          "encode",
        ),
      ).toBe(true);
      expect(piecesOf(submit.mock.calls[0]?.[0])).toStrictEqual(["A:1000", "B:1000"]);
    } finally {
      // The guard must hold no file for a later test.
      answer();
      await waiting;
    }
  });

  it("gives the export store the whole export after the queue took a compose export while it is idle", async () => {
    loadSequence();
    const stores = dialogStores();
    const base = baseOptions(stores);
    stores.scopeStore.getState().publishSetup("export", listOf(["x"]));
    // A run waits, so the Export action sets up an export for the queue.
    stores.queueStore.setState({ waiting: ["run-W"] });
    const listB = listOf(["y"]);
    expect(
      await openExportFlow(
        { ...base, readSourceRevision: matchingReader(), scope: listB },
        stores,
      ),
    ).toBe(true);
    expect(stores.composeStore.getState().composing).toBe(true);
    const submit = vi.fn<(request: ExportRequest) => Promise<ExportQueueSubmitResult>>(
      () => Promise.resolve({ kind: "queued", runId: "run-B" }),
    );
    expect(
      await confirmExportFlow(
        { ...base, ...createComposeFlowTarget(stores.composeStore), submit },
        "default",
        "videoAndAudio",
        "encode",
      ),
    ).toBe(true);
    expect(piecesOf(submit.mock.calls[0]?.[0])).toStrictEqual(["B:1000"]);
    // The dialog leaves the compose state, and the export store is still idle.
    expect(stores.exportStore.getState().status).toBe("idle");
    showExportStoreTarget({ dialogOpen: true }, stores);
    expect(stores.composeStore.getState().composing).toBe(false);
    expect(stores.scopeStore.getState().setup).toStrictEqual({
      export: WHOLE_EXPORT_SCOPE,
      compose: listB,
    });
  });
});
