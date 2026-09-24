import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, isExportRunLive, type ExportStatus } from "@/features/export";
import { resolveExportDialogStep, selectShownFrame } from "./exportDialogFrame";

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

  // A deliberate tripwire. The setup step holds Manage Presets..., which closes this dialog
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
