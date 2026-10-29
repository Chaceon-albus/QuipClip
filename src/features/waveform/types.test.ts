import { describe, expect, it } from "vitest";
import { WAVEFORM_BUCKET_RATE, WAVEFORM_MAX_BUCKETS, WaveformError } from "./types";

describe("the envelope constants", () => {
  it("holds 100 buckets each second and 72 hours at most", () => {
    expect(WAVEFORM_BUCKET_RATE).toBe(100);
    expect(WAVEFORM_MAX_BUCKETS).toBe(25_920_000);
  });
});

describe("WaveformError", () => {
  it("keeps the code and the detail", () => {
    const error = new WaveformError("readFailed", "EIO");
    expect(error).toBeInstanceOf(WaveformError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("readFailed");
    expect(error.detail).toBe("EIO");
    expect(error.message).toBe("readFailed: EIO");
    expect(new WaveformError("busy").message).toBe("busy");
  });
});
