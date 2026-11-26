/**
 * The plan of the Export Frame action (ADR 069), which the key, the button of the transport bar
 * and the item of the macOS File menu all run.
 *
 * The plan reads the playback store of the attached element, not the playback of the sequence:
 * on a sequence, the PTS of a frame is the source PTS of the attached clip, not the sequence time
 * of the interface (ADR 052). It accepts the action only under the conditions of
 * `canExportFrame`, and then records the facts at once: the source of the attached clip with its
 * revision, the inferred PTS of the confirmed frame, the time that the preview shows, and the
 * paths of every source of the session. A later change of the playhead, the clip or the playback
 * does not change them.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { FrameExportFacts } from "@/features/frameExport/controller";
import { getSourceRevisionKey } from "@/features/media/sourceIdentity";
import type { ImportMediaResult } from "@/features/media/types";
import type { PlaybackState } from "@/features/playback/types";
import { isPtsString } from "@/lib/time";
import { canExportFrame, isSourceActive } from "./actionConditions";

/** The playback facts that the plan reads: the state of the playback store of the element. */
export type FrameExportPlayback = Pick<
  PlaybackState,
  | "isAttached"
  | "isReady"
  | "calibrationStatus"
  | "presentedFrame"
  | "decodeStall"
  | "isRecalibrating"
  | "attachedSourceRevisionKey"
>;

/** The media of the attached clip, as far as the plan reads it. */
export type FrameExportMedia = Pick<
  ImportMediaResult,
  "path" | "fileName" | "size" | "mtime"
>;

/** One read of the state that the plan needs. */
export interface FrameExportSnapshot {
  /** The playback store of the attached element (`playbackStore`), with source PTS. */
  readonly playback: FrameExportPlayback;
  /** The media of the attached clip (`attachedMediaStore`), or null while none is attached. */
  readonly attachedMedia: FrameExportMedia | null;
  /** The paths of every imported source of the session (`mediaStore.sources`). */
  readonly sessionSourcePaths: readonly string[];
  /** The time that the preview timecode shows now (`formatPreviewCurrentTime`). */
  readonly displayedTime: string;
  /** True while another Export Frame action is in progress. */
  readonly isBusy: boolean;
}

/**
 * The state of a segment trim that blocks the action: a drag that trims an edge (ADR 030), and a
 * press on an edge that is armed and has not become a trim yet (`segmentTrimSession`).
 */
export interface FrameExportTrimState {
  readonly isTrimDragging: boolean;
  readonly isTrimArmed: boolean;
}

/**
 * True when the plan would accept the action. The button of the transport bar is enabled while
 * this is true, so the button and the key act under the same conditions.
 *
 * The element of the playback store must show the attached media: its revision key must be the
 * key of that media. During the switch to another clip the two can name different sources for a
 * moment, and the PTS of one would then be recorded for the file of the other.
 */
export function isFrameExportAvailable(
  playback: FrameExportPlayback,
  attachedMedia: FrameExportMedia | null,
  trim: FrameExportTrimState,
  isBusy: boolean,
): boolean {
  if (attachedMedia === null) {
    return false;
  }
  const frame = playback.presentedFrame;
  return (
    playback.attachedSourceRevisionKey === getSourceRevisionKey(attachedMedia) &&
    canExportFrame({
      hasActiveSource: isSourceActive(true, playback.isAttached, playback.isReady),
      isCalibrated: playback.calibrationStatus === "ready",
      hasConfirmedFrame: frame !== null && isPtsString(frame.inferredSourcePts),
      isDecodeStalled: playback.decodeStall !== null,
      isRecalibrating: playback.isRecalibrating,
      isTrimDragging: trim.isTrimDragging,
      isTrimArmed: trim.isTrimArmed,
      isBusy,
    })
  );
}

/**
 * The facts of the action, or null when the plan refuses it.
 *
 * The PTS is the PTS that Mark In would write at this moment: the inferred PTS of the confirmed
 * frame (ADR 003). The list of sources holds the source of the attached clip too, once.
 */
export function planFrameExport(
  snapshot: FrameExportSnapshot,
  trim: FrameExportTrimState,
): FrameExportFacts | null {
  const { playback, attachedMedia } = snapshot;
  if (
    attachedMedia === null ||
    playback.presentedFrame === null ||
    !isFrameExportAvailable(playback, attachedMedia, trim, snapshot.isBusy)
  ) {
    return null;
  }
  const sessionSourcePaths = snapshot.sessionSourcePaths.includes(attachedMedia.path)
    ? [...snapshot.sessionSourcePaths]
    : [...snapshot.sessionSourcePaths, attachedMedia.path];
  return {
    sourcePath: attachedMedia.path,
    sourceFileName: attachedMedia.fileName,
    sourceRevision: { size: attachedMedia.size, mtime: attachedMedia.mtime },
    pts: playback.presentedFrame.inferredSourcePts,
    displayedTime: snapshot.displayedTime,
    sessionSourcePaths,
  };
}
