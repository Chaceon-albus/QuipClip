import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useDelayedIndicatorPhase } from "@/components/common/useDelayedIndicator";
import {
  BUFFERING_ELEMENT_EVENTS,
  bufferingIndicatorEvent,
  PREVIEW_BUFFERING_DELAY_MS,
} from "./bufferingIndicator";

/**
 * A small spinner in the bottom-right corner of the preview frame while the video element
 * waits for data during playback (see `bufferingIndicator.ts`).
 *
 * The spinner is decorative and hidden from assistive technology. A polite status region says
 * "Buffering" once when it shows, and it is empty otherwise. The region stays in the tree, so
 * a screen reader announces the change of its text.
 *
 * The caller keys the component on the source, so a source change starts it again with no
 * spinner, and it renders the component only while the element is in the tree. The listeners
 * go on the element that `videoRef` holds when the component mounts.
 */
export function PreviewBufferingIndicator({
  videoRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { t } = useTranslation();
  const [phase, dispatch] = useDelayedIndicatorPhase(PREVIEW_BUFFERING_DELAY_MS);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const listeners = BUFFERING_ELEMENT_EVENTS.map((type) => {
      const listener = () => {
        dispatch(bufferingIndicatorEvent(type));
      };
      video.addEventListener(type, listener);
      return { type, listener };
    });
    return () => {
      for (const { type, listener } of listeners) {
        video.removeEventListener(type, listener);
      }
    };
  }, [videoRef, dispatch]);

  const visible = phase === "visible";
  return (
    <>
      {visible && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-3 bottom-3 z-10 grid size-7 place-items-center rounded-full border border-preview-border bg-preview-background/85 shadow-md"
        >
          <Loader2 className="size-4 animate-spin text-preview-foreground motion-reduce:animate-none" />
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {visible ? t("preview.buffering") : ""}
      </span>
    </>
  );
}
