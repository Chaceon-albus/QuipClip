import { describe, expect, it } from "vitest";
import {
  BACKEND_EXPORT_OUTPUT_ERROR_CODES,
  type ExportOutputErrorCode,
} from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  formatElapsed,
  outputActionErrorKey,
  presentFinishedExport,
  presentOutputFile,
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

describe("formatElapsed", () => {
  it("rounds down to whole seconds", () => {
    expect(formatElapsed(83_999)).toBe("1:23");
    expect(formatElapsed(999)).toBe("0:00");
  });

  it("adds the hours from one hour", () => {
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("presentOutputFile", () => {
  it("splits the name so that a display can keep the extension", () => {
    expect(presentOutputFile("/Users/me/Movies/a long clip name.mov")).toEqual({
      fileName: "a long clip name.mov",
      fileStem: "a long clip name",
      fileExtension: ".mov",
      fullPath: "/Users/me/Movies/a long clip name.mov",
      folderName: "Movies",
    });
  });

  it("gives an empty extension for a name with none", () => {
    expect(presentOutputFile("C:\\Videos\\clip")).toEqual(
      expect.objectContaining({ fileStem: "clip", fileExtension: "" }),
    );
  });

  it("gives null when the path is unknown or empty", () => {
    expect(presentOutputFile(null)).toBeNull();
    expect(presentOutputFile("")).toBeNull();
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
