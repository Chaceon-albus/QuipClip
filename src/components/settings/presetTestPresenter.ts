/**
 * Pure presenter of the preset test: the status line of the editor and of the export setup,
 * the mark of a preset list row, and the state of the Test buttons.
 *
 * A result is information only (ADR 006): nothing here blocks an export or a save.
 *
 * The line of a result is FFmpeg log text. The views carry it apart from the translated
 * sentence, and the interface shows it as it is, under the sentence, so no sentence is built
 * from a translated part and an untranslated part (ADR 011).
 */

import type {
  PresetTestErrorCode,
  PresetTestResult,
} from "@/features/settings/presetTest";
import type {
  PresetTestRun,
  PresetTestView,
} from "@/features/settings/presetTestStore";
import type { MessageView } from "./presetPresenter";

/**
 * The timeout of one test in Rust (`PRESET_TEST_TIMEOUT`), in seconds. The timed-out message
 * names it. A test compares it with the Rust source.
 */
export const PRESET_TEST_TIMEOUT_SECONDS = 10;

/** The colour of a status: its icon and its sentence take it. */
export type PresetTestTone = "neutral" | "success" | "warning" | "destructive";

/** The icon of a status. Its shape carries the state, so the colour is never the only cue. */
export type PresetTestIcon = "spinner" | "passed" | "warning" | "failed";

/** The status line of the test of one preset. */
export type PresetTestStatusView = {
  tone: PresetTestTone;
  /** The icon in front of the sentence, or null for a preset that was not tested. */
  icon: PresetTestIcon | null;
  /** The translated sentence. */
  message: MessageView;
  /**
   * The text under the sentence, shown as it is, or null: the FFmpeg line of a result that did
   * not pass cleanly, or the diagnostic of a refusal whose cause QuipClip cannot name.
   */
  line: string | null;
  /** The text under the sentence when it is a translated message instead, or null. */
  lineMessage: MessageView | null;
};

/** The refusals whose diagnostic the status line shows: a process or a file operation failed. */
const ERROR_CODES_WITH_DETAIL: ReadonlySet<PresetTestErrorCode> = new Set([
  "ffmpegSpawnFailed",
  "temporaryFileUnavailable",
  "commandExecutionFailed",
  "unknown",
]);

/** The status of one result. */
function presentResult(result: PresetTestResult): PresetTestStatusView {
  const line = result.line ?? null;
  // A failure with no stderr still has its exit code, which tells two faults apart.
  const lineMessage =
    line === null && result.exitCode !== undefined
      ? { key: "settings.presetTest.exitCode", values: { code: result.exitCode } }
      : null;
  switch (result.status) {
    case "passed":
      return {
        tone: "success",
        icon: "passed",
        message: { key: "settings.presetTest.passed" },
        line: null,
        lineMessage: null,
      };
    case "passedWithWarnings":
      return {
        tone: "warning",
        icon: "warning",
        message: { key: "settings.presetTest.passedWithWarnings" },
        line,
        lineMessage: null,
      };
    case "failed":
      return {
        tone: "destructive",
        icon: "failed",
        message: { key: "settings.presetTest.failed" },
        line,
        lineMessage,
      };
    case "timedOut":
      return {
        tone: "destructive",
        icon: "failed",
        message: {
          key: "settings.presetTest.timedOut",
          values: { seconds: PRESET_TEST_TIMEOUT_SECONDS },
        },
        line,
        lineMessage: null,
      };
  }
}

/**
 * Presents the status line of `view`: not tested, testing, the result, or the refusal of the
 * last test.
 */
export function presentPresetTestStatus(view: PresetTestView): PresetTestStatusView {
  switch (view.kind) {
    case "none":
      return {
        tone: "neutral",
        icon: null,
        message: { key: "settings.presetTest.notTested" },
        line: null,
        lineMessage: null,
      };
    case "running":
      return {
        tone: "neutral",
        icon: "spinner",
        message: { key: "settings.presetTest.running" },
        line: null,
        lineMessage: null,
      };
    case "result":
      return presentResult(view.result);
    case "error":
      return {
        tone: "destructive",
        icon: "failed",
        message: { key: `settings.presetTest.error.${view.error.code}` },
        line:
          ERROR_CODES_WITH_DETAIL.has(view.error.code) && view.error.detail
            ? view.error.detail
            : null,
        lineMessage: null,
      };
  }
}

/** The mark of a preset list row with a known result. */
export type PresetTestMarkView = {
  tone: Exclude<PresetTestTone, "neutral">;
  icon: Exclude<PresetTestIcon, "spinner">;
  /** The accessible name of the mark, and the first line of its tooltip. */
  label: MessageView;
  /** The FFmpeg line, for the tooltip, or null. */
  line: string | null;
};

/**
 * Presents the mark of a row: pass, warning, or failure, or null for a preset with no known
 * result. A timeout is a failure mark with its own label.
 */
export function presentPresetTestMark(
  result: PresetTestResult | null,
): PresetTestMarkView | null {
  if (result === null) {
    return null;
  }
  const line = result.line ?? null;
  switch (result.status) {
    case "passed":
      return {
        tone: "success",
        icon: "passed",
        label: { key: "settings.presetTest.markPassed" },
        line: null,
      };
    case "passedWithWarnings":
      return {
        tone: "warning",
        icon: "warning",
        label: { key: "settings.presetTest.markWarning" },
        line,
      };
    case "failed":
      return {
        tone: "destructive",
        icon: "failed",
        label: { key: "settings.presetTest.markFailed" },
        line,
      };
    case "timedOut":
      return {
        tone: "destructive",
        icon: "failed",
        label: { key: "settings.presetTest.markTimedOut" },
        line,
      };
  }
}

/** The Test button of the preset editor. */
export type EditorTestActionView = {
  disabled: boolean;
  /**
   * Why the button is off, shown in place of the status line, or null. A test runs the draft,
   * so a draft that the editor could not save cannot be tested either: Rust validates it as a
   * saved preset.
   */
  blocked: MessageView | null;
};

/**
 * Presents the Test button of the editor. It is off while the test of this draft runs, and
 * while the draft has a problem: a field issue, or an import of the extra parameters that
 * failed. A text of the extra parameters that is not applied yet does not block it: the test
 * applies it first, as Save does.
 */
export function presentEditorTestAction(input: {
  readonly issueCount: number;
  readonly optionsErrorCount: number;
  readonly running: boolean;
}): EditorTestActionView {
  const blocked = input.issueCount > 0 || input.optionsErrorCount > 0;
  return {
    disabled: blocked || input.running,
    blocked: blocked ? { key: "settings.presetTest.blocked" } : null,
  };
}

/**
 * The text of the live region of a test that the user started: the running message when it
 * starts (`run` null), and the sentence of its outcome when it ends. `generation` is the
 * binary generation of the store when the test ends. A run of an older generation gives null,
 * because the status line no longer shows it: the probe located another binary during the test.
 *
 * The status line itself is not live. A screen reader would otherwise read it again for each
 * row that an arrow key selects in the preset list, and for each test that the export setup
 * runs in the background. Only a test that the user asked for is announced.
 */
export function presentPresetTestAnnouncement(
  run: PresetTestRun | null,
  generation: number,
): MessageView | null {
  if (run !== null && run.generation !== generation) {
    return null;
  }
  if (run === null || run.status === "running") {
    return { key: "settings.presetTest.running" };
  }
  if (run.status === "failed") {
    return { key: `settings.presetTest.error.${run.error.code}` };
  }
  return presentResult(run.result).message;
}
