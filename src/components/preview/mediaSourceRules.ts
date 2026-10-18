/**
 * Pure rules of the preview for a source that plays through a MediaSource (ADR 046): what a
 * failure of the controller shows, what an error of its element means, the notices about the
 * source, and when a new element scans for decoder configurations.
 */

import type { MseFailure } from "@/features/playback/mse/controller";
import {
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  type DecodeFailureTrigger,
} from "./decodeFailure";

/** What a failure of the MediaSource controller shows. */
export interface MediaSourceFailureOutcome {
  /**
   * The stall of ADR 039 with its cause, tried first when the source decoded in part, or null
   * for the panel at once.
   */
  readonly stall: { readonly cause?: "read" } | null;
  /** The panel, at once, or when the store refuses the stall. */
  readonly trigger: DecodeFailureTrigger;
}

/**
 * The outcome of a failure of the controller. A missing FFmpeg always takes the panel. A codec
 * that the MediaSource refuses, and a window that fails, stop the preview where it is after the
 * source showed a frame, as a decode error does (ADR 039), and take the panel before that.
 */
export function resolveMediaSourceFailure(
  failure: MseFailure,
  decodesInPart: boolean,
): MediaSourceFailureOutcome {
  switch (failure.kind) {
    case "ffmpegMissing":
      return { stall: null, trigger: { kind: "ffmpegMissing" } };
    case "codecRejected":
      return {
        stall: decodesInPart ? {} : null,
        trigger: { kind: "codecRejected", detail: failure.type },
      };
    case "windowFailed":
      return {
        stall: decodesInPart ? { cause: "read" } : null,
        trigger: {
          kind: "windowFailed",
          detail:
            failure.detail === null
              ? failure.code
              : `${failure.code}: ${failure.detail}`,
        },
      };
  }
}

/**
 * The trigger of the panel for an error of the element of a MediaSource source. Its
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` comes from a MediaSource that refused the data of a window, not
 * from a container that the web view cannot open, so the panel names the codec. Whether the
 * error stalls the preview instead follows the media error, as for any source.
 */
export function mediaSourcePanelTrigger(code: number | null): DecodeFailureTrigger {
  return code === MEDIA_ERR_SRC_NOT_SUPPORTED
    ? { kind: "codecRejected" }
    : { kind: "mediaError", code };
}

/**
 * Runs `run` once `store` is ready for seeks, in a microtask, so the action that made it ready
 * has ended first: `syncReady` assumes that no seek precedes it. Returns a function that cancels
 * a run that waits.
 */
export function whenStoreReady(
  store: {
    getState: () => { readonly isReady: boolean };
    subscribe: (listener: (state: { readonly isReady: boolean }) => void) => () => void;
  },
  run: () => void,
): () => void {
  let canceled = false;
  const runLater = () => {
    queueMicrotask(() => {
      if (!canceled) {
        run();
      }
    });
  };
  if (store.getState().isReady) {
    runLater();
    return () => {
      canceled = true;
    };
  }
  const unsubscribe = store.subscribe((state) => {
    if (state.isReady) {
      unsubscribe();
      runLater();
    }
  });
  return () => {
    canceled = true;
    unsubscribe();
  };
}

/** The notices about a video that plays through FFmpeg. */
export type MediaSourceNoticeKey =
  "preview.mediaSource.timestampsDecrease" | "preview.mediaSource.noSound";

/**
 * The notices of one source revision: the ones on screen, and the ones that the user dismissed,
 * which a later report of the same source does not show again.
 */
export interface MediaSourceNotices {
  readonly sourceRevisionKey: string;
  readonly shown: readonly MediaSourceNoticeKey[];
  readonly dismissed: readonly MediaSourceNoticeKey[];
}

export const NO_MEDIA_SOURCE_NOTICES: MediaSourceNotices = {
  sourceRevisionKey: "",
  shown: [],
  dismissed: [],
};

/**
 * The notices of the source that is open now. A new media object of the same revision, as a
 * new import of the open file, keeps them, because its element and its controller stay.
 */
export function mediaSourceNoticesFor(
  notices: MediaSourceNotices,
  sourceRevisionKey: string,
): MediaSourceNotices {
  return notices.sourceRevisionKey === sourceRevisionKey
    ? notices
    : { ...NO_MEDIA_SOURCE_NOTICES, sourceRevisionKey };
}

/** The notices with `key` shown for `sourceRevisionKey`, unless the user dismissed it. */
export function addMediaSourceNotice(
  notices: MediaSourceNotices,
  sourceRevisionKey: string,
  key: MediaSourceNoticeKey,
): MediaSourceNotices {
  const current = mediaSourceNoticesFor(notices, sourceRevisionKey);
  if (current.shown.includes(key) || current.dismissed.includes(key)) {
    return current;
  }
  return { ...current, shown: [...current.shown, key] };
}

/** The notices with `key` dismissed. */
export function dismissMediaSourceNotice(
  notices: MediaSourceNotices,
  key: MediaSourceNoticeKey,
): MediaSourceNotices {
  if (!notices.shown.includes(key)) {
    return notices;
  }
  return {
    ...notices,
    shown: notices.shown.filter((item) => item !== key),
    dismissed: [...notices.dismissed, key],
  };
}

/** The notices on screen for `sourceRevisionKey`. */
export function shownMediaSourceNotices(
  notices: MediaSourceNotices,
  sourceRevisionKey: string,
): readonly MediaSourceNoticeKey[] {
  return notices.sourceRevisionKey === sourceRevisionKey ? notices.shown : [];
}

/**
 * True when the element that attaches now scans for decoder configurations: it is the element
 * of the reload that a decode stall of the source asked for (ADR 046, "Failures"). The stall
 * records the generation of that reload, so a later reload does not scan again.
 */
export function rescansAtAttach(
  rescanGenerations: ReadonlyMap<string, number>,
  sourceRevisionKey: string,
  reloadGeneration: number,
): boolean {
  return rescanGenerations.get(sourceRevisionKey) === reloadGeneration;
}
