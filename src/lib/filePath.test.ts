import { describe, expect, it } from "vitest";
import { isSameFilePath } from "./filePath";

const OPEN_PATH = "/Users/me/Movies/open.mp4";
const OTHER_PATH = "/Users/me/Movies/other.mp4";

describe("isSameFilePath", () => {
  it("compares POSIX paths exactly", () => {
    expect(isSameFilePath(OPEN_PATH, OPEN_PATH)).toBe(true);
    expect(isSameFilePath(OPEN_PATH, OTHER_PATH)).toBe(false);
    // macOS and Linux file systems can be case sensitive, so case counts.
    expect(isSameFilePath("/a/Clip.mp4", "/a/clip.mp4")).toBe(false);
  });

  it("removes the Windows verbatim prefix that canonicalize adds", () => {
    expect(isSameFilePath("\\\\?\\C:\\v\\a.mp4", "C:\\v\\a.mp4")).toBe(true);
    expect(
      isSameFilePath("\\\\?\\UNC\\server\\share\\a.mp4", "\\\\server\\share\\a.mp4"),
    ).toBe(true);
  });

  it("compares Windows paths without regard to case or separator", () => {
    expect(isSameFilePath("C:\\Videos\\A.mp4", "c:/videos/a.MP4")).toBe(true);
    expect(isSameFilePath("C:\\Videos\\a.mp4", "D:\\Videos\\a.mp4")).toBe(false);
  });

  it("does not treat a Windows path and a POSIX path as one file", () => {
    expect(isSameFilePath("C:\\a.mp4", "/a.mp4")).toBe(false);
    expect(isSameFilePath("C:\\a.mp4", "/a.mp4", { ignoreCase: true })).toBe(false);
  });

  describe("with ignoreCase", () => {
    it("compares POSIX paths without regard to case", () => {
      expect(isSameFilePath("/a/Clip.mp4", "/a/clip.MP4", { ignoreCase: true })).toBe(
        true,
      );
      expect(isSameFilePath(OPEN_PATH, OTHER_PATH, { ignoreCase: true })).toBe(false);
    });

    it("keeps the separator of a POSIX path significant", () => {
      // A backslash is an ordinary character in a POSIX file name.
      expect(isSameFilePath("/a/b.mp4", "/a\\b.mp4", { ignoreCase: true })).toBe(false);
    });

    it("folds the composed and the decomposed form of a name", () => {
      const composed = "/x/caf\u00e9.mp4";
      const decomposed = "/x/cafe\u0301.mp4";
      expect(isSameFilePath(composed, decomposed)).toBe(false);
      expect(isSameFilePath(composed, decomposed, { ignoreCase: true })).toBe(true);
    });

    it("never matches a Windows path with another path", () => {
      // The Kelvin sign lowers to "k", but the path does not start with a drive letter.
      expect(isSameFilePath("k:\\a.mp4", "\u212a:\\a.mp4", { ignoreCase: true })).toBe(
        false,
      );
    });

    it("compares a verbatim path with no drive letter as a POSIX path", () => {
      const volume = "\\\\?\\Volume{0A1B}\\a.mp4";
      expect(isSameFilePath(volume, volume.toUpperCase(), { ignoreCase: true })).toBe(
        true,
      );
      expect(isSameFilePath(volume, volume.toUpperCase())).toBe(false);
    });

    it("compares Windows paths as without the option", () => {
      expect(
        isSameFilePath("\\\\?\\C:\\V\\A.mp4", "c:/v/a.mp4", { ignoreCase: true }),
      ).toBe(true);
    });
  });
});
