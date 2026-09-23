import { afterEach, describe, expect, it, vi } from "vitest";
import {
  glyphStrokeWidth,
  readDevicePixelRatio,
  subscribeDevicePixelRatio,
} from "./windowGlyphStroke";

/** The stroke width in device pixels. */
function devicePixels(devicePixelRatio: number): number {
  return glyphStrokeWidth(devicePixelRatio) * devicePixelRatio;
}

describe("glyphStrokeWidth", () => {
  it("is 1 CSS pixel at 100 % and at 200 %", () => {
    expect(glyphStrokeWidth(1)).toBe(1);
    expect(glyphStrokeWidth(2)).toBe(1);
  });

  it.each([
    [1, 1],
    [1.25, 1],
    [1.5, 2],
    [1.75, 2],
    [2, 2],
    [2.25, 2],
    [2.5, 3],
    [3, 3],
  ])("covers a whole number of device pixels at %s", (ratio, expected) => {
    expect(devicePixels(ratio)).toBeCloseTo(expected, 10);
  });

  it("covers at least one device pixel below 100 %", () => {
    expect(devicePixels(0.5)).toBeCloseTo(1, 10);
    expect(devicePixels(0.75)).toBeCloseTo(1, 10);
  });

  it("falls back to 1 CSS pixel for a ratio that is not usable", () => {
    expect(glyphStrokeWidth(0)).toBe(1);
    expect(glyphStrokeWidth(-1)).toBe(1);
    expect(glyphStrokeWidth(Number.NaN)).toBe(1);
    expect(glyphStrokeWidth(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

type ChangeListener = () => void;

/** A resolution query of the fake window. The test fires `change` on it. */
class FakeMediaQueryList {
  readonly listeners = new Set<ChangeListener>();

  constructor(readonly media: string) {}

  addEventListener(type: string, listener: ChangeListener): void {
    expect(type).toBe("change");
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: ChangeListener): void {
    expect(type).toBe("change");
    this.listeners.delete(listener);
  }

  fire(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** A window with a settable scale factor and a `matchMedia` that records each query. */
function stubWindow(devicePixelRatio: number) {
  const queries: FakeMediaQueryList[] = [];
  const fake = {
    devicePixelRatio,
    matchMedia: (media: string) => {
      const query = new FakeMediaQueryList(media);
      queries.push(query);
      return query;
    },
  };
  vi.stubGlobal("window", fake);
  return { fake, queries };
}

describe("readDevicePixelRatio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the scale factor of the window", () => {
    stubWindow(1.5);
    expect(readDevicePixelRatio()).toBe(1.5);
  });

  it("reads 1 when the window reports no scale factor", () => {
    stubWindow(0);
    expect(readDevicePixelRatio()).toBe(1);
  });
});

describe("subscribeDevicePixelRatio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listens to a resolution query for the current scale factor", () => {
    const { queries } = stubWindow(1.25);
    const unsubscribe = subscribeDevicePixelRatio(vi.fn());
    expect(queries.map((query) => query.media)).toEqual(["(resolution: 1.25dppx)"]);
    expect(queries[0]?.listeners.size).toBe(1);
    unsubscribe();
  });

  it("reports a change and moves to a query for the new scale factor", () => {
    const { fake, queries } = stubWindow(1);
    const onChange = vi.fn();
    const unsubscribe = subscribeDevicePixelRatio(onChange);

    fake.devicePixelRatio = 1.5;
    queries[0]?.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(queries.map((query) => query.media)).toEqual([
      "(resolution: 1dppx)",
      "(resolution: 1.5dppx)",
    ]);
    expect(queries[0]?.listeners.size).toBe(0);
    expect(queries[1]?.listeners.size).toBe(1);

    fake.devicePixelRatio = 2;
    queries[1]?.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(queries[2]?.media).toBe("(resolution: 2dppx)");
    expect(queries[1]?.listeners.size).toBe(0);
    expect(queries[2]?.listeners.size).toBe(1);
    unsubscribe();
  });

  it("removes the listener from the current query when it unsubscribes", () => {
    const { fake, queries } = stubWindow(1);
    const onChange = vi.fn();
    const unsubscribe = subscribeDevicePixelRatio(onChange);
    fake.devicePixelRatio = 1.25;
    queries[0]?.fire();

    unsubscribe();
    expect(queries.every((query) => query.listeners.size === 0)).toBe(true);
    // A later change on an old query no longer reports.
    queries[1]?.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
