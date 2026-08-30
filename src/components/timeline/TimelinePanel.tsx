import { useTranslation } from "react-i18next";
import { Eye, Film, Lock } from "lucide-react";

/**
 * Static time markers along the ruler.
 */
const RULER_MARKERS = [
  { time: "00:00:00:00", left: "2%", active: false },
  { time: "00:00:05:00", left: "18%", active: true },
  { time: "00:00:10:00", left: "34%", active: false },
  { time: "00:00:15:00", left: "50%", active: false },
  { time: "00:00:20:00", left: "66%", active: false },
  { time: "00:00:25:00", left: "82%", active: false },
  { time: "00:00:30:00", left: "98%", active: false },
];

export function TimelinePanel() {
  const { t } = useTranslation();

  return (
    <section className="flex h-[180px] shrink-0 flex-col border-t border-timeline-divider bg-timeline-background text-foreground select-none">
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-hidden">
        <div className="flex min-w-[900px] flex-1 flex-col">
          {/* Ruler Row (~28px tall) */}
          <div className="flex h-7 shrink-0 border-b border-timeline-divider">
            {/* Gutter header pinned sticky on the left */}
            <div className="sticky left-0 z-20 w-24 shrink-0 border-r border-timeline-divider bg-sidebar" />

            {/* Ruler track with time markers and tick marks */}
            <div className="relative flex-1 bg-timeline-ruler">
              {/* Playhead handle at top of ruler */}
              <div className="pointer-events-none absolute top-0 bottom-0 left-[18%] z-30 flex -translate-x-1/2 flex-col items-center">
                <div className="h-3.5 w-3 rounded-b-xs bg-timeline-playhead shadow-xs" />
                <div className="w-0.5 flex-1 bg-timeline-playhead" />
              </div>

              {/* Timecode labels and ticks */}
              <div className="relative h-full w-full font-mono text-[10px]">
                {RULER_MARKERS.map((marker) => (
                  <div
                    key={marker.time}
                    className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                    style={{ left: marker.left }}
                  >
                    <span
                      className={
                        marker.active
                          ? "font-medium text-primary"
                          : "text-muted-foreground"
                      }
                    >
                      {marker.time}
                    </span>
                    <div className="h-1.5 w-px bg-timeline-divider" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Single Track Row */}
          <div className="flex min-h-0 flex-1">
            {/* Left gutter (~96px wide) */}
            <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center justify-between border-r border-timeline-divider bg-sidebar px-3">
              <span className="text-xs font-semibold text-sidebar-foreground">
                {t("timeline.track.videoTrack")}
              </span>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Eye className="size-3.5" aria-hidden="true" />
                <Lock className="size-3.5" aria-hidden="true" />
              </div>
            </div>

            {/* Track lane */}
            <div className="relative flex flex-1 items-center bg-timeline-track p-2">
              {/* Playhead vertical line continuing across track */}
              <div className="pointer-events-none absolute top-0 bottom-0 left-[18%] z-30 w-0.5 -translate-x-1/2 bg-timeline-playhead" />

              {/* Clips container */}
              <div className="relative h-full w-full rounded-md">
                {/* Segment 1 */}
                <div className="absolute top-1 bottom-1 left-[2%] flex w-[26%] items-center gap-2 overflow-hidden rounded-lg bg-clip-video p-2 text-clip-foreground shadow-xs">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                    <Film className="size-3.5" />
                  </div>
                  <span className="truncate text-xs font-medium">
                    lake_morning_fog.mp4
                  </span>
                </div>

                {/* Segment 2 (Selected) */}
                <div className="absolute top-1 bottom-1 left-[30%] flex w-[32%] items-center gap-2 overflow-hidden rounded-lg border border-clip-video-selected-border bg-clip-video-selected p-2 text-clip-foreground shadow-xs">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                    <Film className="size-3.5" />
                  </div>
                  <span className="truncate text-xs font-medium">
                    lake_morning_fog.mp4
                  </span>
                </div>

                {/* Segment 3 */}
                <div className="absolute top-1 bottom-1 left-[64%] flex w-[28%] items-center gap-2 overflow-hidden rounded-lg bg-clip-video p-2 text-clip-foreground shadow-xs">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                    <Film className="size-3.5" />
                  </div>
                  <span className="truncate text-xs font-medium">
                    lake_morning_fog.mp4
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
