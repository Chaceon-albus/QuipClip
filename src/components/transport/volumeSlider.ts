/**
 * The rules of the volume slider of the transport bar (`VolumeControl`) that do not need React or
 * the DOM: the large step of the keys, and where the focus goes when a mouse press ends.
 */

/** The large step of the slider, in percent: Page Up, Page Down, and Shift with an arrow. */
export const VOLUME_LARGE_STEP_PERCENT = 10;

/** The part of a key press that `largeStepDirection` reads. */
export interface VolumeKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
}

/**
 * The direction of a large step for a key press on the slider: 1 up, -1 down, or null for a key
 * that is not a large step. Radix takes ten steps for these keys, which is 50 percent at a step of
 * 5, so the slider takes the key press and moves `VOLUME_LARGE_STEP_PERCENT` itself. The
 * directions are those of a horizontal Radix slider: Right and Up raise the value, Left and Down
 * lower it.
 */
export function largeStepDirection(press: VolumeKeyPress): 1 | -1 | null {
  switch (press.key) {
    case "PageUp":
      return 1;
    case "PageDown":
      return -1;
    case "ArrowRight":
    case "ArrowUp":
      return press.shiftKey ? 1 : null;
    case "ArrowLeft":
    case "ArrowDown":
      return press.shiftKey ? -1 : null;
    default:
      return null;
  }
}

/** The focus at the start of a mouse press on the slider. */
export interface VolumeSliderPress<T extends { readonly isConnected: boolean }> {
  /** True when the focus was inside the slider when the press began. */
  readonly startedInside: boolean;
  /** The element that had the focus when the press began, or null when only the body had it. */
  readonly previous: T | null;
}

/**
 * What the slider does with the focus when a mouse press ends (ADR 021):
 *
 * - `leave`: no press runs, the press began with the focus inside the slider, or the focus is no
 *   longer inside it. The focus stays where it is.
 * - `restore`: the focus goes back to the element that had it before the press.
 * - `blur`: no element had it before the press, or that element left the document. The slider
 *   gives up the focus.
 */
export function focusAfterPress<T extends { readonly isConnected: boolean }>(
  press: VolumeSliderPress<T> | null,
  focusInside: boolean,
): "leave" | "restore" | "blur" {
  if (press === null || press.startedInside || !focusInside) {
    return "leave";
  }
  return press.previous?.isConnected === true ? "restore" : "blur";
}
