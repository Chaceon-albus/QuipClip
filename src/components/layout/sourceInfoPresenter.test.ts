import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import { presentSourceInfo, type SourceInfoProbe } from "./sourceInfoPresenter";

/**
 * Resolves a dotted translation key path against a nested catalog object, the way i18next
 * walks a namespaced key. Follows the convention of `playbackHintPresenter.test.ts`.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createProbe(overrides: Partial<SourceInfoProbe> = {}): SourceInfoProbe {
  return {
    width: 1920,
    height: 1080,
    avgFrameRate: { n: 30000, d: 1001 },
    rFrameRate: { n: 30000, d: 1001 },
    ...overrides,
  };
}

// The status bar formats the rate with at most three fraction digits.
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });

describe("presentSourceInfo", () => {
  it("returns null while no source is open, so no default frame size is shown", () => {
    expect(presentSourceInfo(null, number)).toBeNull();
  });

  it("presents the frame size and the average frame rate", () => {
    expect(presentSourceInfo(createProbe(), number)).toStrictEqual({
      lineKey: "statusBar.source.summary",
      lineValues: { width: "1920", height: "1080", fps: "29.97" },
      detail: [
        {
          key: "statusBar.source.resolution",
          values: { width: "1920", height: "1080" },
        },
        { key: "statusBar.source.rateAverage", values: { fps: "29.97" } },
      ],
    });
  });

  it("never groups the digits of the frame size", () => {
    const view = presentSourceInfo(
      createProbe({ width: 7680, height: 4320 }),
      new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }),
    );

    expect(view?.lineValues).toMatchObject({ width: "7680", height: "4320" });
  });

  it("formats the frame rate with the injected formatter", () => {
    const view = presentSourceInfo(
      createProbe({ avgFrameRate: { n: 24000, d: 1001 } }),
      new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }),
    );

    expect(view?.lineValues.fps).toBe("23,976");
  });

  it("falls back to r_frame_rate and names that field when avg_frame_rate is absent", () => {
    const view = presentSourceInfo(
      createProbe({ avgFrameRate: null, rFrameRate: { n: 25, d: 1 } }),
      number,
    );

    expect(view?.lineKey).toBe("statusBar.source.summary");
    expect(view?.lineValues.fps).toBe("25");
    expect(view?.detail[1]).toStrictEqual({
      key: "statusBar.source.rateReal",
      values: { fps: "25" },
    });
  });

  it("falls back to r_frame_rate when avg_frame_rate is not a valid rate", () => {
    const view = presentSourceInfo(
      createProbe({ avgFrameRate: { n: 0, d: 1 }, rFrameRate: { n: 50, d: 1 } }),
      number,
    );

    expect(view?.detail[1]?.key).toBe("statusBar.source.rateReal");
    expect(view?.lineValues.fps).toBe("50");
  });

  it("shows the frame size only when neither rate is valid", () => {
    expect(
      presentSourceInfo(createProbe({ avgFrameRate: null, rFrameRate: null }), number),
    ).toStrictEqual({
      lineKey: "statusBar.source.summaryNoRate",
      lineValues: { width: "1920", height: "1080" },
      detail: [
        {
          key: "statusBar.source.resolution",
          values: { width: "1920", height: "1080" },
        },
        { key: "statusBar.source.rateUnavailable", values: {} },
      ],
    });
  });

  // Every key this presenter can emit must resolve to a non-empty string in the English
  // catalog, so a renamed or deleted message fails here instead of rendering a raw key.
  describe("catalog coverage", () => {
    const emittedKeys = [
      "statusBar.source.summary",
      "statusBar.source.summaryNoRate",
      "statusBar.source.resolution",
      "statusBar.source.rateAverage",
      "statusBar.source.rateReal",
      "statusBar.source.rateUnavailable",
    ];

    it.each(emittedKeys)(
      "resolves key '%s' to a non-empty string in the English catalog",
      (key) => {
        const resolved = resolveCatalogKey(en, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      },
    );
  });
});
