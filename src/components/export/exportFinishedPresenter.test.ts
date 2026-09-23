import { describe, expect, it } from "vitest";
import {
  BACKEND_EXPORT_OUTPUT_ERROR_CODES,
  type ExportOutputErrorCode,
  type ExportStatus,
} from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  elapsedAtFinish,
  formatElapsed,
  outputActionErrorKey,
  presentFinishedExport,
  revealLabelKey,
} from "./exportFinishedPresenter";

/** Walks a dotted key through a nested catalog, the way i18next does. */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

describe("elapsedAtFinish", () => {
  it("gives the time from the recorded start when the status becomes finished", () => {
    expect(elapsedAtFinish(1_000, "finished", 84_500)).toBe(83_500);
  });

  it("gives null when no start was recorded", () => {
    expect(elapsedAtFinish(null, "finished", 84_500)).toBeNull();
  });

  it.each<ExportStatus>([
    "idle",
    "preparing",
    "running",
    "publishing",
    "failed",
    "canceled",
  ])("gives null for the status %s", (status) => {
    expect(elapsedAtFinish(1_000, status, 84_500)).toBeNull();
  });

  it("never gives a negative time", () => {
    expect(elapsedAtFinish(5_000, "finished", 4_000)).toBe(0);
  });
});

describe("formatElapsed", () => {
  it("rounds down to whole seconds", () => {
    expect(formatElapsed(83_999)).toBe("1:23");
    expect(formatElapsed(999)).toBe("0:00");
  });

  it("adds the hours from one hour", () => {
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("presentFinishedExport", () => {
  it("gives the file name, the full path, the folder, and the time", () => {
    expect(presentFinishedExport("/Users/me/Movies/clip.mp4", 83_000)).toEqual({
      fileName: "clip.mp4",
      fileStem: "clip",
      fileExtension: ".mp4",
      fullPath: "/Users/me/Movies/clip.mp4",
      folderName: "Movies",
      elapsed: "1:23",
    });
  });

  it("gives no time when the time is unknown", () => {
    expect(presentFinishedExport("C:\\Videos\\clip.mp4", null)).toEqual({
      fileName: "clip.mp4",
      fileStem: "clip",
      fileExtension: ".mp4",
      fullPath: "C:\\Videos\\clip.mp4",
      folderName: "Videos",
      elapsed: null,
    });
  });

  it("gives null when the path is unknown or empty", () => {
    expect(presentFinishedExport(null, 1_000)).toBeNull();
    expect(presentFinishedExport("", 1_000)).toBeNull();
  });
});

describe("revealLabelKey", () => {
  it("names Finder on macOS and File Explorer elsewhere", () => {
    expect(revealLabelKey(true)).toBe("export.action.revealMac");
    expect(revealLabelKey(false)).toBe("export.action.revealWindows");
  });

  it("names keys that both catalogs hold", () => {
    for (const key of [revealLabelKey(true), revealLabelKey(false)]) {
      expect(typeof resolveCatalogKey(en, key)).toBe("string");
      expect(typeof resolveCatalogKey(zhCN, key)).toBe("string");
    }
  });
});

describe("outputActionErrorKey", () => {
  const codes: ExportOutputErrorCode[] = [
    ...BACKEND_EXPORT_OUTPUT_ERROR_CODES,
    "unknown",
  ];

  it.each(codes)("maps the code %s to a message in both catalogs", (code) => {
    const key = outputActionErrorKey(code);

    expect(key).toBe(`exportOutputError.${code}`);
    expect(typeof resolveCatalogKey(en, key)).toBe("string");
    expect(typeof resolveCatalogKey(zhCN, key)).toBe("string");
  });
});
