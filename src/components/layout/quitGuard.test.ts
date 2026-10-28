import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, isExportRunLive, type ExportStatus } from "@/features/export";
import { createI18nInstance } from "@/i18n";
import type { Pts, Segment } from "@/types/project";
import {
  countOpenSourceSegments,
  countQueuedExports,
  decideClear,
  decideQuit,
  presentClearPrompt,
  presentQuitPrompt,
  type QuitGuardInput,
  type TimelineWorkInput,
} from "./quitGuard";

const OPEN_SOURCE = "s-open";
const OTHER_SOURCE = "s-other";

function createSegment(id: string, sourceId: string): Segment {
  return { id, sourceId, inPts: "0" as Pts, outPts: "1000" as Pts };
}

function createTimeline(overrides: Partial<TimelineWorkInput> = {}): TimelineWorkInput {
  return { sourceId: OPEN_SOURCE, segments: [], pendingInPts: null, ...overrides };
}

function createInput(overrides: Partial<QuitGuardInput> = {}): QuitGuardInput {
  return {
    timeline: createTimeline(),
    exportStatus: "idle",
    exportTracking: false,
    unsavedPresetName: null,
    queuedExports: 0,
    ...overrides,
  };
}

const NOTHING_LOST = {
  segments: 0,
  pendingIn: false,
  exportActive: false,
  queuedExports: 0,
  unsavedPreset: null,
};

describe("countOpenSourceSegments", () => {
  it("counts only the segments of the open source", () => {
    const timeline = createTimeline({
      segments: [
        createSegment("a", OPEN_SOURCE),
        createSegment("b", OTHER_SOURCE),
        createSegment("c", OPEN_SOURCE),
      ],
    });
    expect(countOpenSourceSegments(timeline)).toBe(2);
  });

  it("counts nothing when no source is open", () => {
    const timeline = createTimeline({
      sourceId: null,
      segments: [createSegment("a", OPEN_SOURCE)],
    });
    expect(countOpenSourceSegments(timeline)).toBe(0);
  });
});

describe("decideQuit", () => {
  it("continues at once when nothing would be lost", () => {
    expect(decideQuit(createInput())).toEqual({ ask: false, loss: NOTHING_LOST });
  });

  it("continues at once with no source open, even with segments of another source", () => {
    const decision = decideQuit(
      createInput({
        timeline: createTimeline({
          sourceId: null,
          segments: [createSegment("a", OTHER_SOURCE)],
          // The timeline clears it without a source. A stale value must not count.
          pendingInPts: "500" as Pts,
        }),
      }),
    );
    expect(decision).toEqual({ ask: false, loss: NOTHING_LOST });
  });

  it("asks when the open source has segments", () => {
    const decision = decideQuit(
      createInput({
        timeline: createTimeline({
          segments: [createSegment("a", OPEN_SOURCE), createSegment("b", OTHER_SOURCE)],
        }),
      }),
    );
    expect(decision).toEqual({ ask: true, loss: { ...NOTHING_LOST, segments: 1 } });
  });

  it("asks when the open source has a pending In point", () => {
    const decision = decideQuit(
      createInput({ timeline: createTimeline({ pendingInPts: "500" as Pts }) }),
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
      timeline: createTimeline({
        segments: [createSegment("a", OPEN_SOURCE), createSegment("b", OPEN_SOURCE)],
        pendingInPts: "2000" as Pts,
      }),
      exportStatus: "running",
      exportTracking: true,
      unsavedPresetName: "Archive",
      queuedExports: 2,
    });
    expect(decision).toEqual({
      ask: true,
      loss: {
        segments: 2,
        pendingIn: true,
        exportActive: true,
        queuedExports: 2,
        unsavedPreset: "Archive",
      },
    });
  });
});

describe("decideClear", () => {
  const WITH_SEGMENTS = createTimeline({
    segments: [createSegment("a", OPEN_SOURCE), createSegment("b", OPEN_SOURCE)],
  });

  it("asks when the sequence has segments, and names a pending In point", () => {
    expect(decideClear(createInput({ timeline: WITH_SEGMENTS }))).toEqual({
      ask: true,
      segments: 2,
      pendingIn: false,
    });
    expect(
      decideClear(
        createInput({ timeline: { ...WITH_SEGMENTS, pendingInPts: "500" as Pts } }),
      ),
    ).toEqual({ ask: true, segments: 2, pendingIn: true });
  });

  it("clears at once with no segment, also with a pending In point alone", () => {
    expect(decideClear(createInput())).toEqual({
      ask: false,
      segments: 0,
      pendingIn: false,
    });
    expect(
      decideClear(
        createInput({ timeline: createTimeline({ pendingInPts: "500" as Pts }) }),
      ),
    ).toEqual({ ask: false, segments: 0, pendingIn: true });
    expect(
      decideClear(
        createInput({
          timeline: createTimeline({ segments: [createSegment("a", OTHER_SOURCE)] }),
        }),
      ).ask,
    ).toBe(false);
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
      segments: 3,
      pendingIn: true,
      exportActive: true,
      queuedExports: 2,
      unsavedPreset: "Archive",
    });
    expect(view).toEqual({
      title: { key: "quitGuard.quit.title" },
      lines: [
        { key: "quitGuard.loss.segments", values: { count: 3 } },
        { key: "quitGuard.loss.pendingIn" },
        { key: "quitGuard.loss.export" },
        { key: "quitGuard.loss.queued", values: { count: 2 } },
        { key: "quitGuard.loss.preset", values: { name: "Archive" } },
      ],
      confirm: { key: "quitGuard.quit.confirm" },
      destructive: true,
    });
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
    expect(presentClearPrompt({ segments: 2, pendingIn: false })).toEqual({
      title: { key: "quitGuard.clear.title" },
      lines: [{ key: "quitGuard.clear.segments", values: { count: 2 } }],
      confirm: { key: "quitGuard.clear.confirm" },
      destructive: true,
    });
  });

  it("names the pending In point too", () => {
    expect(presentClearPrompt({ segments: 1, pendingIn: true }).lines).toEqual([
      { key: "quitGuard.clear.segments", values: { count: 1 } },
      { key: "quitGuard.clear.pendingIn" },
    ]);
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
    expect(t("quitGuard.loss.segments", { count: 1 })).toBe(
      "1 marked segment will be lost.",
    );
    expect(t("quitGuard.loss.segments", { count: 4 })).toBe(
      "4 marked segments will be lost.",
    );
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
    expect(t("quitGuard.loss.segments", { count: 1 })).toBe(
      "已标记的 1 个片段将丢失。",
    );
    expect(t("quitGuard.loss.segments", { count: 4 })).toBe(
      "已标记的 4 个片段将丢失。",
    );
    expect(t("quitGuard.loss.preset", { name: "Archive" })).toBe(
      "对“Archive”的未保存更改将丢失。",
    );
    expect(t("quitGuard.loss.presetUnnamed")).toBe("预设的未保存更改将丢失。");
    expect(t("quitGuard.clear.segments", { count: 1 })).toBe(
      "已标记的 1 个片段将从时间轴上移除。撤销可以恢复。",
    );
    expect(t("quitGuard.quit.confirm")).toBe("退出");
  });
});
