import { describe, expect, it } from "vitest";
import { splitFileName } from "./fileName";

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
