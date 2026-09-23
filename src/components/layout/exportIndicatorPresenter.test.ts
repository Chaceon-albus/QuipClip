import { describe, expect, it } from "vitest";
import type { ExportStatus } from "@/features/export";
import type { ExportIndicatorInput } from "./exportIndicatorPresenter";
import { outputNameOf, presentExportIndicator } from "./exportIndicatorPresenter";

function createInput(
  overrides: Partial<ExportIndicatorInput> = {},
): ExportIndicatorInput {
  return {
    status: "running",
    frame: 50,
    expectedFrames: 100,
    fps: { n: 25, d: 1 },
    speed: { n: 1, d: 1 },
    cancelRequested: false,
    panelOpen: false,
    outputPath: "/path/to/exported_video.mp4",
    ...overrides,
  };
}

describe("outputNameOf", () => {
  it("returns null for null", () => {
    expect(outputNameOf(null)).toBeNull();
  });

  it("returns null for empty string or only separators", () => {
    expect(outputNameOf("")).toBeNull();
    expect(outputNameOf("/")).toBeNull();
    expect(outputNameOf("\\")).toBeNull();
    expect(outputNameOf("///")).toBeNull();
    expect(outputNameOf("\\\\\\")).toBeNull();
    expect(outputNameOf("/\\//")).toBeNull();
  });

  it("extracts the last segment of a POSIX path", () => {
    expect(outputNameOf("/home/user/videos/clip.mp4")).toBe("clip.mp4");
    expect(outputNameOf("relative/path/clip.mov")).toBe("clip.mov");
  });

  it("extracts the last segment of a Windows path", () => {
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv")).toBe("output.mkv");
    expect(outputNameOf("D:\\exports\\final.mp4")).toBe("final.mp4");
  });

  it("handles a trailing separator correctly", () => {
    expect(outputNameOf("/home/user/videos/clip.mp4/")).toBe("clip.mp4");
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv\\")).toBe("output.mkv");
    expect(outputNameOf("C:\\Users\\user\\Videos\\output.mkv\\\\")).toBe("output.mkv");
  });

  it("handles a single segment without separators", () => {
    expect(outputNameOf("output.mp4")).toBe("output.mp4");
  });
});

describe("presentExportIndicator", () => {
  describe("panel open hides every status", () => {
    const statuses: ExportStatus[] = [
      "idle",
      "preparing",
      "running",
      "publishing",
      "finished",
      "failed",
      "canceled",
    ];

    for (const status of statuses) {
      it(`returns null when panelOpen is true for ${status}`, () => {
        expect(
          presentExportIndicator(
            createInput({
              status,
              panelOpen: true,
            }),
          ),
        ).toBeNull();
      });
    }
  });

  describe("idle hides", () => {
    it("returns null when status is idle even if panelOpen is false", () => {
      expect(
        presentExportIndicator(
          createInput({
            status: "idle",
            panelOpen: false,
          }),
        ),
      ).toBeNull();
    });
  });

  describe("each active status", () => {
    it("returns active view for preparing status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "preparing",
          outputPath: "/exports/my_video.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("my_video.mp4");
        expect(view.progress.phase).toBe("preparing");
        expect(view.progress.basePhase).toBe("preparing");
        expect(view.progress.barValue).toBeNull();
      }
    });

    it("returns active view for running status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "running",
          frame: 50,
          expectedFrames: 100,
          outputPath: "C:\\videos\\render.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("render.mp4");
        expect(view.progress.phase).toBe("running");
        expect(view.progress.basePhase).toBe("running");
        expect(view.progress.barValue).toBe(50);
        expect(view.progress.percentFraction).toBe(0.5);
      }
    });

    it("returns active view for publishing status", () => {
      const view = presentExportIndicator(
        createInput({
          status: "publishing",
          frame: 100,
          expectedFrames: 100,
          outputPath: "/output.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("output.mp4");
        expect(view.progress.phase).toBe("publishing");
        expect(view.progress.basePhase).toBe("publishing");
        expect(view.progress.barValue).toBe(100);
        expect(view.progress.percentFraction).toBe(1);
      }
    });

    it("returns active view with canceling phase when cancelRequested is true in running", () => {
      const view = presentExportIndicator(
        createInput({
          status: "running",
          cancelRequested: true,
          frame: 50,
          expectedFrames: 100,
          outputPath: "C:\\videos\\render.mp4",
        }),
      );

      expect(view?.kind).toBe("active");
      if (view?.kind === "active") {
        expect(view.outputName).toBe("render.mp4");
        expect(view.progress.phase).toBe("canceling");
        expect(view.progress.basePhase).toBe("running");
      }
    });
  });

  describe("each final status", () => {
    it("returns finished view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "finished",
          outputPath: "/videos/complete.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "finished",
        outputName: "complete.mp4",
      });
    });

    it("returns failed view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "failed",
          outputPath: "C:\\videos\\error.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "failed",
        outputName: "error.mp4",
      });
    });

    it("returns canceled view with outputName", () => {
      const view = presentExportIndicator(
        createInput({
          status: "canceled",
          outputPath: "/videos/aborted.mp4",
        }),
      );

      expect(view).toEqual({
        kind: "canceled",
        outputName: "aborted.mp4",
      });
    });

    it("returns null outputName when outputPath is null", () => {
      const view = presentExportIndicator(
        createInput({
          status: "finished",
          outputPath: null,
        }),
      );

      expect(view).toEqual({
        kind: "finished",
        outputName: null,
      });
    });
  });
});
