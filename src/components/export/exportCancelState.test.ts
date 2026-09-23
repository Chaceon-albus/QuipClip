import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, type ExportStatus } from "@/features/export";
import {
  isCancelEnabled,
  isCancelOutstanding,
  resolveExportDismissal,
} from "./exportCancelState";

const RUN_ID = "run-abc-123";

describe("resolveExportDismissal", () => {
  it("answers 'hide' for preparing, running, and publishing", () => {
    const hideStatuses: ExportStatus[] = ["preparing", "running", "publishing"];
    for (const status of hideStatuses) {
      expect(resolveExportDismissal(status)).toBe("hide");
    }
  });

  it("answers 'close' for all terminal and idle statuses", () => {
    const closeStatuses: ExportStatus[] = ["idle", "finished", "failed", "canceled"];
    for (const status of closeStatuses) {
      expect(resolveExportDismissal(status)).toBe("close");
    }
  });

  it("covers every status in EXPORT_STATUSES", () => {
    for (const status of EXPORT_STATUSES) {
      const dismissal = resolveExportDismissal(status);
      const isProgress =
        status === "preparing" || status === "running" || status === "publishing";
      expect(dismissal).toBe(isProgress ? "hide" : "close");
    }
  });
});

describe("isCancelOutstanding", () => {
  it("reports true in progress statuses when cancelRequested is true", () => {
    for (const status of EXPORT_STATUSES) {
      const isProgress =
        status === "preparing" || status === "running" || status === "publishing";
      expect(isCancelOutstanding({ status, cancelRequested: true })).toBe(isProgress);
    }
  });

  it("reports false in every status when cancelRequested is false", () => {
    for (const status of EXPORT_STATUSES) {
      expect(isCancelOutstanding({ status, cancelRequested: false })).toBe(false);
    }
  });
});

describe("isCancelEnabled", () => {
  it("enables cancel in preparing with or without a run id when no cancel is requested", () => {
    expect(
      isCancelEnabled({ status: "preparing", runId: null, cancelRequested: false }),
    ).toBe(true);
    expect(
      isCancelEnabled({ status: "preparing", runId: RUN_ID, cancelRequested: false }),
    ).toBe(true);
  });

  it("disables cancel in preparing when a cancel is requested", () => {
    expect(
      isCancelEnabled({ status: "preparing", runId: null, cancelRequested: true }),
    ).toBe(false);
    expect(
      isCancelEnabled({ status: "preparing", runId: RUN_ID, cancelRequested: true }),
    ).toBe(false);
  });

  it("enables cancel in running only when runId is known and no cancel is requested", () => {
    expect(
      isCancelEnabled({ status: "running", runId: RUN_ID, cancelRequested: false }),
    ).toBe(true);
    expect(
      isCancelEnabled({ status: "running", runId: null, cancelRequested: false }),
    ).toBe(false);
    expect(
      isCancelEnabled({ status: "running", runId: RUN_ID, cancelRequested: true }),
    ).toBe(false);
  });

  it("disables cancel in publishing regardless of runId or cancelRequested", () => {
    expect(
      isCancelEnabled({ status: "publishing", runId: RUN_ID, cancelRequested: false }),
    ).toBe(false);
    expect(
      isCancelEnabled({ status: "publishing", runId: null, cancelRequested: false }),
    ).toBe(false);
    expect(
      isCancelEnabled({ status: "publishing", runId: RUN_ID, cancelRequested: true }),
    ).toBe(false);
  });

  it("disables cancel in all non-progress statuses", () => {
    for (const status of EXPORT_STATUSES) {
      if (status === "preparing" || status === "running" || status === "publishing") {
        continue;
      }
      expect(isCancelEnabled({ status, runId: RUN_ID, cancelRequested: false })).toBe(
        false,
      );
      expect(isCancelEnabled({ status, runId: null, cancelRequested: false })).toBe(
        false,
      );
      expect(isCancelEnabled({ status, runId: RUN_ID, cancelRequested: true })).toBe(
        false,
      );
    }
  });
});
