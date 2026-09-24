import { describe, expect, it } from "vitest";
import { IMPORT_MEDIA_ERROR_CODES, type ImportMediaErrorCode } from "@/features/media";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  FFMPEG_SETUP_IMPORT_ERROR_CODES,
  NOTICE_EXIT_DURATION_MS,
  PLAYBACK_NOTICE_DURATION_MS,
  importErrorActions,
  importErrorHintKey,
  isFfmpegSetupImportError,
  resolveNoticeTimer,
} from "./previewNoticeRules";

const SETUP_CODES: readonly ImportMediaErrorCode[] = FFMPEG_SETUP_IMPORT_ERROR_CODES;
const OTHER_CODES = IMPORT_MEDIA_ERROR_CODES.filter(
  (code) => !SETUP_CODES.includes(code),
);

describe("isFfmpegSetupImportError", () => {
  it("accepts the two codes that the FFmpeg settings can correct", () => {
    expect([...FFMPEG_SETUP_IMPORT_ERROR_CODES].sort()).toEqual([
      "ffmpegPairMissing",
      "ffprobeSpawnFailed",
    ]);
    for (const code of FFMPEG_SETUP_IMPORT_ERROR_CODES) {
      expect(isFfmpegSetupImportError(code)).toBe(true);
    }
  });

  it("refuses an ffprobe that ran, and every other code", () => {
    // These point at the file, not at the settings.
    expect(isFfmpegSetupImportError("ffprobeProcessFailed")).toBe(false);
    expect(isFfmpegSetupImportError("ffprobeParseFailed")).toBe(false);
    expect(isFfmpegSetupImportError("ffprobeTimedOut")).toBe(false);
    for (const code of OTHER_CODES) {
      expect(isFfmpegSetupImportError(code)).toBe(false);
    }
  });
});

describe("importErrorActions", () => {
  it("offers Open Settings first, then Choose Another File, for a setup error with no video", () => {
    for (const code of SETUP_CODES) {
      expect(importErrorActions(code, "empty")).toEqual(["openSettings", "chooseFile"]);
    }
  });

  it("offers only Choose Another File for every other error with no video", () => {
    for (const code of OTHER_CODES) {
      expect(importErrorActions(code, "empty")).toEqual(["chooseFile"]);
    }
  });

  it("offers only Open Settings in the banner over an open video", () => {
    for (const code of SETUP_CODES) {
      expect(importErrorActions(code, "banner")).toEqual(["openSettings"]);
    }
    for (const code of OTHER_CODES) {
      expect(importErrorActions(code, "banner")).toEqual([]);
    }
  });

  it("covers every import error code, so no error is left without a next step", () => {
    for (const code of IMPORT_MEDIA_ERROR_CODES) {
      expect(importErrorActions(code, "empty").length).toBeGreaterThan(0);
    }
  });
});

describe("importErrorHintKey", () => {
  it("gives the FFmpeg hint to a setup error only", () => {
    for (const code of SETUP_CODES) {
      expect(importErrorHintKey(code)).toBe("preview.importError.ffmpegHint");
    }
    for (const code of OTHER_CODES) {
      expect(importErrorHintKey(code)).toBeNull();
    }
  });

  it("names a message in both catalogs", () => {
    expect(en.preview.importError.ffmpegHint).not.toBe("");
    expect(zhCN.preview.importError.ffmpegHint).not.toBe("");
  });

  it("quotes the label of the Choose Another File button in both catalogs", () => {
    // The hint tells the user which button to press, so a changed label must change it too.
    // Running text names a label without its ellipsis, so the hint quotes the label up to the
    // ellipsis, and it does not quote the ellipsis.
    for (const catalog of [en, zhCN]) {
      const label = catalog.preview.importError.chooseAnother;
      expect(label.endsWith("…")).toBe(true);
      expect(catalog.preview.importError.ffmpegHint).toContain(label.slice(0, -1));
      expect(catalog.preview.importError.ffmpegHint).not.toContain(label);
    }
  });
});

describe("resolveNoticeTimer", () => {
  it("never removes an import error by itself", () => {
    expect(resolveNoticeTimer("import", "shown", false)).toBeNull();
    expect(resolveNoticeTimer("import", "shown", true)).toBeNull();
    expect(resolveNoticeTimer("import", "leaving", false)).toBeNull();
  });

  it("starts the exit of a playback error after about five seconds", () => {
    expect(PLAYBACK_NOTICE_DURATION_MS).toBe(5000);
    expect(resolveNoticeTimer("playback", "shown", false)).toEqual({
      action: "leave",
      delayMs: PLAYBACK_NOTICE_DURATION_MS,
    });
  });

  it("removes a leaving playback error when its exit animation ends", () => {
    expect(resolveNoticeTimer("playback", "leaving", false)).toEqual({
      action: "dismiss",
      delayMs: NOTICE_EXIT_DURATION_MS,
    });
    expect(NOTICE_EXIT_DURATION_MS).toBeLessThan(PLAYBACK_NOTICE_DURATION_MS);
  });

  it("runs no timer while the pointer is over the notice or the focus is in it", () => {
    expect(resolveNoticeTimer("playback", "shown", true)).toBeNull();
    expect(resolveNoticeTimer("playback", "leaving", true)).toBeNull();
  });

  it("gives the full duration again after a pause", () => {
    // The pause ends, and the notice is shown again: the next step is the full wait.
    const afterPause = resolveNoticeTimer("playback", "shown", false);
    expect(afterPause?.delayMs).toBe(PLAYBACK_NOTICE_DURATION_MS);
  });
});
