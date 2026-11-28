import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, isExportRunLive, type ExportStatus } from "@/features/export";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { TimelineState } from "@/features/timeline/types";
import { createI18nInstance } from "@/i18n";
import type { Pts, TickCount } from "@/types/project";
import {
  countQueuedExports,
  decideClear,
  decideQuit,
  isLossListed,
  presentClearPrompt,
  presentOpenPrompt,
  presentQuitPrompt,
  type ProjectWorkInput,
  type QuitGuardInput,
  type QuitLoss,
  timelineWorkOf,
  type TimelineWorkInput,
} from "./quitGuard";

function createTimeline(overrides: Partial<TimelineWorkInput> = {}): TimelineWorkInput {
  return { segmentCount: 0, hasPendingIn: false, ...overrides };
}

/** A project with no changes to save: no file and no segment, or a saved file. */
const SAVED_PROJECT: ProjectWorkInput = {
  hasChangesToSave: false,
  isModifiedFile: false,
  fileName: null,
  identity: 0,
};

/** A project with no file whose sequence has segments (the test of ADR 027). */
const UNSAVED_SEGMENTS: ProjectWorkInput = {
  hasChangesToSave: true,
  isModifiedFile: false,
  fileName: null,
  identity: 0,
};

/** A project with a file that is modified (ADR 072). */
const MODIFIED_FILE: ProjectWorkInput = {
  hasChangesToSave: true,
  isModifiedFile: true,
  fileName: "interview.qcproj",
  identity: 0,
};

function createInput(overrides: Partial<QuitGuardInput> = {}): QuitGuardInput {
  return {
    timeline: createTimeline(),
    project: SAVED_PROJECT,
    exportStatus: "idle",
    exportTracking: false,
    unsavedPresetName: null,
    queuedExports: 0,
    ...overrides,
  };
}

const NOTHING_LOST: QuitLoss = {
  project: null,
  pendingIn: false,
  exportActive: false,
  queuedExports: 0,
  unsavedPreset: null,
};

describe("timelineWorkOf", () => {
  const SOURCE: SequenceSource = {
    id: "a",
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: "0" as Pts,
    videoEndPts: "10000" as Pts,
    videoDurationTicks: "10000" as TickCount,
    approximateDurationSeconds: 10,
  };

  /** The state of a timeline store with one clip and two live segments. */
  function storedTimeline(): TimelineState {
    const store = createTimelineStore({ generateId: () => "g" });
    store.getState().loadSequence(
      [{ id: "c1", sourceId: "a" }],
      [SOURCE],
      [
        {
          id: "s1",
          inClipId: "c1",
          inPts: "1000" as Pts,
          outClipId: "c1",
          outPts: "2000" as Pts,
        },
        {
          id: "s2",
          inClipId: "c1",
          inPts: "3000" as Pts,
          outClipId: "c1",
          outPts: "4000" as Pts,
        },
      ],
    );
    return store.getState();
  }

  it("counts the live segments and reads the stored pending In", () => {
    const state = storedTimeline();
    expect(timelineWorkOf(state)).toEqual({ segmentCount: 2, hasPendingIn: false });
    const pending: TimelineState = {
      ...state,
      sequenceSegments: [],
      pendingIn: { clipId: "c1", pts: "500" as Pts },
    };
    expect(timelineWorkOf(pending)).toEqual({ segmentCount: 0, hasPendingIn: true });
  });

  it("does not count a segment whose clip is not on the sequence", () => {
    const state = storedTimeline();
    const foreign: TimelineState = {
      ...state,
      sequenceSegments: [
        ...state.sequenceSegments,
        {
          id: "s3",
          inClipId: "gone",
          inPts: "1000" as Pts,
          outClipId: "gone",
          outPts: "2000" as Pts,
        },
      ],
    };
    expect(timelineWorkOf(foreign).segmentCount).toBe(2);
  });

  it("reads the stored marks, so a mark with no projection still asks", () => {
    // The sequence cannot project its marks, as with no virtual axis: no projected segment, no
    // projected pending In and no virtual source. The stored marks are still work.
    const state = storedTimeline();
    const unprojected: TimelineState = {
      ...state,
      pendingIn: { clipId: "c1", pts: "500" as Pts },
      virtual: null,
      sourceId: null,
      segments: [],
      pendingInPts: null,
    };
    const timeline = timelineWorkOf(unprojected);
    expect(timeline).toEqual({ segmentCount: 2, hasPendingIn: true });

    // A live segment with no projected entry asks before Clear Timeline.
    expect(decideClear(createInput({ timeline }))).toEqual({
      form: "plain",
      segments: 2,
      pendingIn: true,
    });
    // A stored pending In with no projected PTS asks before a quit.
    expect(
      decideQuit(createInput({ timeline: { segmentCount: 0, hasPendingIn: true } })),
    ).toEqual({ ask: true, loss: { ...NOTHING_LOST, pendingIn: true } });
  });
});

describe("decideQuit", () => {
  it("continues at once when nothing would be lost", () => {
    expect(decideQuit(createInput())).toEqual({ ask: false, loss: NOTHING_LOST });
  });

  it("asks when the project has changes to save, and names its file or no file (ADR 072)", () => {
    expect(decideQuit(createInput({ project: UNSAVED_SEGMENTS }))).toEqual({
      ask: true,
      loss: { ...NOTHING_LOST, project: { fileName: null, identity: 0 } },
    });
    expect(decideQuit(createInput({ project: MODIFIED_FILE }))).toEqual({
      ask: true,
      loss: { ...NOTHING_LOST, project: { fileName: "interview.qcproj", identity: 0 } },
    });
  });

  it("asks nothing about the segments of a saved project that is not modified (ADR 072)", () => {
    // The segments are in the file, so the quit loses none of them.
    const decision = decideQuit(
      createInput({
        timeline: createTimeline({ segmentCount: 1 }),
        project: {
          hasChangesToSave: false,
          isModifiedFile: false,
          fileName: "cut.qcproj",
          identity: 0,
        },
      }),
    );
    expect(decision).toEqual({ ask: false, loss: NOTHING_LOST });
  });

  it("asks when the timeline stores a pending In point", () => {
    const decision = decideQuit(
      createInput({ timeline: createTimeline({ hasPendingIn: true }) }),
    );
    expect(decision).toEqual({ ask: true, loss: { ...NOTHING_LOST, pendingIn: true } });
  });

  it("asks exactly while an export is preparing, running, or publishing, with no tracked run", () => {
    const active: readonly ExportStatus[] = ["preparing", "running", "publishing"];
    for (const exportStatus of EXPORT_STATUSES) {
      const decision = decideQuit(createInput({ exportStatus }));
      const isActive = active.includes(exportStatus);
      expect(decision.ask).toBe(isActive);
      expect(decision.loss.exportActive).toBe(isActive);
    }
  });

  it("asks for queued exports alone", () => {
    expect(decideQuit(createInput({ queuedExports: 1 }))).toEqual({
      ask: true,
      loss: { ...NOTHING_LOST, queuedExports: 1 },
    });
    expect(decideQuit(createInput({ queuedExports: 0 })).ask).toBe(false);
  });

  it("asks for a failure while the store still tracks the run", () => {
    // A Stop request failed, and the backend still encodes. A quit stops that run (ADR 017).
    expect(
      decideQuit(createInput({ exportStatus: "failed", exportTracking: true })),
    ).toEqual({ ask: true, loss: { ...NOTHING_LOST, exportActive: true } });
  });

  it("follows isExportRunLive for the export loss, in every status and tracking", () => {
    for (const exportStatus of EXPORT_STATUSES) {
      for (const exportTracking of [false, true]) {
        const decision = decideQuit(createInput({ exportStatus, exportTracking }));
        const live = isExportRunLive({
          status: exportStatus,
          tracking: exportTracking,
        });
        expect(decision.loss.exportActive).toBe(live);
        expect(decision.ask).toBe(live);
      }
    }
  });

  it("asks when a preset draft holds unsaved edits, also with an empty name", () => {
    expect(decideQuit(createInput({ unsavedPresetName: "Web 1080p" }))).toEqual({
      ask: true,
      loss: { ...NOTHING_LOST, unsavedPreset: "Web 1080p" },
    });
    expect(decideQuit(createInput({ unsavedPresetName: "" }))).toEqual({
      ask: true,
      loss: { ...NOTHING_LOST, unsavedPreset: "" },
    });
  });

  it("reports every loss together", () => {
    const decision = decideQuit({
      timeline: createTimeline({ segmentCount: 2, hasPendingIn: true }),
      project: MODIFIED_FILE,
      exportStatus: "running",
      exportTracking: true,
      unsavedPresetName: "Archive",
      queuedExports: 2,
    });
    expect(decision).toEqual({
      ask: true,
      loss: {
        project: { fileName: "interview.qcproj", identity: 0 },
        pendingIn: true,
        exportActive: true,
        queuedExports: 2,
        unsavedPreset: "Archive",
      },
    });
  });
});

describe("isLossListed", () => {
  const ALL: QuitLoss = {
    project: { fileName: "interview.qcproj", identity: 0 },
    pendingIn: true,
    exportActive: true,
    queuedExports: 2,
    unsavedPreset: "Archive",
  };

  it("covers each loss that the dialog listed, and nothing", () => {
    expect(isLossListed(NOTHING_LOST, NOTHING_LOST)).toBe(true);
    expect(isLossListed(ALL, ALL)).toBe(true);
    expect(isLossListed(NOTHING_LOST, ALL)).toBe(true);
  });

  it("covers the project when the dialog listed the project, whatever its file", () => {
    expect(
      isLossListed(
        { ...NOTHING_LOST, project: { fileName: null, identity: 0 } },
        NOTHING_LOST,
      ),
    ).toBe(false);
    expect(
      isLossListed(
        { ...NOTHING_LOST, project: { fileName: "other.qcproj", identity: 0 } },
        { ...NOTHING_LOST, project: { fileName: null, identity: 0 } },
      ),
    ).toBe(true);
  });

  it("covers the project only when the dialog listed the project with the same identity (ADR 073)", () => {
    const listed: QuitLoss = {
      ...NOTHING_LOST,
      project: { fileName: "cut.qcproj", identity: 4 },
    };
    expect(
      isLossListed(
        { ...NOTHING_LOST, project: { fileName: "cut.qcproj", identity: 4 } },
        listed,
      ),
    ).toBe(true);
    // The project closed and came back, as after the removal of the last clip and an Undo: the
    // dialog did not show the project that the session holds now.
    expect(
      isLossListed(
        { ...NOTHING_LOST, project: { fileName: null, identity: 5 } },
        listed,
      ),
    ).toBe(false);
    expect(
      isLossListed(
        { ...NOTHING_LOST, project: { fileName: "cut.qcproj", identity: 5 } },
        listed,
      ),
    ).toBe(false);
  });

  it("puts the identity of the project into the loss", () => {
    expect(
      decideQuit(createInput({ project: { ...MODIFIED_FILE, identity: 7 } })).loss
        .project,
    ).toEqual({ fileName: "interview.qcproj", identity: 7 });
  });

  it("covers the pending In point and the live export only when the dialog listed them", () => {
    expect(isLossListed({ ...NOTHING_LOST, pendingIn: true }, NOTHING_LOST)).toBe(
      false,
    );
    expect(isLossListed({ ...NOTHING_LOST, exportActive: true }, NOTHING_LOST)).toBe(
      false,
    );
  });

  it("covers the queued exports when their number is not larger", () => {
    const listed = { ...NOTHING_LOST, queuedExports: 2 };
    expect(isLossListed({ ...NOTHING_LOST, queuedExports: 1 }, listed)).toBe(true);
    expect(isLossListed({ ...NOTHING_LOST, queuedExports: 2 }, listed)).toBe(true);
    expect(isLossListed({ ...NOTHING_LOST, queuedExports: 3 }, listed)).toBe(false);
  });

  it("covers the preset draft when it has none or the listed name", () => {
    const listed = { ...NOTHING_LOST, unsavedPreset: "Archive" };
    expect(isLossListed({ ...NOTHING_LOST, unsavedPreset: "Archive" }, listed)).toBe(
      true,
    );
    expect(isLossListed({ ...NOTHING_LOST, unsavedPreset: "Web" }, listed)).toBe(false);
    expect(isLossListed({ ...NOTHING_LOST, unsavedPreset: "" }, NOTHING_LOST)).toBe(
      false,
    );
  });
});

describe("decideClear", () => {
  const WITH_SEGMENTS = createTimeline({ segmentCount: 2 });

  it("asks with the plain form when the sequence has segments, and names a pending In point", () => {
    expect(decideClear(createInput({ timeline: WITH_SEGMENTS }))).toEqual({
      form: "plain",
      segments: 2,
      pendingIn: false,
    });
    expect(
      decideClear(createInput({ timeline: { ...WITH_SEGMENTS, hasPendingIn: true } })),
    ).toEqual({ form: "plain", segments: 2, pendingIn: true });
    // A project with no file and segments has changes to save, and the plain form asks.
    expect(
      decideClear(createInput({ timeline: WITH_SEGMENTS, project: UNSAVED_SEGMENTS })),
    ).toEqual({ form: "plain", segments: 2, pendingIn: false });
  });

  it("asks with the save form when the project has a file and is modified (ADR 072)", () => {
    expect(
      decideClear(createInput({ timeline: WITH_SEGMENTS, project: MODIFIED_FILE })),
    ).toEqual({ form: "save", fileName: "interview.qcproj", pendingIn: false });
    // Also with no segment: the clear closes the project, and Undo does not give the file back.
    expect(
      decideClear(
        createInput({
          timeline: createTimeline({ hasPendingIn: true }),
          project: MODIFIED_FILE,
        }),
      ),
    ).toEqual({ form: "save", fileName: "interview.qcproj", pendingIn: true });
  });

  it("asks with the plain form for a saved project that is not modified", () => {
    expect(
      decideClear(
        createInput({
          timeline: WITH_SEGMENTS,
          project: {
            hasChangesToSave: false,
            isModifiedFile: false,
            fileName: "cut.qcproj",
            identity: 0,
          },
        }),
      ),
    ).toEqual({ form: "plain", segments: 2, pendingIn: false });
  });

  it("clears at once with no segment, also with a pending In point alone", () => {
    expect(decideClear(createInput())).toEqual({ form: "none" });
    expect(
      decideClear(createInput({ timeline: createTimeline({ hasPendingIn: true }) })),
    ).toEqual({ form: "none" });
  });
});

describe("countQueuedExports", () => {
  it("counts the waiting runs and the submissions for the queue that have no answer", () => {
    expect(countQueuedExports({ waiting: [], removing: [], enqueuing: 0 })).toBe(0);
    expect(
      countQueuedExports({ waiting: ["b", "c"], removing: [], enqueuing: 0 }),
    ).toBe(2);
    expect(countQueuedExports({ waiting: ["b"], removing: [], enqueuing: 2 })).toBe(3);
  });

  it("does not count a run that the user removes", () => {
    expect(
      countQueuedExports({ waiting: ["b", "c"], removing: ["c"], enqueuing: 0 }),
    ).toBe(1);
    expect(countQueuedExports({ waiting: ["b"], removing: ["b"], enqueuing: 0 })).toBe(
      0,
    );
  });
});

describe("presentQuitPrompt", () => {
  it("lists every line that applies, in a fixed order", () => {
    const view = presentQuitPrompt({
      project: null,
      pendingIn: true,
      exportActive: true,
      queuedExports: 2,
      unsavedPreset: "Archive",
    });
    expect(view).toEqual({
      title: { key: "quitGuard.quit.title" },
      lines: [
        { key: "quitGuard.loss.pendingIn" },
        { key: "quitGuard.loss.export" },
        { key: "quitGuard.loss.queued", values: { count: 2 } },
        { key: "quitGuard.loss.preset", values: { name: "Archive" } },
      ],
      confirm: { key: "quitGuard.quit.confirm" },
      destructive: true,
      discard: null,
    });
  });

  it("is the save prompt when the project has changes to save (ADR 072)", () => {
    expect(
      presentQuitPrompt({
        project: { fileName: "interview.qcproj", identity: 0 },
        pendingIn: true,
        exportActive: true,
        queuedExports: 2,
        unsavedPreset: "Archive",
      }),
    ).toEqual({
      title: { key: "quitGuard.quit.saveTitle" },
      lines: [
        { key: "quitGuard.project.file", values: { name: "interview.qcproj" } },
        { key: "quitGuard.loss.pendingIn" },
        { key: "quitGuard.loss.export" },
        { key: "quitGuard.loss.queued", values: { count: 2 } },
        { key: "quitGuard.loss.preset", values: { name: "Archive" } },
      ],
      confirm: { key: "quitGuard.save" },
      // Save keeps the work, so it is not a destructive button.
      destructive: false,
      discard: { key: "quitGuard.dontSave" },
    });
    expect(
      presentQuitPrompt({ ...NOTHING_LOST, project: { fileName: null, identity: 0 } })
        .lines,
    ).toEqual([{ key: "quitGuard.project.noFile" }]);
  });

  it("lists only the lines that apply", () => {
    expect(presentQuitPrompt({ ...NOTHING_LOST, exportActive: true }).lines).toEqual([
      { key: "quitGuard.loss.export" },
    ]);
  });

  it("lists the queued exports alone, after the line of the live export", () => {
    expect(presentQuitPrompt({ ...NOTHING_LOST, queuedExports: 1 }).lines).toEqual([
      { key: "quitGuard.loss.queued", values: { count: 1 } },
    ]);
    expect(
      presentQuitPrompt({ ...NOTHING_LOST, exportActive: true, queuedExports: 3 })
        .lines,
    ).toEqual([
      { key: "quitGuard.loss.export" },
      { key: "quitGuard.loss.queued", values: { count: 3 } },
    ]);
  });

  it("formats the line of the queued exports with its plural form", async () => {
    for (const [language, one, other] of [
      [
        "en",
        "1 export in the queue will not start.",
        "2 exports in the queue will not start.",
      ],
      ["zh-CN", "队列中的 1 个导出将不会开始。", "队列中的 2 个导出将不会开始。"],
    ] as const) {
      const instance = await createI18nInstance({
        initialPreference: language,
        storage: null,
        systemLanguages: [],
      });
      const format = (count: number) => {
        const [line] = presentQuitPrompt({
          ...NOTHING_LOST,
          queuedExports: count,
        }).lines;
        // The dialog formats a line through the same view of `t`.
        const translate = instance.t as (
          key: string,
          values?: Readonly<Record<string, string | number>>,
        ) => string;
        return line === undefined ? "" : translate(line.key, line.values);
      };
      expect(format(1)).toBe(one);
      expect(format(2)).toBe(other);
    }
  });

  it("names no preset when the draft has no name yet", () => {
    expect(presentQuitPrompt({ ...NOTHING_LOST, unsavedPreset: "" }).lines).toEqual([
      { key: "quitGuard.loss.presetUnnamed" },
    ]);
    expect(presentQuitPrompt({ ...NOTHING_LOST, unsavedPreset: "  " }).lines).toEqual([
      { key: "quitGuard.loss.presetUnnamed" },
    ]);
  });
});

describe("presentClearPrompt", () => {
  it("says that Undo brings the segments back, with a destructive confirm", () => {
    expect(
      presentClearPrompt({ form: "plain", segments: 2, pendingIn: false }),
    ).toEqual({
      title: { key: "quitGuard.clear.title" },
      lines: [{ key: "quitGuard.clear.segments", values: { count: 2 } }],
      confirm: { key: "quitGuard.clear.confirm" },
      destructive: true,
      discard: null,
    });
  });

  it("names the pending In point too", () => {
    expect(
      presentClearPrompt({ form: "plain", segments: 1, pendingIn: true }).lines,
    ).toEqual([
      { key: "quitGuard.clear.segments", values: { count: 1 } },
      { key: "quitGuard.clear.pendingIn" },
    ]);
  });

  it("is the save prompt for a project with a file that is modified (ADR 072)", () => {
    expect(
      presentClearPrompt({
        form: "save",
        fileName: "interview.qcproj",
        pendingIn: false,
      }),
    ).toEqual({
      title: { key: "quitGuard.clear.saveTitle" },
      lines: [
        { key: "quitGuard.project.file", values: { name: "interview.qcproj" } },
        { key: "quitGuard.clear.projectCloses" },
        { key: "quitGuard.clear.undoKeepsNoFile" },
      ],
      confirm: { key: "quitGuard.save" },
      destructive: false,
      discard: { key: "quitGuard.dontSave" },
    });
    expect(
      presentClearPrompt({
        form: "save",
        fileName: "interview.qcproj",
        pendingIn: true,
      }).lines,
    ).toEqual([
      { key: "quitGuard.project.file", values: { name: "interview.qcproj" } },
      { key: "quitGuard.clear.projectCloses" },
      { key: "quitGuard.clear.undoKeepsNoFile" },
      { key: "quitGuard.clear.pendingIn" },
    ]);
  });
});

describe("presentOpenPrompt (ADR 072)", () => {
  it("is the save prompt with its own title and the line that names the file", () => {
    expect(presentOpenPrompt({ fileName: "interview.qcproj" })).toEqual({
      title: { key: "quitGuard.open.saveTitle" },
      lines: [{ key: "quitGuard.project.file", values: { name: "interview.qcproj" } }],
      confirm: { key: "quitGuard.save" },
      destructive: false,
      discard: { key: "quitGuard.dontSave" },
    });
  });

  it("says that a project with no file has no file", () => {
    expect(presentOpenPrompt({ fileName: null }).lines).toEqual([
      { key: "quitGuard.project.noFile" },
    ]);
  });

  it("has the title of a restore before a restore, and the same lines and buttons (ADR 073)", () => {
    const open = presentOpenPrompt({ fileName: "interview.qcproj" });
    expect(presentOpenPrompt({ fileName: "interview.qcproj" }, true)).toEqual({
      ...open,
      title: { key: "quitGuard.open.restoreSaveTitle" },
    });
  });
});

describe("quit guard catalog messages", () => {
  it("renders the English prompt with the CLDR plural forms", async () => {
    const i18n = await createI18nInstance({ initialPreference: "en", storage: null });
    const t = i18n.t as unknown as (
      key: string,
      options?: Readonly<Record<string, string | number>>,
    ) => string;

    expect(t("quitGuard.quit.title")).toBe("Quit QuipClip?");
    expect(t("quitGuard.loss.pendingIn")).toBe("The pending In point will be lost.");
    expect(t("quitGuard.loss.export")).toBe("The export will stop.");
    expect(t("quitGuard.loss.preset", { name: "Archive" })).toBe(
      "The unsaved changes to “Archive” will be lost.",
    );
    expect(t("quitGuard.loss.presetUnnamed")).toBe(
      "The unsaved changes to the preset will be lost.",
    );
    expect(t("quitGuard.clear.title")).toBe("Clear the timeline?");
    expect(t("quitGuard.clear.segments", { count: 1 })).toBe(
      "The marked segment leaves the timeline. Undo brings it back.",
    );
    expect(t("quitGuard.clear.segments", { count: 3 })).toBe(
      "The 3 marked segments leave the timeline. Undo brings them back.",
    );
    // The save prompt (ADR 072).
    expect(t("quitGuard.quit.saveTitle")).toBe("Save the project before you quit?");
    expect(t("quitGuard.open.saveTitle")).toBe(
      "Save the project before you open another one?",
    );
    expect(t("quitGuard.clear.saveTitle")).toBe(
      "Save the project before you clear the timeline?",
    );
    expect(t("quitGuard.project.file", { name: "interview.qcproj" })).toBe(
      "“interview.qcproj” has changes that are not saved.",
    );
    expect(t("quitGuard.project.noFile")).toBe(
      "The project has no file, so its segments are not saved.",
    );
    expect(t("quitGuard.clear.projectCloses")).toBe(
      "Clear Timeline closes the project.",
    );
    expect(t("quitGuard.clear.undoKeepsNoFile")).toBe(
      "Undo brings the videos and the segments back, but not the project file.",
    );
    expect(t("quitGuard.save")).toBe("Save");
    expect(t("quitGuard.dontSave")).toBe("Don’t Save");
  });

  it("renders the Simplified Chinese prompt with its one plural form", async () => {
    const i18n = await createI18nInstance({
      initialPreference: "zh-CN",
      storage: null,
    });
    const t = i18n.t as unknown as (
      key: string,
      options?: Readonly<Record<string, string | number>>,
    ) => string;

    expect(t("quitGuard.quit.title")).toBe("退出 QuipClip？");
    expect(t("quitGuard.loss.preset", { name: "Archive" })).toBe(
      "对“Archive”的未保存更改将丢失。",
    );
    expect(t("quitGuard.loss.presetUnnamed")).toBe("预设的未保存更改将丢失。");
    expect(t("quitGuard.clear.segments", { count: 1 })).toBe(
      "已标记的 1 个片段将从时间轴上移除。撤销可以恢复。",
    );
    expect(t("quitGuard.quit.confirm")).toBe("退出");
    // The save prompt (ADR 072). "Project" is 项目.
    expect(t("quitGuard.quit.saveTitle")).toBe("是否在退出前保存项目？");
    expect(t("quitGuard.clear.saveTitle")).toBe("是否在清空时间轴前保存项目？");
    expect(t("quitGuard.open.saveTitle")).toBe("是否在打开其他项目前保存当前项目？");
    expect(t("quitGuard.project.file", { name: "interview.qcproj" })).toBe(
      "“interview.qcproj”有未保存的更改。",
    );
    expect(t("quitGuard.project.noFile")).toBe("项目没有文件，因此其片段尚未保存。");
    expect(t("quitGuard.clear.projectCloses")).toBe("清空时间轴会关闭项目。");
    expect(t("quitGuard.clear.undoKeepsNoFile")).toBe(
      "撤销可以恢复视频和片段，但不能恢复项目文件。",
    );
    expect(t("quitGuard.save")).toBe("保存");
    expect(t("quitGuard.dontSave")).toBe("不保存");
  });

  it("has no line of the segments of a quit after ADR 072", async () => {
    // The project line replaces it. Neither catalog keeps the messages.
    for (const language of ["en", "zh-CN"] as const) {
      const i18n = await createI18nInstance({
        initialPreference: language,
        storage: null,
      });
      expect(i18n.exists("quitGuard.loss.segments", { count: 1 })).toBe(false);
      expect(i18n.exists("quitGuard.loss.segments", { count: 2 })).toBe(false);
    }
  });
});
