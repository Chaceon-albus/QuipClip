import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAC_DEFAULT_TITLE_BAR_HEIGHT,
  MAC_TITLE_BAR_RESERVE_PX,
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_WINDOW_BUTTON_PITCH,
  MAC_WINDOW_BUTTON_SIZE,
  resolveTitleBarPadding,
  TITLE_BAR_BORDER_PX,
  TITLE_BAR_HEIGHT_PX,
} from "./titleBarLayout";

interface WindowConfig {
  readonly label?: string;
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
}

function readMacWindowConfig(): WindowConfig | undefined {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src-tauri/tauri.macos.conf.json", import.meta.url)),
    "utf8",
  );
  const config = JSON.parse(source) as { app?: { windows?: WindowConfig[] } };
  return config.app?.windows?.find((window) => window.label === "main");
}

/**
 * The centre of a window button from the top of the window, for a `trafficLightPosition` of
 * `y`. tao and wry make the title bar container `buttonSize + y` high, and the button keeps
 * its default distance from the bottom of the container.
 */
function buttonCentreFromTop(y: number): number {
  const distanceFromBottom =
    (MAC_DEFAULT_TITLE_BAR_HEIGHT - MAC_WINDOW_BUTTON_SIZE) / 2;
  const containerHeight = MAC_WINDOW_BUTTON_SIZE + y;
  return containerHeight - distanceFromBottom - MAC_WINDOW_BUTTON_SIZE / 2;
}

/**
 * Reads `TITLE_BAR_CONTENT_HEIGHT` out of `src-tauri/src/traffic_lights.rs`. Rust computes the
 * position of the window buttons from it when the application starts, so it must be the height
 * of the title bar less its bottom border.
 */
function readRustTitleBarContentHeight(): number | null {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src-tauri/src/traffic_lights.rs", import.meta.url)),
    "utf8",
  );
  const match = /const TITLE_BAR_CONTENT_HEIGHT: f64 = ([0-9]+(?:\.[0-9]+)?);/.exec(
    source,
  );
  return match === null ? null : Number(match[1]);
}

describe("the macOS window buttons", () => {
  it("are centred by Rust in the title bar that this component draws", () => {
    // A change to the height or to the border of the title bar on one side only would move
    // the buttons away from the centre of the bar, and no other test would fail.
    const rustHeight = readRustTitleBarContentHeight();
    expect(rustHeight).not.toBeNull();
    expect(rustHeight).toBe(TITLE_BAR_HEIGHT_PX - TITLE_BAR_BORDER_PX);
  });

  it("have the position that the macOS window configuration sets", () => {
    expect(readMacWindowConfig()?.trafficLightPosition).toEqual(
      MAC_TRAFFIC_LIGHT_POSITION,
    );
  });

  it("centre on the whole point above the centre of the title bar controls", () => {
    // The controls centre in the content box, which the bottom border does not include.
    const controlsCentre = (TITLE_BAR_HEIGHT_PX - TITLE_BAR_BORDER_PX) / 2;
    expect(controlsCentre).toBe(19.5);
    expect(buttonCentreFromTop(MAC_TRAFFIC_LIGHT_POSITION.y)).toBe(
      Math.floor(controlsCentre),
    );
  });

  it("start on whole points, so they stay sharp at a scale of 1", () => {
    const top =
      buttonCentreFromTop(MAC_TRAFFIC_LIGHT_POSITION.y) - MAC_WINDOW_BUTTON_SIZE / 2;
    expect(Number.isInteger(top)).toBe(true);
    expect(Number.isInteger(MAC_TRAFFIC_LIGHT_POSITION.x)).toBe(true);
  });

  it("have a left margin equal to their top margin", () => {
    const top =
      buttonCentreFromTop(MAC_TRAFFIC_LIGHT_POSITION.y) - MAC_WINDOW_BUTTON_SIZE / 2;
    expect(MAC_TRAFFIC_LIGHT_POSITION.x).toBe(top);
  });
});

describe("the title bar reserve", () => {
  it("is the end of the zoom button plus a gap equal to the left margin", () => {
    const zoomEnd =
      MAC_TRAFFIC_LIGHT_POSITION.x +
      2 * MAC_WINDOW_BUTTON_PITCH +
      MAC_WINDOW_BUTTON_SIZE;
    expect(zoomEnd).toBe(72);
    expect(MAC_TITLE_BAR_RESERVE_PX).toBe(zoomEnd + MAC_TRAFFIC_LIGHT_POSITION.x);
  });

  it("keeps the space of the window buttons free on macOS", () => {
    expect(resolveTitleBarPadding({ isMac: true, fullscreen: false })).toBe(
      `pr-3 pl-[${MAC_TITLE_BAR_RESERVE_PX}px]`,
    );
  });

  it("gives the space back in full screen, where macOS hides the window buttons", () => {
    expect(resolveTitleBarPadding({ isMac: true, fullscreen: true })).toBe("pr-3 pl-3");
  });

  it("keeps the padding of the other platforms, whatever the full-screen state", () => {
    expect(resolveTitleBarPadding({ isMac: false, fullscreen: false })).toBe(
      "pr-0 pl-3",
    );
    expect(resolveTitleBarPadding({ isMac: false, fullscreen: true })).toBe(
      "pr-0 pl-3",
    );
  });
});
