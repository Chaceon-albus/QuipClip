/**
 * The clips of the sequence in the track lane (ADR 052).
 *
 * `ClipBars` draws one bar for each clip, where the single source bar was. The export cuts away
 * each part that no segment covers, so each bar keeps the quiet hatch of the source bar. A line
 * at each junction shows where one clip ends and the next one starts.
 *
 * `ClipLabels` shows the file name of each clip at the top left of its bar, with a menu that
 * shows, cancels or hides the audio envelope of the source of the clip (ADR 056), chooses the
 * audio track of a source with two or more audio streams (ADR 070), moves the clip, removes it,
 * or clears the timeline. The labels are interactive, and interactive content cannot be inside
 * the `role="slider"` element of the lane, so they are a sibling of the slider, as the segment
 * layer is.
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { previewPathOfMedia } from "@/components/preview/previewPath";
import {
  audioOverrideStore,
  previewAudioStreamOf,
  useAudioOverrides,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import { useShallow } from "zustand/react/shallow";
import {
  IDLE_WAVEFORM_SOURCE,
  resolveWaveformAction,
  useWaveformStore,
  type WaveformMenuAction,
  type WaveformPhase,
  type WaveformStoreState,
} from "@/features/waveform";
import { waveformController } from "@/features/waveform/instance";
import {
  timelineStore,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import {
  audioTrackItemText,
  presentAudioTrackMenu,
  type AudioTrackMenu,
  type AudioTrackTranslate,
} from "./audioTrackMenu";
import { calculateClipBarLayouts } from "./clipBarLayout";

const selectVirtual = (state: TimelineStoreState) => state.virtual;
const selectSources = (state: MediaStoreState) => state.sources;
// The phase of each source, and not its progress, so a running job does not render the labels
// at each progress message.
const selectWaveformPhases = (
  state: WaveformStoreState,
): Record<string, WaveformPhase> =>
  Object.fromEntries(
    Object.entries(state.sources).map(([id, source]) => [id, source.phase]),
  );
const selectRunningSourceId = (state: WaveformStoreState) => state.runningSourceId;

/** The catalog key of each envelope item. */
const WAVEFORM_ITEM_KEYS = {
  show: "timeline.clip.showWaveform",
  cancel: "timeline.clip.cancelWaveform",
  hide: "timeline.clip.hideWaveform",
} as const satisfies Record<WaveformMenuAction, string>;

function runWaveformAction(action: WaveformMenuAction, sourceId: string): void {
  switch (action) {
    case "show":
      waveformController.show(sourceId);
      return;
    case "cancel":
      waveformController.cancel(sourceId);
      return;
    case "hide":
      waveformController.hide(sourceId);
      return;
  }
}

/**
 * The "Audio Track" submenu of the source of a clip (ADR 070). Each item is a radio item, and the
 * effective stream has the mark. The note is a label under the items, not an item, so it cannot be
 * chosen.
 */
function AudioTrackSubmenu({
  sourceId,
  menu,
}: {
  sourceId: string;
  menu: AudioTrackMenu;
}) {
  const { t } = useTranslation();
  const translate = t as unknown as AudioTrackTranslate;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t("timeline.clip.audioTrack")}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-w-80">
        <DropdownMenuRadioGroup
          value={menu.checkedIndex === null ? "" : String(menu.checkedIndex)}
          onValueChange={(value) => {
            const item = menu.items.find(
              (entry) => String(entry.stream.index) === value,
            );
            if (item !== undefined) {
              audioOverrideStore.getState().choose(sourceId, menu.probe, item.stream);
            }
          }}
        >
          {menu.items.map((item) => (
            <DropdownMenuRadioItem
              key={item.stream.index}
              value={String(item.stream.index)}
            >
              {audioTrackItemText(item, translate)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {menu.showsPreviewNote ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal whitespace-normal">
              {t("timeline.clip.audioTrackPreviewNote")}
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

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
  const waveformPhases = useWaveformStore(useShallow(selectWaveformPhases));
  const runningSourceId = useWaveformStore(selectRunningSourceId);
  const audioOverrides = useAudioOverrides();
  const waveformSources = Object.fromEntries(
    Object.entries(waveformPhases).map(([id, phase]) => [
      id,
      { ...IDLE_WAVEFORM_SOURCE, phase },
    ]),
  );
  const layouts = calculateClipBarLayouts(virtual, totalDurationSeconds);
  if (layouts === null) {
    return null;
  }
  const count = layouts.length;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1 h-0">
      {layouts.map((layout) => {
        const name = sources[layout.sourceId]?.fileName ?? "";
        const waveform = resolveWaveformAction(
          layout.sourceId,
          sources[layout.sourceId],
          {
            sources: waveformSources,
            runningSourceId,
          },
        );
        const media = sources[layout.sourceId];
        const override = audioOverrides[layout.sourceId];
        // The note of the submenu depends on how the preview plays the source (ADR 070).
        const audioTracks =
          media === undefined
            ? null
            : presentAudioTrackMenu(
                media.probe,
                override,
                previewPathOfMedia(media, previewAudioStreamOf(media.probe, override))
                  .kind,
              );
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
                  disabled={!waveform.enabled}
                  onSelect={() => runWaveformAction(waveform.action, layout.sourceId)}
                >
                  {t(WAVEFORM_ITEM_KEYS[waveform.action])}
                </DropdownMenuItem>
                {audioTracks === null ? null : (
                  <AudioTrackSubmenu sourceId={layout.sourceId} menu={audioTracks} />
                )}
                <DropdownMenuSeparator />
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
