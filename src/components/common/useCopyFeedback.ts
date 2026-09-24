import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { isMacOS } from "@/lib/platform";
import {
  ANNOUNCE_GAP_MS,
  copyFeedbackDurationMs,
  copyFeedbackOf,
  selectedHintKey,
  type CopyFeedback,
} from "./diagnosticDetailsModel";

export interface CopyFeedbackControls {
  /**
   * The result of the last Copy click, or null. The caller shows the check mark for
   * `copied`, and the visible `hint` for `selected`.
   */
  feedback: CopyFeedback | null;
  /** The hint that names the copy shortcut of the platform, for a refused write. */
  hint: string;
  /**
   * The text of the live region, or null. The caller renders the region always, so a screen
   * reader speaks each change of its text.
   */
  announcement: string | null;
  /** Copies `text`. The click handler of the Copy button calls it. */
  copy: () => Promise<void>;
}

/**
 * The React wiring of a Copy button that follows the rules in `diagnosticDetailsModel`.
 *
 * Copy writes `text` to the clipboard, and `feedback` becomes `copied` for a short time. When
 * the clipboard refuses the write, the hook selects the contents of `selectTarget` instead,
 * and `feedback` becomes `selected` until the next click. `announcement` gives the live
 * region "Copied" or the hint. The button label stays "Copy", so its accessible name always
 * holds its visible label (WCAG 2.5.3).
 */
export function useCopyFeedback(
  text: string,
  selectTarget: RefObject<HTMLElement | null>,
): CopyFeedbackControls {
  const { t } = useTranslation();
  // The result of the last Copy click, or null. It sets the icon and the visible hint. Each
  // click stores a new object, so the timer below starts again, and the check mark stays
  // for its full time after the last click.
  const [feedback, setFeedback] = useState<{ kind: CopyFeedback } | null>(null);
  // The result that the live region speaks, or null. It is apart from `feedback`, so the
  // gap before an announcement never changes what shows. See `copy`.
  const [announced, setAnnounced] = useState<CopyFeedback | null>(null);
  const announceTimerRef = useRef<number | null>(null);
  // False after the unmount. The copy answers after an await, and a timer must not start
  // for a component that is gone.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (feedback === null) {
      return;
    }
    const durationMs = copyFeedbackDurationMs(feedback.kind);
    if (durationMs === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFeedback(null);
      setAnnounced(null);
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [feedback]);

  // A screen reader speaks a live region only when its text changes. A result that repeats
  // the last one, such as a second copy within the confirmation time or a second refused
  // copy, would otherwise pass in silence. So the click empties the region, and the result
  // goes into it `ANNOUNCE_GAP_MS` later, after the empty region reached the screen reader.
  const copy = async () => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
      announceTimerRef.current = null;
    }
    setAnnounced(null);
    const kind = copyFeedbackOf(await copyText(text));
    if (!mountedRef.current) {
      return;
    }
    if (kind === "selected") {
      const element = selectTarget.current;
      const selection = window.getSelection();
      if (element !== null && selection !== null) {
        selection.selectAllChildren(element);
      }
    }
    setFeedback({ kind });
    announceTimerRef.current = window.setTimeout(() => {
      announceTimerRef.current = null;
      setAnnounced(kind);
    }, ANNOUNCE_GAP_MS);
  };

  const hint = t(selectedHintKey(isMacOS()));
  let announcement: string | null = null;
  if (announced === "copied") {
    announcement = t("common.diagnostic.copied");
  } else if (announced === "selected") {
    announcement = hint;
  }

  return { feedback: feedback?.kind ?? null, hint, announcement, copy };
}
