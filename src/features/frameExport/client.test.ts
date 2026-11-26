import { describe, expect, it, vi } from "vitest";
import type { InvokeFn } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import { exportFrame, normalizeFrameExportError } from "./client";
import type { FrameExportRequest } from "./types";

const REQUEST: FrameExportRequest = {
  sourcePath: "/media/clip.mp4",
  sourceRevision: { size: 10, mtime: 20 },
  pts: "9007199254740993" as Pts,
  sessionSourcePaths: ["/media/clip.mp4"],
  outputPath: "/out/clip_00-00-01-000.png",
};

/**
 * An invoke that answers `answer`, or rejects with it when `reject` is true. Tauri rejects with
 * the plain object that the Rust command returned, not with an `Error`.
 */
function invokeAnswering(answer: unknown, reject = false) {
  const invoke = vi.fn((..._args: unknown[]): Promise<unknown> =>
    Promise.resolve(answer),
  );
  if (reject) {
    invoke.mockRejectedValue(answer);
  }
  return invoke;
}

describe("exportFrame (ADR 069)", () => {
  it("sends the request to export_frame, with the PTS as a string", async () => {
    const invoke = invokeAnswering({ outputPath: "/out/a.png" });
    await exportFrame(REQUEST, invoke as unknown as InvokeFn);
    expect(invoke).toHaveBeenCalledWith("export_frame", { request: REQUEST });
  });

  it("answers with the path that Rust wrote", async () => {
    const invoke = invokeAnswering({ outputPath: "/out/a.png" });
    expect(await exportFrame(REQUEST, invoke as unknown as InvokeFn)).toEqual({
      kind: "done",
      outputPath: "/out/a.png",
    });
  });

  it("answers invalidResponse for an answer of the wrong shape", async () => {
    for (const answer of [null, {}, { outputPath: "" }, { outputPath: 1 }, "a.png"]) {
      const invoke = invokeAnswering(answer);
      expect(await exportFrame(REQUEST, invoke as unknown as InvokeFn)).toEqual({
        kind: "failed",
        failure: { code: "invalidResponse", detail: null },
      });
    }
  });

  it("answers the failure of a rejection instead of throwing", async () => {
    const invoke = invokeAnswering(
      { code: "ffmpegProcessFailed", detail: "tail", exitCode: 1 },
      true,
    );
    expect(await exportFrame(REQUEST, invoke as unknown as InvokeFn)).toEqual({
      kind: "failed",
      failure: { code: "ffmpegProcessFailed", detail: "tail" },
    });
  });
});

describe("normalizeFrameExportError", () => {
  it("keeps a code of Rust and its detail", () => {
    expect(normalizeFrameExportError({ code: "outputNotPng" })).toEqual({
      code: "outputNotPng",
      detail: null,
    });
    expect(normalizeFrameExportError({ code: "noFrame", detail: "" })).toEqual({
      code: "noFrame",
      detail: null,
    });
  });

  it("reads anything else as unknown, with no detail", () => {
    // A code of the page is not a code that Rust sends.
    expect(normalizeFrameExportError({ code: "dialogFailed" })).toEqual({
      code: "unknown",
      detail: null,
    });
    expect(
      normalizeFrameExportError(new Error("command export_frame not allowed")),
    ).toEqual({
      code: "unknown",
      detail: null,
    });
    expect(normalizeFrameExportError("text")).toEqual({
      code: "unknown",
      detail: null,
    });
    expect(normalizeFrameExportError(null)).toEqual({ code: "unknown", detail: null });
  });
});
