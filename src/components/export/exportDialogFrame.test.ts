import { describe, expect, it } from "vitest";
import {
  EXPORT_ERROR_CODES,
  EXPORT_STATUSES,
  ExportError,
  isExportRunLive,
  type ExportStatus,
} from "@/features/export";
import {
  resolveExportDialogFocusOrder,
  resolveExportDialogFooter,
  resolveExportDialogStep,
  resolveExportDialogTitleKey,
  selectShownFrame,
  type ExportDialogFooter,
  type ExportDialogFocusTarget,
} from "./exportDialogFrame";

const FOOTERS: readonly ExportDialogFooter[] = [
  "setup",
  "run",
  "confirmation",
  "finished",
  "result",
];

describe("resolveExportDialogStep", () => {
  it("maps each status to its step", () => {
    const expected: Record<ExportStatus, string> = {
      idle: "setup",
      preparing: "progress",
      running: "progress",
      publishing: "progress",
      finished: "result",
      failed: "result",
      canceled: "result",
    };
    for (const status of EXPORT_STATUSES) {
      expect(resolveExportDialogStep(status)).toBe(expected[status]);
    }
  });

  // A deliberate tripwire. The setup step holds Manage Presets…, which closes this dialog
  // and resets the export store, so the action must never show while an export runs. The step
  // itself does not check the run. It relies on this rule: only `idle` shows the setup step,
  // and no status of a live run does. A change here must move that guard into the step.
  it("shows the setup step only while the store is idle", () => {
    const setupStatuses = EXPORT_STATUSES.filter(
      (status) => resolveExportDialogStep(status) === "setup",
    );
    expect(setupStatuses).toStrictEqual(["idle"]);
  });

  it("never shows the setup step for a live run", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        if (isExportRunLive({ status, tracking })) {
          expect(resolveExportDialogStep(status)).not.toBe("setup");
        }
      }
    }
  });
});

describe("resolveExportDialogFooter", () => {
  it("maps each status with no tracked run to its footer", () => {
    const expected: Record<ExportStatus, ExportDialogFooter> = {
      idle: "setup",
      preparing: "run",
      running: "run",
      publishing: "run",
      finished: "finished",
      failed: "result",
      canceled: "result",
    };
    for (const status of EXPORT_STATUSES) {
      expect(resolveExportDialogFooter({ status, tracking: false, error: null })).toBe(
        expected[status],
      );
    }
  });

  it("gives the run footer to a failure while the store still tracks the run", () => {
    // A Stop request failed, and the backend still encodes. The footer offers Stop Export
    // again and "Run in Background", and no Close that resets the store.
    const error = new ExportError({ code: "unknown", detail: "IPC closed" });
    expect(resolveExportDialogFooter({ status: "failed", tracking: true, error })).toBe(
      "run",
    );
  });

  it("gives the run footer to every live run, whatever the error code", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        for (const code of EXPORT_ERROR_CODES) {
          const footer = resolveExportDialogFooter({
            status,
            tracking,
            error: new ExportError({ code }),
          });
          expect(footer === "run").toBe(isExportRunLive({ status, tracking }));
        }
      }
    }
  });

  it("gives the confirmation footer to a source revision change with no tracked run", () => {
    const error = new ExportError({ code: "sourceRevisionChanged" });
    expect(
      resolveExportDialogFooter({ status: "failed", tracking: false, error }),
    ).toBe("confirmation");
    // The code does not make a canceled run a confirmation.
    expect(
      resolveExportDialogFooter({ status: "canceled", tracking: false, error }),
    ).toBe("result");
  });

  it("gives the setup footer to idle, whatever the tracking", () => {
    for (const tracking of [false, true]) {
      expect(resolveExportDialogFooter({ status: "idle", tracking, error: null })).toBe(
        "setup",
      );
    }
  });
});

describe("resolveExportDialogTitleKey", () => {
  it("gives the confirmation a title of its own", () => {
    expect(resolveExportDialogTitleKey("confirmation")).toBe(
      "export.sourceChanged.title",
    );
  });

  it("gives every other footer the title of the dialog", () => {
    for (const footer of FOOTERS.filter((entry) => entry !== "confirmation")) {
      expect(resolveExportDialogTitleKey(footer)).toBe("export.title");
    }
  });
});

describe("resolveExportDialogFocusOrder", () => {
  it("names the control of each footer, in order", () => {
    const expected: Record<ExportDialogFooter, readonly ExportDialogFocusTarget[]> = {
      setup: ["primary", "setupFirstControl", "dialog"],
      confirmation: ["cancel", "dialog"],
      finished: ["done", "dialog"],
      run: ["dialog"],
      result: ["dialog"],
    };
    for (const footer of FOOTERS) {
      expect(resolveExportDialogFocusOrder(footer)).toStrictEqual(expected[footer]);
    }
  });

  it("gives the setup step to the default button, Export…", () => {
    expect(resolveExportDialogFocusOrder("setup")[0]).toBe("primary");
  });

  it("gives the source-change confirmation to Cancel, so Enter changes nothing", () => {
    expect(resolveExportDialogFocusOrder("confirmation")[0]).toBe("cancel");
  });

  // The run footer holds Stop Export. A default focus on a footer button would let Enter
  // arm or confirm the stop.
  it("never gives a live run to a button of its footer", () => {
    expect(resolveExportDialogFocusOrder("run")).toStrictEqual(["dialog"]);
  });

  it("ends every order with the dialog, which can always take the focus", () => {
    for (const footer of FOOTERS) {
      const order = resolveExportDialogFocusOrder(footer);
      expect(order[order.length - 1]).toBe("dialog");
    }
  });
});

describe("selectShownFrame", () => {
  const live = { status: "idle" };
  const held = { status: "finished" };

  it("shows the held frame while the dialog closes", () => {
    expect(selectShownFrame(false, live, held)).toBe(held);
  });

  it("shows the live frame while the dialog is open, so a reopen shows fresh content", () => {
    expect(selectShownFrame(true, live, held)).toBe(live);
    expect(selectShownFrame(true, live, null)).toBe(live);
  });

  it("shows the live frame for a closed dialog that holds no frame", () => {
    expect(selectShownFrame(false, live, null)).toBe(live);
  });
});
