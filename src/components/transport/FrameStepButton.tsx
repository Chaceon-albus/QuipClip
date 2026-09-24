import { useEffect, useId, useRef, type ReactNode } from "react";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import type { ShortcutLabel } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { playbackStore } from "@/features/playback";
import { createStepHold, isStepHoldPress, type StepHold } from "./stepHold";

/**
 * Keeps a mouse click from moving the focus to the button, as every transport button does
 * (ADR 021). The window shortcut layer takes Space from a focused button, so a step button
 * that kept the focus would turn the next Space into nothing. The Tab order does not change.
 */
const preventFocusOnMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
};

export interface FrameStepButtonProps {
  /** The frames of one step: -1 steps back, 1 steps forward. */
  readonly delta: -1 | 1;
  readonly disabled: boolean;
  /** The name of the action, for the accessible name and the tooltip. */
  readonly label: string;
  readonly shortcut: ShortcutLabel | null;
  /** Why the button is disabled, or null. */
  readonly reason: string | null;
  readonly children: ReactNode;
}

/**
 * One frame step button of the transport bar, with press and hold (see `stepHold.ts`).
 *
 * A primary press steps at once, and a press of 400 ms repeats the step about 30 times each
 * second, one `seekNominal` request for each repeat, as a held arrow key does (ADR 021). The
 * repeat stops on release and on pointer cancel anywhere in the window, on pointer leave,
 * when the window loses the focus, when the button becomes disabled, and when it leaves the
 * tree. Enter on a focused button sends a click with a count of 0, which steps once and does
 * not start the repeat. The window shortcut layer takes Space, as for every button.
 *
 * The button does not capture the pointer. Pointer leave must reach it, so a drag off the
 * button stops the repeat.
 *
 * A disabled button takes no pointer events, so its own tooltip could never open. The span
 * around it is the tooltip trigger, as for the edit buttons: it takes the pointer while the
 * button is disabled, and the events of an enabled button reach it by bubbling. The span has
 * no tabIndex, so the Tab order does not change.
 */
export function FrameStepButton({
  delta,
  disabled,
  label,
  shortcut,
  reason,
  children,
}: FrameStepButtonProps) {
  const reasonId = useId();
  // The hold lives in the effect, so its timers and its window listeners have one owner that
  // cleans them up. The handlers read it when they run, never during the render.
  const holdRef = useRef<StepHold | null>(null);

  useEffect(() => {
    const hold = createStepHold(() => {
      playbackStore.getState().seekNominal(delta);
    });
    holdRef.current = hold;
    // A release can land outside the button, so the end of a press is read on the window, in
    // the capture phase, where no other handler can stop it. A window blur ends it too: the
    // release then goes to another application.
    const stop = () => {
      hold.stop();
    };
    // Every pointer down forgets the last press first. A press that ended off the button sent
    // no click, and its record would otherwise swallow the click of a later press that the
    // button does not take, such as a click with a modifier. The capture phase on the window
    // runs before the pointer down of the button, which then records its own press again.
    const forgetPress = () => {
      hold.forgetPress();
    };
    window.addEventListener("pointerdown", forgetPress, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerdown", forgetPress, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", stop);
      hold.cancel();
      if (holdRef.current === hold) {
        holdRef.current = null;
      }
    };
  }, [delta]);

  // A button that becomes disabled during a hold receives no release, so the hold ends here.
  useEffect(() => {
    if (disabled) {
      holdRef.current?.cancel();
    }
  }, [disabled]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="tool-ghost"
            size="tool-icon"
            disabled={disabled}
            onMouseDown={preventFocusOnMouseDown}
            onPointerDown={(event) => {
              if (isStepHoldPress(event)) {
                holdRef.current?.press();
              }
            }}
            onPointerLeave={() => {
              holdRef.current?.stop();
            }}
            onClick={(event) => {
              holdRef.current?.click(event.detail);
            }}
            aria-label={label}
            aria-describedby={reasonId}
            aria-keyshortcuts={shortcut?.aria}
          >
            {children}
          </Button>
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        </span>
      </TooltipTrigger>
      <ShortcutTooltipContent label={label} keys={shortcut?.keys} reason={reason} />
    </Tooltip>
  );
}
