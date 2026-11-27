import { describe, expect, it } from "vitest";
import { classifyOpenPaths } from "./openPaths";

describe("classifyOpenPaths (ADR 072, One Open action)", () => {
  it("gives the videos, as before, when no file is a project file", () => {
    expect(classifyOpenPaths(["/v/a.mp4", "/v/b.mkv"])).toEqual({
      kind: "videos",
      paths: ["/v/a.mp4", "/v/b.mkv"],
    });
  });

  it("keeps each path of a request with no project file, so the import reports a file that is not a video, as before", () => {
    expect(classifyOpenPaths(["/v/notes.txt", "/v/a.mp4"])).toEqual({
      kind: "videos",
      paths: ["/v/notes.txt", "/v/a.mp4"],
    });
  });

  it("gives an empty request as videos with no path", () => {
    expect(classifyOpenPaths([])).toEqual({ kind: "videos", paths: [] });
  });

  it("opens one project file alone", () => {
    expect(classifyOpenPaths(["/p/cut.qcproj"])).toEqual({
      kind: "project",
      path: "/p/cut.qcproj",
      othersIgnored: false,
    });
  });

  it("ignores the letter case of the extension, also on a Windows path", () => {
    expect(classifyOpenPaths(["C:\\Work\\CUT.QcProj"])).toEqual({
      kind: "project",
      path: "C:\\Work\\CUT.QcProj",
      othersIgnored: false,
    });
  });

  it("opens the project and leaves out a file that is no video and no project file", () => {
    expect(classifyOpenPaths(["/p/notes.txt", "/p/cut.qcproj"])).toEqual({
      kind: "project",
      path: "/p/cut.qcproj",
      othersIgnored: true,
    });
  });

  it("does not count a blank path as another file", () => {
    expect(classifyOpenPaths(["  ", "/p/cut.qcproj"])).toEqual({
      kind: "project",
      path: "/p/cut.qcproj",
      othersIgnored: false,
    });
  });

  it("opens nothing for a project file with a video", () => {
    expect(classifyOpenPaths(["/p/cut.qcproj", "/v/a.mp4"])).toEqual({
      kind: "projectNotAlone",
    });
  });

  it("opens nothing for two project files", () => {
    expect(classifyOpenPaths(["/p/a.qcproj", "/p/b.qcproj"])).toEqual({
      kind: "projectNotAlone",
    });
  });
});
