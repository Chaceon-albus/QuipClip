import { describe, expect, it } from "vitest";
import { isExportRunLive } from "./runState";
import { EXPORT_STATUSES, type ExportStatus } from "./types";

describe("isExportRunLive", () => {
  const active: ExportStatus[] = ["preparing", "running", "publishing"];

  it("is true in each active status, with or without a tracked run", () => {
    for (const status of active) {
      expect(isExportRunLive({ status, tracking: false })).toBe(true);
      expect(isExportRunLive({ status, tracking: true })).toBe(true);
    }
  });

  it("is true for a failure while the store still tracks the run", () => {
    expect(isExportRunLive({ status: "failed", tracking: true })).toBe(true);
  });

  it("is false for a failure with no tracked run", () => {
    expect(isExportRunLive({ status: "failed", tracking: false })).toBe(false);
  });

  it("is false in idle, finished and canceled, whatever the tracking", () => {
    for (const status of ["idle", "finished", "canceled"] as const) {
      expect(isExportRunLive({ status, tracking: false })).toBe(false);
      expect(isExportRunLive({ status, tracking: true })).toBe(false);
    }
  });

  it("covers every status in EXPORT_STATUSES", () => {
    for (const status of EXPORT_STATUSES) {
      expect(isExportRunLive({ status, tracking: false })).toBe(
        active.includes(status),
      );
    }
  });
});
