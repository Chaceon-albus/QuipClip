import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseFfmpegDownloadOffer,
  parseFfmpegInstallMessage,
  parseFfmpegInstallStarted,
  toFfmpegInstallError,
} from "./protocol";
import { FFMPEG_INSTALL_ERROR_CODES, FfmpegInstallError } from "./types";

const OFFER = {
  version: "9.0.2",
  source: "github.com/GyanD/codexffmpeg",
  license: { gpl: true, nonfree: false, version3: true },
  downloadSize: 257_736_868,
  directory: "C:\\Users\\u\\AppData\\Local\\io.github.capric98.quipclip\\bin",
  replaces: false,
};

/** The variants of `InstallErrorCode` in Rust, in camel case. */
function readRustErrorCodes(): string[] {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../../src-tauri/src/ffmpeg/install/mod.rs", import.meta.url),
    ),
    "utf8",
  );
  const body = /pub enum InstallErrorCode \{([\s\S]*?)\n\}/.exec(source);
  expect(body).not.toBeNull();
  // A rename of one variant would change its wire name, and this reading would miss it.
  expect(body![1]).not.toMatch(/#\[serde/);
  const variants = body![1].matchAll(/^\s*([A-Z][A-Za-z0-9]*),\s*$/gm);
  return Array.from(variants, (match) => match[1][0].toLowerCase() + match[1].slice(1));
}

describe("FFMPEG_INSTALL_ERROR_CODES", () => {
  it("names each error code of Rust, in the same order", () => {
    expect([...FFMPEG_INSTALL_ERROR_CODES]).toEqual(readRustErrorCodes());
  });
});

describe("parseFfmpegDownloadOffer", () => {
  it("reads an offer", () => {
    expect(parseFfmpegDownloadOffer(OFFER)).toEqual(OFFER);
  });

  it("refuses an offer of the wrong shape", () => {
    for (const reply of [
      null,
      [],
      { ...OFFER, version: "" },
      { ...OFFER, source: 1 },
      { ...OFFER, license: { gpl: true } },
      { ...OFFER, downloadSize: 0 },
      { ...OFFER, downloadSize: -1 },
      { ...OFFER, downloadSize: 1.5 },
      { ...OFFER, directory: "" },
      { ...OFFER, replaces: "no" },
    ]) {
      expect(parseFfmpegDownloadOffer(reply)).toBeNull();
    }
  });
});

describe("parseFfmpegInstallStarted", () => {
  it("reads a job id above zero", () => {
    expect(parseFfmpegInstallStarted({ jobId: 3 })).toEqual({ jobId: 3 });
    expect(parseFfmpegInstallStarted({ jobId: 0 })).toBeNull();
    expect(parseFfmpegInstallStarted({ jobId: "3" })).toBeNull();
    expect(parseFfmpegInstallStarted(null)).toBeNull();
  });
});

describe("parseFfmpegInstallMessage", () => {
  it("reads the progress of the download with its byte counts", () => {
    expect(
      parseFfmpegInstallMessage({
        type: "progress",
        phase: "download",
        received: 5,
        total: 10,
      }),
    ).toEqual({
      kind: "progress",
      progress: { phase: "download", received: 5, total: 10 },
    });
  });

  it("reads each other step without byte counts", () => {
    for (const phase of ["extract", "check", "install"]) {
      expect(parseFfmpegInstallMessage({ type: "progress", phase })).toEqual({
        kind: "progress",
        progress: { phase, received: null, total: null },
      });
    }
  });

  it("refuses a progress message of the wrong shape", () => {
    for (const message of [
      { type: "progress", phase: "download" },
      { type: "progress", phase: "download", received: 11, total: 10 },
      { type: "progress", phase: "extract", received: 1, total: 2 },
      { type: "progress", phase: "unpack" },
    ]) {
      expect(parseFfmpegInstallMessage(message)).toEqual({ kind: "invalid" });
    }
  });

  it("reads each end", () => {
    expect(parseFfmpegInstallMessage({ type: "end", outcome: "installed" })).toEqual({
      kind: "end",
      end: { outcome: "installed" },
    });
    expect(parseFfmpegInstallMessage({ type: "end", outcome: "canceled" })).toEqual({
      kind: "end",
      end: { outcome: "canceled" },
    });
    expect(
      parseFfmpegInstallMessage({
        type: "end",
        outcome: "failed",
        error: { code: "hashMismatch", detail: "the file has the SHA-256 x" },
      }),
    ).toEqual({
      kind: "end",
      end: {
        outcome: "failed",
        code: "hashMismatch",
        detail: "the file has the SHA-256 x",
      },
    });
    expect(
      parseFfmpegInstallMessage({
        type: "end",
        outcome: "failed",
        error: { code: "networkFailed" },
      }),
    ).toEqual({
      kind: "end",
      end: { outcome: "failed", code: "networkFailed", detail: null },
    });
  });

  it("refuses an end of the wrong shape", () => {
    for (const message of [
      { type: "end", outcome: "failed" },
      { type: "end", outcome: "failed", error: { code: "invalidResponse" } },
      { type: "end", outcome: "failed", error: { code: "busy", detail: 1 } },
      { type: "end", outcome: "installed", error: { code: "busy" } },
      { type: "end", outcome: "done" },
      { type: "chunk" },
      "end",
    ]) {
      expect(parseFfmpegInstallMessage(message)).toEqual({ kind: "invalid" });
    }
  });
});

describe("toFfmpegInstallError", () => {
  it("keeps a known error and its detail", () => {
    const error = toFfmpegInstallError({ code: "busy" });
    expect(error).toBeInstanceOf(FfmpegInstallError);
    expect(error.code).toBe("busy");
    expect(error.detail).toBeNull();
    expect(toFfmpegInstallError({ code: "httpStatus", detail: "404" }).detail).toBe(
      "404",
    );
  });

  it("makes any other rejection a command failure with its text", () => {
    const error = toFfmpegInstallError("Command start_ffmpeg_install not allowed");
    expect(error.code).toBe("commandExecutionFailed");
    expect(error.detail).toBe("Command start_ffmpeg_install not allowed");
    expect(toFfmpegInstallError({ code: "invalidResponse" }).code).toBe(
      "commandExecutionFailed",
    );
  });
});
