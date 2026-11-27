import { describe, expect, it } from "vitest";
import {
  directoryOfPath,
  fileNameOfPath,
  hasProjectExtension,
  isWindowsPath,
  projectFileNameFor,
  siblingPath,
} from "./paths";

describe("project paths", () => {
  it("splits the paths of macOS and of Windows", () => {
    expect(fileNameOfPath("/media/a.mp4")).toBe("a.mp4");
    expect(fileNameOfPath("C:\\media\\a.mp4")).toBe("a.mp4");
    expect(fileNameOfPath("a.mp4")).toBe("a.mp4");
    expect(directoryOfPath("/media/a.mp4")).toBe("/media");
    expect(directoryOfPath("C:\\media\\a.mp4")).toBe("C:\\media");
    expect(directoryOfPath("/a.mp4")).toBe("/");
    expect(directoryOfPath("C:\\a.mp4")).toBe("C:\\");
    expect(directoryOfPath("a.mp4")).toBeNull();
    expect(siblingPath("/new/a.mp4", "b.mp4")).toBe("/new/b.mp4");
    expect(siblingPath("D:\\new\\a.mp4", "b.mp4")).toBe("D:\\new\\b.mp4");
    expect(siblingPath("a.mp4", "b.mp4")).toBeNull();
  });

  it("splits at a backslash only for a path in a Windows form", () => {
    // On macOS a backslash is a character of a file name.
    expect(isWindowsPath("/old/Tape\\B.mp4")).toBe(false);
    expect(fileNameOfPath("/old/Tape\\B.mp4")).toBe("Tape\\B.mp4");
    expect(directoryOfPath("/old/Tape\\B.mp4")).toBe("/old");
    expect(siblingPath("/new/a.mp4", "Tape\\B.mp4")).toBe("/new/Tape\\B.mp4");
    expect(fileNameOfPath("Tape\\B.mp4")).toBe("Tape\\B.mp4");
    expect(directoryOfPath("Tape\\B.mp4")).toBeNull();
    // The Windows forms: a drive with either separator, a share, and the verbatim forms.
    for (const [path, name, directory] of [
      ["C:\\media\\a.mp4", "a.mp4", "C:\\media"],
      ["c:/media/a.mp4", "a.mp4", "c:/media"],
      ["D:\\media/sub\\a.mp4", "a.mp4", "D:\\media/sub"],
      ["\\\\server\\share\\a.mp4", "a.mp4", "\\\\server\\share"],
      ["\\\\?\\C:\\media\\a.mp4", "a.mp4", "\\\\?\\C:\\media"],
      ["\\\\?\\C:\\a.mp4", "a.mp4", "\\\\?\\C:\\"],
      ["\\\\?\\UNC\\server\\share\\a.mp4", "a.mp4", "\\\\?\\UNC\\server\\share"],
    ] as const) {
      expect(isWindowsPath(path)).toBe(true);
      expect(fileNameOfPath(path)).toBe(name);
      expect(directoryOfPath(path)).toBe(directory);
    }
    expect(siblingPath("\\\\server\\share\\a.mp4", "b.mp4")).toBe(
      "\\\\server\\share\\b.mp4",
    );
    // A colon in a macOS path is no drive.
    expect(directoryOfPath("/a:/b.mp4")).toBe("/a:");
  });

  it("tests the extension with the case of ASCII letters ignored", () => {
    for (const path of [
      "/p/cut.qcproj",
      "/p/cut.QCPROJ",
      "C:\\p\\cut.QcProj",
      ".qcproj",
    ]) {
      expect(hasProjectExtension(path)).toBe(true);
    }
    for (const path of [
      "/p/cut.mp4",
      "/p/cut.qcproj.txt",
      "/p/cut.qcproj/x",
      "/p/cutqcproj",
      // U+0130 and U+212A are not ASCII letters.
      "/p/cut.qcproİ",
      "/p/cut.qcproj\u212A",
    ]) {
      expect(hasProjectExtension(path)).toBe(false);
    }
  });

  it("replaces the extension of the file of the first clip", () => {
    expect(projectFileNameFor("clip.mp4")).toBe("clip.qcproj");
    expect(projectFileNameFor("live.2026.flv")).toBe("live.2026.qcproj");
    expect(projectFileNameFor("noext")).toBe("noext.qcproj");
    expect(projectFileNameFor(".hidden")).toBe(".hidden.qcproj");
  });
});
