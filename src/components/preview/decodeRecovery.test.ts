import { describe, expect, it } from "vitest";
import { resolveTimecodeDisplay } from "@/features/playback";
import { en, extractPlaceholders, zhCN } from "@/i18n";
import type { TimecodeDisplay } from "@/lib/timecode";
import {
  MEDIA_ERR_ABORTED,
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  type DecodeFailureTrigger,
} from "./decodeFailure";
import {
  classifyDecodeFailure,
  DECODE_STALL_MESSAGE_KEY,
  NO_DECODE_EVIDENCE,
  presentDecodeStall,
  provesPartialDecode,
  stepDecodeEvidence,
  type DecodeEvidence,
} from "./decodeRecovery";

function mediaError(code: number | null): DecodeFailureTrigger {
  return { kind: "mediaError", code };
}

function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog;
  for (const segment of key.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const MILLISECONDS: TimecodeDisplay = { format: "milliseconds" };
const FRAMES_25: TimecodeDisplay = {
  format: "frames",
  rate: { n: 25, d: 1 },
  videoTimeBase: { n: 1, d: 12800 },
};

function evidenceOf(...events: ("frame" | "seeking")[]): DecodeEvidence {
  return events.reduce(stepDecodeEvidence, NO_DECODE_EVIDENCE);
}

describe("provesPartialDecode", () => {
  it("needs a frame after the first frame", () => {
    expect(provesPartialDecode(NO_DECODE_EVIDENCE)).toBe(false);
    expect(provesPartialDecode(evidenceOf("frame"))).toBe(false);
    expect(provesPartialDecode(evidenceOf("frame", "frame"))).toBe(true);
  });

  it("takes a seek after the first frame, which left a part that decoded", () => {
    expect(provesPartialDecode(evidenceOf("frame", "seeking"))).toBe(true);
    expect(provesPartialDecode(evidenceOf("frame", "seeking", "seeking"))).toBe(true);
  });

  it("does not take a seek before the first frame", () => {
    expect(provesPartialDecode(evidenceOf("seeking"))).toBe(false);
    expect(provesPartialDecode(evidenceOf("seeking", "frame"))).toBe(false);
    expect(evidenceOf("seeking")).toBe(NO_DECODE_EVIDENCE);
  });
});

describe("classifyDecodeFailure", () => {
  it("reads a decode error of a source that decodes in part as a stall", () => {
    expect(classifyDecodeFailure(mediaError(MEDIA_ERR_DECODE), true)).toBe("stall");
  });

  it("reads an unsupported source that decodes in part as a stall", () => {
    expect(classifyDecodeFailure(mediaError(MEDIA_ERR_SRC_NOT_SUPPORTED), true)).toBe(
      "stall",
    );
  });

  it("keeps the failure panel for every error before the source decodes in part", () => {
    for (const code of [
      MEDIA_ERR_ABORTED,
      MEDIA_ERR_NETWORK,
      MEDIA_ERR_DECODE,
      MEDIA_ERR_SRC_NOT_SUPPORTED,
      null,
    ]) {
      expect(classifyDecodeFailure(mediaError(code), false)).toBe("failure");
    }
  });

  it("keeps the failure panel for a file that could not be read, also after it decoded in part", () => {
    expect(classifyDecodeFailure(mediaError(MEDIA_ERR_NETWORK), true)).toBe("failure");
    expect(classifyDecodeFailure(mediaError(MEDIA_ERR_ABORTED), true)).toBe("failure");
    expect(classifyDecodeFailure(mediaError(null), true)).toBe("failure");
    expect(classifyDecodeFailure(mediaError(99), true)).toBe("failure");
  });

  it("keeps the failure panel for a failed picture check", () => {
    expect(classifyDecodeFailure({ kind: "pictureMissing" }, false)).toBe("failure");
    expect(classifyDecodeFailure({ kind: "pictureMissing" }, true)).toBe("failure");
  });
});

describe("presentDecodeStall", () => {
  it("names the position in the millisecond format", () => {
    expect(presentDecodeStall({ atSeconds: 10.0213 }, MILLISECONDS)).toEqual({
      key: DECODE_STALL_MESSAGE_KEY,
      values: { time: "00:00:10.021" },
    });
  });

  it("names the position in the frame format of the playhead", () => {
    expect(presentDecodeStall({ atSeconds: 10.5 }, FRAMES_25).values.time).toBe(
      "00:00:10:12",
    );
  });

  it("follows the timecode preference and the probe, as the playhead does", () => {
    const probe = {
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      videoTimeBase: { n: 1, d: 15360 },
    };
    expect(
      presentDecodeStall({ atSeconds: 1.5 }, resolveTimecodeDisplay("frames", probe))
        .values.time,
    ).toBe("00:00:01:15");
    expect(
      presentDecodeStall(
        { atSeconds: 1.5 },
        resolveTimecodeDisplay("milliseconds", probe),
      ).values.time,
    ).toBe("00:00:01.500");
  });

  it("names the start for a position that is not a time", () => {
    for (const atSeconds of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(presentDecodeStall({ atSeconds }, MILLISECONDS).values.time).toBe(
        "00:00:00.000",
      );
    }
  });

  it("has a message with the time placeholder only, in both catalogs", () => {
    for (const catalog of [en, zhCN]) {
      const message = lookup(catalog, DECODE_STALL_MESSAGE_KEY);
      expect(typeof message).toBe("string");
      expect(extractPlaceholders(message as string)).toEqual(["time"]);
    }
  });

  it("marks the time as approximate and makes no claim about the export", () => {
    const english = lookup(en, DECODE_STALL_MESSAGE_KEY) as string;
    const chinese = lookup(zhCN, DECODE_STALL_MESSAGE_KEY) as string;
    expect(english).toContain("about {{time}}");
    expect(chinese).toContain("约 {{time}}");
    expect(english.toLowerCase()).not.toContain("export");
    expect(chinese).not.toContain("导出");
  });
});
