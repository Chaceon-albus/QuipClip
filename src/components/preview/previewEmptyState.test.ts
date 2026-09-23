import { describe, expect, it } from "vitest";
import { VIDEO_FILE_EXTENSIONS } from "@/features/media";
import { formatSupportedVideoFormats } from "./previewEmptyState";

describe("formatSupportedVideoFormats", () => {
  it("writes each extension in capitals and joins them with a middle dot", () => {
    expect(formatSupportedVideoFormats(["mp4", "mov", "mkv"])).toBe("MP4 · MOV · MKV");
  });

  it("uses the mixed-case name of WebM", () => {
    expect(formatSupportedVideoFormats(["webm"])).toBe("WebM");
    expect(formatSupportedVideoFormats(["WEBM"])).toBe("WebM");
  });

  it("keeps the order of the input", () => {
    expect(formatSupportedVideoFormats(["ts", "avi"])).toBe("TS · AVI");
  });

  it("returns an empty string for no extensions", () => {
    expect(formatSupportedVideoFormats([])).toBe("");
  });

  it("lists every extension the file dialog accepts", () => {
    const line = formatSupportedVideoFormats(VIDEO_FILE_EXTENSIONS);
    expect(line.split(" · ")).toHaveLength(VIDEO_FILE_EXTENSIONS.length);
    expect(line.startsWith("MP4 · MOV · MKV · WebM")).toBe(true);
  });
});
