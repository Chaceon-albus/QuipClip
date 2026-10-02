/**
 * Pure rules for a decode error in the middle of a source that the preview could play.
 *
 * Some files decode at the start and fail later. An example is a join of two files with
 * different picture sizes by stream copy: the web view decodes the first part, and its decoder
 * fails where the second part starts. Chromium then fires `error` with `MEDIA_ERR_DECODE`, and
 * the element does not play or seek again: a seek back to the first part never ends. Before
 * this rule the preview showed the decode-failure panel for the whole file, and it never
 * recovered.
 *
 * This module holds two rules:
 *
 * - `classifyDecodeFailure` tells a stall from a failure. A stall keeps the element and the
 *   timeline, shows a notice, and reloads the element at the next seek (`decodeStall` of the
 *   playback store). A failure shows the decode-failure panel, as before.
 * - `presentDecodeStall` states what the notice of a stall says.
 *
 * The presenter returns a translation key and its values without calling the i18n runtime
 * (ADR 011).
 */

import { formatElapsedTimecode, type TimecodeDisplay } from "@/lib/timecode";
import type { DecodeStall } from "@/features/playback";
import {
  MEDIA_ERR_DECODE,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  type DecodeFailureTrigger,
} from "./decodeFailure";

/**
 * What the preview does about a decode problem of its video element.
 *
 * - `stall`: the source decoded in part, and then its element stopped with a media error. The
 *   preview keeps the timeline, shows the notice of a stall, and loads a new element at the next
 *   seek.
 * - `failure`: the preview shows the decode-failure panel in place of the element.
 */
export type DecodeFailureClass = "stall" | "failure";

/**
 * What one video element has shown of its source (`stepDecodeEvidence`).
 *
 * - `frames`: the number of its frame callbacks. The first one is the calibration anchor, the
 *   first frame after the load (ADR 003).
 * - `seekedAfterFirstFrame`: true when the element started a seek after its first frame. The
 *   store defers every seek until the anchor (ADR 022), so such a seek moved the element away
 *   from the frame that decoded.
 */
export interface DecodeEvidence {
  readonly frames: number;
  readonly seekedAfterFirstFrame: boolean;
}

/** The evidence of an element that has shown nothing yet. */
export const NO_DECODE_EVIDENCE: DecodeEvidence = {
  frames: 0,
  seekedAfterFirstFrame: false,
};

/** Adds a frame callback, or the start of a seek, of the element to its evidence. */
export function stepDecodeEvidence(
  evidence: DecodeEvidence,
  event: "frame" | "seeking",
): DecodeEvidence {
  if (event === "frame") {
    return { ...evidence, frames: evidence.frames + 1 };
  }
  return evidence.frames > 0 && !evidence.seekedAfterFirstFrame
    ? { ...evidence, seekedAfterFirstFrame: true }
    : evidence;
}

/**
 * True when the evidence of an element proves that its source decodes in part, so that a later
 * decode error of the source is a stall (`classifyDecodeFailure`):
 *
 * - The element presented a frame after its first frame. One frame alone does not prove it: a
 *   decoder can show the first frame of a source and fail at the next one, and that source does
 *   not decode at all for the user.
 * - Or the element presented its first frame and then started a seek. An error after that seek
 *   comes from the part that the seek reached, and the part at the first frame decoded. A user
 *   who opens a file and clicks first in a part that does not decode gets this case.
 */
export function provesPartialDecode(evidence: DecodeEvidence): boolean {
  return (
    evidence.frames >= 2 || (evidence.frames >= 1 && evidence.seekedAfterFirstFrame)
  );
}

/**
 * Classifies a decode problem of the video element.
 *
 * A stall needs both of these:
 *
 * - The source decodes in part: an element of the source proved it (`provesPartialDecode`)
 *   since the media object of the source was opened. The source then shows some parts, so a
 *   new element can show them again. The rule reads the source and not only the element that
 *   failed, because the new element of a reload can seek before its own first frame when the
 *   calibration is unavailable, and a seek into the same part then fails before that frame. A new
 *   import of the file starts the record again.
 * - The trigger is an `error` event with `MEDIA_ERR_DECODE`, or with
 *   `MEDIA_ERR_SRC_NOT_SUPPORTED`. A web view reports a decoder that fails after the metadata
 *   with the first code. The second code belongs to the load of the resource, but a web view
 *   that reports it after the source decoded in part has shown that it can decode the source,
 *   so the same rule applies.
 *
 * Everything else is a failure, as before this rule:
 *
 * - An error before the source proved that it decodes in part. The source does not decode at its
 *   start, and the decode-failure panel names the reason.
 * - A failed picture check: the element plays no picture at all (`resolvePictureCheck`).
 * - `MEDIA_ERR_NETWORK`, `MEDIA_ERR_ABORTED` and an error with no code. The file could not be
 *   read, and the panel says that. A new element would read the same file.
 *
 * @param decodesInPart True when an element of the source proved that the source decodes in
 *   part (`provesPartialDecode`).
 */
export function classifyDecodeFailure(
  trigger: DecodeFailureTrigger,
  decodesInPart: boolean,
): DecodeFailureClass {
  if (
    decodesInPart &&
    trigger.kind === "mediaError" &&
    (trigger.code === MEDIA_ERR_DECODE || trigger.code === MEDIA_ERR_SRC_NOT_SUPPORTED)
  ) {
    return "stall";
  }
  return "failure";
}

/** The catalog key of the notice of a stall. */
export const DECODE_STALL_MESSAGE_KEY = "preview.decodeStall.message";

/** What the notice of a stall says. */
export interface DecodeStallNotice {
  readonly key: typeof DECODE_STALL_MESSAGE_KEY;
  readonly values: {
    /**
     * The position of the stall in the timecode format of the open source, the format of the
     * playhead (ADR 028). The message calls it an approximate time.
     */
    readonly time: string;
  };
}

/**
 * Returns the notice of a stall: where the preview stopped, why, and what makes it continue.
 *
 * The position comes from `currentTime` of the element, so it is approximate, as the time of
 * the hover line is. The message says "about" before it. It is formatted with the conversion of
 * the hover line (`formatElapsedTimecode`) in the format of the playhead. The message does not
 * mention the export: the export decodes the file with FFmpeg and does not use the preview.
 */
export function presentDecodeStall(
  stall: DecodeStall,
  display: TimecodeDisplay,
): DecodeStallNotice {
  const seconds =
    Number.isFinite(stall.atSeconds) && stall.atSeconds > 0 ? stall.atSeconds : 0;
  return {
    key: DECODE_STALL_MESSAGE_KEY,
    values: { time: formatElapsedTimecode(seconds, display) },
  };
}
