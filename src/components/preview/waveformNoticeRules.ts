/**
 * The notices of the audio envelope (ADR 056) in the notification area of the preview.
 *
 * - A job that reads the file shows a warning: the read competes with the reads of the preview,
 *   so the preview can stutter until the job ends. A cache hit reads no file, so it shows none,
 *   and the notice waits for the reply of the start, which says which of the two the job is.
 * - A job that failed shows an error. A refusal of the start is a failure too.
 *
 * The user can close each notice. A new job of the source shows its notices again.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { WaveformErrorCode, WaveformState } from "@/features/waveform";

/** The catalog keys of the error notice. Each is a whole sentence (ADR 011). */
export const WAVEFORM_ERROR_KEYS = {
  ffmpegNotFound: "preview.waveform.error.ffmpegNotFound",
  sourceChanged: "preview.waveform.error.sourceChanged",
  readFailed: "preview.waveform.error.readFailed",
  decodeFailed: "preview.waveform.error.decodeFailed",
  busy: "preview.waveform.error.busy",
  other: "preview.waveform.error.other",
} as const;

export type WaveformErrorKey =
  (typeof WAVEFORM_ERROR_KEYS)[keyof typeof WAVEFORM_ERROR_KEYS];

export type WaveformNotice =
  | {
      readonly kind: "waveform";
      readonly sourceId: string;
      readonly name: string;
      /** The whole percent of the job that is done, or null when it is not known. */
      readonly percent: number | null;
    }
  | {
      readonly kind: "waveformError";
      readonly sourceId: string;
      readonly name: string;
      readonly messageKey: WaveformErrorKey;
      /** The untranslated diagnostic text of the failure (ADR 011). */
      readonly detail: string | null;
    };

/** The message of the error notice for a code. */
export function waveformErrorKey(code: WaveformErrorCode | null): WaveformErrorKey {
  switch (code) {
    case "ffmpegNotFound":
      return WAVEFORM_ERROR_KEYS.ffmpegNotFound;
    case "sourceChanged":
      return WAVEFORM_ERROR_KEYS.sourceChanged;
    case "readFailed":
    case "sourceUnreadable":
      return WAVEFORM_ERROR_KEYS.readFailed;
    case "decodeFailed":
    case "spawnFailed":
      return WAVEFORM_ERROR_KEYS.decodeFailed;
    case "busy":
      return WAVEFORM_ERROR_KEYS.busy;
    default:
      return WAVEFORM_ERROR_KEYS.other;
  }
}

/**
 * The notices to show, the running job first.
 *
 * @param fileName The file name of a source, for the message.
 */
export function resolveWaveformNotices(
  state: WaveformState,
  fileName: (sourceId: string) => string,
): WaveformNotice[] {
  const notices: WaveformNotice[] = [];
  for (const [sourceId, source] of Object.entries(state.sources)) {
    if (source.noticeDismissed) {
      continue;
    }
    if (source.phase === "running" && source.cached === false) {
      notices.unshift({
        kind: "waveform",
        sourceId,
        name: fileName(sourceId),
        percent:
          source.progress === null
            ? null
            : Math.floor(Math.min(1, Math.max(0, source.progress)) * 100),
      });
    } else if (source.phase === "failed") {
      notices.push({
        kind: "waveformError",
        sourceId,
        name: fileName(sourceId),
        messageKey: waveformErrorKey(source.errorCode),
        detail: source.errorDetail,
      });
    }
  }
  return notices;
}
