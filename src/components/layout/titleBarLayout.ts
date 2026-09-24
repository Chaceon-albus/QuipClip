/**
 * The position of the macOS window buttons, and the left reserve of the title bar (ADR 020).
 *
 * macOS draws the close, minimize and zoom buttons over the top left of the web view, because
 * the window uses `titleBarStyle: "Overlay"`. `trafficLightPosition` in
 * `src-tauri/tauri.macos.conf.json` moves them, and the title bar keeps the space under them
 * free. In full screen the system hides the buttons, so the title bar gives the space back.
 *
 * # The vertical position
 *
 * tao and wry apply `trafficLightPosition` with one rule. They set the height of the title bar
 * container of AppKit to `buttonSize + y`, and they move each button to `x` plus its default
 * distance from the first button. They do not move a button vertically: it keeps its default
 * distance from the bottom of the container, which is `(defaultTitleBarHeight - buttonSize) / 2`
 * because AppKit centres the buttons in its own title bar. So the centre of a button is
 * `y + buttonSize / 2 - (defaultTitleBarHeight - buttonSize) / 2` from the top of the window.
 *
 * The title bar is 40 pixels high, and its 1 pixel bottom border is inside that height, so its
 * controls centre at 19.5. The buttons centre at 19, the whole point above: a frame on whole
 * points stays sharp on a display at a scale of 1. With the macOS 26 metrics below, the centre
 * is `y - 2`, so `y` is 21.
 *
 * # The horizontal position and the reserve
 *
 * The top of a button is then 19 - 7 = 12 points from the top of the window. `x` is 12 too, so
 * the margin to the left edge equals the margin to the top edge, as it does in the default
 * layout of AppKit (9 and 9 in its 32 point title bar). The zoom button then ends at
 * 12 + 2 * 23 + 14 = 72. The reserve adds a gap of 12, the same margin again, so the File menu
 * starts at 84. In full screen the reserve is `pl-3`, 12 pixels, the left padding of the
 * Windows title bar.
 *
 * # Other macOS versions
 *
 * The metrics are the metrics of macOS 26 and later, measured with `standardWindowButton` on
 * macOS 27. macOS 15 and earlier use a 28 point title bar and a different button frame, so the
 * same `y` would put the buttons lower there. `src-tauri/src/traffic_lights.rs` therefore
 * measures the close button when the application starts, and it builds the window with the `y`
 * that the same rule gives for the measured metrics. The configured value is the fallback when
 * the measurement fails. `x` and the reserve are not measured.
 *
 * On macOS 15 and earlier the buttons are reported to start 20 points apart. The zoom button
 * then ends at 66, and the gap before the File menu is 18 there.
 */

/** The height of the title bar in CSS pixels, `h-10` in `TitleBar.tsx`. */
export const TITLE_BAR_HEIGHT_PX = 40;

/** The bottom border of the title bar, `border-b`, inside `TITLE_BAR_HEIGHT_PX`. */
export const TITLE_BAR_BORDER_PX = 1;

/** The width and the height of the frame of one macOS window button, in points (macOS 26). */
export const MAC_WINDOW_BUTTON_SIZE = 14;

/** The distance from the left edge of one window button to the next, in points (macOS 26). */
export const MAC_WINDOW_BUTTON_PITCH = 23;

/** The height of the default AppKit title bar that centres the buttons, in points (macOS 26). */
export const MAC_DEFAULT_TITLE_BAR_HEIGHT = 32;

/** `trafficLightPosition` in `src-tauri/tauri.macos.conf.json`. A test compares the two. */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 21 } as const;

/**
 * The left padding of the macOS title bar while the window buttons show: the end of the zoom
 * button, 72, and a gap of 12. `resolveTitleBarPadding` holds it as a class.
 */
export const MAC_TITLE_BAR_RESERVE_PX = 84;

/** The facts that decide the horizontal padding of the title bar. */
export interface TitleBarPaddingInput {
  /** True on macOS, where the system draws the window buttons. */
  readonly isMac: boolean;
  /** True while the window is in full screen. Only macOS reads it. */
  readonly fullscreen: boolean;
}

/**
 * The horizontal padding classes of the title bar.
 *
 * - macOS, windowed: the reserve for the window buttons on the left, and 12 on the right.
 * - macOS, full screen: the system hides the window buttons, so 12 on both sides.
 * - Every other platform: 12 on the left. The right is 0, because the window buttons of the
 *   application fill the right end of the bar.
 *
 * Each value is a complete class literal, so Tailwind finds it in this file.
 */
export function resolveTitleBarPadding({
  isMac,
  fullscreen,
}: TitleBarPaddingInput): string {
  if (!isMac) {
    return "pr-0 pl-3";
  }
  return fullscreen ? "pr-3 pl-3" : "pr-3 pl-[84px]";
}
