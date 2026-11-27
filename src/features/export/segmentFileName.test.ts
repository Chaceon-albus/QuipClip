import { describe, expect, it } from "vitest";
import {
  exportFileName,
  SEGMENT_FILE_NAME_MAX_BYTES,
  segmentFileName,
  stripFileExtension,
} from "./segmentFileName";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("exportFileName", () => {
  it("names the whole export <source name>_export.<extension> (ADR 024)", () => {
    expect(exportFileName("clip.final.mov", "mp4")).toBe("clip.final_export.mp4");
    expect(exportFileName("noext", "mkv")).toBe("noext_export.mkv");
    expect(stripFileExtension("archive.tar.gz")).toBe("archive.tar");
  });
});

describe("segmentFileName (ADR 067)", () => {
  const base = { sourceFileName: "clip.mov", extension: "mp4" };

  it("names a segment with no name <source name>_<number>.<extension>", () => {
    expect(segmentFileName({ ...base, number: 3, name: undefined })).toBe(
      "clip_03.mp4",
    );
  });

  it("gives the number a leading zero below 10 only", () => {
    expect(segmentFileName({ ...base, number: 1, name: undefined })).toBe(
      "clip_01.mp4",
    );
    expect(segmentFileName({ ...base, number: 9, name: undefined })).toBe(
      "clip_09.mp4",
    );
    expect(segmentFileName({ ...base, number: 10, name: undefined })).toBe(
      "clip_10.mp4",
    );
    expect(segmentFileName({ ...base, number: 123, name: undefined })).toBe(
      "clip_123.mp4",
    );
  });

  it("adds the name after a space", () => {
    expect(segmentFileName({ ...base, number: 2, name: "Opening scene" })).toBe(
      "clip_02 Opening scene.mp4",
    );
  });

  it("keeps the source name as it is, without its extension", () => {
    expect(
      segmentFileName({
        sourceFileName: "My trip. Day 1.mkv",
        extension: "m4a",
        number: 4,
        name: undefined,
      }),
    ).toBe("My trip. Day 1_04.m4a");
  });

  it("changes each separator character to _", () => {
    expect(segmentFileName({ ...base, number: 1, name: 'a\\b/c:d*e?f"g<h>i|j' })).toBe(
      "clip_01 a_b_c_d_e_f_g_h_i_j.mp4",
    );
  });

  it("changes each control character to _", () => {
    expect(
      segmentFileName({ ...base, number: 1, name: "a\u0001b\u007fc\u009fd" }),
    ).toBe("clip_01 a_b_c_d.mp4");
  });

  it("removes spaces and full stops at the end of the name part", () => {
    expect(segmentFileName({ ...base, number: 1, name: "End. . " })).toBe(
      "clip_01 End.mp4",
    );
    // Only at the end: a full stop inside the name stays.
    expect(segmentFileName({ ...base, number: 1, name: "v1.2 final" })).toBe(
      "clip_01 v1.2 final.mp4",
    );
  });

  it("gives no name part when the name part is empty after the changes", () => {
    expect(segmentFileName({ ...base, number: 5, name: "..." })).toBe("clip_05.mp4");
    expect(segmentFileName({ ...base, number: 5, name: ". ." })).toBe("clip_05.mp4");
  });

  it("cuts the name part so that the whole name has no more than 200 bytes in UTF-8", () => {
    const name = "x".repeat(300);
    const result = segmentFileName({ ...base, number: 1, name });
    expect(bytes(result)).toBe(SEGMENT_FILE_NAME_MAX_BYTES);
    expect(result.startsWith("clip_01 xxx")).toBe(true);
    expect(result.endsWith("x.mp4")).toBe(true);
  });

  it("cuts at a character, never inside one", () => {
    // "clip_01 " is 8 bytes and ".mp4" is 4, so 188 bytes remain for the name part. Each 中
    // has 3 bytes: 62 of them take 186 bytes, and a 63rd would take 189.
    const result = segmentFileName({ ...base, number: 1, name: "中".repeat(100) });
    expect(result).toBe(`clip_01 ${"中".repeat(62)}.mp4`);
    expect(bytes(result)).toBe(198);
    // A character of 4 bytes, outside the basic plane, is not split into its surrogates.
    const emoji = segmentFileName({ ...base, number: 1, name: "😀".repeat(60) });
    expect(emoji).toBe(`clip_01 ${"😀".repeat(47)}.mp4`);
  });

  it("removes spaces and full stops that the cut leaves at the end", () => {
    // 187 letters and then a space and more: the cut keeps 188 bytes, which end in the space.
    const name = `${"y".repeat(187)} tail`;
    const result = segmentFileName({ ...base, number: 1, name });
    expect(result).toBe(`clip_01 ${"y".repeat(187)}.mp4`);
  });

  it("gives no name part when the name without it has 200 bytes or more already", () => {
    // A stem of 189 bytes with "_01" and ".mp4" makes 196 bytes: 3 bytes remain, minus the
    // space, so the name part keeps 3 letters.
    const almost = { ...base, sourceFileName: `${"s".repeat(189)}.mov` };
    expect(segmentFileName({ ...almost, number: 1, name: "abcdef" })).toBe(
      `${"s".repeat(189)}_01 abc.mp4`,
    );
    // 193 bytes of stem: the name without a name part has exactly 200 bytes.
    const full = { ...base, sourceFileName: `${"s".repeat(193)}.mov` };
    expect(segmentFileName({ ...full, number: 1, name: "abc" })).toBe(
      `${"s".repeat(193)}_01.mp4`,
    );
    // More than 200 bytes: the name stays whole, with no name part.
    const over = { ...base, sourceFileName: `${"s".repeat(250)}.mov` };
    expect(segmentFileName({ ...over, number: 1, name: "abc" })).toBe(
      `${"s".repeat(250)}_01.mp4`,
    );
  });

  it("gives no name part when only the space would fit", () => {
    // 192 bytes of stem with "_01" and ".mp4" make 199 bytes, and the space takes the last.
    const tight = { ...base, sourceFileName: `${"s".repeat(192)}.mov` };
    expect(segmentFileName({ ...tight, number: 1, name: "abc" })).toBe(
      `${"s".repeat(192)}_01.mp4`,
    );
  });
});
