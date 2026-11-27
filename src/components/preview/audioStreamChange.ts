/**
 * What a change of the effective audio stream of a source does to the preview (ADR 070).
 *
 * The windows of a MediaSource element and the PCM windows of the cue of a native element read
 * the effective stream of their source (`previewAudioStreamOf`). Each one reads it when it starts,
 * so a change must replace the reader that runs:
 *
 * - The controller of a MediaSource element keeps one MediaSource for the life of its element,
 *   and the track count of a SourceBuffer cannot change. The element is replaced through the
 *   reload of ADR 039, with no stall, as a recalibration replaces it (ADR 063,
 *   `replacePreviewElement`). The new element gets a new MediaSource and new windows.
 * - The PCM cue of a native element (ADR 062) is replaced, with its PCM and its windows. The
 *   element and its calibration stay: the element plays the track that the web view chooses.
 * - A MediaSource source whose preview failed shows the decode failure panel, and no element is
 *   in the tree. The failure can come from the stream, such as a window that copies an AC-3
 *   stream with no packet, so the pane clears the failure, and the element mounts again with a
 *   new controller that reads the new stream.
 *
 * A source with no reader that runs changes nothing now. The next reader of that source reads its
 * effective stream when it starts.
 */

/** The audio stream that a reader of the preview reads now. */
export interface HeldAudioStream {
  /** The revision key of the source of the element. */
  readonly sourceRevisionKey: string;
  /** The absolute index of the stream that the windows map, or null for no audio. */
  readonly audioStreamIndex: number | null;
}

/**
 * What the preview does for a change of the effective audio stream:
 *
 * - `reloadElement`: replace the MediaSource element (`replacePreviewElement`).
 * - `replaceCue`: replace the PCM cue of the native element.
 * - `retryFailed`: clear the decode failure of a MediaSource source, so its element mounts again.
 * - `none`: nothing now.
 */
export type AudioStreamChangeEffect =
  "reloadElement" | "replaceCue" | "retryFailed" | "none";

export interface AudioStreamChangeInput {
  /** How the preview plays the source of the attached clip (`PreviewPath.kind`). */
  readonly path: "native" | "mediaSource";
  /** The revision key of the source of the attached clip. */
  readonly sourceRevisionKey: string;
  /** The absolute index of the effective stream of that source before the change. */
  readonly previousStreamIndex: number | null;
  /** The absolute index of the effective stream of that source, or null for no audio. */
  readonly effectiveStreamIndex: number | null;
  /** True while the pane shows the decode failure panel for that source. */
  readonly showsFailure: boolean;
  /**
   * What the reader of the path reads now: the controller of the MediaSource element, or the PCM
   * cue of the native element. Null when no such reader runs, as for a native source with no PCM
   * cue, while the failure panel shows, or between the detach of an element and the attach of
   * the next one.
   */
  readonly held: HeldAudioStream | null;
  /**
   * True when the sequence has a generation that the pane did not render yet, as in step 8 of the
   * open of a project (ADR 072). The preview then builds new elements for the new sequence, and
   * each one reads the effective stream when it attaches: the choice of the document.
   */
  readonly isNewSequence: boolean;
}

/**
 * Decides what the preview does when the effective audio stream of a source may have changed.
 *
 * Only a reader of the source of the attached clip that reads another stream than the effective
 * one is replaced. Two clips of one source share the override and the element, so the decision is
 * for the source (ADR 052). Every other case does nothing:
 *
 * - No reader runs. The next reader reads the effective stream when it starts.
 * - The reader belongs to another source, as during a switch to another clip.
 * - The reader reads the effective stream already, as after a change back to the stream that it
 *   reads. Two quick changes therefore end on the last one: each change compares the last
 *   override with the stream that runs.
 *
 * A change that comes with a new sequence does nothing either (ADR 072). The open of a project
 * changes the overrides in the same step as the sequence, and the elements of the new sequence are
 * new attachments: a reload of the old element would keep its position, and the new element would
 * take it. The failure panel goes for a new sequence too, so no retry is needed.
 *
 * While the failure panel of a MediaSource source shows, no reader holds a stream, so the change
 * itself decides: a new effective stream of that source retries the preview once. A change that
 * leaves the effective stream of the source as it was, such as an override of another source or
 * an override of the preferred stream, retries nothing. A native source never retries: its
 * element does not read the effective stream. A retry that fails shows the panel again by the
 * ordinary path, and only a later change retries again, so no loop starts by itself.
 */
export function audioStreamChangeEffect(
  input: AudioStreamChangeInput,
): AudioStreamChangeEffect {
  if (input.isNewSequence) {
    return "none";
  }
  if (input.path === "mediaSource" && input.showsFailure) {
    return input.previousStreamIndex === input.effectiveStreamIndex
      ? "none"
      : "retryFailed";
  }
  const { held } = input;
  if (
    held === null ||
    held.sourceRevisionKey !== input.sourceRevisionKey ||
    held.audioStreamIndex === input.effectiveStreamIndex
  ) {
    return "none";
  }
  return input.path === "mediaSource" ? "reloadElement" : "replaceCue";
}
