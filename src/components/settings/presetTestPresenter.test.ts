import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  PRESET_TEST_ERROR_CODES,
  PresetTestError,
  type PresetTestResult,
} from "@/features/settings/presetTest";
import {
  presentEditorTestAction,
  presentPresetTestAnnouncement,
  presentPresetTestMark,
  presentPresetTestStatus,
  PRESET_TEST_TIMEOUT_SECONDS,
} from "./presetTestPresenter";

const TESTED_AT = 1_790_000_000;

function result(overrides: Partial<PresetTestResult>): PresetTestResult {
  return { status: "passed", testedAt: TESTED_AT, ...overrides };
}

/** Looks a dotted key up in a catalog. */
function lookup(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

describe("presentPresetTestStatus", () => {
  it("says that a preset was not tested, and that a test runs", () => {
    expect(presentPresetTestStatus({ kind: "none" })).toEqual({
      tone: "neutral",
      icon: null,
      message: { key: "settings.presetTest.notTested" },
      line: null,
      lineMessage: null,
    });
    expect(presentPresetTestStatus({ kind: "running" })).toMatchObject({
      tone: "neutral",
      icon: "spinner",
      message: { key: "settings.presetTest.running" },
    });
  });

  it("shows a pass with no line", () => {
    expect(
      presentPresetTestStatus({ kind: "result", result: result({}), stored: true }),
    ).toEqual({
      tone: "success",
      icon: "passed",
      message: { key: "settings.presetTest.passed" },
      line: null,
      lineMessage: null,
    });
  });

  it("shows the line of a warning and of a failure apart from the sentence", () => {
    expect(
      presentPresetTestStatus({
        kind: "result",
        stored: true,
        result: result({
          status: "passedWithWarnings",
          line: "[libsvtav1] [warning] Error parsing option no-such-key: 2.",
        }),
      }),
    ).toEqual({
      tone: "warning",
      icon: "warning",
      message: { key: "settings.presetTest.passedWithWarnings" },
      line: "[libsvtav1] [warning] Error parsing option no-such-key: 2.",
      lineMessage: null,
    });
    expect(
      presentPresetTestStatus({
        kind: "result",
        stored: true,
        result: result({
          status: "failed",
          line: "[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)",
          exitCode: 183,
        }),
      }),
    ).toEqual({
      tone: "destructive",
      icon: "failed",
      message: { key: "settings.presetTest.failed" },
      line: "[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)",
      lineMessage: null,
    });
  });

  it("shows the exit code of a failure that wrote no line", () => {
    expect(
      presentPresetTestStatus({
        kind: "result",
        stored: true,
        result: result({ status: "failed", exitCode: 1 }),
      }),
    ).toMatchObject({
      line: null,
      lineMessage: { key: "settings.presetTest.exitCode", values: { code: 1 } },
    });
  });

  it("names the timeout of a test that did not finish", () => {
    expect(
      presentPresetTestStatus({
        kind: "result",
        stored: true,
        result: result({ status: "timedOut" }),
      }),
    ).toMatchObject({
      tone: "destructive",
      icon: "failed",
      message: {
        key: "settings.presetTest.timedOut",
        values: { seconds: PRESET_TEST_TIMEOUT_SECONDS },
      },
    });
  });

  it("names the timeout that Rust uses", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src-tauri/src/ffmpeg/capabilities/preset_test.rs",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(source).toContain(
      `pub const PRESET_TEST_TIMEOUT: Duration = Duration::from_secs(${PRESET_TEST_TIMEOUT_SECONDS});`,
    );
  });

  it("shows a refusal by its code, with the diagnostic of a process or file failure only", () => {
    expect(
      presentPresetTestStatus({
        kind: "error",
        error: new PresetTestError("exportRunning"),
      }),
    ).toEqual({
      tone: "destructive",
      icon: "failed",
      message: { key: "settings.presetTest.error.exportRunning" },
      line: null,
      lineMessage: null,
    });
    expect(
      presentPresetTestStatus({
        kind: "error",
        error: new PresetTestError(
          "ffmpegSpawnFailed",
          "Permission denied (os error 13)",
        ),
      }).line,
    ).toBe("Permission denied (os error 13)");
    // The detail of an invalid preset is an English message of the Rust validation. The code
    // is the whole account (ADR 011).
    expect(
      presentPresetTestStatus({
        kind: "error",
        error: new PresetTestError(
          "invalidPreset",
          "presets[0].pixelFormat is not a valid pixel format name",
        ),
      }).line,
    ).toBeNull();
  });

  it("has a message in both catalogs for every key it presents", () => {
    const keys = [
      "settings.presetTest.notTested",
      "settings.presetTest.running",
      "settings.presetTest.passed",
      "settings.presetTest.passedWithWarnings",
      "settings.presetTest.failed",
      "settings.presetTest.timedOut",
      "settings.presetTest.exitCode",
      "settings.presetTest.blocked",
      "settings.presetTest.test",
      "settings.presetTest.testAgain",
      "settings.presetTest.summaryLabel",
      "settings.presetTest.markPassed",
      "settings.presetTest.markWarning",
      "settings.presetTest.markFailed",
      "settings.presetTest.markTimedOut",
      ...PRESET_TEST_ERROR_CODES.map((code) => `settings.presetTest.error.${code}`),
    ];
    for (const key of keys) {
      expect(typeof lookup(en, key), key).toBe("string");
      expect(typeof lookup(zhCN, key), key).toBe("string");
    }
  });
});

describe("presentPresetTestMark", () => {
  it("marks a row with a known result only", () => {
    expect(presentPresetTestMark(null)).toBeNull();
    expect(presentPresetTestMark(result({}))).toEqual({
      tone: "success",
      icon: "passed",
      label: { key: "settings.presetTest.markPassed" },
      line: null,
    });
    expect(
      presentPresetTestMark(
        result({ status: "passedWithWarnings", line: "[warning] x" }),
      ),
    ).toEqual({
      tone: "warning",
      icon: "warning",
      label: { key: "settings.presetTest.markWarning" },
      line: "[warning] x",
    });
    expect(
      presentPresetTestMark(result({ status: "failed", line: "[error] x" })),
    ).toEqual({
      tone: "destructive",
      icon: "failed",
      label: { key: "settings.presetTest.markFailed" },
      line: "[error] x",
    });
    expect(presentPresetTestMark(result({ status: "timedOut" }))).toEqual({
      tone: "destructive",
      icon: "failed",
      label: { key: "settings.presetTest.markTimedOut" },
      line: null,
    });
  });
});

describe("presentEditorTestAction", () => {
  it("is on for a draft with no problem, saved or not", () => {
    expect(
      presentEditorTestAction({ issueCount: 0, optionsErrorCount: 0, running: false }),
    ).toEqual({ disabled: false, blocked: null });
  });

  it("is off while the test of the draft runs", () => {
    expect(
      presentEditorTestAction({ issueCount: 0, optionsErrorCount: 0, running: true }),
    ).toEqual({ disabled: true, blocked: null });
  });

  it("is off, and says why, for a draft that the editor could not save", () => {
    for (const counts of [
      { issueCount: 1, optionsErrorCount: 0 },
      { issueCount: 0, optionsErrorCount: 2 },
    ]) {
      expect(presentEditorTestAction({ ...counts, running: false })).toEqual({
        disabled: true,
        blocked: { key: "settings.presetTest.blocked" },
      });
    }
  });
});

describe("presentPresetTestAnnouncement", () => {
  it("announces the start of a test that the user started, and the sentence of its end", () => {
    expect(presentPresetTestAnnouncement(null, 0)).toEqual({
      key: "settings.presetTest.running",
    });
    expect(
      presentPresetTestAnnouncement(
        {
          status: "finished",
          result: result({ status: "failed", line: "[error] x" }),
          stored: true,
          generation: 0,
        },
        0,
      ),
    ).toEqual({ key: "settings.presetTest.failed" });
    expect(
      presentPresetTestAnnouncement(
        {
          status: "finished",
          result: result({ status: "timedOut" }),
          stored: false,
          generation: 0,
        },
        0,
      ),
    ).toEqual({
      key: "settings.presetTest.timedOut",
      values: { seconds: PRESET_TEST_TIMEOUT_SECONDS },
    });
    expect(
      presentPresetTestAnnouncement(
        {
          status: "failed",
          error: new PresetTestError("exportRunning"),
          at: 1,
          generation: 0,
        },
        0,
      ),
    ).toEqual({ key: "settings.presetTest.error.exportRunning" });
  });

  it("announces nothing for a test of the binary before, which the status line hides", () => {
    const finished = {
      status: "finished",
      result: result({ status: "passed" }),
      stored: true,
      generation: 0,
    } as const;
    expect(presentPresetTestAnnouncement(finished, 1)).toBeNull();
    expect(
      presentPresetTestAnnouncement(
        {
          status: "failed",
          error: new PresetTestError("unknown"),
          at: 1,
          generation: 0,
        },
        1,
      ),
    ).toBeNull();
    expect(presentPresetTestAnnouncement(null, 1)).toEqual({
      key: "settings.presetTest.running",
    });
  });
});
