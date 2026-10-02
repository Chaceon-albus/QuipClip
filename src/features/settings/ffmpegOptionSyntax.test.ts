import { describe, expect, it } from "vitest";

import {
  importOptionsText,
  renderOptionsText,
  type OptionImportResult,
  type OptionSyntaxError,
} from "./ffmpegOptionSyntax";
import { DENIED_OPTION_NAMES } from "./limits";
import { createPresetDraft } from "./presetDocument";
import type { Preset, PresetOption } from "./types";

/** The preset an import starts from in these tests: the draft of a new preset. */
function base(): Preset {
  return createPresetDraft("preset-1", "Preset");
}

function option(name: string, value: string): PresetOption {
  return { name, value };
}

/** The preset of a successful import, or a failed test with the errors. */
function imported(text: string, draft: Preset = base()): Preset {
  const result = importOptionsText(text, draft);
  if (!result.ok) {
    throw new Error(`import failed: ${JSON.stringify(result.errors)}`);
  }
  return result.preset;
}

/** The errors of a failed import, or a failed test. */
function errorsOf(text: string, draft: Preset = base()): OptionSyntaxError[] {
  const result = importOptionsText(text, draft);
  if (result.ok) {
    throw new Error(`import succeeded: ${JSON.stringify(result.preset)}`);
  }
  return result.errors;
}

/** Renders the option lists of `preset` and imports the text into the same preset. */
function roundTrip(preset: Preset): OptionImportResult {
  return importOptionsText(renderOptionsText(preset), preset);
}

// The five blocks the user exports with, verbatim.
const VIDEOTOOLBOX_HEVC = String.raw`-c:v hevc_videotoolbox \
-profile:v main10 -pix_fmt p010le \
-q:v 80 -b:v 0 \
-realtime 0 -prio_speed 0 -power_efficient 0 \
-spatial_aq 1 \
-bf 3 -g 300 \
-allow_sw 0 \
-tag:v hvc1`;

const X264 =
  '-c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -x264-params "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0:qcomp=0.65:rc-lookahead=60:bframes=6:b-adapt=2"';

const SVT_AV1 =
  '-c:v libsvtav1 -preset 5 -crf 38 -pix_fmt yuv420p10le -g 250 -svtav1-params "tune=0:enable-variance-boost=1:variance-boost-strength=2:film-grain=0"';

const NVENC_H264 =
  "-c:v h264_nvenc -preset p7 -tune hq -pix_fmt yuv420p -rc vbr -cq 25 -b:v 0 -maxrate 24M -bufsize 48M -multipass fullres -rc-lookahead 32 -spatial-aq 1 -temporal-aq 1 -aq-strength 8 -bf 3 -b_ref_mode middle -g 250";

const NVENC_HEVC =
  "-c:v hevc_nvenc -preset p7 -tune hq -pix_fmt p010le -rc vbr -cq 25 -b:v 0 -maxrate 16M -bufsize 32M -multipass fullres -rc-lookahead 32 -spatial-aq 1 -temporal-aq 1 -aq-strength 8 -bf 3 -b_ref_mode middle -g 250";

/** The NVENC options of both NVENC blocks, with the bitrate caps of each one. */
function nvencOptions(maxrate: string, bufsize: string): PresetOption[] {
  return [
    option("preset", "p7"),
    option("tune", "hq"),
    option("rc", "vbr"),
    option("maxrate", maxrate),
    option("bufsize", bufsize),
    option("multipass", "fullres"),
    option("rc-lookahead", "32"),
    option("spatial-aq", "1"),
    option("temporal-aq", "1"),
    option("aq-strength", "8"),
    option("bf", "3"),
    option("b_ref_mode", "middle"),
    option("g", "250"),
  ];
}

describe("importOptionsText", () => {
  describe("the five user blocks", () => {
    it("imports the VideoToolbox HEVC block, with its line continuations", () => {
      const result = importOptionsText(VIDEOTOOLBOX_HEVC, base());
      expect(result).toEqual({
        ok: true,
        preset: {
          ...base(),
          videoEncoder: "hevc_videotoolbox",
          pixelFormat: "p010le",
          quality: { kind: "qualityScale", value: 80 },
          videoOptions: [
            option("profile", "main10"),
            option("realtime", "0"),
            option("prio_speed", "0"),
            option("power_efficient", "0"),
            option("spatial_aq", "1"),
            option("bf", "3"),
            option("g", "300"),
            option("allow_sw", "0"),
            option("tag", "hvc1"),
          ],
          audioOptions: [],
        },
        notes: [
          { code: "movedToFields", flags: ["-c:v", "-pix_fmt", "-q:v"] },
          { code: "zeroBitrateConstant" },
        ],
      });
    });

    it("imports the x264 block, with its quoted parameters", () => {
      expect(importOptionsText(X264, base())).toEqual({
        ok: true,
        preset: {
          ...base(),
          videoEncoder: "libx264",
          pixelFormat: "yuv420p",
          quality: { kind: "crf", value: 20 },
          videoOptions: [
            option("preset", "slow"),
            option(
              "x264-params",
              "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0:qcomp=0.65:rc-lookahead=60:bframes=6:b-adapt=2",
            ),
          ],
          audioOptions: [],
        },
        notes: [{ code: "movedToFields", flags: ["-c:v", "-crf", "-pix_fmt"] }],
      });
    });

    it("imports the SVT-AV1 block", () => {
      expect(importOptionsText(SVT_AV1, base())).toEqual({
        ok: true,
        preset: {
          ...base(),
          videoEncoder: "libsvtav1",
          pixelFormat: "yuv420p10le",
          quality: { kind: "crf", value: 38 },
          videoOptions: [
            option("preset", "5"),
            option("g", "250"),
            option(
              "svtav1-params",
              "tune=0:enable-variance-boost=1:variance-boost-strength=2:film-grain=0",
            ),
          ],
          audioOptions: [],
        },
        notes: [{ code: "movedToFields", flags: ["-c:v", "-crf", "-pix_fmt"] }],
      });
    });

    it("imports the NVENC H.264 block, and absorbs -b:v 0 into the cq kind", () => {
      expect(importOptionsText(NVENC_H264, base())).toEqual({
        ok: true,
        preset: {
          ...base(),
          videoEncoder: "h264_nvenc",
          pixelFormat: "yuv420p",
          quality: { kind: "cq", value: 25 },
          videoOptions: nvencOptions("24M", "48M"),
          audioOptions: [],
        },
        notes: [
          { code: "movedToFields", flags: ["-c:v", "-pix_fmt", "-cq"] },
          { code: "zeroBitrateCq" },
        ],
      });
    });

    it("imports the NVENC HEVC block", () => {
      expect(importOptionsText(NVENC_HEVC, base())).toEqual({
        ok: true,
        preset: {
          ...base(),
          videoEncoder: "hevc_nvenc",
          pixelFormat: "p010le",
          quality: { kind: "cq", value: 25 },
          videoOptions: nvencOptions("16M", "32M"),
          audioOptions: [],
        },
        notes: [
          { code: "movedToFields", flags: ["-c:v", "-pix_fmt", "-cq"] },
          { code: "zeroBitrateCq" },
        ],
      });
    });

    it.each([VIDEOTOOLBOX_HEVC, X264, SVT_AV1, NVENC_H264, NVENC_HEVC])(
      "renders an imported block to a text that imports to the same preset: %#",
      (text) => {
        const preset = imported(text);
        expect(roundTrip(preset)).toEqual({ ok: true, preset, notes: [] });
      },
    );
  });

  describe("the text", () => {
    it("reads the line continuations of cmd.exe and PowerShell, and CRLF line ends", () => {
      const expected = imported("-preset slow -tune film -g 250");
      expect(imported("-preset slow ^\r\n-tune film ^\r\n-g 250")).toEqual(expected);
      expect(imported("-preset slow `\n-tune film `\n-g 250")).toEqual(expected);
      expect(imported("-preset slow \\   \n-tune film\n\n-g 250\n")).toEqual(expected);
      // A continuation joins the next line to the word in front of it, as in a shell.
      expect(imported("-preset sl\\\now").videoOptions).toEqual([
        option("preset", "slow"),
      ]);
      // A continuation at the end of the text ends the text.
      expect(imported("-g 250 \\").videoOptions).toEqual([option("g", "250")]);
    });

    it("keeps a continuation character that is not at the end of its line", () => {
      expect(
        imported(String.raw`-stats_file C:\enc\pass.log -xa a^b -xb a${"`"}b`)
          .videoOptions,
      ).toEqual([
        option("stats_file", String.raw`C:\enc\pass.log`),
        option("xa", "a^b"),
        option("xb", "a`b"),
      ]);
    });

    it("reads double quotes, single quotes, and quoted parts joined to a word", () => {
      expect(
        imported(
          String.raw`-xa "x y" -xb 'p q r' -xc "say \\ \x" -xd pre"fix "post -xe ''x`,
          base(),
        ).videoOptions,
      ).toEqual([
        option("xa", "x y"),
        option("xb", "p q r"),
        option("xc", String.raw`say \ \x`),
        option("xd", "prefix post"),
        option("xe", "x"),
      ]);
    });

    it("reads an escaped double quote, and the value rule then refuses it", () => {
      // A value may hold no double quote: the Windows quoting of an argument would lengthen
      // it past the counted command line budget (ADR 040).
      expect(errorsOf(String.raw`-xb 'p "q" r' -xc "say \"hi\""`)).toEqual([
        { code: "optionValue", line: 1, column: 1, values: { flag: "-xb", max: 512 } },
        { code: "optionValue", line: 1, column: 15, values: { flag: "-xc", max: 512 } },
      ]);
    });

    it("reads a negative number and a quoted word that starts with - as values", () => {
      expect(imported('-g -1 -qp -0.5 -metadata_x "-x"').videoOptions).toEqual([
        option("g", "-1"),
        option("qp", "-0.5"),
        option("metadata_x", "-x"),
      ]);
    });

    it("routes :a to the audio list, and :v or no specifier to the video list", () => {
      const preset = imported(
        "-profile:v main -profile:a aac_low -g 120 -cutoff:a 18000",
      );
      expect(preset.videoOptions).toEqual([
        option("profile", "main"),
        option("g", "120"),
      ]);
      expect(preset.audioOptions).toEqual([
        option("profile", "aac_low"),
        option("cutoff", "18000"),
      ]);
    });

    it("replaces both lists, and keeps every field the text does not name", () => {
      const draft: Preset = {
        ...base(),
        videoEncoder: "libx265",
        quality: { kind: "crf", value: 24 },
        videoOptions: [option("preset", "medium")],
        audioOptions: [option("profile", "aac_low")],
      };
      expect(importOptionsText("-g 60", draft)).toEqual({
        ok: true,
        preset: { ...draft, videoOptions: [option("g", "60")], audioOptions: [] },
        notes: [],
      });
      expect(importOptionsText("   \n ", draft)).toEqual({
        ok: true,
        preset: { ...draft, videoOptions: [], audioOptions: [] },
        notes: [],
      });
    });
  });

  describe("the managed flags", () => {
    it("moves every managed flag into its field", () => {
      const preset = imported(
        "-c:v libx265 -c:a libopus -b:a 192k -ar 44100 -ac 1 -pix_fmt yuv420p10le -crf 26",
      );
      expect(preset).toEqual({
        ...base(),
        videoEncoder: "libx265",
        audioEncoder: "libopus",
        audioBitrate: 192,
        audioSampleRate: 44100,
        audioChannels: "mono",
        pixelFormat: "yuv420p10le",
        quality: { kind: "crf", value: 26 },
        videoOptions: [],
        audioOptions: [],
      });
      expect(imported("-ac 2").audioChannels).toBe("stereo");
      expect(imported("-crf:v 18 -ar:a 48000 -ac:a 2 -pix_fmt:v nv12")).toEqual({
        ...base(),
        quality: { kind: "crf", value: 18 },
        audioSampleRate: 48000,
        audioChannels: "stereo",
        pixelFormat: "nv12",
      });
    });

    it("reads a video bitrate in k, M, or bits per second as the bitrate kind", () => {
      expect(imported("-b:v 8000k").quality).toEqual({ kind: "bitrate", value: 8000 });
      expect(imported("-b:v 24M").quality).toEqual({ kind: "bitrate", value: 24_000 });
      expect(imported("-b:v 2.5M").quality).toEqual({ kind: "bitrate", value: 2500 });
      expect(imported("-b:v 6000000").quality).toEqual({
        kind: "bitrate",
        value: 6000,
      });
      expect(imported("-b:a 320000").audioBitrate).toBe(320);
    });

    it("applies the lossless rule to an imported audio encoder, unless -b:a names a bitrate", () => {
      const flac = imported("-c:a flac");
      expect(flac.audioEncoder).toBe("flac");
      expect("audioBitrate" in flac).toBe(false);
      expect(imported("-c:a flac -b:a 900k").audioBitrate).toBe(900);
      expect(imported("-b:a 900k -c:a flac").audioBitrate).toBe(900);
      expect(imported("-c:a aac", { ...flac }).audioBitrate).toBe(320);
    });

    it("absorbs -b:v 0 beside the constant-quality kind of the draft", () => {
      const cq: Preset = { ...base(), quality: { kind: "cq", value: 30 } };
      expect(importOptionsText("-b:v 0 -g 60", cq)).toEqual({
        ok: true,
        preset: { ...cq, videoOptions: [option("g", "60")] },
        notes: [{ code: "zeroBitrateCq" }],
      });
      // The kind of the text wins over the kind of the draft, in either order.
      expect(importOptionsText("-b:v 0 -crf 20", cq)).toEqual({
        ok: true,
        preset: { ...cq, quality: { kind: "crf", value: 20 } },
        notes: [
          { code: "movedToFields", flags: ["-crf"] },
          { code: "zeroBitrateConstant" },
        ],
      });
    });
  });

  describe("the errors", () => {
    it("reports a quote with no end on its line, and goes on at the next line", () => {
      expect(errorsOf('-xa "x y\n-xb 1 -xc')).toEqual([
        { code: "unterminatedQuote", line: 1, column: 5 },
        { code: "missingValue", line: 2, column: 7, values: { flag: "-xc" } },
      ]);
      expect(errorsOf("-xa 'x")).toEqual([
        { code: "unterminatedQuote", line: 1, column: 5 },
      ]);
    });

    it("reports a curly quote from pasted text, where it stands", () => {
      expect(errorsOf("-x264-params \u201Caq-mode=3:b-adapt=2\u201D")).toEqual([
        { code: "curlyQuote", line: 1, column: 14 },
        { code: "curlyQuote", line: 1, column: 34 },
      ]);
      expect(errorsOf("-preset \u2018slow\u2019")).toEqual([
        { code: "curlyQuote", line: 1, column: 9 },
        { code: "curlyQuote", line: 1, column: 14 },
      ]);
    });

    it("reports a value with no option in front of it", () => {
      expect(errorsOf("ffmpeg -g 1 slow")).toEqual([
        { code: "unexpectedValue", line: 1, column: 1, values: { value: "ffmpeg" } },
        { code: "unexpectedValue", line: 1, column: 13, values: { value: "slow" } },
      ]);
    });

    it("reports an option with no value, at the end and in front of another option", () => {
      expect(errorsOf("-preset -tune film\n-g")).toEqual([
        { code: "missingValue", line: 1, column: 1, values: { flag: "-preset" } },
        { code: "missingValue", line: 2, column: 1, values: { flag: "-g" } },
      ]);
      expect(errorsOf("-c:v")).toEqual([
        { code: "missingValue", line: 1, column: 1, values: { flag: "-c:v" } },
      ]);
    });

    it("reports a stream specifier other than :v and :a", () => {
      expect(errorsOf("-g:s 1 -bf:v:0 3 -b:v:0 1M -c:0 x")).toEqual([
        { code: "streamSpecifier", line: 1, column: 1, values: { flag: "-g:s" } },
        { code: "streamSpecifier", line: 1, column: 8, values: { flag: "-bf:v:0" } },
        { code: "streamSpecifier", line: 1, column: 18, values: { flag: "-b:v:0" } },
        { code: "streamSpecifier", line: 1, column: 28, values: { flag: "-c:0" } },
      ]);
    });

    it("reports an option name outside the rule", () => {
      expect(errorsOf("-/filter_complex x --g 1 -1x 2 -:v 3")).toEqual([
        {
          code: "optionName",
          line: 1,
          column: 1,
          values: { flag: "-/filter_complex" },
        },
        { code: "optionName", line: 1, column: 20, values: { flag: "--g" } },
        { code: "optionName", line: 1, column: 26, values: { flag: "-1x" } },
        { code: "optionName", line: 1, column: 32, values: { flag: "-:v" } },
      ]);
    });

    it("refuses every denied option, with or without a specifier and a value", () => {
      // A managed flag goes into its field before the deny list is asked.
      const managed = new Set([
        "c:a",
        "crf",
        "cq",
        "b:a",
        "ar",
        "ar:a",
        "ac",
        "ac:a",
        "pix_fmt",
      ]);
      for (const name of DENIED_OPTION_NAMES) {
        for (const flag of [`-${name}`, `-${name}:a`]) {
          if (managed.has(flag.slice(1))) {
            continue;
          }
          expect(errorsOf(`${flag} 1`)).toEqual([
            { code: "optionDenied", line: 1, column: 1, values: { flag } },
          ]);
        }
      }
      // An argument-less option before the next option takes no value from it.
      expect(errorsOf("-y -noshortest -g 1 -an")).toEqual([
        { code: "optionDenied", line: 1, column: 1, values: { flag: "-y" } },
        { code: "optionDenied", line: 1, column: 4, values: { flag: "-noshortest" } },
        { code: "optionDenied", line: 1, column: 21, values: { flag: "-an" } },
      ]);
      // A managed flag on the wrong stream is no managed flag, and the deny list refuses it.
      expect(errorsOf("-crf:a 20 -c 1 -b 2M -q 3")).toEqual([
        { code: "optionDenied", line: 1, column: 1, values: { flag: "-crf:a" } },
        { code: "optionDenied", line: 1, column: 11, values: { flag: "-c" } },
        { code: "optionDenied", line: 1, column: 16, values: { flag: "-b" } },
        { code: "optionDenied", line: 1, column: 22, values: { flag: "-q" } },
      ]);
    });

    it("reports an option or a managed flag that occurs twice", () => {
      expect(errorsOf("-g 1 -g:v 2 -g:a 3 -c:v x -c:v y")).toEqual([
        { code: "optionDuplicate", line: 1, column: 6, values: { flag: "-g:v" } },
        { code: "optionDuplicate", line: 1, column: 27, values: { flag: "-c:v" } },
      ]);
    });

    it("reports an empty value and one longer than 512 characters", () => {
      expect(errorsOf(`-xa "" -xb ${"x".repeat(513)}`)).toEqual([
        { code: "optionValue", line: 1, column: 1, values: { flag: "-xa", max: 512 } },
        { code: "optionValue", line: 1, column: 8, values: { flag: "-xb", max: 512 } },
      ]);
    });

    it("reports a managed number, bitrate, or channel count that it cannot read", () => {
      expect(errorsOf("-crf 20.5")).toEqual([
        {
          code: "integerValue",
          line: 1,
          column: 1,
          values: { flag: "-crf", value: "20.5" },
        },
      ]);
      expect(errorsOf("-q:v high")).toEqual([
        {
          code: "integerValue",
          line: 1,
          column: 1,
          values: { flag: "-q:v", value: "high" },
        },
      ]);
      expect(errorsOf("-ar 44.1k")).toEqual([
        {
          code: "integerValue",
          line: 1,
          column: 1,
          values: { flag: "-ar", value: "44.1k" },
        },
      ]);
      expect(errorsOf("-b:v 1500 -b:a 96kbps")).toEqual([
        {
          code: "bitrateValue",
          line: 1,
          column: 1,
          values: { flag: "-b:v", value: "1500" },
        },
        {
          code: "bitrateValue",
          line: 1,
          column: 11,
          values: { flag: "-b:a", value: "96kbps" },
        },
      ]);
      expect(errorsOf("-ac 6")).toEqual([
        {
          code: "channelsValue",
          line: 1,
          column: 1,
          values: { flag: "-ac", value: "6" },
        },
      ]);
    });

    it("reports two flags that both set the quality", () => {
      expect(errorsOf("-crf 20 -cq 25 -q:v 3 -b:v 8M")).toEqual([
        {
          code: "qualityConflict",
          line: 1,
          column: 9,
          values: { flag: "-cq", other: "-crf" },
        },
        {
          code: "qualityConflict",
          line: 1,
          column: 16,
          values: { flag: "-q:v", other: "-crf" },
        },
        {
          code: "qualityConflict",
          line: 1,
          column: 23,
          values: { flag: "-b:v", other: "-crf" },
        },
      ]);
    });

    it("reports -b:v 0 when the quality kind sets a bitrate", () => {
      const bitrate: Preset = { ...base(), quality: { kind: "bitrate", value: 8000 } };
      expect(errorsOf("-b:v 0", bitrate)).toEqual([
        { code: "zeroBitrate", line: 1, column: 1, values: { flag: "-b:v" } },
      ]);
    });

    it("reports a list past 32 options at the first option too many", () => {
      const options = Array.from({ length: 33 }, (_, index) => `-o${index} 1`).join(
        "\n",
      );
      expect(errorsOf(options)).toEqual([
        { code: "tooManyOptions", line: 33, column: 1, values: { max: 32 } },
      ]);
    });

    it("reports the bytes past the limit at the option that passes it, video first", () => {
      // 2 × 505 bytes of video options, then an audio option of 15 bytes: 1025 bytes.
      const text = `-xc:a ${"a".repeat(10)}\n-xa ${"v".repeat(500)}\n-xb ${"v".repeat(500)}`;
      expect(errorsOf(text)).toEqual([
        { code: "optionsTooLong", line: 1, column: 1, values: { max: 1024 } },
      ]);
      // One byte less fits.
      expect(
        imported(text.replace("a".repeat(10), "a".repeat(9))).audioOptions,
      ).toEqual([option("xc", "a".repeat(9))]);
    });

    it("changes nothing when any error occurs", () => {
      const result = importOptionsText("-c:v libx265 -g 1 -y", base());
      expect(result.ok).toBe(false);
    });
  });
});

describe("renderOptionsText", () => {
  it("writes one option on each line, the video options first, with their specifiers", () => {
    expect(
      renderOptionsText({
        videoOptions: [option("preset", "slow"), option("tag", "hvc1")],
        audioOptions: [option("profile", "aac_low")],
      }),
    ).toBe("-preset:v slow\n-tag:v hvc1\n-profile:a aac_low");
    expect(renderOptionsText({ videoOptions: [], audioOptions: [] })).toBe("");
  });

  it("quotes a value only when the import would not read it back bare", () => {
    expect(
      renderOptionsText({
        videoOptions: [
          option("o1", "x y"),
          option("o2", 'say "hi"'),
          option("o3", String.raw`C:\enc\pass.log`),
          option("o4", "-x"),
          option("o5", "-1"),
          option("o6", "a^"),
          option("o7", "a`"),
          option("o8", "it's"),
          option("o9", "aq-mode=3:psy-rd=0.8,0.0"),
        ],
        audioOptions: [],
      }),
    ).toBe(
      [
        '-o1:v "x y"',
        String.raw`-o2:v "say \"hi\""`,
        String.raw`-o3:v "C:\\enc\\pass.log"`,
        '-o4:v "-x"',
        "-o5:v -1",
        '-o6:v "a^"',
        '-o7:v "a`"',
        `-o8:v "it's"`,
        "-o9:v aq-mode=3:psy-rd=0.8,0.0",
      ].join("\n"),
    );
  });

  it("round-trips values with every character the import reads in a special way", () => {
    const preset: Preset = {
      ...base(),
      videoOptions: [
        option("o1", "x  y\tz"),
        option("o2", String.raw`\\'`),
        option("o3", "-x264"),
        option("o4", "a \\ b"),
        option("o5", "ends with ^"),
        option("o6", "ends with `"),
        option("o7", "-0.25"),
        option("o8", "\u{1F600} é"),
      ],
      audioOptions: [option("o9", "'quoted'"), option("p1", "-1")],
    };
    expect(roundTrip(preset)).toEqual({ ok: true, preset, notes: [] });
  });
});
