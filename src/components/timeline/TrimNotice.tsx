import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ANNOUNCE_GAP_MS } from "@/components/common/diagnosticDetailsModel";
import { segmentTrimSession } from "./segmentTrimSession";

/** How long the notice of a trim that was not applied stays visible, in milliseconds. */
export const TRIM_NOTICE_DURATION_MS = 4000;

/**
 * The notice of a trim that was not applied (ADR 030). A released trim can end with no commit:
 * no frame of the target frame arrived in time, the calibration or the source changed, or
 * a later seek replaced the seek of the release. The segment then keeps its boundaries, the
 * preview disappears, and this notice says so, so that the change does not revert in silence.
 *
 * The session counts those trims (`getNoticeCount`). Each new count shows a chip in the timeline
 * for `TRIM_NOTICE_DURATION_MS` and puts the message into a live region. A screen reader speaks
 * a region only when its text changes, so the region is emptied first, and the message goes in
 * `ANNOUNCE_GAP_MS` later, as the Copy feedback does. The chip is aria-hidden, so the message is
 * not read twice, and it takes no pointer event. It takes the tooltip palette, with the border
 * of that palette, which the dark theme needs to set the chip apart from the timeline.
 */
export const TrimNotice = memo(function TrimNotice() {
  const { t } = useTranslation();
  const [isShown, setIsShown] = useState(false);
  const [isAnnounced, setIsAnnounced] = useState(false);

  useEffect(() => {
    let lastCount = segmentTrimSession.getNoticeCount();
    let announceTimer: number | null = null;
    let hideTimer: number | null = null;
    const clearTimers = () => {
      if (announceTimer !== null) {
        window.clearTimeout(announceTimer);
        announceTimer = null;
      }
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const unsubscribe = segmentTrimSession.subscribe(() => {
      const count = segmentTrimSession.getNoticeCount();
      if (count === lastCount) {
        return;
      }
      lastCount = count;
      clearTimers();
      setIsShown(true);
      setIsAnnounced(false);
      announceTimer = window.setTimeout(() => {
        announceTimer = null;
        setIsAnnounced(true);
      }, ANNOUNCE_GAP_MS);
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        setIsShown(false);
        setIsAnnounced(false);
      }, TRIM_NOTICE_DURATION_MS);
    });
    return () => {
      unsubscribe();
      clearTimers();
    };
  }, []);

  const message = t("timeline.trimNotApplied");
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isAnnounced ? message : ""}
      </span>
      {isShown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-2 bottom-3 z-50 rounded-sm border border-tooltip-border bg-tooltip px-2 py-1 text-xs text-tooltip-foreground"
        >
          {message}
        </div>
      )}
    </>
  );
});
