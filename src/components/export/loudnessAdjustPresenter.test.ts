import { describe, expect, it } from "vitest";
import { BACKEND_EXPORT_ERROR_CODES } from "@/features/export/types";
import type { LoudnessMeasurement } from "@/features/loudness/store";
import {
  LOUDNESS_RUN_ERROR_CODES,
  LOUDNESS_START_ERROR_CODES,
} from "@/features/loudness/types";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  NO_VALUE,
  filledFieldText,
  gainFieldText,
  loudnessErrorKey,
  presentAdjustSwitch,
  presentGainField,
  presentLoudnessLines,
} from "./loudnessAdjustPresenter";

function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

const COMPLETE: LoudnessMeasurement = {
  status: "complete",
  generation: 1,
  values: { integratedLufs: -14.56, truePeakDbtp: 0.71 },
};

describe("the Adjust switch of the Gain row (ADR 061)", () => {
  it("writes a gain as the text of the field", () => {
    expect(gainFieldText(-17)).toBe("-1.7");
    expect(gainFieldText(0)).toBe("0.0");
    expect(gainFieldText(-0)).toBe("0.0");
    expect(gainFieldText(15)).toBe("1.5");
    expect(gainFieldText(-200)).toBe("-20.0");
  });

  it("fills the gain that brings the true peak to -1.0 dBTP, and only after a completion", () => {
    // TP +0.71 rounds up to +0.8, so the gain is -1.8 dB.
    expect(filledFieldText(COMPLETE)).toBe("-1.8");
    expect(
      filledFieldText({
        status: "complete",
        generation: 1,
        values: { integratedLufs: null, truePeakDbtp: null },
      }),
    ).toBe("0.0");
    expect(
      filledFieldText({ status: "measuring", generation: 1, progress: null }),
    ).toBeNull();
  });

  it("checks the field as the preset editor checks its gain (ADR 054)", () => {
    expect(presentGainField("-1.7", false, false)).toMatchObject({
      tenthsDb: -17,
      issue: null,
      disabled: false,
      min: -20,
      max: 20,
      step: 0.1,
    });
    expect(presentGainField("-1.25", false, false)).toMatchObject({
      tenthsDb: null,
      issue: { key: "settings.field.oneDecimal" },
    });
    // The digits of the text decide, not the number: this one reads as -1.
    expect(presentGainField("-1.0000000000000001", false, false)).toMatchObject({
      tenthsDb: null,
      issue: { key: "settings.field.oneDecimal" },
    });
    expect(presentGainField("-1e0", false, false)).toMatchObject({
      tenthsDb: -10,
      issue: null,
    });
    expect(presentGainField("", false, false)).toMatchObject({
      tenthsDb: null,
      issue: { key: "settings.field.oneDecimal" },
    });
    expect(presentGainField("-25", false, false)).toMatchObject({
      tenthsDb: null,
      issue: { key: "settings.field.outOfRange", values: { min: -20, max: 20 } },
    });
    // A whole number too large for a number is out of range, and the field keeps its text.
    expect(presentGainField("1e400", false, false)).toMatchObject({
      text: "1e400",
      tenthsDb: null,
      issue: { key: "settings.field.outOfRange", values: { min: -20, max: 20 } },
    });
    // Disabled while the measurement runs or the step does not measure, and while the save
    // panel is open.
    expect(presentGainField("0.0", true, false).disabled).toBe(true);
    expect(presentGainField("0.0", false, true).disabled).toBe(true);
  });

  it("shows no line before a measurement", () => {
    expect(presentLoudnessLines({ status: "idle", generation: 0 }, 0, "en")).toBeNull();
  });

  it("shows the progress while it measures, and no After gain line", () => {
    expect(
      presentLoudnessLines(
        { status: "measuring", generation: 1, progress: null },
        0,
        "en",
      ),
    ).toEqual({
      measured: { kind: "measuring", text: { key: "export.setup.measuring" } },
      after: null,
    });
    expect(
      presentLoudnessLines(
        { status: "measuring", generation: 1, progress: { readUs: 1, totalUs: 3 } },
        0,
        "en",
      )?.measured,
    ).toEqual({
      kind: "measuring",
      text: { key: "export.setup.measuringPercent", values: { percent: "33%" } },
    });
  });

  it("shows both lines after a completion, with the tone of the true peak", () => {
    expect(presentLoudnessLines(COMPLETE, -18, "en")).toEqual({
      measured: {
        kind: "values",
        text: {
          key: "export.setup.loudnessValues",
          values: { loudness: "-14.6", peak: "+0.8" },
        },
      },
      after: {
        text: {
          key: "export.setup.loudnessValues",
          values: { loudness: "-16.4", peak: "-1.0" },
        },
        tone: "normal",
      },
    });
    expect(presentLoudnessLines(COMPLETE, 0, "en")?.after?.tone).toBe("destructive");
    expect(presentLoudnessLines(COMPLETE, -10, "en")?.after?.tone).toBe("warning");
    // A gain that is not valid shows no After gain line.
    expect(presentLoudnessLines(COMPLETE, null, "en")?.after).toBeNull();
    // Silence has no values.
    expect(
      presentLoudnessLines(
        {
          status: "complete",
          generation: 1,
          values: { integratedLufs: null, truePeakDbtp: null },
        },
        0,
        "en",
      ),
    ).toEqual({
      measured: {
        kind: "values",
        text: {
          key: "export.setup.loudnessValues",
          values: { loudness: NO_VALUE, peak: NO_VALUE },
        },
      },
      after: {
        text: {
          key: "export.setup.loudnessValues",
          values: { loudness: NO_VALUE, peak: NO_VALUE },
        },
        tone: "normal",
      },
    });
  });

  it("shows a failure with the message of its code and its diagnostic", () => {
    expect(
      presentLoudnessLines(
        { status: "failed", generation: 1, code: "audioShort", detail: "x" },
        0,
        "en",
      ),
    ).toEqual({
      measured: {
        kind: "failed",
        text: { key: "export.setup.measureFailed" },
        reasonKey: "loudnessError.audioShort",
        detail: "x",
      },
      after: null,
    });
    expect(loudnessErrorKey("sourceHasNoAudio")).toBe("exportError.sourceHasNoAudio");
    expect(loudnessErrorKey("invalidAudio")).toBe("loudnessError.invalidAudio");
    // Two messages of the export preparation name the export, so the measurement has its own.
    expect(loudnessErrorKey("sourceRevisionMismatch")).toBe(
      "exportError.sourceRevisionChanged",
    );
    expect(loudnessErrorKey("commandExecutionFailed")).toBe(
      "loudnessError.commandExecutionFailed",
    );
  });

  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ] as const)("names keys that the %s catalog defines", (_language, catalog) => {
    const keys = [
      presentAdjustSwitch(true).labelKey,
      "export.setup.copyLockedByAdjust",
      "export.setup.measuredLabel",
      "export.setup.afterGainLabel",
      "export.setup.loudnessValues",
      "export.setup.measuring",
      "export.setup.measuringPercent",
      "export.setup.measureFailed",
      ...[
        ...LOUDNESS_RUN_ERROR_CODES,
        ...LOUDNESS_START_ERROR_CODES,
        ...BACKEND_EXPORT_ERROR_CODES.filter((code) => code !== "canceled"),
        "invalidResponse",
        "commandExecutionFailed",
      ].map((code) => loudnessErrorKey(code as Parameters<typeof loudnessErrorKey>[0])),
    ];
    for (const key of keys) {
      expect(typeof lookup(catalog, key), key).toBe("string");
    }
  });
});
