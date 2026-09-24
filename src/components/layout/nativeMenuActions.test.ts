import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import type { Pts, TickCount } from "@/types/project";
import {
  NATIVE_MENU_ACTIONS,
  parseNativeMenuAction,
  planNativeMenuCommand,
  type NativeMenuContext,
} from "./nativeMenuActions";
import { shortcutFor } from "./shortcutLabels";
import {
  planShortcutCommand,
  type ShortcutProbe,
  type ShortcutSnapshot,
} from "./shortcutCommands";

const pts = (value: string): Pts => value as Pts;
const ticks = (value: string): TickCount => value as TickCount;

const PROBE: ShortcutProbe = {
  videoStartPts: pts("0"),
  videoTimeBase: { n: 1, d: 90_000 },
  videoDurationTicks: ticks("900000"),
  approximateDurationSeconds: 10.01,
  avgFrameRate: { n: 30, d: 1 },
  rFrameRate: { n: 30, d: 1 },
};

/** A calibrated, attached, ready and paused source, or no media when `probe` is null. */
function createSnapshot(
  probe: ShortcutProbe | null = PROBE,
  playback: Partial<ShortcutSnapshot["playback"]> = {},
): ShortcutSnapshot {
  return {
    probe,
    playback: {
      isAttached: probe !== null,
      isReady: probe !== null,
      isPlaying: false,
      calibrationStatus: probe === null ? "unavailable" : "ready",
      presentedFrame:
        probe === null ? null : { mediaTime: 1, inferredSourcePts: pts("90000") },
      seekTargetSeconds: null,
      runtimeBrowserDurationSeconds: probe === null ? null : 10.02,
      approximateBrowserTimeSeconds: probe === null ? null : 1,
      ...playback,
    },
    timeline: {
      sourceId: probe === null ? null : "source-1",
      segments: [],
      currentSegmentId: null,
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
    },
    viewport: { zoom: 1, maxZoom: 8 },
  };
}

const FREE: NativeMenuContext = { isOverlayOpen: false, isFileDialogOpen: false };

/** The snapshots that the equality test runs every action against. */
const SNAPSHOTS: readonly [string, ShortcutSnapshot][] = [
  ["media is open", createSnapshot()],
  ["no media is open", createSnapshot(null)],
  ["the element is not attached", createSnapshot(PROBE, { isAttached: false })],
  ["the element has not loaded metadata", createSnapshot(PROBE, { isReady: false })],
  [
    "the source is calibrating",
    createSnapshot(PROBE, { calibrationStatus: "calibrating" }),
  ],
  ["playback runs", createSnapshot(PROBE, { isPlaying: true })],
];

/** The command items that `src-tauri/src/menu.rs` declares. */
function readRustCommandItems(): {
  label: string;
  accelerator: string;
  action: string;
}[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src-tauri/src/menu.rs", import.meta.url)),
    "utf8",
  );
  const pattern =
    /CommandItem \{\s*id: "[^"]+",\s*label: "([^"]+)",\s*accelerator: "([^"]+)",\s*action: "([^"]+)",\s*\}/g;
  return Array.from(source.matchAll(pattern), (match) => ({
    label: match[1],
    accelerator: match[2],
    action: match[3],
  }));
}

describe("parseNativeMenuAction", () => {
  it("accepts the action of each command item", () => {
    expect(parseNativeMenuAction("openMedia")).toBe("openMedia");
    expect(parseNativeMenuAction("export")).toBe("export");
    expect(parseNativeMenuAction("openSettings")).toBe("openSettings");
  });

  it("refuses every other payload", () => {
    // An action of the key table that no menu item sends is not a menu action.
    expect(parseNativeMenuAction("markIn")).toBeNull();
    expect(parseNativeMenuAction("undo")).toBeNull();
    expect(parseNativeMenuAction("OpenMedia")).toBeNull();
    expect(parseNativeMenuAction("")).toBeNull();
    expect(parseNativeMenuAction(null)).toBeNull();
    expect(parseNativeMenuAction(undefined)).toBeNull();
    expect(parseNativeMenuAction(1)).toBeNull();
    expect(parseNativeMenuAction({ action: "export" })).toBeNull();
    expect(parseNativeMenuAction(["export"])).toBeNull();
  });
});

describe("planNativeMenuCommand", () => {
  it("opens media and Settings with no condition", () => {
    expect(planNativeMenuCommand("openMedia", FREE, createSnapshot(null))).toEqual({
      kind: "openMedia",
    });
    expect(planNativeMenuCommand("openSettings", FREE, createSnapshot(null))).toEqual({
      kind: "openSettings",
    });
  });

  it("exports only while media is open, as the Export button does", () => {
    expect(planNativeMenuCommand("export", FREE, createSnapshot())).toEqual({
      kind: "export",
    });
    expect(planNativeMenuCommand("export", FREE, createSnapshot(null))).toBeNull();
  });

  it("plans the command of the key for every action and every state", () => {
    for (const action of NATIVE_MENU_ACTIONS) {
      for (const [, snapshot] of SNAPSHOTS) {
        expect(planNativeMenuCommand(action, FREE, snapshot)).toEqual(
          planShortcutCommand(action, snapshot),
        );
      }
    }
  });

  it("does nothing while a dialog or a menu of the page is open", () => {
    const context: NativeMenuContext = { isOverlayOpen: true, isFileDialogOpen: false };
    for (const action of NATIVE_MENU_ACTIONS) {
      expect(planNativeMenuCommand(action, context, createSnapshot())).toBeNull();
    }
  });

  it("does nothing while the native Open Media dialog is open", () => {
    // A second Open Media would queue a second dialog behind the first one.
    const context: NativeMenuContext = { isOverlayOpen: false, isFileDialogOpen: true };
    for (const action of NATIVE_MENU_ACTIONS) {
      expect(planNativeMenuCommand(action, context, createSnapshot())).toBeNull();
    }
  });

  it("does nothing for a payload that names no command item", () => {
    expect(planNativeMenuCommand("markIn", FREE, createSnapshot())).toBeNull();
    expect(planNativeMenuCommand(null, FREE, createSnapshot())).toBeNull();
  });
});

describe("the command items of the Rust menu", () => {
  it("send exactly the actions that the frontend runs", () => {
    const items = readRustCommandItems();
    // Guards the parse itself: a reformatted item would otherwise read as no item.
    expect(items).toHaveLength(NATIVE_MENU_ACTIONS.length);
    expect(items.map((item) => item.action).sort()).toEqual(
      [...NATIVE_MENU_ACTIONS].sort(),
    );
  });

  it("carry the macOS key of their action in the key table", () => {
    for (const item of readRustCommandItems()) {
      const action = parseNativeMenuAction(item.action);
      expect(action).not.toBeNull();
      const binding = action === null ? null : shortcutFor(action, "macos");
      expect(binding).not.toBeNull();
      if (binding === null) {
        continue;
      }
      // `CmdOrCtrl` is Cmd on macOS, which is `primary` there, and no other modifier is held.
      expect(binding.modifiers).toEqual(["primary"]);
      const key =
        binding.key.kind === "letter"
          ? binding.key.letter
          : binding.key.kind === "character"
            ? binding.key.character
            : null;
      expect(item.accelerator).toBe(`CmdOrCtrl+${key}`);
    }
  });

  it("use the labels of the File menu of the title bar", () => {
    const labels = new Map(
      readRustCommandItems().map((item) => [item.action, item.label]),
    );
    expect(labels.get("openMedia")).toBe(en.titleBar.menu.openMedia);
    expect(labels.get("export")).toBe(en.titleBar.menu.export);
    // The title bar has no Settings item. The label is the standard macOS label, with the
    // three-dot ellipsis of the catalogs.
    expect(labels.get("openSettings")).toBe(`${en.settings.title}...`);
  });
});
