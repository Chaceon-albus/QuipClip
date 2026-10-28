import { describe, expect, it } from "vitest";
import {
  ExportError,
  ExportOutputError,
  NO_EXPORT_OUTPUT_ACTION,
  selectExportQueueRows,
  type ExportOutputActionState,
  type ExportQueueJob,
  type ExportQueueRow,
  type ExportQueueState,
  type ExportState,
} from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { presentExportQueue, type ExportQueueViewInput } from "./exportQueuePresenter";

/** Walks a dotted key through a nested catalog, the way i18next does. */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function job(
  runId: string,
  outputPath = `/Users/me/Movies/${runId}.mp4`,
): ExportQueueJob {
  return {
    runId,
    outputPath,
    presetName: `Preset ${runId}`,
    segmentCount: 2,
    streams: "videoAndAudio",
  };
}

type QueueSlice = Pick<
  ExportQueueState,
  "jobs" | "order" | "waiting" | "ended" | "removing"
>;

/** A batch of the runs `ids`, all of them waiting until a test changes that. */
function queue(ids: string[], overrides: Partial<QueueSlice> = {}): QueueSlice {
  return {
    jobs: Object.fromEntries(ids.map((id) => [id, job(id)])),
    order: ids,
    waiting: ids,
    ended: [],
    removing: [],
    ...overrides,
  };
}

type ExportSlice = Pick<ExportState, "status" | "tracking" | "error" | "runId">;

function exportState(overrides: Partial<ExportSlice> = {}): ExportSlice {
  return { status: "running", tracking: true, error: null, runId: null, ...overrides };
}

const NO_ACTIONS: ExportOutputActionState = { runs: {} };

function present(
  q: QueueSlice,
  e: ExportSlice,
  outputActions: ExportOutputActionState = NO_ACTIONS,
) {
  const input: ExportQueueViewInput = {
    rows: selectExportQueueRows(q, e),
    batchSize: q.order.length,
    exportState: e,
    outputActions,
  };
  return presentExportQueue(input);
}

describe("presentExportQueue", () => {
  it("hides the list for a batch of one run", () => {
    const q = queue(["a"], { waiting: [] });
    expect(present(q, exportState({ runId: "a" }))).toBeNull();
  });

  it("hides the list for an empty batch", () => {
    expect(present(queue([]), exportState())).toBeNull();
  });

  it("hides the list when no row has a phase", () => {
    const input: ExportQueueViewInput = {
      rows: [],
      batchSize: 2,
      exportState: exportState(),
      outputActions: NO_ACTIONS,
    };
    expect(presentExportQueue(input)).toBeNull();
  });

  it("lists the rows in the order of submission, keyed by run id", () => {
    const q = queue(["a", "b", "c"], {
      waiting: ["c"],
      ended: [{ runId: "a", status: "finished", error: null }],
    });
    const view = present(q, exportState({ runId: "b" }));
    expect(view?.rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(view?.rows.map((row) => row.runId)).toEqual(["a", "b", "c"]);
    expect(view?.rows.map((row) => row.statusKey)).toEqual([
      "export.queue.status.finished",
      "export.queue.status.current",
      "export.queue.status.waiting",
    ]);
    expect(view?.rows.map((row) => row.current)).toEqual([false, true, false]);
  });

  it("shows the file name, the folder, and the preset name of the job", () => {
    const q = queue(["a", "b"]);
    q.jobs.a = job("a", "/Users/me/Movies/final cut.v2.mov");
    const row = present(q, exportState())?.rows[0];
    expect(row).toMatchObject({
      fileName: "final cut.v2.mov",
      fileStem: "final cut.v2",
      fileExtension: ".mov",
      fullPath: "/Users/me/Movies/final cut.v2.mov",
      folderName: "Movies",
      presetName: "Preset a",
    });
  });

  it("splits a Windows path", () => {
    const q = queue(["a", "b"]);
    q.jobs.a = job("a", "C:\\Videos\\out.mp4");
    expect(present(q, exportState())?.rows[0]).toMatchObject({
      fileName: "out.mp4",
      folderName: "Videos",
    });
  });

  it("keeps the whole path as the name of a path with no segment", () => {
    const q = queue(["a", "b"]);
    q.jobs.a = job("a", "/");
    expect(present(q, exportState())?.rows[0]).toMatchObject({
      fileName: "/",
      fileStem: "/",
      fileExtension: "",
      folderName: null,
    });
  });

  describe("the current row", () => {
    const q = queue(["a", "b"], { waiting: ["b"] });

    it.each(["preparing", "running", "publishing"] as const)(
      "says that it exports while %s",
      (status) => {
        const row = present(q, exportState({ runId: "a", status }))?.rows[0];
        expect(row).toMatchObject({
          statusKey: "export.queue.status.current",
          current: true,
          show: null,
          canRemove: false,
          error: null,
        });
      },
    );

    it("says that it exports after a failed Stop request, while the store tracks it", () => {
      const error = new ExportError({ code: "unknown", detail: "ipc" });
      const row = present(
        q,
        exportState({ runId: "a", status: "failed", tracking: true, error }),
      )?.rows[0];
      expect(row).toMatchObject({
        statusKey: "export.queue.status.current",
        error: null,
      });
    });

    // The run panel and the footer above the list show this run with its Show File and its
    // failure, so the current row repeats neither.
    it("shows the end of the last run that the export store keeps, and nothing more", () => {
      const ended = queue(["a", "b"], {
        waiting: [],
        ended: [{ runId: "a", status: "finished", error: null }],
      });
      const finished = present(
        ended,
        exportState({ runId: "b", status: "finished", tracking: false }),
        { runs: { b: { pending: true, error: null } } },
      )?.rows[1];
      expect(finished).toMatchObject({
        statusKey: "export.queue.status.finished",
        current: true,
        show: null,
        error: null,
      });

      const failed = present(
        ended,
        exportState({
          runId: "b",
          status: "failed",
          tracking: false,
          error: new ExportError({ code: "ffmpegProcessFailed" }),
        }),
      )?.rows[1];
      expect(failed).toMatchObject({
        statusKey: "export.queue.status.failed",
        current: true,
        show: null,
        error: null,
      });

      const canceled = present(
        ended,
        exportState({
          runId: "b",
          status: "canceled",
          tracking: false,
          error: new ExportError({ code: "canceled" }),
        }),
      )?.rows[1];
      expect(canceled).toMatchObject({
        statusKey: "export.queue.status.canceled",
        show: null,
        error: null,
      });
    });
  });

  describe("an ended row", () => {
    function endedRow(ended: ExportQueueState["ended"][number]) {
      const q = queue(["a", "b"], { waiting: [], ended: [ended] });
      return present(q, exportState({ runId: "b" }))?.rows[0];
    }

    it("offers Show File when it finished", () => {
      expect(endedRow({ runId: "a", status: "finished", error: null })).toMatchObject({
        statusKey: "export.queue.status.finished",
        current: false,
        show: { pending: false, errorKey: null, errorDetail: null },
        canRemove: false,
        error: null,
      });
    });

    it("gives the message key of the error code when it failed", () => {
      const row = endedRow({
        runId: "a",
        status: "failed",
        error: new ExportError({ code: "outputNotWritable", detail: "EACCES" }),
      });
      expect(row).toMatchObject({
        statusKey: "export.queue.status.failed",
        show: null,
        error: { key: "exportError.outputNotWritable" },
      });
    });

    it("gives the unknown message for a failure with no error", () => {
      expect(endedRow({ runId: "a", status: "failed", error: null })?.error).toEqual({
        key: "exportError.unknown",
      });
    });

    it("gives the unknown message for a code absent from the catalog", () => {
      const error = new ExportError({ code: "unknown" });
      (error as { code: string }).code = "notACode";
      expect(endedRow({ runId: "a", status: "failed", error })?.error).toEqual({
        key: "exportError.unknown",
      });
    });

    it("says stopped, not failed, for the canceled code", () => {
      const row = endedRow({
        runId: "a",
        status: "failed",
        error: new ExportError({ code: "canceled" }),
      });
      expect(row).toMatchObject({
        statusKey: "export.queue.status.canceled",
        error: null,
      });
      expect(endedRow({ runId: "a", status: "canceled", error: null })).toMatchObject({
        statusKey: "export.queue.status.canceled",
        error: null,
      });
    });
  });

  describe("Show File", () => {
    const q = queue(["a", "b", "c"], {
      waiting: [],
      ended: [
        { runId: "a", status: "finished", error: null },
        { runId: "b", status: "finished", error: null },
      ],
    });
    const state = exportState({ runId: "c", status: "finished", tracking: false });

    it("reads the Show state of each run on its own", () => {
      const view = present(q, state, {
        runs: { a: { pending: true, error: null } },
      });
      expect(view?.rows[0].show).toEqual({
        pending: true,
        errorKey: null,
        errorDetail: null,
      });
      expect(view?.rows[1].show).toEqual({
        pending: false,
        errorKey: null,
        errorDetail: null,
      });
    });

    it("is never offered on the current row, which the footer serves", () => {
      const view = present(q, state, {
        runs: {
          c: {
            pending: false,
            error: new ExportOutputError("outputMissing", "ENOENT"),
          },
        },
      });
      expect(view?.rows[2]).toMatchObject({
        statusKey: "export.queue.status.finished",
        current: true,
        show: null,
      });
    });

    it("gives the output error key and the detail of a failed request", () => {
      const view = present(q, state, {
        runs: {
          b: {
            pending: false,
            error: new ExportOutputError("outputMissing", "ENOENT"),
          },
        },
      });
      expect(view?.rows[1].show).toEqual({
        pending: false,
        errorKey: "exportOutputError.outputMissing",
        errorDetail: "ENOENT",
      });
    });

    it("drops an empty detail", () => {
      const view = present(q, state, {
        runs: {
          b: { pending: false, error: new ExportOutputError("revealFailed", "") },
        },
      });
      expect(view?.rows[1].show?.errorDetail).toBeNull();
    });

    it("ignores the Show state of a row that did not finish", () => {
      const waiting = queue(["a", "b"], { waiting: ["b"] });
      const view = present(waiting, exportState({ runId: "a" }), {
        runs: { b: NO_EXPORT_OUTPUT_ACTION, a: { pending: true, error: null } },
      });
      expect(view?.rows.map((row) => row.show)).toEqual([null, null]);
    });
  });

  describe("Remove", () => {
    it("is offered on a waiting row", () => {
      const view = present(
        queue(["a", "b"], { waiting: ["b"] }),
        exportState({ runId: "a" }),
      );
      expect(view?.rows[1]).toMatchObject({ canRemove: true, removing: false });
    });

    it("is disabled while the backend cancels the run", () => {
      const view = present(
        queue(["a", "b"], { waiting: ["b"], removing: ["b"] }),
        exportState({ runId: "a" }),
      );
      expect(view?.rows[1]).toMatchObject({
        statusKey: "export.queue.status.waiting",
        canRemove: false,
        removing: true,
      });
    });

    it("is never offered on a row that does not wait", () => {
      const view = present(
        queue(["a", "b"], {
          waiting: [],
          removing: ["a"],
          ended: [{ runId: "a", status: "canceled", error: null }],
        }),
        exportState({ runId: "b" }),
      );
      expect(view?.rows.map((row) => [row.canRemove, row.removing])).toEqual([
        [false, false],
        [false, false],
      ]);
    });
  });

  it("accepts rows that the caller built", () => {
    const rows: ExportQueueRow[] = [
      { runId: "a", job: job("a"), phase: "waiting", ended: null, removing: false },
      { runId: "b", job: job("b"), phase: "waiting", ended: null, removing: false },
    ];
    const view = presentExportQueue({
      rows,
      batchSize: 2,
      exportState: exportState(),
      outputActions: NO_ACTIONS,
    });
    expect(view?.rows).toHaveLength(2);
  });
});

describe("the queue catalog keys", () => {
  const keys = [
    "export.queue.heading",
    "export.queue.status.waiting",
    "export.queue.status.current",
    "export.queue.status.finished",
    "export.queue.status.failed",
    "export.queue.status.canceled",
    "export.queue.remove",
    "export.queue.removeNamed",
  ];

  it.each(keys)("%s exists in both catalogs", (key) => {
    expect(typeof resolveCatalogKey(en, key)).toBe("string");
    expect(typeof resolveCatalogKey(zhCN, key)).toBe("string");
  });

  it("names the run in the accessible name of Remove", () => {
    expect(resolveCatalogKey(en, "export.queue.removeNamed")).toContain("{{name}}");
    expect(resolveCatalogKey(zhCN, "export.queue.removeNamed")).toContain("{{name}}");
  });
});
