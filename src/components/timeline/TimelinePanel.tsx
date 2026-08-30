import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import { useMediaStore } from "@/features/media";
import { generateRulerMarkers } from "./timelineMarkers";

export function TimelinePanel() {
  const { t } = useTranslation();
  const media = useMediaStore((state) => state.media);

  const markers = media
    ? generateRulerMarkers(media.probe.frameCount, media.probe.avgFrameRate)
    : [];

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
              {/* Timecode labels and ticks */}
              <div className="relative h-full w-full font-mono text-[10px]">
                {markers.map((marker) => (
                  <div
                    key={`${marker.frame}-${marker.left}`}
                    className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                    style={{ left: marker.left }}
                  >
                    <span className="text-muted-foreground">{marker.timecode}</span>
                    <div className="h-1.5 w-px bg-timeline-divider" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Single-Source Overview Track Row */}
          <div className="flex min-h-0 flex-1">
            {/* Left gutter (~96px wide) displaying Source Media lane header */}
            <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center border-r border-timeline-divider bg-sidebar px-3">
              <span className="truncate text-xs font-semibold text-sidebar-foreground">
                {t("timeline.sourceLane")}
              </span>
            </div>

            {/* Track lane */}
            <div className="relative flex flex-1 items-center bg-timeline-track p-2">
              {media ? (
                /* Single-source overview lane spanning the full source extent */
                <div className="relative h-full w-full">
                  <div className="absolute inset-0 flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-clip-video p-2 text-clip-foreground shadow-xs">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                      <Film className="size-3.5" />
                    </div>
                    <span className="truncate text-xs font-medium">
                      {media.fileName}
                    </span>
                  </div>
                </div>
              ) : (
                /* Localized empty prompt */
                <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                  <span className="italic">{t("timeline.emptyPrompt")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
