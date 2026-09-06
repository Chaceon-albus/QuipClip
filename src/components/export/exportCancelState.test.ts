import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES } from "@/features/export";
import {
  isCancelEnabled,
  isCancelOutstanding,
  isExportDismissalRefused,
} from "./exportCancelState";

const RUN_ID = "run-abc-123";
const OTHER_RUN_ID = "run-xyz-789";

describe("isExportDismissalRefused", () => {
  // BLOCKING 08-F1: "preparing" before the backend answers is the one progress phase with
  // no run to protect. Refusing it too left the interface with a state it could enter and
  // could not leave, because `isCancelEnabled` also refuses while `runId` is null.
  it("permits dismissal during preparing while no run id exists", () => {
    expect(isExportDismissalRefused({ status: "preparing", runId: null })).toBe(false);
    expect(
      isCancelEnabled({ status: "preparing", runId: null, cancelingRunId: null }),
    ).toBe(false);
  });

  it("refuses dismissal once a run exists, and for running and publishing", () => {
    expect(isExportDismissalRefused({ status: "preparing", runId: RUN_ID })).toBe(true);
    expect(isExportDismissalRefused({ status: "running", runId: RUN_ID })).toBe(true);
    expect(isExportDismissalRefused({ status: "publishing", runId: RUN_ID })).toBe(
      true,
    );
  });

  it("permits dismissal in every status that is not a progress phase", () => {
    for (const status of EXPORT_STATUSES) {
      const progress =
        status === "preparing" || status === "running" || status === "publishing";
      if (progress) {
        continue;
      }
      expect(isExportDismissalRefused({ status, runId: RUN_ID })).toBe(false);
      expect(isExportDismissalRefused({ status, runId: null })).toBe(false);
    }
  });
});

describe("isCancelOutstanding", () => {
  it("reports no outstanding cancel while no run id is known, in every status", () => {
    for (const status of EXPORT_STATUSES) {
      expect(isCancelOutstanding({ status, runId: null, cancelingRunId: null })).toBe(
        false,
      );
    }
  });

  it("reports an outstanding cancel only in the phases where a run is active", () => {
    for (const status of EXPORT_STATUSES) {
      const active =
        status === "preparing" || status === "running" || status === "publishing";
      expect(
        isCancelOutstanding({ status, runId: RUN_ID, cancelingRunId: RUN_ID }),
      ).toBe(active);
    }
  });

  it("ignores a cancel that names a different run, so a new export starts clean", () => {
    for (const status of EXPORT_STATUSES) {
      expect(
        isCancelOutstanding({ status, runId: RUN_ID, cancelingRunId: OTHER_RUN_ID }),
      ).toBe(false);
    }
  });
});

describe("isCancelEnabled", () => {
  it("keeps the button disabled while no run id is known, in every status", () => {
    for (const status of EXPORT_STATUSES) {
      expect(isCancelEnabled({ status, runId: null, cancelingRunId: null })).toBe(
        false,
      );
      expect(isCancelEnabled({ status, runId: null, cancelingRunId: RUN_ID })).toBe(
        false,
      );
    }
  });

  it("keeps the button disabled during publishing, even with a run id", () => {
    expect(
      isCancelEnabled({ status: "publishing", runId: RUN_ID, cancelingRunId: null }),
    ).toBe(false);
  });

  it("enables the button in preparing and running with a run id and no outstanding cancel", () => {
    for (const status of ["preparing", "running"] as const) {
      expect(isCancelEnabled({ status, runId: RUN_ID, cancelingRunId: null })).toBe(
        true,
      );
    }
  });

  it("disables the button while a cancel for the active run is outstanding", () => {
    for (const status of ["preparing", "running"] as const) {
      expect(isCancelEnabled({ status, runId: RUN_ID, cancelingRunId: RUN_ID })).toBe(
        false,
      );
    }
  });

  it("keeps the button enabled when the outstanding cancel names a different run", () => {
    for (const status of ["preparing", "running"] as const) {
      expect(
        isCancelEnabled({ status, runId: RUN_ID, cancelingRunId: OTHER_RUN_ID }),
      ).toBe(true);
    }
  });

  it("keeps the button disabled in every status that carries no active run", () => {
    for (const status of EXPORT_STATUSES) {
      if (status === "preparing" || status === "running") {
        continue;
      }
      expect(isCancelEnabled({ status, runId: RUN_ID, cancelingRunId: null })).toBe(
        false,
      );
    }
  });
});
