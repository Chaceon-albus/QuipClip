import { describe, expect, it } from "vitest";
import {
  isSameDisplayPath,
  splitFilePath,
  splitFileName,
  stripVerbatimPrefix,
} from "./fileName";

describe("splitFileName", () => {
  it.each([
    ["clip.mp4", "clip", ".mp4"],
    ["Clip.MOV", "Clip", ".MOV"],
    ["holiday 2026.final.mkv", "holiday 2026.final", ".mkv"],
    ["a.tar.gz", "a.tar", ".gz"],
    ["..mp4", ".", ".mp4"],
    ["a.b", "a", ".b"],
    ["视频 片段.webm", "视频 片段", ".webm"],
  ])("splits %j at its last dot", (name, stem, extension) => {
    expect(splitFileName(name)).toEqual({ stem, extension });
  });

  it.each([
    ["no dot", "README"],
    ["an empty name", ""],
    ["a dotfile", ".gitignore"],
    ["a single dot", "."],
    ["a trailing dot", "clip."],
    ["only dots", "..."],
  ])("gives no extension for %s", (_case, name) => {
    expect(splitFileName(name)).toEqual({ stem: name, extension: "" });
  });

  it("keeps every character, so the two parts join to the whole name", () => {
    for (const name of ["clip.mp4", ".env", "a.b.c", "clip.", "x", "", "..mp4"]) {
      const { stem, extension } = splitFileName(name);
      expect(stem + extension).toBe(name);
    }
  });
});

describe("splitFilePath", () => {
  it("splits a macOS path into the file name and its folder", () => {
    expect(splitFilePath("/Users/me/Movies/clip-final.mp4")).toEqual({
      name: "clip-final.mp4",
      folderName: "Movies",
    });
  });

  it("keeps a backslash inside a macOS file name", () => {
    expect(splitFilePath("/Users/me/Movies/a\\b.mp4")).toEqual({
      name: "a\\b.mp4",
      folderName: "Movies",
    });
  });

  it("gives the root as the folder of a file in the POSIX root", () => {
    expect(splitFilePath("/out.mp4")).toEqual({ name: "out.mp4", folderName: "/" });
  });

  it("splits a Windows path on the backslash", () => {
    expect(splitFilePath("C:\\Users\\me\\Videos\\output.mkv")).toEqual({
      name: "output.mkv",
      folderName: "Videos",
    });
  });

  it("splits a Windows path that uses forward slashes", () => {
    expect(splitFilePath("D:/exports/final.mp4")).toEqual({
      name: "final.mp4",
      folderName: "exports",
    });
  });

  it("gives the drive root as the folder of a file at the top of a drive", () => {
    expect(splitFilePath("C:\\out.mp4")).toEqual({
      name: "out.mp4",
      folderName: "C:\\",
    });
  });

  it("gives the share as the folder of a file at the top of a UNC share", () => {
    expect(splitFilePath("\\\\server\\share\\out.mp4")).toEqual({
      name: "out.mp4",
      folderName: "share",
    });
  });

  it("skips doubled and trailing separators", () => {
    expect(splitFilePath("/Users/me//Movies/out.mp4/")).toEqual({
      name: "out.mp4",
      folderName: "Movies",
    });
    expect(splitFilePath("C:\\Videos\\\\out.mp4\\")).toEqual({
      name: "out.mp4",
      folderName: "Videos",
    });
  });

  it("names no folder for a bare file name", () => {
    expect(splitFilePath("out.mp4")).toEqual({ name: "out.mp4", folderName: null });
  });

  it("gives null for a path with no segment", () => {
    expect(splitFilePath("")).toBeNull();
    expect(splitFilePath("/")).toBeNull();
    expect(splitFilePath("\\\\")).toBeNull();
  });
});

describe("stripVerbatimPrefix", () => {
  it.each([
    ["\\\\?\\C:\\tools\\ffmpeg.exe", "C:\\tools\\ffmpeg.exe"],
    ["\\\\?\\d:\\ffmpeg.exe", "d:\\ffmpeg.exe"],
    ["\\\\?\\C:", "C:"],
    ["\\\\?\\UNC\\server\\share\\ffmpeg.exe", "\\\\server\\share\\ffmpeg.exe"],
    ["\\\\?\\unc\\server\\share\\ffmpeg.exe", "\\\\server\\share\\ffmpeg.exe"],
  ])("removes the verbatim prefix from %j", (path, expected) => {
    expect(stripVerbatimPrefix(path)).toBe(expected);
  });

  it.each([
    ["a drive path", "C:\\tools\\ffmpeg.exe"],
    ["a network path", "\\\\server\\share\\ffmpeg.exe"],
    ["a macOS path", "/opt/homebrew/bin/ffmpeg"],
    [
      "a volume GUID path",
      "\\\\?\\Volume{0a1b2c3d-0000-0000-0000-000000000000}\\ffmpeg.exe",
    ],
    ["a device path", "\\\\.\\C:\\ffmpeg.exe"],
    ["a path with the prefix later in it", "C:\\x\\\\?\\C:\\y"],
    ["an empty path", ""],
  ])("keeps %s as it is", (_case, path) => {
    expect(stripVerbatimPrefix(path)).toBe(path);
  });
});

describe("isSameDisplayPath", () => {
  it("matches a verbatim path with the same path without the prefix", () => {
    expect(
      isSameDisplayPath("\\\\?\\C:\\tools\\ffmpeg.exe", "C:\\tools\\ffmpeg.exe", true),
    ).toBe(true);
    expect(
      isSameDisplayPath(
        "\\\\?\\UNC\\server\\share\\ffmpeg.exe",
        "\\\\server\\share\\ffmpeg.exe",
        true,
      ),
    ).toBe(true);
  });

  it("ignores letter case only on Windows", () => {
    expect(
      isSameDisplayPath("\\\\?\\C:\\Tools\\FFMPEG.EXE", "c:\\tools\\ffmpeg.exe", true),
    ).toBe(true);
    expect(isSameDisplayPath("/Tools/ffmpeg", "/tools/ffmpeg", false)).toBe(false);
    expect(isSameDisplayPath("/tools/ffmpeg", "/tools/ffmpeg", false)).toBe(true);
  });

  it("folds the separators before it removes the verbatim prefix on Windows", () => {
    expect(
      isSameDisplayPath("//?/C:/tools/ffmpeg.exe", "C:\\tools\\ffmpeg.exe", true),
    ).toBe(true);
    expect(
      isSameDisplayPath(
        "//?/UNC/server/share/ffmpeg.exe",
        "\\\\server\\share\\ffmpeg.exe",
        true,
      ),
    ).toBe(true);
  });

  it("reads a forward slash as a backslash on Windows", () => {
    expect(
      isSameDisplayPath("\\\\?\\C:\\tools\\ffmpeg.exe", "C:/tools/ffmpeg.exe", true),
    ).toBe(true);
    expect(
      isSameDisplayPath("\\\\?\\C:\\tools\\ffmpeg.exe", "C:\\tools/ffmpeg.exe", true),
    ).toBe(true);
    expect(
      isSameDisplayPath(
        "\\\\?\\UNC\\server\\share\\ffmpeg.exe",
        "//server/share/ffmpeg.exe",
        true,
      ),
    ).toBe(true);
  });

  it("ignores one trailing separator on Windows", () => {
    expect(isSameDisplayPath("\\\\?\\D:\\ffmpeg\\bin", "D:\\ffmpeg\\bin\\", true)).toBe(
      true,
    );
    expect(isSameDisplayPath("\\\\?\\D:\\ffmpeg\\bin", "d:/ffmpeg/bin/", true)).toBe(
      true,
    );
    expect(isSameDisplayPath("\\\\server\\share\\", "\\\\server\\share", true)).toBe(
      true,
    );
  });

  it("keeps the separator of a Windows drive root, which names another folder without it", () => {
    expect(isSameDisplayPath("\\\\?\\C:\\", "C:/", true)).toBe(true);
    expect(isSameDisplayPath("C:\\", "C:", true)).toBe(false);
  });

  it("treats a slash and a trailing separator as part of the name on macOS", () => {
    expect(isSameDisplayPath("/opt/homebrew/bin", "/opt/homebrew/bin/", false)).toBe(
      false,
    );
    expect(isSameDisplayPath("/tools/a\\b", "/tools/a/b", false)).toBe(false);
  });

  it("does not match different paths", () => {
    expect(isSameDisplayPath("C:\\tools", "C:\\tools\\ffmpeg.exe", true)).toBe(false);
    expect(isSameDisplayPath("C:\\tools\\", "C:\\tools\\\\", true)).toBe(false);
    expect(
      isSameDisplayPath("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", false),
    ).toBe(false);
  });
});
