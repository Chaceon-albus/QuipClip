import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES } from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n";
import {
  STOP_CONFIRM_AFTER_MS,
  STOP_CONFIRM_MIN_DELAY_MS,
  STOP_CONFIRM_WINDOW_MS,
  decideStopClick,
  isStopArmed,
  presentStopButton,
  refreshStopArmedAt,
  stopArmRemainingMs,
  type StopButtonInput,
} from "./exportStopPresenter";

const RUN_ID = "run-abc-123";
const START = 1_000;

function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createButtonInput(overrides: Partial<StopButtonInput> = {}): StopButtonInput {
  return {
    status: "running",
    runId: RUN_ID,
    cancelRequested: false,
    tracking: true,
    armed: false,
    ...overrides,
  };
}

describe("stop confirmation constants", () => {
  it("asks for a second click from 30 seconds, and waits 3 seconds for it", () => {
    expect(STOP_CONFIRM_AFTER_MS).toBe(30_000);
    expect(STOP_CONFIRM_WINDOW_MS).toBe(3_000);
  });

  it("ignores a second click within the 500 ms double-click interval", () => {
    expect(STOP_CONFIRM_MIN_DELAY_MS).toBe(500);
    expect(STOP_CONFIRM_MIN_DELAY_MS).toBeLessThan(STOP_CONFIRM_WINDOW_MS);
  });
});

describe("isStopArmed", () => {
  it("is false when the button was never armed", () => {
    expect(isStopArmed(null, START)).toBe(false);
  });

  it("is true from the arming click until the window ends", () => {
    expect(isStopArmed(START, START)).toBe(true);
    expect(isStopArmed(START, START + STOP_CONFIRM_WINDOW_MS - 1)).toBe(true);
  });

  it("is false once the window ends", () => {
    expect(isStopArmed(START, START + STOP_CONFIRM_WINDOW_MS)).toBe(false);
    expect(isStopArmed(START, START + STOP_CONFIRM_WINDOW_MS + 10_000)).toBe(false);
  });

  it("is false for a time before the arming click", () => {
    expect(isStopArmed(START, START - 1)).toBe(false);
  });
});

describe("refreshStopArmedAt", () => {
  it("keeps the armed time while the window is open", () => {
    expect(refreshStopArmedAt(START, START + STOP_CONFIRM_WINDOW_MS - 1)).toBe(START);
  });

  it("clears the armed time after the window, when a delayed timer did not", () => {
    expect(refreshStopArmedAt(START, START + STOP_CONFIRM_WINDOW_MS)).toBeNull();
    expect(refreshStopArmedAt(START, START + 60_000)).toBeNull();
  });

  it("leaves a button that is not armed unarmed", () => {
    expect(refreshStopArmedAt(null, START)).toBeNull();
  });
});

describe("stopArmRemainingMs", () => {
  it("counts down to zero across the window", () => {
    expect(stopArmRemainingMs(START, START)).toBe(STOP_CONFIRM_WINDOW_MS);
    expect(stopArmRemainingMs(START, START + 1_000)).toBe(
      STOP_CONFIRM_WINDOW_MS - 1_000,
    );
    expect(stopArmRemainingMs(START, START + STOP_CONFIRM_WINDOW_MS)).toBe(0);
  });

  it("never goes below zero", () => {
    expect(stopArmRemainingMs(START, START + STOP_CONFIRM_WINDOW_MS + 5_000)).toBe(0);
  });
});

describe("decideStopClick", () => {
  it("stops at once when the export has run for less than 30 seconds", () => {
    expect(decideStopClick({ now: START, startedAt: START, armedAt: null })).toEqual({
      kind: "stop",
    });
    expect(
      decideStopClick({
        now: START + STOP_CONFIRM_AFTER_MS - 1,
        startedAt: START,
        armedAt: null,
      }),
    ).toEqual({ kind: "stop" });
  });

  it("arms the button when the export has run for 30 seconds", () => {
    const now = START + STOP_CONFIRM_AFTER_MS;
    expect(decideStopClick({ now, startedAt: START, armedAt: null })).toEqual({
      kind: "arm",
      armedAt: now,
    });
  });

  it("arms the button when the export has run for longer than 30 seconds", () => {
    const now = START + 10 * 60_000;
    expect(decideStopClick({ now, startedAt: START, armedAt: null })).toEqual({
      kind: "arm",
      armedAt: now,
    });
  });

  it("ignores a click less than 500 ms after the arming click", () => {
    const armedAt = START + STOP_CONFIRM_AFTER_MS;
    expect(decideStopClick({ now: armedAt + 1, startedAt: START, armedAt })).toEqual({
      kind: "ignore",
    });
    expect(decideStopClick({ now: armedAt + 499, startedAt: START, armedAt })).toEqual({
      kind: "ignore",
    });
  });

  it("does not let one double-click arm and stop", () => {
    const first = START + 60_000;
    const armed = decideStopClick({ now: first, startedAt: START, armedAt: null });
    expect(armed).toEqual({ kind: "arm", armedAt: first });

    const second = decideStopClick({
      now: first + 150,
      startedAt: START,
      armedAt: first,
    });
    expect(second).toEqual({ kind: "ignore" });

    // The ignored click keeps the armed time, so a later, separate click still confirms.
    const third = decideStopClick({
      now: first + 1_200,
      startedAt: START,
      armedAt: first,
    });
    expect(third).toEqual({ kind: "stop" });
  });

  it("stops on a second click from 500 ms until 3 seconds after the arming click", () => {
    const armedAt = START + STOP_CONFIRM_AFTER_MS;
    expect(decideStopClick({ now: armedAt + 500, startedAt: START, armedAt })).toEqual({
      kind: "stop",
    });
    expect(
      decideStopClick({
        now: armedAt + STOP_CONFIRM_WINDOW_MS - 1,
        startedAt: START,
        armedAt,
      }),
    ).toEqual({ kind: "stop" });
  });

  it("arms again, and does not stop, on a click after the window expired", () => {
    const armedAt = START + STOP_CONFIRM_AFTER_MS;
    const late = armedAt + STOP_CONFIRM_WINDOW_MS;
    expect(decideStopClick({ now: late, startedAt: START, armedAt })).toEqual({
      kind: "arm",
      armedAt: late,
    });
  });

  it("walks the whole sequence: arm, expire, arm again, confirm", () => {
    const first = START + 45_000;
    const firstDecision = decideStopClick({
      now: first,
      startedAt: START,
      armedAt: null,
    });
    expect(firstDecision).toEqual({ kind: "arm", armedAt: first });

    // The dialog clears the armed state when the window ends. A click after that arms again.
    const second = first + STOP_CONFIRM_WINDOW_MS + 500;
    const secondDecision = decideStopClick({
      now: second,
      startedAt: START,
      armedAt: null,
    });
    expect(secondDecision).toEqual({ kind: "arm", armedAt: second });

    const third = second + 800;
    expect(decideStopClick({ now: third, startedAt: START, armedAt: second })).toEqual({
      kind: "stop",
    });
  });

  it("stops at once when the start is unknown", () => {
    expect(decideStopClick({ now: 99_999, startedAt: null, armedAt: null })).toEqual({
      kind: "stop",
    });
  });
});

describe("presentStopButton", () => {
  it("shows Stop Export, enabled and destructive, while running", () => {
    expect(presentStopButton(createButtonInput())).toEqual({
      labelKey: "export.action.stop",
      enabled: true,
      armed: false,
      appearance: "destructive",
      noteKey: null,
    });
  });

  it("shows Stop Export, enabled, while preparing with no run id", () => {
    expect(
      presentStopButton(createButtonInput({ status: "preparing", runId: null })),
    ).toEqual({
      labelKey: "export.action.stop",
      enabled: true,
      armed: false,
      appearance: "destructive",
      noteKey: null,
    });
  });

  it("shows the confirmation label while armed", () => {
    expect(presentStopButton(createButtonInput({ armed: true }))).toEqual({
      labelKey: "export.action.stopConfirm",
      enabled: true,
      armed: true,
      appearance: "destructive",
      noteKey: null,
    });
  });

  it("shows Stopping..., disabled and outlined, while a cancel is outstanding, even when armed", () => {
    expect(
      presentStopButton(createButtonInput({ cancelRequested: true, armed: true })),
    ).toEqual({
      labelKey: "export.status.canceling",
      enabled: false,
      armed: false,
      appearance: "outline",
      noteKey: null,
    });
  });

  it("disables and outlines the button in publishing, and says why", () => {
    expect(presentStopButton(createButtonInput({ status: "publishing" }))).toEqual({
      labelKey: "export.action.stop",
      enabled: false,
      armed: false,
      appearance: "outline",
      noteKey: "export.status.stopUnavailable",
    });
  });

  it("never shows the confirmation label on the disabled button in publishing", () => {
    const view = presentStopButton(
      createButtonInput({ status: "publishing", armed: true }),
    );
    expect(view.labelKey).toBe("export.action.stop");
    expect(view.armed).toBe(false);
    expect(view.noteKey).toBe("export.status.stopUnavailable");
  });

  it("omits the note in publishing while a cancel is outstanding", () => {
    expect(
      presentStopButton(
        createButtonInput({ status: "publishing", cancelRequested: true }),
      ),
    ).toEqual({
      labelKey: "export.status.canceling",
      enabled: false,
      armed: false,
      appearance: "outline",
      noteKey: null,
    });
  });

  it("disables the button in running with no run id, with no note", () => {
    expect(presentStopButton(createButtonInput({ runId: null }))).toEqual({
      labelKey: "export.action.stop",
      enabled: false,
      armed: false,
      appearance: "outline",
      noteKey: null,
    });
  });

  it("offers the stop again, with the two-click rule, after a failed Stop request", () => {
    // `failed` while the store still tracks the run: the backend did not confirm the stop.
    for (const runId of [RUN_ID, null]) {
      expect(presentStopButton(createButtonInput({ status: "failed", runId }))).toEqual(
        {
          labelKey: "export.action.stop",
          enabled: true,
          armed: false,
          appearance: "destructive",
          noteKey: null,
        },
      );
      expect(
        presentStopButton(createButtonInput({ status: "failed", runId, armed: true })),
      ).toMatchObject({ labelKey: "export.action.stopConfirm", armed: true });
      expect(
        presentStopButton(
          createButtonInput({ status: "failed", runId, cancelRequested: true }),
        ),
      ).toMatchObject({ labelKey: "export.status.canceling", enabled: false });
    }
  });

  it("disables the button for a failure that the store no longer tracks", () => {
    expect(
      presentStopButton(createButtonInput({ status: "failed", tracking: false })),
    ).toMatchObject({ enabled: false, appearance: "outline" });
  });

  it("uses the destructive style exactly when the button is enabled", () => {
    for (const status of EXPORT_STATUSES) {
      for (const cancelRequested of [false, true]) {
        for (const runId of [RUN_ID, null]) {
          const view = presentStopButton(
            createButtonInput({ status, cancelRequested, runId }),
          );
          expect(view.appearance).toBe(view.enabled ? "destructive" : "outline");
        }
      }
    }
  });

  it("uses keys that exist in both catalogs", () => {
    const keys = [
      "export.action.stop",
      "export.action.stopConfirm",
      "export.status.canceling",
      "export.status.stopUnavailable",
      "export.action.hide",
    ];
    for (const key of keys) {
      for (const catalog of [en, zhCN]) {
        const resolved = resolveCatalogKey(catalog, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
