import { describe, expect, it } from "vitest";
import {
  parseWaveformCacheCleared,
  parseWaveformCacheUsage,
  parseWaveformChunk,
  parseWaveformEnd,
  parseWaveformMessage,
  parseWaveformProgress,
  parseWaveformStartError,
  parseWaveformStarted,
  rawMessageBytes,
  toWaveformError,
} from "./protocol";
import { chunkBytes } from "./testSupport";
import { WaveformError } from "./types";

const END = {
  type: "end",
  status: "complete",
  code: null,
  detail: null,
  bucketCount: 120,
  cached: false,
  timestampsDecrease: true,
  damaged: false,
  truncated: true,
  alignmentUncertain: false,
};

describe("parseWaveformChunk", () => {
  it("reads the little-endian header and the pairs", () => {
    const chunk = parseWaveformChunk(chunkBytes(0x01020304, [10, 5, 200, 100]));
    expect(chunk?.startBucket).toBe(0x01020304);
    expect(chunk?.count).toBe(2);
    expect([...(chunk?.pairs ?? [])]).toEqual([10, 5, 200, 100]);
  });

  it("reads an empty message", () => {
    expect(parseWaveformChunk(chunkBytes(7, []))).toMatchObject({
      startBucket: 7,
      count: 0,
    });
  });

  it("refuses a short header", () => {
    expect(parseWaveformChunk(new Uint8Array(7))).toBeNull();
  });

  it("refuses a length that disagrees with the count", () => {
    const bytes = chunkBytes(0, [1, 2, 3, 4]);
    expect(parseWaveformChunk(bytes.subarray(0, bytes.length - 1))).toBeNull();
    const longer = new Uint8Array(bytes.length + 2);
    longer.set(bytes);
    expect(parseWaveformChunk(longer)).toBeNull();
  });

  it("reads a view with an offset", () => {
    const inner = chunkBytes(3, [9, 8]);
    const outer = new Uint8Array(inner.length + 5);
    outer.set(inner, 5);
    const chunk = parseWaveformChunk(outer.subarray(5));
    expect(chunk?.startBucket).toBe(3);
    expect([...(chunk?.pairs ?? [])]).toEqual([9, 8]);
  });
});

describe("rawMessageBytes", () => {
  it("accepts an ArrayBuffer and a typed-array view", () => {
    expect(rawMessageBytes(new ArrayBuffer(4))?.length).toBe(4);
    const data = new Uint16Array([1, 2, 3]);
    expect(rawMessageBytes(data.subarray(1))?.length).toBe(4);
  });

  it("returns null for a JSON message", () => {
    expect(rawMessageBytes({ type: "end" })).toBeNull();
    expect(rawMessageBytes([1, 2])).toBeNull();
  });
});

describe("parseWaveformProgress", () => {
  it("reads a progress message with and without byte counts", () => {
    expect(
      parseWaveformProgress({
        type: "progress",
        highWater: 5,
        bytesRead: 10,
        totalBytes: 20,
      }),
    ).toEqual({ highWater: 5, bytesRead: 10, totalBytes: 20 });
    expect(
      parseWaveformProgress({
        type: "progress",
        highWater: 5,
        bytesRead: null,
        totalBytes: null,
      }),
    ).toEqual({ highWater: 5, bytesRead: null, totalBytes: null });
  });

  it("refuses the wrong shape", () => {
    expect(parseWaveformProgress({ type: "end", highWater: 5 })).toBeNull();
    expect(parseWaveformProgress({ type: "progress", highWater: -1 })).toBeNull();
    expect(parseWaveformProgress({ type: "progress", highWater: 1.5 })).toBeNull();
    expect(
      parseWaveformProgress({ type: "progress", highWater: 1, bytesRead: "1" }),
    ).toBeNull();
    expect(
      parseWaveformProgress({ type: "progress", highWater: 1, totalBytes: -2 }),
    ).toBeNull();
    expect(parseWaveformProgress(null)).toBeNull();
  });
});

describe("parseWaveformEnd", () => {
  it("reads a complete end with its flags", () => {
    expect(parseWaveformEnd(END)).toEqual({
      status: "complete",
      code: null,
      detail: null,
      bucketCount: 120,
      cached: false,
      flags: {
        timestampsDecrease: true,
        damaged: false,
        truncated: true,
        alignmentUncertain: false,
      },
    });
  });

  it("reads a canceled end", () => {
    expect(parseWaveformEnd({ ...END, status: "canceled" })?.status).toBe("canceled");
  });

  it("reads each failed end code with its detail", () => {
    for (const code of ["spawnFailed", "readFailed", "decodeFailed", "sourceChanged"]) {
      expect(
        parseWaveformEnd({ ...END, status: "failed", code, detail: "ffmpeg said no" }),
      ).toMatchObject({ status: "failed", code, detail: "ffmpeg said no" });
    }
  });

  it("refuses an unknown status or code", () => {
    expect(parseWaveformEnd({ ...END, status: "done" })).toBeNull();
    expect(parseWaveformEnd({ ...END, status: "failed", code: "busy" })).toBeNull();
    expect(parseWaveformEnd({ ...END, status: "failed", code: null })).toBeNull();
    expect(parseWaveformEnd({ ...END, code: "readFailed" })).toBeNull();
    expect(parseWaveformEnd({ ...END, code: 4 })).toBeNull();
  });

  it("refuses a missing flag or a bad count", () => {
    expect(parseWaveformEnd({ ...END, damaged: undefined })).toBeNull();
    expect(parseWaveformEnd({ ...END, cached: "no" })).toBeNull();
    expect(parseWaveformEnd({ ...END, bucketCount: -1 })).toBeNull();
    expect(parseWaveformEnd({ ...END, detail: 3 })).toBeNull();
    expect(parseWaveformEnd({ ...END, type: "progress" })).toBeNull();
    expect(parseWaveformEnd("end")).toBeNull();
  });
});

describe("parseWaveformMessage", () => {
  it("sorts each kind", () => {
    expect(parseWaveformMessage(chunkBytes(0, [1, 1]).buffer).kind).toBe("chunk");
    expect(parseWaveformMessage(chunkBytes(0, [1, 1])).kind).toBe("chunk");
    expect(
      parseWaveformMessage({
        type: "progress",
        highWater: 1,
        bytesRead: null,
        totalBytes: null,
      }).kind,
    ).toBe("progress");
    expect(parseWaveformMessage(END).kind).toBe("end");
  });

  it("marks a malformed message as invalid", () => {
    expect(parseWaveformMessage(new Uint8Array(3)).kind).toBe("invalid");
    expect(parseWaveformMessage({ type: "other" }).kind).toBe("invalid");
    expect(parseWaveformMessage(undefined).kind).toBe("invalid");
  });
});

describe("parseWaveformStarted", () => {
  it("reads the reply", () => {
    expect(parseWaveformStarted({ jobId: 3, cached: true, bucketRate: 100 })).toEqual({
      jobId: 3,
      cached: true,
      bucketRate: 100,
    });
  });

  it("refuses the wrong shape", () => {
    expect(
      parseWaveformStarted({ jobId: -1, cached: true, bucketRate: 100 }),
    ).toBeNull();
    expect(parseWaveformStarted({ jobId: 1, cached: 1, bucketRate: 100 })).toBeNull();
    expect(parseWaveformStarted({ jobId: 1, cached: true, bucketRate: 0 })).toBeNull();
    expect(parseWaveformStarted(null)).toBeNull();
  });
});

describe("the start error", () => {
  it("reads each known code", () => {
    for (const code of [
      "invalidRequest",
      "sourceUnreadable",
      "sourceNotAllowed",
      "sourceChanged",
      "busy",
      "superseded",
      "closed",
      "cacheUnavailable",
      "ffmpegNotFound",
      "commandExecutionFailed",
    ]) {
      expect(parseWaveformStartError({ code })).toEqual({ code, detail: null });
    }
    expect(parseWaveformStartError({ code: "busy", detail: "x" })).toEqual({
      code: "busy",
      detail: "x",
    });
  });

  it("refuses an unknown code", () => {
    expect(parseWaveformStartError({ code: "readFailed" })).toBeNull();
    expect(parseWaveformStartError("busy")).toBeNull();
  });

  it("turns any rejection into a WaveformError", () => {
    expect(toWaveformError({ code: "busy" })).toMatchObject({
      code: "busy",
      detail: null,
    });
    expect(toWaveformError({ code: "nope" })).toMatchObject({
      code: "commandExecutionFailed",
    });
    expect(toWaveformError(new Error("boom"))).toMatchObject({
      code: "commandExecutionFailed",
      detail: "boom",
    });
    const error = new WaveformError("closed");
    expect(toWaveformError(error)).toBe(error);
  });
});

describe("the cache replies", () => {
  it("reads the usage and the clear", () => {
    expect(
      parseWaveformCacheUsage({ bytes: 10, entries: 1, limitBytes: 268435456 }),
    ).toEqual({
      bytes: 10,
      entries: 1,
      limitBytes: 268435456,
    });
    expect(parseWaveformCacheCleared({ removedBytes: 10 })).toEqual({
      removedBytes: 10,
    });
  });

  it("refuses the wrong shape", () => {
    expect(parseWaveformCacheUsage({ bytes: 10, entries: 1 })).toBeNull();
    expect(parseWaveformCacheUsage(null)).toBeNull();
    expect(parseWaveformCacheCleared({ removedBytes: -1 })).toBeNull();
  });
});
