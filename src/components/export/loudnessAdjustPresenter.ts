/**
 * The view of the Adjust switch of the Gain row (ADR 061): the switch, the Gain field, and the
 * Measured and After gain lines under the row.
 *
 * Every number here is in tenths of a decibel, as `features/loudness/gain.ts` computes it. The
 * presenter formats the numbers and chooses the catalog keys. It translates nothing.
 */

import { BACKEND_EXPORT_ERROR_CODES } from "@/features/export/types";
import {
  filledGainTenths,
  loudnessLines,
  type AfterGainTone,
} from "@/features/loudness/gain";
import type { LoudnessMeasurement } from "@/features/loudness/store";
import type { LoudnessErrorCode } from "@/features/loudness/types";
import { parseAudioGainField } from "@/features/settings/audioGain";
import {
  MAX_AUDIO_GAIN_TENTHS_DB,
  MIN_AUDIO_GAIN_TENTHS_DB,
  audioGainIssue,
} from "@/features/settings/limits";
import {
  presentPresetIssue,
  type MessageView,
} from "@/components/settings/presetPresenter";
import { formatGainDecibels } from "./exportSetupPresenter";

/** The text that a value the meter did not give shows, such as the loudness of silence. */
export const NO_VALUE = "—";

const EXPORT_ERROR_CODES: ReadonlySet<string> = new Set(BACKEND_EXPORT_ERROR_CODES);

/** The Adjust switch at the end of the Gain row. */
export type AdjustSwitchView = {
  readonly checked: boolean;
  /** The visible label of the switch, which is also its accessible name. */
  readonly labelKey: "export.setup.adjust";
};

export function presentAdjustSwitch(checked: boolean): AdjustSwitchView {
  return { checked, labelKey: "export.setup.adjust" };
}

/**
 * The text of the Gain field for a gain in tenths: decibels with one decimal place, such as
 * "-1.7" or "0.0", with no sign for a positive gain, as a number input reads it.
 */
export function gainFieldText(tenthsDb: number): string {
  const text = (tenthsDb / 10).toFixed(1);
  return text === "-0.0" ? "0.0" : text;
}

/** The Gain field while the Adjust switch is on. */
export type GainFieldView = {
  readonly text: string;
  /** The gain of the text in tenths, or null when the text is not a valid gain. */
  readonly tenthsDb: number | null;
  /**
   * Disabled while the measurement runs, while the step does not measure, and while the save
   * panel is open.
   */
  readonly disabled: boolean;
  /** The message of a value that is not valid, as in the preset editor (ADR 054). */
  readonly issue: MessageView | null;
  readonly min: number;
  readonly max: number;
  readonly step: number;
};

/**
 * The Gain field for `text`. `locked` is true while the measurement runs or the step does not
 * measure, and `frozen` while the save panel is open.
 */
export function presentGainField(
  text: string,
  locked: boolean,
  frozen: boolean,
): GainFieldView {
  const tenthsDb = parseAudioGainField(text);
  const issue = audioGainIssue(tenthsDb);
  return {
    text,
    tenthsDb: issue === null ? tenthsDb : null,
    disabled: locked || frozen,
    issue: issue === null ? null : presentPresetIssue(issue),
    min: MIN_AUDIO_GAIN_TENTHS_DB / 10,
    max: MAX_AUDIO_GAIN_TENTHS_DB / 10,
    step: 0.1,
  };
}

/** A line of text with its catalog key. */
export type LineText = {
  readonly key: string;
  readonly values?: Record<string, string | number>;
};

/** The Measured line. */
export type MeasuredLineView =
  | { readonly kind: "measuring"; readonly text: LineText }
  | { readonly kind: "values"; readonly text: LineText }
  | {
      readonly kind: "failed";
      /** The sentence of the failure. Its `reasonKey` is the message of the code. */
      readonly text: LineText;
      readonly reasonKey: string;
      /** The untranslated diagnostic (ADR 011). */
      readonly detail: string | null;
    };

/** The After gain line, with the tone of the true peak after the gain. */
export type AfterLineView = {
  readonly text: LineText;
  readonly tone: AfterGainTone;
};

export type LoudnessLinesView = {
  readonly measured: MeasuredLineView;
  /** Absent while the measurement runs, after a failure, and for a gain that is not valid. */
  readonly after: AfterLineView | null;
};

/**
 * The messages of the export preparation that name the export and not the measurement, and the
 * message that the measurement shows in their place.
 */
const MEASUREMENT_MESSAGE_KEYS: Readonly<Partial<Record<LoudnessErrorCode, string>>> = {
  // "So the export stopped" is not true of a measurement.
  sourceRevisionMismatch: "exportError.sourceRevisionChanged",
  audioStreamChanged: "loudnessError.audioStreamChanged",
  commandExecutionFailed: "loudnessError.commandExecutionFailed",
  preparationTimedOut: "loudnessError.preparationTimedOut",
};

/** The catalog key of the message of a failed measurement. */
export function loudnessErrorKey(code: LoudnessErrorCode): string {
  return (
    MEASUREMENT_MESSAGE_KEYS[code] ??
    (EXPORT_ERROR_CODES.has(code) ? `exportError.${code}` : `loudnessError.${code}`)
  );
}

/** `fraction` (0 to 1) as a whole percent in the number format of `locale`, such as "40%". */
function percentText(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}

function valueText(tenths: number | null, locale: string): string {
  return tenths === null ? NO_VALUE : formatGainDecibels(tenths, locale);
}

/**
 * The two lines under the Gain row for `measurement` and the gain of the field, or null when the
 * step shows no line: before the first measurement, and after a stop.
 */
export function presentLoudnessLines(
  measurement: LoudnessMeasurement,
  gainTenths: number | null,
  locale: string,
): LoudnessLinesView | null {
  switch (measurement.status) {
    case "idle":
      return null;
    case "measuring": {
      const progress = measurement.progress;
      const percent =
        progress === null || progress.totalUs === 0
          ? null
          : Math.min(100, Math.floor((progress.readUs * 100) / progress.totalUs));
      return {
        measured: {
          kind: "measuring",
          text:
            percent === null
              ? { key: "export.setup.measuring" }
              : {
                  key: "export.setup.measuringPercent",
                  values: { percent: percentText(percent / 100, locale) },
                },
        },
        after: null,
      };
    }
    case "failed": {
      const reasonKey = loudnessErrorKey(measurement.code);
      return {
        measured: {
          kind: "failed",
          text: { key: "export.setup.measureFailed" },
          reasonKey,
          detail: measurement.detail,
        },
        after: null,
      };
    }
    case "complete": {
      const lines = loudnessLines(measurement.values, gainTenths ?? 0);
      const measured: MeasuredLineView = {
        kind: "values",
        text: {
          key: "export.setup.loudnessValues",
          values: {
            loudness: valueText(lines.measuredLoudnessTenths, locale),
            peak: valueText(lines.measuredPeakTenths, locale),
          },
        },
      };
      if (gainTenths === null) {
        return { measured, after: null };
      }
      return {
        measured,
        after: {
          text: {
            key: "export.setup.loudnessValues",
            values: {
              loudness: valueText(lines.afterLoudnessTenths, locale),
              peak: valueText(lines.afterPeakTenths, locale),
            },
          },
          tone: lines.tone,
        },
      };
    }
  }
}

/** The gain that the step fills into the field after a measurement that completed. */
export function filledFieldText(measurement: LoudnessMeasurement): string | null {
  return measurement.status === "complete"
    ? gainFieldText(filledGainTenths(measurement.values.truePeakDbtp))
    : null;
}
