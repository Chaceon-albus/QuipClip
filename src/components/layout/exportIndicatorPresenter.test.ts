import { describe, expect, it } from "vitest";
import { presentExportProgress } from "@/components/export/exportProgressPresenter";
import type { ExportStatus } from "@/features/export";
import { createI18nInstance, en, zhCN } from "@/i18n";
import type {
  ExportIndicatorInput,
  ExportIndicatorLine,
  IndicatorTranslate,
} from "./exportIndicatorPresenter";
import {
  announcementKeyOf,
  decideFocusRestore,
  focusInsideAfterBlur,
  formatIndicatorLine,
  INDICATOR_SLOT_MARKERS,
  outputNameOf,
  presentExportIndicator,
  presentIndicatorLine,
  resultLabelKey,
  splitAtSlots,
} from "./exportIndicatorPresenter";

function createInput(
  overrides: Partial<ExportIndicatorInput> = {},
): ExportIndicatorInput {
  return {
    status: "running",
    frame: 50,
    expectedFrames: 100,
    fps: { n: 25, d: 1 },
    speed: { n: 1, d: 1 },
    cancelRequested: false,
    panelOpen: false,
    outputPath: "/path/to/exported_video.mp4",
    tracking: false,
    ...overrides,
  };
}

describe("outputNameOf", () => {
  it("returns null for null", () => {
    expect(outputNameOf(null)).toBeNull();
  });

  it("returns null for empty string or only separators", () => {
    expect(outputNameOf("")).toBeNull();
    expect(outputNameOf("/")).toBeNull();
    expect(outputNameOf("\\")).toBeNull();
    expect(outputNameOf("///")).toBeNull();
    expect(outputNameOf("\\\\\\")).toBeNull();
  });

  it("keeps a backslash in the name of a POSIX path, as the finished panel does", () => {
    expect(outputNameOf("/Users/me/Movies/a\\b.mp4")).toBe("a\\b.mp4");
    expect(outputNameOf("/\\//")).toBe("\\");
  });

  it("extracts the last segment of a POSIX path", () => {
    expect(outputNameOf("/home/user/videos/clip.mp4")).toBe("clip.mp4");
    expect(outputNameOf("relative/path/clip.mov")).toBe("clip.mov");
  });

  it("extracts the last segment of a Windows path", () => {
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv")).toBe("output.mkv");
    expect(outputNameOf("D:\\exports\\final.mp4")).toBe("final.mp4");
  });

  it("handles a trailing separator correctly", () => {
    expect(outputNameOf("/home/user/videos/clip.mp4/")).toBe("clip.mp4");
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv\\")).toBe("output.mkv");
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv\\\\")).toBe("output.mkv");
  });

  it("handles a single segment without separators", () => {
    expect(outputNameOf("output.mp4")).toBe("output.mp4");
  });
});

describe("presentExportIndicator", () => {
  describe("panel open hides every status", () => {
    const statuses: ExportStatus[] = [
      "idle",
      "preparing",
      "running",
      "publishing",
      "finished",
      "failed",
      "canceled",
    ];

    for (const status of statuses) {
      it(`returns null when panelOpen is true for ${status}`, () => {
        expect(
          presentExportIndicator(
            createInput({
              status,
              panelOpen: true,
            }),
          ),
        ).toBeNull();
      });
    }
  });

  describe("idle hides", () => {
    it("returns null when status is idle even if panelOpen is false", () => {
      expect(
        presentExportIndicator(
          createInput({
            status: "idle",
            panelOpen: false,
          }),
        ),
      ).toBeNull();
    });
  });

  describe("each active status", () => {
    it("returns active view for preparing status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "preparing",
          outputPath: "/exports/my_video.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("my_video.mp4");
        expect(view.progress.phase).toBe("preparing");
        expect(view.progress.basePhase).toBe("preparing");
        expect(view.progress.barValue).toBeNull();
      }
    });

    it("returns active view for running status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "running",
          frame: 50,
          expectedFrames: 100,
          outputPath: "C:\\videos\\render.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("render.mp4");
        expect(view.progress.phase).toBe("running");
        expect(view.progress.basePhase).toBe("running");
        expect(view.progress.barValue).toBe(50);
        expect(view.progress.percentFraction).toBe(0.5);
      }
    });

    it("returns active view for publishing status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "publishing",
          frame: 100,
          expectedFrames: 100,
          outputPath: "/output.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("output.mp4");
        expect(view.progress.phase).toBe("publishing");
        expect(view.progress.basePhase).toBe("publishing");
        expect(view.progress.barValue).toBe(100);
        expect(view.progress.percentFraction).toBe(1);
      }
    });

    it("returns active view with canceling phase when cancelRequested is true in running", () => {
      const view = presentExportIndicator(
        createInput({
          status: "running",
          cancelRequested: true,
          frame: 50,
          expectedFrames: 100,
          outputPath: "C:\\videos\\render.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("render.mp4");
        expect(view.progress.phase).toBe("canceling");
        expect(view.progress.basePhase).toBe("running");
      }
    });
  });

  describe("each final status", () => {
    it("returns finished view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "finished",
          outputPath: "/videos/complete.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "finished",
        outputName: "complete.mp4",
        canDismiss: true,
      });
    });

    it("returns failed view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "failed",
          outputPath: "C:\\videos\\error.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "failed",
        outputName: "error.mp4",
        canDismiss: true,
      });
    });

    it("returns canceled view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "canceled",
          outputPath: "/videos/aborted.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "canceled",
        outputName: "aborted.mp4",
        canDismiss: true,
      });
    });

    it("returns null outputName when outputPath is null", () => {
      const view = presentExportIndicator(
        createInput({
          status: "finished",
          outputPath: null,
        }),
      );

      expect(view).toEqual({
        kind: "finished",
        outputName: null,
        canDismiss: true,
      });
    });
  });
});

function lineOf(overrides: Partial<ExportIndicatorInput> = {}): ExportIndicatorLine {
  const progress = presentExportProgress(createInput(overrides));
  if (progress === null) {
    throw new Error("expected an active status");
  }
  return presentIndicatorLine(progress);
}

describe("presentIndicatorLine", () => {
  it("names the preparing, publishing, and canceling phases with no values", () => {
    expect(lineOf({ status: "preparing" })).toEqual({
      key: "statusBar.export.preparing",
    });
    expect(lineOf({ status: "publishing" })).toEqual({
      key: "statusBar.export.publishing",
    });
    expect(lineOf({ status: "running", cancelRequested: true })).toEqual({
      key: "statusBar.export.canceling",
    });
  });

  it("shows no percent while the frame goal is unknown", () => {
    expect(lineOf({ expectedFrames: null })).toEqual({
      key: "statusBar.export.runningUnknown",
    });
    expect(lineOf({ expectedFrames: 0 })).toEqual({
      key: "statusBar.export.runningUnknown",
    });
  });

  it("shows the percent alone while no time estimate is possible", () => {
    expect(lineOf({ frame: 42, expectedFrames: 100, fps: null })).toEqual({
      key: "statusBar.export.running",
      percentFraction: 0.42,
    });
    expect(lineOf({ frame: 42, expectedFrames: 100, fps: { n: 0, d: 1 } })).toEqual({
      key: "statusBar.export.running",
      percentFraction: 0.42,
    });
  });

  it("shows the percent and the time estimate in one line", () => {
    expect(lineOf({ frame: 50, expectedFrames: 100, fps: { n: 25, d: 1 } })).toEqual({
      key: "statusBar.export.runningWithRemaining",
      percentFraction: 0.5,
      remainingSeconds: 2,
    });
  });

  it("is part of the active view", () => {
    const view = presentExportIndicator(createInput());
    expect(view?.kind).toBe("active");
    if (view?.kind === "active") {
      expect(view.line).toEqual(presentIndicatorLine(view.progress));
    }
  });
});

describe("resultLabelKey", () => {
  it("gives the catalog key of each result", () => {
    expect(resultLabelKey("finished")).toBe("statusBar.export.finished");
    expect(resultLabelKey("failed")).toBe("statusBar.export.failed");
    expect(resultLabelKey("canceled")).toBe("statusBar.export.canceled");
  });
});

describe("announcementKeyOf", () => {
  it("announces nothing while nothing is shown", () => {
    expect(announcementKeyOf(null)).toBeNull();
    expect(
      announcementKeyOf(presentExportIndicator(createInput({ status: "idle" }))),
    ).toBeNull();
  });

  it("announces no progress of an active run", () => {
    const inputs: Partial<ExportIndicatorInput>[] = [
      { status: "preparing" },
      { status: "running", frame: 1 },
      { status: "running", frame: 99 },
      { status: "running", cancelRequested: true },
      { status: "publishing" },
    ];
    for (const overrides of inputs) {
      expect(
        announcementKeyOf(presentExportIndicator(createInput(overrides))),
      ).toBeNull();
    }
  });

  it("announces the result of a run that ended while the dialog was hidden", () => {
    for (const status of ["finished", "failed", "canceled"] as const) {
      expect(announcementKeyOf(presentExportIndicator(createInput({ status })))).toBe(
        resultLabelKey(status),
      );
    }
  });

  it("announces nothing while the dialog is open, because the dialog shows the result", () => {
    for (const status of ["finished", "failed", "canceled"] as const) {
      expect(
        announcementKeyOf(
          presentExportIndicator(createInput({ status, panelOpen: true })),
        ),
      ).toBeNull();
    }
  });
});

describe("splitAtSlots", () => {
  const P = INDICATOR_SLOT_MARKERS.percent;
  const T = INDICATOR_SLOT_MARKERS.time;

  it("keeps a message with no slot as one text part", () => {
    expect(splitAtSlots("Exporting")).toEqual([{ kind: "text", text: "Exporting" }]);
  });

  it("gives no part for an empty message", () => {
    expect(splitAtSlots("")).toEqual([]);
  });

  it("splits at each slot in the order of the message", () => {
    expect(splitAtSlots(`Exporting ${P} · ${T} left`)).toEqual([
      { kind: "text", text: "Exporting " },
      { kind: "slot", slot: "percent" },
      { kind: "text", text: " · " },
      { kind: "slot", slot: "time" },
      { kind: "text", text: " left" },
    ]);
  });

  it("keeps the order that a translation chooses", () => {
    expect(splitAtSlots(`${T} left, ${P}`)).toEqual([
      { kind: "slot", slot: "time" },
      { kind: "text", text: " left, " },
      { kind: "slot", slot: "percent" },
    ]);
  });

  it("gives no empty text part between two adjacent slots", () => {
    expect(splitAtSlots(`${P}${T}`)).toEqual([
      { kind: "slot", slot: "percent" },
      { kind: "slot", slot: "time" },
    ]);
  });

  it("keeps a private use character that is not a marker as text", () => {
    expect(splitAtSlots("ab")).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("keeps a character outside the basic plane whole", () => {
    expect(splitAtSlots(`\u{1F600}${P}`)).toEqual([
      { kind: "text", text: "\u{1F600}" },
      { kind: "slot", slot: "percent" },
    ]);
  });
});

describe("formatIndicatorLine", () => {
  const formatPercent = (fraction: number) => `${Math.round(fraction * 100)}%`;

  async function translatorFor(language: "en" | "zh-CN"): Promise<IndicatorTranslate> {
    const instance = await createI18nInstance({
      initialPreference: language,
      storage: null,
      systemLanguages: [],
    });
    // The component passes its `t` through the same view.
    return instance.t as unknown as IndicatorTranslate;
  }

  it("formats the percent and the time from one key in English", async () => {
    const translate = await translatorFor("en");
    const line = formatIndicatorLine(
      {
        key: "statusBar.export.runningWithRemaining",
        percentFraction: 0.42,
        remainingSeconds: 83,
      },
      translate,
      formatPercent,
    );
    expect(line.label).toBe("Exporting 42% · 1:23 left");
    expect(line.parts).toEqual([
      { kind: "text", text: "Exporting " },
      { kind: "slot", slot: "percent" },
      { kind: "text", text: " · " },
      { kind: "slot", slot: "time" },
      { kind: "text", text: " left" },
    ]);
    expect(line.slotText).toEqual({ percent: "42%", time: "1:23" });
  });

  it("formats the percent and the time from one key in Simplified Chinese", async () => {
    const translate = await translatorFor("zh-CN");
    const line = formatIndicatorLine(
      {
        key: "statusBar.export.runningWithRemaining",
        percentFraction: 0.07,
        remainingSeconds: 3725,
      },
      translate,
      formatPercent,
    );
    expect(line.label).toBe("正在导出 7% · 剩余 1:02:05");
    expect(line.parts).toEqual([
      { kind: "text", text: "正在导出 " },
      { kind: "slot", slot: "percent" },
      { kind: "text", text: " · 剩余 " },
      { kind: "slot", slot: "time" },
    ]);
    expect(line.slotText).toEqual({ percent: "7%", time: "1:02:05" });
  });

  it("gives the label when the parts and the slot values are put together", async () => {
    for (const language of ["en", "zh-CN"] as const) {
      const translate = await translatorFor(language);
      const lines: ExportIndicatorLine[] = [
        {
          key: "statusBar.export.runningWithRemaining",
          percentFraction: 0.99,
          remainingSeconds: 3599,
        },
        { key: "statusBar.export.running", percentFraction: 0.05 },
        { key: "statusBar.export.runningUnknown" },
        { key: "statusBar.export.preparing" },
      ];
      for (const entry of lines) {
        const line = formatIndicatorLine(entry, translate, formatPercent);
        const joined = line.parts
          .map((part) => (part.kind === "text" ? part.text : line.slotText[part.slot]))
          .join("");
        expect(joined).toBe(line.label);
      }
    }
  });

  it("formats the percent alone into its slot", async () => {
    const translate = await translatorFor("en");
    const line = formatIndicatorLine(
      { key: "statusBar.export.running", percentFraction: 0.05 },
      translate,
      formatPercent,
    );
    expect(line.label).toBe("Exporting 5%");
    expect(line.parts).toEqual([
      { kind: "text", text: "Exporting " },
      { kind: "slot", slot: "percent" },
    ]);
    expect(line.slotText).toEqual({ percent: "5%", time: "" });
  });

  it("gives a line with no values as one text part", async () => {
    const translate = await translatorFor("en");
    for (const [key, text] of [
      ["statusBar.export.preparing", "Preparing export"],
      ["statusBar.export.runningUnknown", "Exporting"],
      ["statusBar.export.publishing", "Finishing"],
      ["statusBar.export.canceling", "Stopping"],
    ] as const) {
      const line = formatIndicatorLine({ key }, translate, formatPercent);
      expect(line.label).toBe(text);
      expect(line.parts).toEqual([{ kind: "text", text }]);
      expect(line.slotText).toEqual({ percent: "", time: "" });
    }
  });

  it("formats the label from the one key with both values, not from two messages", () => {
    const calls: [string, Readonly<Record<string, string>> | undefined][] = [];
    const translate: IndicatorTranslate = (key, values) => {
      calls.push([key, values]);
      return `${key}:${values?.percent ?? ""}:${values?.time ?? ""}`;
    };
    const line = formatIndicatorLine(
      {
        key: "statusBar.export.runningWithRemaining",
        percentFraction: 0.5,
        remainingSeconds: 60,
      },
      translate,
      formatPercent,
    );
    expect(line.label).toBe("statusBar.export.runningWithRemaining:50%:1:00");
    expect(calls.map(([key]) => key)).toEqual([
      "statusBar.export.runningWithRemaining",
      "statusBar.export.runningWithRemaining",
    ]);
  });

  /**
   * A translator that formats one fixed message the way i18next does: each `{{name}}` takes
   * the value of `name`, as often as the message names it.
   */
  function stubTranslator(message: string): IndicatorTranslate {
    return (_key, values) =>
      message.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? "");
  }

  function joinedParts(line: ReturnType<typeof formatIndicatorLine>): string {
    return line.parts
      .map((part) => (part.kind === "text" ? part.text : line.slotText[part.slot]))
      .join("");
  }

  const withRemaining: ExportIndicatorLine = {
    key: "statusBar.export.runningWithRemaining",
    percentFraction: 0.42,
    remainingSeconds: 83,
  };

  it("follows a translation that drops a placeholder", () => {
    const line = formatIndicatorLine(
      withRemaining,
      stubTranslator("Exporting {{percent}}"),
      formatPercent,
    );
    expect(line.label).toBe("Exporting 42%");
    expect(line.parts).toEqual([
      { kind: "text", text: "Exporting " },
      { kind: "slot", slot: "percent" },
    ]);
    expect(joinedParts(line)).toBe(line.label);
  });

  it("follows a translation that names a placeholder twice", () => {
    const line = formatIndicatorLine(
      withRemaining,
      stubTranslator("{{percent}} done ({{percent}}), {{time}} left"),
      formatPercent,
    );
    expect(line.label).toBe("42% done (42%), 1:23 left");
    expect(line.parts).toEqual([
      { kind: "slot", slot: "percent" },
      { kind: "text", text: " done (" },
      { kind: "slot", slot: "percent" },
      { kind: "text", text: "), " },
      { kind: "slot", slot: "time" },
      { kind: "text", text: " left" },
    ]);
    expect(joinedParts(line)).toBe(line.label);
  });

  it("finds both placeholders of the line with the estimate in both catalogs", () => {
    for (const catalog of [en, zhCN]) {
      const message = catalog.statusBar.export.runningWithRemaining;
      expect(message).toContain("{{percent}}");
      expect(message).toContain("{{time}}");
    }
  });
});

describe("result dismissal", () => {
  it("offers no dismissal for a failed run that the store still tracks", () => {
    // A Stop that fails at the IPC layer reports `failed`, and the backend keeps the run.
    expect(
      presentExportIndicator(createInput({ status: "failed", tracking: true })),
    ).toEqual({
      kind: "failed",
      outputName: "exported_video.mp4",
      canDismiss: false,
    });
  });

  it("offers the dismissal once the failed run is no longer tracked", () => {
    expect(
      presentExportIndicator(createInput({ status: "failed", tracking: false })),
    ).toMatchObject({ kind: "failed", canDismiss: true });
  });

  it("offers the dismissal for a finished or canceled result in every tracking state", () => {
    for (const status of ["finished", "canceled"] as const) {
      for (const tracking of [false, true]) {
        expect(presentExportIndicator(createInput({ status, tracking }))).toMatchObject(
          {
            kind: status,
            canDismiss: true,
          },
        );
      }
    }
  });

  it("keeps an active run free of the dismissal field", () => {
    const view = presentExportIndicator(
      createInput({ status: "running", tracking: true }),
    );
    expect(view?.kind).toBe("active");
    expect(view).not.toHaveProperty("canDismiss");
  });
});

describe("focusInsideAfterBlur", () => {
  it("keeps the focus inside when the next target is inside the wrapper", () => {
    for (const documentHasFocus of [false, true]) {
      expect(focusInsideAfterBlur({ nextTarget: "inside", documentHasFocus })).toBe(
        true,
      );
    }
  });

  it("clears the focus note when the next target is outside the wrapper", () => {
    for (const documentHasFocus of [false, true]) {
      expect(focusInsideAfterBlur({ nextTarget: "outside", documentHasFocus })).toBe(
        false,
      );
    }
  });

  it("clears the focus note when the focus goes to the body of a focused window", () => {
    expect(focusInsideAfterBlur({ nextTarget: "none", documentHasFocus: true })).toBe(
      false,
    );
  });

  it("keeps the focus note when the window loses the focus", () => {
    expect(focusInsideAfterBlur({ nextTarget: "none", documentHasFocus: false })).toBe(
      true,
    );
  });
});

describe("decideFocusRestore", () => {
  const places = ["inside", "outside", "none"] as const;

  it("restores nothing when the focus was not inside", () => {
    for (const wrapperExists of [false, true]) {
      for (const activeElement of places) {
        expect(
          decideFocusRestore({ focusWasInside: false, wrapperExists, activeElement }),
        ).toEqual({ restore: false, focusInside: false });
      }
    }
  });

  it("restores nothing when the indicator shows nothing, such as for an open dialog", () => {
    for (const activeElement of places) {
      expect(
        decideFocusRestore({
          focusWasInside: true,
          wrapperExists: false,
          activeElement,
        }),
      ).toEqual({ restore: false, focusInside: false });
    }
  });

  it("restores the focus when the focused button went with the old content", () => {
    expect(
      decideFocusRestore({
        focusWasInside: true,
        wrapperExists: true,
        activeElement: "none",
      }),
    ).toEqual({ restore: true });
  });

  it("leaves a focus that is already in the new content, and keeps the note", () => {
    expect(
      decideFocusRestore({
        focusWasInside: true,
        wrapperExists: true,
        activeElement: "inside",
      }),
    ).toEqual({ restore: false, focusInside: true });
  });

  it("leaves a focus that is on another element, and clears the note", () => {
    expect(
      decideFocusRestore({
        focusWasInside: true,
        wrapperExists: true,
        activeElement: "outside",
      }),
    ).toEqual({ restore: false, focusInside: false });
  });
});
