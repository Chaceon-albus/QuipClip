import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, isExportRunLive, type ExportStatus } from "@/features/export";
import { createI18nInstance } from "@/i18n";
import type { Pts, Segment } from "@/types/project";
import {
  countOpenSourceSegments,
  decideQuit,
  decideReplace,
  isSameFilePath,
  presentQuitPrompt,
  presentReplacePrompt,
  type QuitGuardInput,
  type TimelineWorkInput,
} from "./quitGuard";

const OPEN_SOURCE = "s-open";
const OTHER_SOURCE = "s-other";
const OPEN_PATH = "/Users/me/Movies/open.mp4";
const OTHER_PATH = "/Users/me/Movies/other.mp4";

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
    openMediaPath: OPEN_PATH,
    ...overrides,
  };
}

const NOTHING_LOST = {
  segments: 0,
  pendingIn: false,
  exportActive: false,
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
      openMediaPath: OPEN_PATH,
    });
    expect(decision).toEqual({
      ask: true,
      loss: {
        segments: 2,
        pendingIn: true,
        exportActive: true,
        unsavedPreset: "Archive",
      },
    });
  });
});

describe("decideReplace", () => {
  const WITH_SEGMENTS = createTimeline({
    segments: [createSegment("a", OPEN_SOURCE), createSegment("b", OPEN_SOURCE)],
  });

  it("asks when the open source has segments", () => {
    expect(decideReplace(createInput({ timeline: WITH_SEGMENTS }), OTHER_PATH)).toEqual(
      { ask: true, segments: 2, pendingIn: false },
    );
  });

  it("reports the pending In point that the replacement clears", () => {
    expect(
      decideReplace(
        createInput({ timeline: { ...WITH_SEGMENTS, pendingInPts: "500" as Pts } }),
        OTHER_PATH,
      ),
    ).toEqual({ ask: true, segments: 2, pendingIn: true });
  });

  it("opens at once when the open source has no segments", () => {
    expect(decideReplace(createInput(), OTHER_PATH)).toEqual({
      ask: false,
      segments: 0,
      pendingIn: false,
    });
    expect(
      decideReplace(
        createInput({
          timeline: createTimeline({ segments: [createSegment("a", OTHER_SOURCE)] }),
        }),
        OTHER_PATH,
      ).ask,
    ).toBe(false);
  });

  it("opens at once when no video is open", () => {
    expect(
      decideReplace(
        createInput({
          timeline: createTimeline({
            sourceId: null,
            segments: [createSegment("a", OPEN_SOURCE)],
          }),
          openMediaPath: null,
        }),
        OTHER_PATH,
      ).ask,
    ).toBe(false);
  });

  it("does not ask for a pending In point alone", () => {
    expect(
      decideReplace(
        createInput({ timeline: createTimeline({ pendingInPts: "500" as Pts }) }),
        OTHER_PATH,
      ),
    ).toEqual({ ask: false, segments: 0, pendingIn: true });
  });

  it("does not ask when the chosen file is the open file", () => {
    expect(decideReplace(createInput({ timeline: WITH_SEGMENTS }), OPEN_PATH).ask).toBe(
      false,
    );
    // The canonical Windows path of the import against the path of a file dialog.
    expect(
      decideReplace(
        createInput({
          timeline: WITH_SEGMENTS,
          openMediaPath: "\\\\?\\C:\\Videos\\Clip.MP4",
        }),
        "C:\\Videos\\clip.mp4",
      ).ask,
    ).toBe(false);
  });
});

describe("isSameFilePath", () => {
  it("compares POSIX paths exactly", () => {
    expect(isSameFilePath(OPEN_PATH, OPEN_PATH)).toBe(true);
    expect(isSameFilePath(OPEN_PATH, OTHER_PATH)).toBe(false);
    // macOS and Linux file systems can be case sensitive, so case counts.
    expect(isSameFilePath("/a/Clip.mp4", "/a/clip.mp4")).toBe(false);
  });

  it("removes the Windows verbatim prefix that canonicalize adds", () => {
    expect(isSameFilePath("\\\\?\\C:\\v\\a.mp4", "C:\\v\\a.mp4")).toBe(true);
    expect(
      isSameFilePath("\\\\?\\UNC\\server\\share\\a.mp4", "\\\\server\\share\\a.mp4"),
    ).toBe(true);
  });

  it("compares Windows paths without regard to case or separator", () => {
    expect(isSameFilePath("C:\\Videos\\A.mp4", "c:/videos/a.MP4")).toBe(true);
    expect(isSameFilePath("C:\\Videos\\a.mp4", "D:\\Videos\\a.mp4")).toBe(false);
  });

  it("does not treat a Windows path and a POSIX path as one file", () => {
    expect(isSameFilePath("C:\\a.mp4", "/a.mp4")).toBe(false);
  });
});

describe("presentQuitPrompt", () => {
  it("lists every line that applies, in a fixed order", () => {
    const view = presentQuitPrompt({
      segments: 3,
      pendingIn: true,
      exportActive: true,
      unsavedPreset: "Archive",
    });
    expect(view).toEqual({
      title: { key: "quitGuard.quit.title" },
      lines: [
        { key: "quitGuard.loss.segments", values: { count: 3 } },
        { key: "quitGuard.loss.pendingIn" },
        { key: "quitGuard.loss.export" },
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

  it("names no preset when the draft has no name yet", () => {
    expect(presentQuitPrompt({ ...NOTHING_LOST, unsavedPreset: "" }).lines).toEqual([
      { key: "quitGuard.loss.presetUnnamed" },
    ]);
    expect(presentQuitPrompt({ ...NOTHING_LOST, unsavedPreset: "  " }).lines).toEqual([
      { key: "quitGuard.loss.presetUnnamed" },
    ]);
  });
});

describe("presentReplacePrompt", () => {
  it("says that the segments stay with the open video, with a neutral confirm", () => {
    expect(presentReplacePrompt({ segments: 2, pendingIn: false })).toEqual({
      title: { key: "quitGuard.replace.title" },
      lines: [{ key: "quitGuard.replace.segments", values: { count: 2 } }],
      confirm: { key: "quitGuard.replace.confirm" },
      destructive: false,
    });
  });

  it("names the pending In point as a loss, with a destructive confirm", () => {
    expect(presentReplacePrompt({ segments: 1, pendingIn: true })).toEqual({
      title: { key: "quitGuard.replace.title" },
      lines: [
        { key: "quitGuard.replace.segments", values: { count: 1 } },
        { key: "quitGuard.loss.pendingIn" },
      ],
      confirm: { key: "quitGuard.replace.confirm" },
      destructive: true,
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
    expect(t("quitGuard.replace.title")).toBe("Replace the open video?");
    expect(t("quitGuard.replace.segments", { count: 1 })).toBe(
      "The marked segment stays with the open video. Open that video again to see it.",
    );
    expect(t("quitGuard.replace.segments", { count: 3 })).toBe(
      "The 3 marked segments stay with the open video. Open that video again to see them.",
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
    expect(t("quitGuard.replace.segments", { count: 1 })).toBe(
      "已标记的 1 个片段会保留在当前视频中，重新打开该视频即可看到。",
    );
    expect(t("quitGuard.quit.confirm")).toBe("退出");
  });
});
