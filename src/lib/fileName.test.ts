import { describe, expect, it } from "vitest";
import { splitFilePath, splitFileName } from "./fileName";

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
