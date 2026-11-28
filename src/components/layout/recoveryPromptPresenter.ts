/**
 * The text of the recovery prompt (ADR 073, "The recovery prompt").
 *
 * The prompt names the project file of the offer, or says that the project had no file, and it
 * shows the time of the last write of the offer in the format of the language of the interface.
 * Restore is the primary button, Discard the discard button, and Not Now the cancel button.
 *
 * The module has no React and no DOM, so the tests need no document. It returns catalog keys and
 * values, and it does not call the i18n runtime. The time is the one value that it formats itself,
 * with `Intl.DateTimeFormat` and the language that the catalogs use (ADR 011).
 */

import { fileNameOfPath } from "@/features/project/paths";
import type { RecoveryOfferSummary } from "@/features/recovery/types";

/** One catalog message, with its named values. */
export interface RecoveryPromptMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** What the recovery prompt shows. */
export interface RecoveryPromptView {
  readonly title: RecoveryPromptMessage;
  /** The line that names the project file or says that it had no file, and the line of the time. */
  readonly lines: readonly RecoveryPromptMessage[];
  /** The primary button. */
  readonly restore: RecoveryPromptMessage;
  /** The discard button. */
  readonly discard: RecoveryPromptMessage;
  /** The cancel button, which has the default focus. */
  readonly notNow: RecoveryPromptMessage;
}

/** Options of the format of the time. */
export interface RecoveryTimeOptions {
  /** The time zone of the format. The zone of the system when absent. A test passes `UTC`. */
  readonly timeZone?: string;
}

/**
 * The time of the last write of an offer, as a short date and a short time in the format of
 * `locale`, the language of the interface ("en" or "zh-CN").
 */
export function formatRecoveryTime(
  writtenAtMs: number,
  locale: string,
  options: RecoveryTimeOptions = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(new Date(writtenAtMs));
}

/** The view of the recovery prompt for `offer`, with the time in the format of `locale`. */
export function presentRecoveryPrompt(
  offer: RecoveryOfferSummary,
  locale: string,
  options: RecoveryTimeOptions = {},
): RecoveryPromptView {
  const name = offer.projectPath === null ? "" : fileNameOfPath(offer.projectPath);
  return {
    title: { key: "recovery.title" },
    lines: [
      // A path with no name, such as a path that ends in a separator, names no file.
      name === ""
        ? { key: "recovery.noFile" }
        : { key: "recovery.file", values: { name } },
      {
        key: "recovery.savedAt",
        values: { time: formatRecoveryTime(offer.writtenAtMs, locale, options) },
      },
    ],
    restore: { key: "recovery.restore" },
    discard: { key: "recovery.discard" },
    notNow: { key: "recovery.notNow" },
  };
}
