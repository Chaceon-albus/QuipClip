import { describe, expect, it } from "vitest";
import type { ExportProgressInput } from "./exportProgressPresenter";
import { formatRemaining, presentExportProgress } from "./exportProgressPresenter";

function createInput(
  overrides: Partial<ExportProgressInput> = {},
): ExportProgressInput {
  return {
    status: "running",
    frame: 100,
    expectedFrames: 1000,
    fps: { n: 30, d: 1 },
    speed: { n: 3, d: 2 },
    cancelRequested: false,
    ...overrides,
  };
}

describe("presentExportProgress", () => {
  describe("every status", () => {
    it("returns null for idle status", () => {
      expect(presentExportProgress(createInput({ status: "idle" }))).toBeNull();
    });

    it("returns null for finished status", () => {
      expect(presentExportProgress(createInput({ status: "finished" }))).toBeNull();
    });

    it("returns null for failed status", () => {
      expect(presentExportProgress(createInput({ status: "failed" }))).toBeNull();
    });

    it("returns null for canceled status", () => {
      expect(presentExportProgress(createInput({ status: "canceled" }))).toBeNull();
    });

    it("returns view for preparing status with indeterminate bar and no percent or time", () => {
      const view = presentExportProgress(
        createInput({
          status: "preparing",
          frame: null,
          expectedFrames: 500,
        }),
      );

      expect(view).toEqual({
        phase: "preparing",
        basePhase: "preparing",
        barValue: null,
        percentFraction: null,
        remainingSeconds: null,
        speed: 1.5,
        frame: null,
        expectedFrames: 500,
      });
    });

    it("returns view for running status with computed progress and estimate", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 250,
          expectedFrames: 1000,
          fps: { n: 25, d: 1 },
          speed: { n: 1, d: 1 },
        }),
      );

      expect(view).toEqual({
        phase: "running",
        basePhase: "running",
        barValue: 25,
        percentFraction: 0.25,
        remainingSeconds: 30, // (1000 - 250) / 25 = 750 / 25 = 30
        speed: 1,
        frame: 250,
        expectedFrames: 1000,
      });
    });

    it("returns view for publishing status at 100 percent with no remaining time", () => {
      const view = presentExportProgress(
        createInput({
          status: "publishing",
          frame: 1000,
          expectedFrames: 1000,
          fps: { n: 30, d: 1 },
        }),
      );

      expect(view).toEqual({
        phase: "publishing",
        basePhase: "publishing",
        barValue: 100,
        percentFraction: 1,
        remainingSeconds: null,
        speed: 1.5,
        frame: 1000,
        expectedFrames: 1000,
      });
    });
  });

  describe("null and zero goals", () => {
    it("handles null expectedFrames by yielding indeterminate bar, null percent, and null remaining", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 50,
          expectedFrames: null,
        }),
      );

      expect(view).toEqual(
        expect.objectContaining({
          barValue: null,
          percentFraction: null,
          remainingSeconds: null,
        }),
      );
    });

    it("handles zero expectedFrames by yielding indeterminate bar, null percent, and null remaining", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 0,
          expectedFrames: 0,
        }),
      );

      expect(view).toEqual(
        expect.objectContaining({
          barValue: null,
          percentFraction: null,
          remainingSeconds: null,
        }),
      );
    });
  });

  describe("99 percent cap", () => {
    it("caps percentFraction at 0.99 while allowing barValue to reach 100", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 1000,
          expectedFrames: 1000,
        }),
      );

      expect(view?.barValue).toBe(100);
      expect(view?.percentFraction).toBe(0.99);
    });

    it("caps percentFraction at 0.99 when frame count exceeds expectedFrames", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 1050,
          expectedFrames: 1000,
        }),
      );

      expect(view?.barValue).toBe(105);
      expect(view?.percentFraction).toBe(0.99);
      expect(view?.remainingSeconds).toBe(0);
    });

    it("rounds down percentFraction so 99.9% becomes 0.99", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 999,
          expectedFrames: 1000,
        }),
      );

      expect(view?.percentFraction).toBe(0.99);
    });

    it("floors percentFraction so partial percentages do not round up", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 499,
          expectedFrames: 1000,
        }),
      );

      expect(view?.percentFraction).toBe(0.49);
    });
  });

  describe("integer percentage calculation", () => {
    it("avoids floating-point error on exact whole percentages", () => {
      expect(
        presentExportProgress(
          createInput({
            status: "running",
            frame: 29,
            expectedFrames: 100,
          }),
        )?.percentFraction,
      ).toBe(0.29);

      expect(
        presentExportProgress(
          createInput({
            status: "running",
            frame: 57,
            expectedFrames: 100,
          }),
        )?.percentFraction,
      ).toBe(0.57);

      expect(
        presentExportProgress(
          createInput({
            status: "running",
            frame: 290,
            expectedFrames: 1000,
          }),
        )?.percentFraction,
      ).toBe(0.29);

      expect(
        presentExportProgress(
          createInput({
            status: "running",
            frame: 570,
            expectedFrames: 1000,
          }),
        )?.percentFraction,
      ).toBe(0.57);

      expect(
        presentExportProgress(
          createInput({
            status: "running",
            frame: 145,
            expectedFrames: 250,
          }),
        )?.percentFraction,
      ).toBe(0.58);
    });

    it("sweeps every frame from 0 to 1000 for a goal of 1000", () => {
      for (let frame = 0; frame <= 1000; frame++) {
        const view = presentExportProgress(
          createInput({
            status: "running",
            frame,
            expectedFrames: 1000,
          }),
        );
        expect(Math.round((view?.percentFraction ?? 0) * 100)).toBe(
          Math.min(Math.floor(frame / 10), 99),
        );
      }
    });
  });

  describe("publishing at 100", () => {
    it("sets barValue to 100 and percentFraction to 1 regardless of frame counts", () => {
      const view = presentExportProgress(
        createInput({
          status: "publishing",
          frame: null,
          expectedFrames: null,
        }),
      );

      expect(view?.barValue).toBe(100);
      expect(view?.percentFraction).toBe(1);
    });
  });

  describe("canceling overlay", () => {
    it("overlays canceling phase on running without changing barValue, but clears remainingSeconds", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 500,
          expectedFrames: 1000,
          cancelRequested: true,
        }),
      );

      expect(view).toEqual({
        phase: "canceling",
        basePhase: "running",
        barValue: 50,
        percentFraction: 0.5,
        remainingSeconds: null,
        speed: 1.5,
        frame: 500,
        expectedFrames: 1000,
      });
    });

    it("overlays canceling phase on preparing", () => {
      const view = presentExportProgress(
        createInput({
          status: "preparing",
          cancelRequested: true,
        }),
      );

      expect(view?.phase).toBe("canceling");
      expect(view?.basePhase).toBe("preparing");
      expect(view?.barValue).toBeNull();
    });

    it("overlays canceling phase on publishing keeping 100 barValue", () => {
      const view = presentExportProgress(
        createInput({
          status: "publishing",
          cancelRequested: true,
        }),
      );

      expect(view?.phase).toBe("canceling");
      expect(view?.basePhase).toBe("publishing");
      expect(view?.barValue).toBe(100);
      expect(view?.percentFraction).toBe(1);
    });
  });

  describe("missing and zero fps", () => {
    it("returns null remainingSeconds when fps is null", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          fps: null,
        }),
      );

      expect(view?.remainingSeconds).toBeNull();
    });

    it("returns null remainingSeconds when fps is zero", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          fps: { n: 0, d: 1 },
        }),
      );

      expect(view?.remainingSeconds).toBeNull();
    });

    it("returns null remainingSeconds when fps is negative", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          fps: { n: -30, d: 1 },
        }),
      );

      expect(view?.remainingSeconds).toBeNull();
    });

    it("returns null remainingSeconds when frame is null", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: null,
          expectedFrames: 100,
        }),
      );

      expect(view?.remainingSeconds).toBeNull();
    });
  });

  describe("rounding up of the estimate", () => {
    it("rounds up fractional seconds using Math.ceil", () => {
      // (100 - 0) / 30 = 3.333... -> 4 seconds
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 0,
          expectedFrames: 100,
          fps: { n: 30, d: 1 },
        }),
      );

      expect(view?.remainingSeconds).toBe(4);
    });

    it("rounds up tiny remainder to a full second", () => {
      // (25 - 10) / 10 = 1.5 -> 2 seconds
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 10,
          expectedFrames: 25,
          fps: { n: 10, d: 1 },
        }),
      );

      expect(view?.remainingSeconds).toBe(2);
    });

    it("computes 0 when all frames have completed", () => {
      const view = presentExportProgress(
        createInput({
          status: "running",
          frame: 100,
          expectedFrames: 100,
          fps: { n: 30, d: 1 },
        }),
      );

      expect(view?.remainingSeconds).toBe(0);
    });
  });

  describe("speed handling", () => {
    it("returns null when speed is null", () => {
      const view = presentExportProgress(createInput({ speed: null }));
      expect(view?.speed).toBeNull();
    });

    it("returns null when speed is zero or negative", () => {
      expect(
        presentExportProgress(createInput({ speed: { n: 0, d: 1 } }))?.speed,
      ).toBeNull();
      expect(
        presentExportProgress(createInput({ speed: { n: -1, d: 1 } }))?.speed,
      ).toBeNull();
    });

    it("returns float speed when valid rational is provided", () => {
      expect(
        presentExportProgress(createInput({ speed: { n: 125, d: 100 } }))?.speed,
      ).toBe(1.25);
    });
  });
});

describe("formatRemaining", () => {
  it("formats 0 as '0:00'", () => {
    expect(formatRemaining(0)).toBe("0:00");
  });

  it("formats 59 as '0:59'", () => {
    expect(formatRemaining(59)).toBe("0:59");
  });

  it("formats 60 as '1:00'", () => {
    expect(formatRemaining(60)).toBe("1:00");
  });

  it("formats 3599 as '59:59'", () => {
    expect(formatRemaining(3599)).toBe("59:59");
  });

  it("formats 3600 as '1:00:00'", () => {
    expect(formatRemaining(3600)).toBe("1:00:00");
  });

  it("formats 3661 as '1:01:01'", () => {
    expect(formatRemaining(3661)).toBe("1:01:01");
  });

  it("formats a fraction by flooring seconds", () => {
    expect(formatRemaining(59.9)).toBe("0:59");
    expect(formatRemaining(3661.7)).toBe("1:01:01");
  });

  it("formats NaN as '0:00'", () => {
    expect(formatRemaining(Number.NaN)).toBe("0:00");
  });

  it("formats a negative value as '0:00'", () => {
    expect(formatRemaining(-1)).toBe("0:00");
    expect(formatRemaining(-3600)).toBe("0:00");
  });

  it("formats non-finite numbers as '0:00'", () => {
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatRemaining(Number.NEGATIVE_INFINITY)).toBe("0:00");
  });
});
