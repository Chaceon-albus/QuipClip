import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOUDNESS_RUN_ERROR_CODES, LOUDNESS_START_ERROR_CODES } from "./types";

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

describe("loudness wire types (ADR 061)", () => {
  it("names the failures of the run as the Rust RunCode does, in its order", () => {
    expect(readRustEnum("ffmpeg/loudness/job.rs", "RunCode")).toEqual([
      ...LOUDNESS_RUN_ERROR_CODES,
    ]);
  });

  it("names the refusals of the start as the Rust command does, in its order", () => {
    expect(readRustEnum("commands/loudness.rs", "LoudnessStartErrorCode")).toEqual([
      ...LOUDNESS_START_ERROR_CODES,
    ]);
  });
});
