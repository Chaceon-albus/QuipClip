import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { openPngSaveDialog } from "./store";
import { BACKEND_FRAME_EXPORT_ERROR_CODES, FRAME_EXPORT_ERROR_CODES } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

/**
 * Reads the variants of the Rust enum `name` out of `file`, in their order, as the camel-case
 * names that `#[serde(rename_all = "camelCase")]` gives them. The enum body is matched rather
 * than the whole file, so another enum cannot contribute a variant.
 */
function readRustEnum(file: string, name: string): string[] {
  const source = readFileSync(
    fileURLToPath(new URL(`../../../src-tauri/src/${file}`, import.meta.url)),
    "utf8",
  );
  const body = new RegExp(`\\npub enum ${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(
    source,
  );
  expect(body).not.toBeNull();
  const variants = body![1].matchAll(/^ {4}([A-Z][A-Za-z]+),$/gm);
  return Array.from(variants, (match) => match[1][0].toLowerCase() + match[1].slice(1));
}

describe("Export Frame wire types (ADR 069)", () => {
  it("names the failures as the Rust FrameExportErrorCode does, in its order", () => {
    expect(readRustEnum("commands/frame_export.rs", "FrameExportErrorCode")).toEqual([
      ...BACKEND_FRAME_EXPORT_ERROR_CODES,
    ]);
  });

  it("names the folder of a missing or refused destination as the export does", () => {
    for (const code of ["outputDirectoryMissing", "outputNotWritable"] as const) {
      expect(en.frameExportError[code]).toContain("destination folder");
      expect(zhCN.frameExportError[code]).toContain("目标文件夹");
    }
  });

  it("has a message for every code in both catalogs", () => {
    for (const code of FRAME_EXPORT_ERROR_CODES) {
      expect(en.frameExportError[code], code).toBeTypeOf("string");
      expect(zhCN.frameExportError[code], code).toBeTypeOf("string");
    }
    expect(Object.keys(en.frameExportError).sort()).toEqual(
      [...FRAME_EXPORT_ERROR_CODES].sort(),
    );
  });
});

describe("openPngSaveDialog", () => {
  it("opens the dialog with the PNG filter and the offered name", async () => {
    const saveDialog = vi.fn(() => Promise.resolve("/out/a.png"));
    expect(
      await openPngSaveDialog({
        defaultName: "clip_00-00-01-000.png",
        filterName: "PNG Images",
        saveDialog,
      }),
    ).toBe("/out/a.png");
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: "clip_00-00-01-000.png",
      filters: [{ name: "PNG Images", extensions: ["png"] }],
    });
  });

  it("answers null for a cancel, and rejects when the dialog fails", async () => {
    expect(
      await openPngSaveDialog({
        defaultName: "a.png",
        filterName: "PNG",
        saveDialog: vi.fn(() => Promise.resolve(null)),
      }),
    ).toBeNull();
    await expect(
      openPngSaveDialog({
        defaultName: "a.png",
        filterName: "PNG",
        saveDialog: vi.fn(() => Promise.reject(new Error("no window"))),
      }),
    ).rejects.toThrow();
  });
});
