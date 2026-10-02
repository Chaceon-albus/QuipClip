import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS, type BackendCommand } from "@/lib/ipc";
import {
  BACKEND_PRESET_TEST_ERROR_CODES,
  MAX_PRESET_TEST_LINE_BYTES,
  normalizePresetTestError,
  PRESET_TEST_FIELDS,
  PRESET_TEST_STATUSES,
  PresetTestError,
  presetTestFingerprint,
  presetTestResults,
  testPreset,
  validatePresetTestedPayload,
  validatePresetTestResponse,
  validatePresetTestResult,
  validatePresetTestResults,
} from "./presetTest";
import type { Preset } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function preset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-h264-mp4",
    name: "H.264 MP4",
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    pixelFormat: "yuv420p",
    videoOptions: [{ name: "preset", value: "slow" }],
    audioOptions: [],
    ...overrides,
  };
}

function readRust(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../src-tauri/src/${file}`, import.meta.url)),
    "utf8",
  );
}

const TESTED_AT = 1_790_000_000;

describe("the wire vocabulary of the preset test", () => {
  it("names the statuses of the Rust enum, in its order", () => {
    // The enum carries `rename_all = "camelCase"`, so a variant crosses as its name with the
    // first letter lowered.
    const declaration =
      /#\[serde\(rename_all = "camelCase"\)\]\npub enum PresetTestStatus \{\n([\s\S]*?)\n\}\n/.exec(
        readRust("ffmpeg/capabilities/preset_test.rs"),
      );
    expect(declaration).not.toBeNull();
    const variants = Array.from(
      declaration![1].matchAll(/^ {4}([A-Z][A-Za-z0-9]*),$/gm),
      (match) => match[1][0].toLowerCase() + match[1].slice(1),
    );
    expect(variants).toEqual([...PRESET_TEST_STATUSES]);
  });

  it("names the error codes of the Rust list, in its order", () => {
    const list = /preset_test_error_codes! \{\n([\s\S]*?)\n\}\n/.exec(
      readRust("commands/preset_test.rs"),
    );
    expect(list).not.toBeNull();
    const codes = Array.from(
      list![1].matchAll(/^ {4}[A-Z][A-Za-z0-9]* => "([a-zA-Z]+)",$/gm),
      (match) => match[1],
    );
    expect(codes).toEqual([...BACKEND_PRESET_TEST_ERROR_CODES]);
  });

  it("bounds the line as Rust cuts it", () => {
    expect(readRust("ffmpeg/capabilities/preset_test.rs")).toContain(
      `pub const MAX_LINE_BYTES: usize = ${MAX_PRESET_TEST_LINE_BYTES};`,
    );
  });
});

describe("validatePresetTestResult", () => {
  it("reads each status, with and without its optional fields", () => {
    expect(validatePresetTestResult({ status: "passed", testedAt: TESTED_AT })).toEqual(
      {
        status: "passed",
        testedAt: TESTED_AT,
      },
    );
    expect(
      validatePresetTestResult({
        status: "failed",
        line: "[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)",
        exitCode: 183,
        testedAt: TESTED_AT,
      }),
    ).toEqual({
      status: "failed",
      line: "[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)",
      exitCode: 183,
      testedAt: TESTED_AT,
    });
    for (const status of PRESET_TEST_STATUSES) {
      expect(validatePresetTestResult({ status, testedAt: TESTED_AT })?.status).toBe(
        status,
      );
    }
  });

  it("keeps a negative exit code, which a signal or a Windows status can give", () => {
    expect(
      validatePresetTestResult({ status: "failed", exitCode: -22, testedAt: TESTED_AT })
        ?.exitCode,
    ).toBe(-22);
  });

  it("refuses a value that Rust does not write", () => {
    const refused: unknown[] = [
      null,
      "passed",
      [],
      {},
      { status: "exploded", testedAt: TESTED_AT },
      { status: "passed" },
      { status: "passed", testedAt: 0 },
      { status: "passed", testedAt: 4_294_967_296 },
      { status: "passed", testedAt: 1.5 },
      { status: "passed", testedAt: TESTED_AT, line: "" },
      { status: "passed", testedAt: TESTED_AT, line: 7 },
      { status: "passed", testedAt: TESTED_AT, line: "x".repeat(513) },
      { status: "failed", testedAt: TESTED_AT, exitCode: 2_147_483_648 },
      { status: "failed", testedAt: TESTED_AT, exitCode: "1" },
      { status: "passed", testedAt: TESTED_AT, line: null },
      { status: "passed", testedAt: TESTED_AT, extra: true },
    ];
    for (const value of refused) {
      expect(validatePresetTestResult(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("accepts a line of exactly the bound", () => {
    expect(
      validatePresetTestResult({
        status: "passedWithWarnings",
        line: "x".repeat(MAX_PRESET_TEST_LINE_BYTES),
        testedAt: TESTED_AT,
      }),
    ).not.toBeNull();
  });
});

describe("validatePresetTestResults", () => {
  it("reads the entries in their order", () => {
    expect(
      validatePresetTestResults({
        results: [
          { presetId: "a", result: { status: "passed", testedAt: TESTED_AT } },
          { presetId: "b", result: { status: "timedOut", testedAt: TESTED_AT } },
        ],
      }),
    ).toEqual([
      { presetId: "a", result: { status: "passed", testedAt: TESTED_AT } },
      { presetId: "b", result: { status: "timedOut", testedAt: TESTED_AT } },
    ]);
    expect(validatePresetTestResults({ results: [] })).toEqual([]);
  });

  it("refuses a malformed list as a whole", () => {
    const good = { presetId: "a", result: { status: "passed", testedAt: TESTED_AT } };
    const refused: unknown[] = [
      null,
      [],
      { results: null },
      { results: [null] },
      { results: [{ presetId: "", result: good.result }] },
      { results: [{ presetId: "a", result: { status: "nope", testedAt: TESTED_AT } }] },
      { results: [good, good] },
    ];
    for (const value of refused) {
      expect(validatePresetTestResults(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("normalizePresetTestError", () => {
  it("keeps a known code and its detail", () => {
    const error = normalizePresetTestError({
      code: "ffmpegSpawnFailed",
      detail: "No such file or directory (os error 2)",
    });
    expect(error).toBeInstanceOf(PresetTestError);
    expect(error.code).toBe("ffmpegSpawnFailed");
    expect(error.detail).toBe("No such file or directory (os error 2)");
    expect(normalizePresetTestError({ code: "exportRunning" }).detail).toBeUndefined();
  });

  it("reads every other rejection as unknown", () => {
    expect(normalizePresetTestError({ code: "nope" }).code).toBe("unknown");
    expect(normalizePresetTestError(null).code).toBe("unknown");
    // Tauri rejects with a string when the preset does not deserialize.
    const text = normalizePresetTestError(
      "invalid args `preset` for command `test_preset`",
    );
    expect(text.code).toBe("unknown");
    expect(text.detail).toBe("invalid args `preset` for command `test_preset`");
  });

  it("returns an error that is already normalized as it is", () => {
    const error = new PresetTestError("invalidPreset", "presets[0].name is blank");
    expect(normalizePresetTestError(error)).toBe(error);
  });
});

describe("validatePresetTestedPayload", () => {
  it("reads the label of the window, and refuses anything else", () => {
    expect(validatePresetTestedPayload({ origin: "settings" })).toEqual({
      origin: "settings",
    });
    expect(validatePresetTestedPayload({ origin: "" })).toBeNull();
    expect(validatePresetTestedPayload({})).toBeNull();
    expect(validatePresetTestedPayload("settings")).toBeNull();
  });
});

describe("presetTestFingerprint", () => {
  /**
   * Another value for each field of a preset. The type names every field, so a new field of
   * `Preset` fails the type check here too, until this test says what a change of it does.
   */
  const OTHER_VALUES: { readonly [Field in keyof Preset]-?: Preset[Field] } = {
    id: "copy",
    name: "My copy",
    container: "mkv",
    videoEncoder: "libx265",
    audioEncoder: "libopus",
    audioBitrate: 96,
    audioSampleRate: 44_100,
    audioChannels: "mono",
    quality: { kind: "cq", value: 20 },
    resolution: { w: 1280, h: 720 },
    frameRate: { n: 24, d: 1 },
    pixelFormat: "yuv420p10le",
    videoOptions: [{ name: "preset", value: "veryslow" }],
    audioOptions: [{ name: "application", value: "audio" }],
  };

  it("reads the fields that build_test_arguments reads in Rust, and no other", () => {
    expect([...PRESET_TEST_FIELDS]).toEqual([
      "container",
      "videoEncoder",
      "audioEncoder",
      "audioBitrate",
      "audioSampleRate",
      "audioChannels",
      "quality",
      "pixelFormat",
      "videoOptions",
      "audioOptions",
    ]);
  });

  it("changes with each field that reaches the test, and with no other field", () => {
    const base = presetTestFingerprint(preset());
    for (const field of Object.keys(OTHER_VALUES) as (keyof Preset)[]) {
      const changed = presetTestFingerprint(preset({ [field]: OTHER_VALUES[field] }));
      if (PRESET_TEST_FIELDS.includes(field)) {
        expect(changed, field).not.toBe(base);
      } else {
        expect(changed, field).toBe(base);
      }
    }
  });

  it("tells an absent audio bitrate from a bitrate, and one quality value from another", () => {
    const base = presetTestFingerprint(preset());
    expect(presetTestFingerprint(preset({ audioBitrate: undefined }))).not.toBe(base);
    expect(
      presetTestFingerprint(preset({ quality: { kind: "crf", value: 21 } })),
    ).not.toBe(base);
    expect(presetTestFingerprint(preset({ videoOptions: [] }))).not.toBe(base);
  });

  it("does not depend on the order of the keys of an object", () => {
    // A document from Rust and a draft of the editor can build the same values in another
    // key order.
    const reordered = preset({
      quality: { value: 20, kind: "crf" },
      videoOptions: [{ value: "slow", name: "preset" }],
    });
    expect(presetTestFingerprint(reordered)).toBe(presetTestFingerprint(preset()));
  });

  it("keeps the order of the options, which is the order of the command", () => {
    const a = { name: "g", value: "250" };
    const b = { name: "bf", value: "3" };
    expect(presetTestFingerprint(preset({ videoOptions: [a, b] }))).not.toBe(
      presetTestFingerprint(preset({ videoOptions: [b, a] })),
    );
  });
});

describe("validatePresetTestResponse", () => {
  it("reads the result and whether Rust stored it", () => {
    expect(
      validatePresetTestResponse({
        result: { status: "passed", testedAt: TESTED_AT },
        stored: false,
      }),
    ).toEqual({ result: { status: "passed", testedAt: TESTED_AT }, stored: false });
  });

  it("refuses a response that Rust does not write", () => {
    const good = { status: "passed", testedAt: TESTED_AT };
    for (const value of [
      null,
      good,
      { result: good },
      { result: good, stored: "yes" },
      { result: { status: "x", testedAt: TESTED_AT }, stored: true },
      { result: good, stored: true, extra: 1 },
    ]) {
      expect(validatePresetTestResponse(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("the client", () => {
  it("sends the whole preset to test_preset and validates the response", async () => {
    const invoke = vi.fn().mockResolvedValue({
      result: { status: "passed", testedAt: TESTED_AT },
      stored: true,
    });
    const draft = preset({ name: "Unsaved draft" });

    const response = await testPreset(draft, {
      invoke: invoke as <T>(
        cmd: BackendCommand,
        args?: Record<string, unknown>,
      ) => Promise<T>,
    });

    expect(response).toEqual({
      result: { status: "passed", testedAt: TESTED_AT },
      stored: true,
    });
    expect(invoke).toHaveBeenCalledWith(BACKEND_COMMANDS.TEST_PRESET, {
      preset: draft,
    });
  });

  it("normalizes a rejection and refuses a malformed response", async () => {
    const rejecting = vi.fn().mockRejectedValue({ code: "exportRunning" });
    await expect(
      testPreset(preset(), {
        invoke: rejecting as <T>(
          cmd: BackendCommand,
          args?: Record<string, unknown>,
        ) => Promise<T>,
      }),
    ).rejects.toMatchObject({ code: "exportRunning" });

    // The result alone, the shape before `stored`, is not a response.
    const malformed = vi
      .fn()
      .mockResolvedValue({ status: "passed", testedAt: TESTED_AT });
    await expect(
      testPreset(preset(), {
        invoke: malformed as <T>(
          cmd: BackendCommand,
          args?: Record<string, unknown>,
        ) => Promise<T>,
      }),
    ).rejects.toMatchObject({ code: "unknown" });
  });

  it("reads the stored results from preset_test_results", async () => {
    const invoke = vi.fn().mockResolvedValue({
      results: [{ presetId: "a", result: { status: "failed", testedAt: TESTED_AT } }],
    });

    const entries = await presetTestResults({
      invoke: invoke as <T>(
        cmd: BackendCommand,
        args?: Record<string, unknown>,
      ) => Promise<T>,
    });

    expect(entries).toEqual([
      { presetId: "a", result: { status: "failed", testedAt: TESTED_AT } },
    ]);
    expect(invoke).toHaveBeenCalledWith(BACKEND_COMMANDS.PRESET_TEST_RESULTS);

    const malformed = vi.fn().mockResolvedValue({ results: [{}] });
    await expect(
      presetTestResults({
        invoke: malformed as <T>(
          cmd: BackendCommand,
          args?: Record<string, unknown>,
        ) => Promise<T>,
      }),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});
