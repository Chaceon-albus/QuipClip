import { describe, expect, it } from "vitest";
import { WaveformBuffer } from "./buffer";
import {
  codeToDbfs,
  drawEnvelope,
  ENVELOPE_HEIGHT_TABLE,
  type EnvelopeContext,
} from "./envelopeRender";
import type { WaveformPlan } from "./geometry";

class FakeContext implements EnvelopeContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  globalAlpha = 1;
  readonly calls: string[] = [];

  fillRect(x: number, y: number, width: number, height: number): void {
    const style = typeof this.fillStyle === "string" ? this.fillStyle : "object";
    this.calls.push(`fill ${style} ${this.globalAlpha} ${x} ${y} ${width} ${height}`);
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.calls.push(`clear ${x} ${y} ${width} ${height}`);
  }
}

describe("the height table", () => {
  it("maps codes on a dB scale with a floor of -54 dBFS", () => {
    expect(codeToDbfs(255)).toBe(0);
    expect(ENVELOPE_HEIGHT_TABLE[0]).toBe(0);
    expect(ENVELOPE_HEIGHT_TABLE[1]).toBe(0);
    expect(ENVELOPE_HEIGHT_TABLE[39]).toBe(0);
    expect(ENVELOPE_HEIGHT_TABLE[40]).toBeGreaterThan(0);
    expect(ENVELOPE_HEIGHT_TABLE[255]).toBe(1);
    // -27 dBFS is half the scale: code (63.75 - 27) × 4 = 147.
    expect(ENVELOPE_HEIGHT_TABLE[147]).toBeCloseTo(0.5, 6);
    for (let code = 40; code < 256; code++) {
      expect(ENVELOPE_HEIGHT_TABLE[code]).toBeGreaterThan(
        ENVELOPE_HEIGHT_TABLE[code - 1] ?? 0,
      );
    }
  });
});

describe("drawEnvelope", () => {
  it("draws the peak then the RMS of each column about the centre", () => {
    const buffer = new WaveformBuffer();
    // Buckets: peak 255 / RMS 147, then silence, then peak 147 / RMS 0.
    buffer.write(0, new Uint8Array([255, 147, 0, 0, 147, 0, 100, 20]));
    const plan: WaveformPlan = {
      canvasLeftPx: 0,
      widthDevicePx: 10,
      dpr: 1,
      clips: [
        {
          clipId: "c1",
          sourceId: "s1",
          firstColumn: 4,
          bucketStarts: new Uint32Array([0, 1, 2, 4]),
          bucketEnds: new Uint32Array([1, 2, 4, 4]),
        },
      ],
    };
    const ctx = new FakeContext();
    drawEnvelope(ctx, plan, (id) => (id === "s1" ? buffer : undefined), {
      heightPx: 40,
      peakColor: "light",
      rmsColor: "dark",
      alpha: 0.5,
    });
    expect(ctx.calls).toEqual([
      "clear 0 0 10 40",
      // Column 4: the full peak, and the RMS at half.
      "fill light 0.5 4 0 1 40",
      // Column 6: buckets 2..4, the highest peak is 147.
      "fill light 0.5 6 10 1 20",
      "fill dark 0.5 4 10 1 20",
    ]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("skips a source with no buffer and clears a canvas of no height", () => {
    const plan: WaveformPlan = {
      canvasLeftPx: 0,
      widthDevicePx: 3,
      dpr: 1,
      clips: [
        {
          clipId: "c1",
          sourceId: "s1",
          firstColumn: 0,
          bucketStarts: new Uint32Array([0]),
          bucketEnds: new Uint32Array([1]),
        },
      ],
    };
    const ctx = new FakeContext();
    const style = { heightPx: 10, peakColor: "a", rmsColor: "b", alpha: 1 };
    drawEnvelope(ctx, plan, () => undefined, style);
    expect(ctx.calls).toEqual(["clear 0 0 3 10"]);
    const flat = new FakeContext();
    drawEnvelope(flat, plan, () => undefined, { ...style, heightPx: 0 });
    expect(flat.calls).toEqual(["clear 0 0 3 0"]);
  });
});
