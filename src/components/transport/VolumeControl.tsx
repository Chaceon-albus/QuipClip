import {
  useMemo,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Slider as SliderPrimitive } from "radix-ui";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isPreviewSilent,
  MAX_PREVIEW_VOLUME_PERCENT,
  previewMutePreferenceStore,
  usePreviewMutePreference,
} from "@/features/settings/previewMutePreference";
import { getResolvedLanguage } from "@/i18n";
import {
  VOLUME_LARGE_STEP_PERCENT,
  focusAfterPress,
  largeStepDirection,
  type VolumeSliderPress,
} from "./volumeSlider";

// The preference actions never change, so they are read once.
const { toggleMuted, setVolumePercent } = previewMutePreferenceStore.getState();

/**
 * One step of the slider for an arrow key and for a drag, in percent. Page Up, Page Down, and
 * Shift with an arrow take `VOLUME_LARGE_STEP_PERCENT`.
 */
const VOLUME_STEP_PERCENT = 5;

/** Below this volume, in percent, the glyph shows one wave instead of two. */
const LOW_VOLUME_PERCENT = 50;

/**
 * The mute toggle and the volume slider of the transport bar. Both set the preview preference
 * (`previewMutePreference`), which reaches the preview elements and the frame step cue. Neither
 * needs a source, so neither is ever disabled.
 *
 * The toggle keeps the same name in both states, and aria-pressed says whether the preview is
 * silent, so a screen reader does not hear a name that changes with the state. The glyph and the
 * fill show the state to the eye. The preview is silent while mute is on or while the volume is
 * 0, and the toggle shows both as pressed, because both give no sound. While it is pressed,
 * hover goes one step past the rest fill, and press mixes the hover fill 5% toward the
 * foreground, the press of the secondary variant, so a press still shows. It has no key: the
 * free conventional key of media players, M, is the marker key of the editors that ADR 026
 * follows.
 *
 * The slider keeps its position while mute is on, and its fill turns to the muted colour, so the
 * level that unmute gives back stays in view. Its value text then says that mute is on. A move of
 * the slider to a level above 0 turns mute off. A focused slider owns the arrow keys, Home, End,
 * Page Up and Page Down (`isValueSliderKey`). Space still plays. Only a press of the primary
 * button without Control moves the slider: Radix reads no button, so the slider cancels the
 * press of any other button, and a Control-click.
 *
 * A transport control does not keep the focus after a mouse press (ADR 021): the window layer
 * then gives the arrow keys to the playhead again. Radix moves the focus to the thumb on each
 * change of the value, so the slider cannot cancel the mouse down as a button does
 * (`preventFocusOnMouseDown`). It notes the focused element at the press instead, and gives the
 * focus back to it when the press ends (`focusAfterPress`). A press that starts with the focus
 * inside the slider leaves the focus there.
 */
export function VolumeControl() {
  const { t, i18n } = useTranslation();
  const isMuted = usePreviewMutePreference((s) => s.muted);
  const volumePercent = usePreviewMutePreference((s) => s.volumePercent);
  const isSilent = isPreviewSilent({ muted: isMuted, volumePercent });

  const resolvedLanguage = getResolvedLanguage(i18n);
  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        style: "percent",
        maximumFractionDigits: 0,
      }),
    [resolvedLanguage],
  );
  const levelText = percentFormatter.format(volumePercent / 100);
  const volumeText = isMuted
    ? t("transport.state.volumeMuted", { level: levelText })
    : levelText;

  // The focus when the running mouse press on the slider began, or null while no press runs.
  const pressRef = useRef<VolumeSliderPress<HTMLElement> | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    // A cancelled pointer down makes Radix skip its capture, its slide and its focus. WebKit
    // reports a Control-click, which opens the context menu on macOS, as the primary button.
    if (event.button !== 0 || event.ctrlKey) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    pressRef.current = {
      startedInside: active !== null && event.currentTarget.contains(active),
      previous:
        active instanceof HTMLElement && active !== document.body ? active : null,
    };
  };

  // Radix captures the pointer on the element under it, and releases it on pointer up. A
  // cancelled pointer also loses the capture, so this one event ends every press.
  const handleLostPointerCapture = (event: PointerEvent<HTMLSpanElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    const active = document.activeElement;
    const focusInside =
      active instanceof HTMLElement && event.currentTarget.contains(active);
    switch (focusAfterPress(press, focusInside)) {
      case "restore":
        press?.previous?.focus({ preventScroll: true });
        break;
      case "blur":
        if (active instanceof HTMLElement) {
          active.blur();
        }
        break;
      case "leave":
        break;
    }
  };

  // A focus that leaves the slider during a press, such as a window switch, ends the note, so
  // a later press cannot give the focus to an element from before.
  const handleBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    pressRef.current = null;
  };

  // A handled key press is cancelled, so the key handler of Radix skips it.
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const direction = largeStepDirection(event);
    if (direction === null) {
      return;
    }
    event.preventDefault();
    setVolumePercent(
      previewMutePreferenceStore.getState().volumePercent +
        direction * VOLUME_LARGE_STEP_PERCENT,
    );
  };

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="tool-ghost"
            size="tool-icon"
            onMouseDown={preventFocusOnMouseDown}
            onClick={toggleMuted}
            className="aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:hover:bg-secondary-hover aria-pressed:active:bg-[color-mix(in_oklab,var(--secondary-hover),var(--foreground)_5%)]"
            aria-label={t("transport.action.mute")}
            aria-pressed={isSilent}
          >
            {isSilent ? (
              <VolumeX className="size-4" />
            ) : volumePercent < LOW_VOLUME_PERCENT ? (
              <Volume1 className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <ShortcutTooltipContent label={t("transport.action.mute")} />
      </Tooltip>

      {/* The root is 40 px high, the row size of the bar, so the whole height takes a press,
          and the track is 4 px of it. The fill and the thumb border are the primary colour,
          and both turn to the muted foreground while mute is on. The unfilled track is the
          muted foreground at 75%, as the unchecked track of the Switch, so the extent of the
          control reads against the bar. The fill is then close to the track in the light
          theme, but the thumb marks the level at every value, so the fill is a second cue.
          Measured with the WCAG 2 formula against the palette, on the background of the bar:
          | Part                          | Light  | Dark   |
          | ----------------------------- | ------ | ------ |
          | Track, bar                    | 3.29:1 | 4.29:1 |
          | Thumb border, bar             | 4.74:1 | 8.28:1 |
          | Thumb border while muted, bar | 5.55:1 | 6.91:1 |
          | Fill, track                   | 1.44:1 | 1.93:1 | */}
      <Tooltip>
        <TooltipTrigger asChild>
          <SliderPrimitive.Root
            // The marker of `VALUE_SLIDER_SELECTOR` (`isValueSliderKey`).
            data-value-slider=""
            min={0}
            max={MAX_PREVIEW_VOLUME_PERCENT}
            step={VOLUME_STEP_PERCENT}
            value={[volumePercent]}
            onValueChange={(values) => {
              const [next] = values;
              if (next !== undefined) {
                setVolumePercent(next);
              }
            }}
            onPointerDown={handlePointerDown}
            onLostPointerCapture={handleLostPointerCapture}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="group/volume relative flex h-10 w-20 shrink-0 touch-none items-center select-none"
            data-muted={isMuted ? "" : undefined}
          >
            <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-muted-foreground/75">
              <SliderPrimitive.Range className="absolute h-full bg-primary group-data-muted/volume:bg-muted-foreground" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
              className="block size-3.5 rounded-full border-2 border-primary bg-card shadow-xs focus-ring transition-[border-color,box-shadow] outline-none group-data-muted/volume:border-muted-foreground"
              aria-label={t("transport.action.volume")}
              aria-valuetext={volumeText}
            />
          </SliderPrimitive.Root>
        </TooltipTrigger>
        <ShortcutTooltipContent
          label={t("transport.action.volume")}
          reason={volumeText}
        />
      </Tooltip>
    </div>
  );
}
