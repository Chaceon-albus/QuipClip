import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDelayedVisibility } from "@/components/common/useDelayedIndicator";
import { isSourceActive } from "@/components/layout/actionConditions";
import { MarkInIcon, MarkOutIcon } from "@/components/transport/markPointIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import { usePlaybackStore } from "@/features/playback";
import { useTimelineStore, type TimelineStoreState } from "@/features/timeline";
import { cn } from "@/lib/utils";
import {
  BOUNDARY_BADGE_DELAY_MS,
  boundaryBadgeFramePts,
  describeBoundaryBadges,
  indexSegmentBoundaries,
  matchBoundaryBadges,
  type BoundaryBadgeLine,
} from "./boundaryBadgeModel";

const selectHasMedia = (s: MediaStoreState) => s.media !== null;
const selectSegments = (s: TimelineStoreState) => s.segments;
const selectSourceId = (s: TimelineStoreState) => s.sourceId;
const selectPendingInPts = (s: TimelineStoreState) => s.pendingInPts;

type BoundaryBadgeKind = "in" | "out";

/**
 * One badge: the bracket glyph of its mark, as the transport bar and the timeline draw it,
 * and the short name of the mark.
 *
 * The In badge is filled with the brand colour, as a segment and the pending In flag are:
 * its frame is in the segment. The Out badge is only outlined on the dark ground of the
 * preview, and its glyph puts the segment block before the bracket, with the name after it:
 * its frame is the first frame after the segment, outside it (ADR 002).
 *
 * The tooltip gives one line for each boundary that the frame is. The badge takes the pointer
 * for its tooltip only. It is not a control and takes no focus, because it comes and goes with
 * each frame step. The status region of the badges gives the same lines to assistive
 * technology.
 */
function BoundaryBadge({
  kind,
  label,
  lines,
}: {
  kind: BoundaryBadgeKind;
  label: string;
  lines: readonly string[];
}) {
  const Icon = kind === "in" ? MarkInIcon : MarkOutIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "pointer-events-auto inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm border border-primary px-1.5 text-2xs leading-none font-semibold uppercase shadow-md",
            kind === "in"
              ? "bg-primary text-primary-foreground"
              : "bg-preview-background/85 text-preview-foreground",
          )}
        >
          <Icon className={cn("size-3.5", kind === "out" && "text-primary")} />
          <span className="truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="flex-col items-start gap-1"
      >
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The In and Out badges of the preview frame (see `boundaryBadgeModel.ts`). A badge shows when
 * the frame on screen is a stored boundary: "In" for the In frame of a segment or for the
 * pending In mark, and "Out" for the Out frame of a segment.
 *
 * - **The frame.** The test is the exact PTS of the presented frame, and it runs only while
 *   the calibration is ready, a frame is presented, no seek is pending and playback is paused.
 *   The store selector settles on that PTS or null, so playback renders nothing here.
 * - **No flash.** A badge shows only after the frame has stayed on its boundary for
 *   `BOUNDARY_BADGE_DELAY_MS`, and it hides at once when the frame leaves, as the dimming of
 *   the transport edit controls does. A held step key that passes a boundary shows nothing.
 *   The badges then fade in. The fade changes only the opacity, so reduced motion keeps it.
 * - **A shared frame.** The frame at a split point is the Out frame of one segment and the In
 *   frame of the next. Both badges show, Out first and In second, in the order of the two
 *   brackets on the timeline, where the `]` of the earlier segment meets the `[` of the later
 *   one. Two badges keep the rule of each: the frame is outside the one segment and inside the
 *   other.
 * - **Placement.** The badges sit in the top-left corner of the picture, and wrap inside it
 *   when the picture is narrow. The frame takes the ratio of the picture only inside the
 *   limits of `previewFrameAspectRatio`. A wider or taller picture has bars inside the frame,
 *   so the badges take the picture box that the pane passes (`previewPictureBox`), centred in
 *   the frame, and never sit on a bar. A very tall picture, about 1:8 or narrower, in a small
 *   frame gives a box so narrow that `overflow-hidden` can cut the badge. That is accepted.
 *   The notices take the top-left corner of the frame, so the pane passes `suppressed` while a
 *   notice shows, and the badges hide. The buffering spinner is in the bottom-right corner,
 *   and it shows only while playback waits for data, when no badge shows. The typed timecode
 *   is under the frame, and its error at the bottom-left edge of the picture. The badges are
 *   drawn below the notices and the spinner.
 *
 * The caller keys the component on the source, so a new source starts with no badge.
 */
export function PreviewBoundaryBadges({
  suppressed,
  pictureBoxStyle,
}: {
  suppressed: boolean;
  /** The size of the picture box in the frame (`previewPictureBoxStyle`). */
  pictureBoxStyle: CSSProperties;
}) {
  const { t } = useTranslation();
  const hasMedia = useMediaStore(selectHasMedia);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const pendingInPts = useTimelineStore(selectPendingInPts);

  // Parsed once for each edit, so the test for each frame only compares BigInt values.
  const index = useMemo(
    () => indexSegmentBoundaries(segments, sourceId, pendingInPts),
    [segments, sourceId, pendingInPts],
  );
  const framePts = usePlaybackStore((s) =>
    boundaryBadgeFramePts(s, isSourceActive(hasMedia, s.isAttached, s.isReady)),
  );
  const badges = useMemo(() => matchBoundaryBadges(framePts, index), [framePts, index]);
  const visible = useDelayedVisibility(
    !suppressed && badges !== null,
    BOUNDARY_BADGE_DELAY_MS,
  );

  const lines = visible && badges !== null ? describeBoundaryBadges(badges) : null;
  const lineText = (line: BoundaryBadgeLine) =>
    line.key === "preview.boundaryBadge.inPending"
      ? t(line.key)
      : t(line.key, line.values);
  const outLines = lines?.out.map(lineText) ?? [];
  const inLines = lines?.in.map(lineText) ?? [];

  return (
    <>
      {/* The outer layer is the content box of the frame, inside its 1px border, where the
          element lies. The inner layer is the picture box, centred in it, as `object-fit:
          contain` centres the picture. */}
      {lines !== null && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-px">
          <div
            className="absolute inset-0 m-auto flex animate-in flex-wrap content-start items-start gap-1 overflow-hidden p-2 duration-(--motion-fast) ease-enter fade-in-0"
            style={pictureBoxStyle}
          >
            {outLines.length > 0 && (
              <BoundaryBadge
                kind="out"
                label={t("preview.boundaryBadge.out")}
                lines={outLines}
              />
            )}
            {inLines.length > 0 && (
              <BoundaryBadge
                kind="in"
                label={t("preview.boundaryBadge.in")}
                lines={inLines}
              />
            )}
          </div>
        </div>
      )}
      {/* The region stays in the tree, so a screen reader announces each change of its text:
          once when the frame on screen settles on a boundary. */}
      <span role="status" aria-live="polite" className="sr-only">
        {[...outLines, ...inLines].join(" ")}
      </span>
    </>
  );
}
