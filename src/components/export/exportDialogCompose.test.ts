import { describe, expect, it } from "vitest";
import {
  EXPORT_ERROR_CODES,
  EXPORT_STATUSES,
  ExportError,
  isExportRunLive,
  type ExportComposeState,
} from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { canGoBackToSetup } from "./exportBackToSetup";
import {
  addsToQueue,
  resolveComposeExit,
  resolveExportCloseLabelKey,
  resolveSetupConfirmLabelKey,
  selectExportDialogTargetState,
  showsNewExportAction,
  type ExportDialogTargetState,
} from "./exportDialogCompose";
import {
  resolveExportDialogFooter,
  resolveExportDialogStep,
  resolveExportDialogTitleKey,
} from "./exportDialogFrame";

/** A live run of the export store, behind the compose state. */
const LIVE_RUN: ExportDialogTargetState = {
  status: "running",
  tracking: true,
  error: null,
};

function compose(
  overrides: Partial<ExportComposeState> = {},
): Pick<ExportComposeState, "composing" | "status" | "error"> {
  return { composing: true, status: "idle", error: null, ...overrides };
}

function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

describe("selectExportDialogTargetState", () => {
  it("reads the export store while the dialog does not compose", () => {
    const error = new ExportError({ code: "unknown" });
    const exportState = { status: "failed", tracking: true, error } as const;
    expect(
      selectExportDialogTargetState(
        compose({ composing: false, status: "failed", error: null }),
        exportState,
      ),
    ).toStrictEqual(exportState);
  });

  it("reads the compose store while the dialog composes, with no tracking", () => {
    const error = new ExportError({ code: "outputAlreadyQueued" });
    expect(
      selectExportDialogTargetState(compose({ status: "failed", error }), LIVE_RUN),
    ).toStrictEqual({ status: "failed", tracking: false, error });
  });

  it("is never live while the dialog composes, whatever the export store holds", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        for (const composeStatus of ["idle", "failed"] as const) {
          const target = selectExportDialogTargetState(
            compose({ status: composeStatus }),
            { status, tracking, error: null },
          );
          expect(isExportRunLive(target)).toBe(false);
        }
      }
    }
  });
});

describe("the frame rules in the compose state", () => {
  const frameOf = (state: Pick<ExportComposeState, "status" | "error">) => {
    const target = selectExportDialogTargetState(compose(state), LIVE_RUN);
    const footer = resolveExportDialogFooter(target);
    return {
      step: resolveExportDialogStep(target.status),
      footer,
      title: resolveExportDialogTitleKey(footer),
    };
  };

  it("shows the setup step for an idle compose store, beside a live run", () => {
    expect(frameOf({ status: "idle", error: null })).toStrictEqual({
      step: "setup",
      footer: "setup",
      title: "export.title",
    });
  });

  it("shows the confirmation for a source revision change", () => {
    const error = new ExportError({ code: "sourceRevisionChanged" });
    expect(frameOf({ status: "failed", error })).toStrictEqual({
      step: "result",
      footer: "confirmation",
      title: "export.sourceChanged.title",
    });
  });

  it("shows the result for every other failure, and never the run footer", () => {
    for (const code of EXPORT_ERROR_CODES) {
      if (code === "sourceRevisionChanged" || code === "canceled") {
        continue;
      }
      const error = new ExportError({ code });
      expect(frameOf({ status: "failed", error })).toStrictEqual({
        step: "result",
        footer: "result",
        title: "export.title",
      });
    }
  });

  it("offers Back for a failure of the compose state", () => {
    const target = selectExportDialogTargetState(
      compose({ status: "failed", error: new ExportError({ code: "noSegments" }) }),
      LIVE_RUN,
    );
    expect(canGoBackToSetup(target)).toBe(true);
  });
});

describe("resolveComposeExit", () => {
  it("closes the dialog on a dismissal, in every status of the export store", () => {
    for (const status of EXPORT_STATUSES) {
      expect(resolveComposeExit("dismiss", { status })).toBe("closeDialog");
    }
  });

  it("goes back to the run view on Cancel while the export store has a run or a result", () => {
    for (const status of EXPORT_STATUSES.filter((entry) => entry !== "idle")) {
      expect(resolveComposeExit("cancel", { status })).toBe("showRun");
    }
  });

  it("closes the dialog on Cancel while the export store is idle", () => {
    expect(resolveComposeExit("cancel", { status: "idle" })).toBe("closeDialog");
  });
});

describe("addsToQueue", () => {
  const idle = { status: "idle", tracking: false } as const;
  const empty = { waiting: [], submitting: 0 };

  it("is false with no live run and no pending work", () => {
    expect(addsToQueue({ exportState: idle, queue: empty, ownSubmission: false })).toBe(
      false,
    );
  });

  it("follows isExportRunLive of the export store", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        expect(
          addsToQueue({
            exportState: { status, tracking },
            queue: empty,
            ownSubmission: false,
          }),
        ).toBe(isExportRunLive({ status, tracking }));
      }
    }
  });

  it("is true while runs wait", () => {
    expect(
      addsToQueue({
        exportState: idle,
        queue: { waiting: ["run-2"], submitting: 0 },
        ownSubmission: true,
      }),
    ).toBe(true);
  });

  it("is true while another submission has no answer", () => {
    expect(
      addsToQueue({
        exportState: idle,
        queue: { waiting: [], submitting: 1 },
        ownSubmission: false,
      }),
    ).toBe(true);
    expect(
      addsToQueue({
        exportState: idle,
        queue: { waiting: [], submitting: 2 },
        ownSubmission: true,
      }),
    ).toBe(true);
  });

  it("does not count the submission of the setup step itself", () => {
    // The step submits its first export, so the label must not change to Add to Queue.
    expect(
      addsToQueue({
        exportState: idle,
        queue: { waiting: [], submitting: 1 },
        ownSubmission: true,
      }),
    ).toBe(false);
  });
});

describe("resolveSetupConfirmLabelKey", () => {
  it("reads Add to Queue for an export that joins the queue, and Export otherwise", () => {
    expect(resolveSetupConfirmLabelKey(true)).toBe("export.action.addToQueue");
    expect(resolveSetupConfirmLabelKey(false)).toBe("export.action.chooseDestination");
  });
});

describe("resolveExportCloseLabelKey", () => {
  it("says that a live run continues, and else reads Close", () => {
    expect(resolveExportCloseLabelKey(true)).toBe("export.action.hide");
    expect(resolveExportCloseLabelKey(false)).toBe("common.close");
  });
});

describe("showsNewExportAction", () => {
  it("shows New Export only while the run footer shows no note of Stop Export", () => {
    expect(showsNewExportAction(null)).toBe(true);
    expect(showsNewExportAction("export.status.stopUnavailable")).toBe(false);
  });
});

describe("the compose keys", () => {
  it("name a message in both catalogs", () => {
    for (const key of [
      "export.action.addToQueue",
      "export.action.newExport",
      "export.setup.queueNote",
      "export.action.chooseDestination",
      "export.action.hide",
      "common.close",
    ]) {
      expect(typeof lookup(en, key)).toBe("string");
      expect(typeof lookup(zhCN, key)).toBe("string");
    }
  });
});
