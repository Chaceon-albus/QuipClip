/**
 * The clips of the sequence in the track lane (ADR 052).
 *
 * `ClipBars` draws one bar for each clip, where the single source bar was. The export cuts away
 * each part that no segment covers, so each bar keeps the quiet hatch of the source bar. A line
 * at each junction shows where one clip ends and the next one starts.
 *
 * `ClipLabels` shows the file name of each clip at the top left of its bar, with a menu that
 * moves the clip, removes it, or clears the timeline. The labels are interactive, and interactive
 * content cannot be inside the `role="slider"` element of the lane, so they are a sibling of the
 * slider, as the segment layer is.
 *
 * Both read the place of each clip from the virtual axis of the timeline store, so they agree
 * with the segments and the playhead by construction: every position is a percent of the same
 * extent.
 */

import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { quitGuard } from "@/components/layout/quitGuardController";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import {
  timelineStore,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { calculateClipBarLayouts } from "./clipBarLayout";

const selectVirtual = (state: TimelineStoreState) => state.virtual;
const selectSources = (state: MediaStoreState) => state.sources;

/** The hatch of a bar: the part of a source that no segment keeps (see the source bar note). */
const BAR_CLASS =
  "pointer-events-none absolute inset-y-0 rounded-lg border border-timeline-divider bg-timeline-track bg-[linear-gradient(135deg,var(--timeline-divider)_0_9%,transparent_9%_50%,var(--timeline-divider)_50%_59%,transparent_59%)] bg-size-[8px_8px]";

/** One hatched bar for each clip. With no axis, one bar spans the lane, as before ADR 052. */
export function ClipBars({
  totalDurationSeconds,
}: {
  totalDurationSeconds: number | null;
}) {
  const virtual = useTimelineStore(selectVirtual);
  const layouts = calculateClipBarLayouts(virtual, totalDurationSeconds);
  if (layouts === null || layouts.length <= 1) {
    return <div className={`${BAR_CLASS} inset-x-0`} />;
  }
  return (
    <>
      {layouts.map((layout) => (
        <div
          key={layout.clipId}
          className={BAR_CLASS}
          style={{ left: `${layout.leftPercent}%`, width: `${layout.widthPercent}%` }}
          data-clip-id={layout.clipId}
        />
      ))}
    </>
  );
}

/** The file name and the menu of each clip. */
export function ClipLabels({
  totalDurationSeconds,
}: {
  totalDurationSeconds: number | null;
}) {
  const { t } = useTranslation();
  const virtual = useTimelineStore(selectVirtual);
  const sources = useMediaStore(selectSources);
  const layouts = calculateClipBarLayouts(virtual, totalDurationSeconds);
  if (layouts === null) {
    return null;
  }
  const count = layouts.length;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1 h-0">
      {layouts.map((layout) => {
        const name = sources[layout.sourceId]?.fileName ?? "";
        return (
          <div
            key={layout.clipId}
            className="pointer-events-none absolute top-0 flex max-w-full min-w-0 items-center"
            // 8px inside the clip, clear of the 6px edge of a segment that starts with the clip.
            style={{
              left: `calc(${layout.leftPercent}% + 8px)`,
              maxWidth: `calc(${layout.widthPercent}% - 8px)`,
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-events-auto z-20 h-5 max-w-full min-w-0 gap-1 rounded-sm bg-timeline-track/80 px-1 text-[11px] font-normal text-muted-foreground"
                  aria-label={t("timeline.clip.menu", { name })}
                  title={name}
                >
                  <span className="truncate">{name}</span>
                  <MoreHorizontal className="size-3 shrink-0" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  disabled={layout.index === 0}
                  onSelect={() =>
                    timelineStore.getState().moveClip(layout.index, layout.index - 1)
                  }
                >
                  {t("timeline.clip.moveLeft")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={layout.index === count - 1}
                  onSelect={() =>
                    timelineStore.getState().moveClip(layout.index, layout.index + 2)
                  }
                >
                  {t("timeline.clip.moveRight")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => timelineStore.getState().removeClip(layout.index)}
                >
                  {t("timeline.clip.remove")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => quitGuard.requestClear()}>
                  {t("timeline.clip.clear")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
