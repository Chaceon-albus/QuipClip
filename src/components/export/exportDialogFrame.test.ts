import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, type ExportStatus } from "@/features/export";
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
