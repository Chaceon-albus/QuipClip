/**
 * Pure rules for the notices of the preview: the actions that an import error offers, and the
 * timing that removes a playback error by itself.
 */

import type { ImportMediaErrorCode } from "@/features/media";

/**
 * The import errors that a change in the FFmpeg settings can correct.
 *
 * - `ffmpegPairMissing`: discovery found no `ffmpeg` and `ffprobe` pair.
 * - `ffprobeSpawnFailed`: the located `ffprobe` did not start, for example because the
 *   configured path is not an executable.
 *
 * An `ffprobe` that ran and then failed, timed out, or wrote output that QuipClip cannot use
 * points at the file, not at the settings, so those codes are not in the list.
 */
export const FFMPEG_SETUP_IMPORT_ERROR_CODES = [
  "ffmpegPairMissing",
  "ffprobeSpawnFailed",
] as const satisfies readonly ImportMediaErrorCode[];

/** Tells whether the FFmpeg settings can correct an import error. */
export function isFfmpegSetupImportError(code: ImportMediaErrorCode): boolean {
  return (FFMPEG_SETUP_IMPORT_ERROR_CODES as readonly ImportMediaErrorCode[]).includes(
    code,
  );
}

/**
 * An action that an import error offers.
 *
 * - `openSettings`: opens the Settings dialog on its FFmpeg tab.
 * - `chooseFile`: runs the Open Media action, so the user can choose a file.
 */
export type ImportErrorAction = "openSettings" | "chooseFile";

/**
 * Where the preview shows an import error.
 *
 * - `empty`: no video is open, so the error takes the place of the empty state.
 * - `banner`: a video is open, and the error is a notice above it. The File menu stays the way
 *   to choose another file, so the banner does not repeat that action.
 */
export type ImportErrorPlacement = "empty" | "banner";

/**
 * The actions of an import error, in display order. The first action is the primary one.
 */
export function importErrorActions(
  code: ImportMediaErrorCode,
  placement: ImportErrorPlacement,
): readonly ImportErrorAction[] {
  const setup = isFfmpegSetupImportError(code);
  if (placement === "banner") {
    return setup ? ["openSettings"] : [];
  }
  return setup ? ["openSettings", "chooseFile"] : ["chooseFile"];
}

/** The hint under an import error message, or null when the message is the whole account. */
export function importErrorHintKey(
  code: ImportMediaErrorCode,
): "preview.importError.ffmpegHint" | null {
  return isFfmpegSetupImportError(code) ? "preview.importError.ffmpegHint" : null;
}

/** The kind of a preview notice. */
export type PreviewNoticeKind = "import" | "playback";

/**
 * The phase of a notice that can remove itself: on screen, or in its exit animation.
 */
export type PreviewNoticePhase = "shown" | "leaving";

/** How long a playback error stays on screen before it starts to leave. */
export const PLAYBACK_NOTICE_DURATION_MS = 5000;

/**
 * How long the exit animation of a notice runs. It is the default duration of the
 * tw-animate-css `animate-out` keyframes.
 */
export const NOTICE_EXIT_DURATION_MS = 150;

/** The next timed step of a notice. */
export type NoticeTimerStep = {
  /** `leave` starts the exit animation. `dismiss` removes the notice. */
  readonly action: "leave" | "dismiss";
  readonly delayMs: number;
};

/**
 * The next timed step of a notice, or null when no timer runs.
 *
 * An import error stays until the user dismisses it or starts another import, so it never
 * gets a timer. A playback error leaves after `PLAYBACK_NOTICE_DURATION_MS`. While the pointer
 * is over it or the focus is in it, it is paused and gets no timer. When the pause ends, the
 * full duration starts again, so the user always has the whole time to read it.
 *
 * @param paused True while the pointer is over the notice or the focus is in it.
 */
export function resolveNoticeTimer(
  kind: PreviewNoticeKind,
  phase: PreviewNoticePhase,
  paused: boolean,
): NoticeTimerStep | null {
  if (kind === "import" || paused) {
    return null;
  }
  return phase === "shown"
    ? { action: "leave", delayMs: PLAYBACK_NOTICE_DURATION_MS }
    : { action: "dismiss", delayMs: NOTICE_EXIT_DURATION_MS };
}
