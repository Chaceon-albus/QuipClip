import { describe, expect, it } from "vitest";
import {
  parseLoudnessEnd,
  parseLoudnessMessage,
  parseLoudnessProgress,
  parseLoudnessStarted,
  toLoudnessError,
} from "./protocol";
import { LoudnessError } from "./types";

const COMPLETE = {
  type: "end",
  status: "complete",
  code: null,
  detail: null,
  integratedLufs: -14.25,
  truePeakDbtp: 0.71,
};

describe("loudness protocol (ADR 061)", () => {
  it("reads a progress message, and refuses one of another shape", () => {
    expect(parseLoudnessProgress({ type: "progress", readUs: 5, totalUs: 9 })).toEqual({
      readUs: 5,
      totalUs: 9,
    });
    for (const bad of [
      { type: "progress", readUs: -1, totalUs: 9 },
      { type: "progress", readUs: 1.5, totalUs: 9 },
      { type: "progress", readUs: 1 },
      { type: "end", readUs: 1, totalUs: 2 },
      null,
      [],
    ]) {
      expect(parseLoudnessProgress(bad)).toBeNull();
    }
  });

  it("reads a complete end with its values, which can be null", () => {
    expect(parseLoudnessEnd(COMPLETE)).toEqual({
      status: "complete",
      integratedLufs: -14.25,
      truePeakDbtp: 0.71,
    });
    expect(
      parseLoudnessEnd({ ...COMPLETE, integratedLufs: null, truePeakDbtp: null }),
    ).toEqual({ status: "complete", integratedLufs: null, truePeakDbtp: null });
    // A value must be a finite number or null, and a complete end has no code.
    expect(parseLoudnessEnd({ ...COMPLETE, truePeakDbtp: "0.7" })).toBeNull();
    expect(parseLoudnessEnd({ ...COMPLETE, truePeakDbtp: undefined })).toBeNull();
    expect(parseLoudnessEnd({ ...COMPLETE, code: "audioShort" })).toBeNull();
  });

  it("reads a failed end with a code of the run or of the export preparation", () => {
    const failed = {
      ...COMPLETE,
      status: "failed",
      integratedLufs: null,
      truePeakDbtp: null,
    };
    expect(parseLoudnessEnd({ ...failed, code: "audioShort", detail: "x" })).toEqual({
      status: "failed",
      code: "audioShort",
      detail: "x",
    });
    expect(parseLoudnessEnd({ ...failed, code: "sourceHasNoAudio" })).toEqual({
      status: "failed",
      code: "sourceHasNoAudio",
      detail: null,
    });
    // An unknown code, no code, or values on a failure are refused.
    expect(parseLoudnessEnd({ ...failed, code: "nope" })).toBeNull();
    expect(parseLoudnessEnd({ ...failed, code: null })).toBeNull();
    expect(
      parseLoudnessEnd({ ...failed, code: "audioShort", truePeakDbtp: 1 }),
    ).toBeNull();
  });

  it("reads a canceled end, which carries nothing", () => {
    const canceled = {
      ...COMPLETE,
      status: "canceled",
      integratedLufs: null,
      truePeakDbtp: null,
    };
    expect(parseLoudnessEnd(canceled)).toEqual({ status: "canceled" });
    expect(parseLoudnessEnd({ ...canceled, integratedLufs: -20 })).toBeNull();
    expect(parseLoudnessEnd({ ...canceled, status: "done" })).toBeNull();
  });

  it("sorts each message by its kind", () => {
    expect(parseLoudnessMessage({ type: "progress", readUs: 1, totalUs: 2 }).kind).toBe(
      "progress",
    );
    expect(parseLoudnessMessage(COMPLETE).kind).toBe("end");
    expect(parseLoudnessMessage("{}").kind).toBe("invalid");
    expect(parseLoudnessMessage(new ArrayBuffer(4)).kind).toBe("invalid");
  });

  it("reads the start reply and the start refusals", () => {
    expect(parseLoudnessStarted({ jobId: 4 })).toEqual({ jobId: 4 });
    expect(parseLoudnessStarted({ jobId: 0 })).toBeNull();
    expect(parseLoudnessStarted({ jobId: "4" })).toBeNull();
    expect(toLoudnessError({ code: "busy" })).toEqual(new LoudnessError("busy"));
    expect(toLoudnessError({ code: "invalidRequest", detail: "x" }).detail).toBe("x");
    const unknown = toLoudnessError("ipc failed");
    expect(unknown.code).toBe("commandExecutionFailed");
    expect(unknown.detail).toBe("ipc failed");
    expect(toLoudnessError({ code: "audioShort" }).code).toBe("commandExecutionFailed");
  });

  it("refuses every shape that Rust does not send", () => {
    // Rust writes each key of an end message, with null where it has no value.
    const { code: _code, ...noCode } = COMPLETE;
    expect(parseLoudnessEnd(noCode)).toBeNull();
    const { detail: _detail, ...noDetail } = COMPLETE;
    expect(parseLoudnessEnd(noDetail)).toBeNull();
    expect(parseLoudnessEnd({ ...COMPLETE, extra: 1 })).toBeNull();
    // A complete or canceled end carries no diagnostic.
    expect(parseLoudnessEnd({ ...COMPLETE, detail: "x" })).toBeNull();
    // A cancel is a status, never the code of a failure.
    expect(
      parseLoudnessEnd({
        ...COMPLETE,
        status: "failed",
        code: "canceled",
        integratedLufs: null,
        truePeakDbtp: null,
      }),
    ).toBeNull();
    expect(
      parseLoudnessProgress({ type: "progress", readUs: 1, totalUs: 2, x: 0 }),
    ).toBeNull();
    expect(parseLoudnessStarted({ jobId: 4, cached: false })).toBeNull();
    // Rust leaves out a start detail that it does not have, and never sends another type.
    expect(toLoudnessError({ code: "busy", detail: 5 }).code).toBe(
      "commandExecutionFailed",
    );
    expect(toLoudnessError({ code: "busy", other: 1 }).code).toBe(
      "commandExecutionFailed",
    );
  });
});
