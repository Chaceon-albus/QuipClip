import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import { en } from "@/i18n/locales/en";
import type { Pts, TickCount } from "@/types/project";
import {
  NATIVE_MENU_ACTIONS,
  parseNativeMenuAction,
  planNativeMenuCommand,
  type NativeMenuContext,
} from "./nativeMenuActions";
import { UNBOUND_SHORTCUT_ACTIONS, type ShortcutAction } from "./shortcutBindings";
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
      // No clip list: the snapshot reads the derived segments of one clip (ADR 066).
      clips: [],
      sequenceSegments: [],
      sequenceSources: {},
      sourceId: probe === null ? null : "source-1",
      segments: [],
      currentSegmentId: null,
      selectedSegmentIds: [],
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
    },
    viewport: { zoom: 1, maxZoom: 8 },
  };
}

/** The actions with no key (ADR 067). */
const UNBOUND = new Set<ShortcutAction>(UNBOUND_SHORTCUT_ACTIONS);

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

/**
 * The command items that `src-tauri/src/menu.rs` declares. `action` is the action of the key
 * table that the item stands for. `sent` is true for an item that sends that action to the
 * frontend, and false for the Settings item, which Rust answers itself. `accelerator` is null
 * for an item with no key (ADR 067).
 */
function readRustCommandItems(): {
  label: string;
  accelerator: string | null;
  action: string;
  sent: boolean;
}[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src-tauri/src/menu.rs", import.meta.url)),
    "utf8",
  );
  const pattern =
    /CommandItem \{\s*id: "[^"]+",\s*label: "([^"]+)",\s*accelerator: (?:Some\("([^"]+)"\)|None),\s*action: MenuAction::(?:Frontend\("([^"]+)"\)|(OpenSettingsWindow)),\s*\}/g;
  return Array.from(source.matchAll(pattern), (match) => ({
    label: match[1],
    accelerator: match[2] ?? null,
    action: match[3] ?? "openSettings",
    sent: match[4] === undefined,
  }));
}

describe("parseNativeMenuAction", () => {
  it("accepts the action of each command item that sends one", () => {
    expect(parseNativeMenuAction("openMedia")).toBe("openMedia");
    expect(parseNativeMenuAction("saveProject")).toBe("saveProject");
    expect(parseNativeMenuAction("saveProjectAs")).toBe("saveProjectAs");
    expect(parseNativeMenuAction("export")).toBe("export");
    expect(parseNativeMenuAction("exportFrame")).toBe("exportFrame");
  });

  it("refuses every other payload", () => {
    // An action of the key table that no menu item sends is not a menu action. The Settings
    // item opens its window in Rust and sends nothing.
    expect(parseNativeMenuAction("openSettings")).toBeNull();
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
  it("opens media with no condition", () => {
    expect(planNativeMenuCommand("openMedia", FREE, createSnapshot(null))).toEqual({
      kind: "openMedia",
    });
  });

  it("exports only while media is open, as the Export button does", () => {
    expect(planNativeMenuCommand("export", FREE, createSnapshot())).toEqual({
      kind: "export",
    });
    expect(planNativeMenuCommand("export", FREE, createSnapshot(null))).toBeNull();
  });

  it("saves only while the sequence has a clip, as the Save key does (ADR 072)", () => {
    const empty = createSnapshot();
    const withClip: ShortcutSnapshot = {
      ...empty,
      timeline: { ...empty.timeline, clips: [{ id: "c1", sourceId: "source-1" }] },
    };
    expect(planNativeMenuCommand("saveProject", FREE, withClip)).toEqual({
      kind: "saveProject",
      mode: "save",
    });
    expect(planNativeMenuCommand("saveProjectAs", FREE, withClip)).toEqual({
      kind: "saveProject",
      mode: "saveAs",
    });
    expect(planNativeMenuCommand("saveProject", FREE, empty)).toBeNull();
    expect(planNativeMenuCommand("saveProjectAs", FREE, empty)).toBeNull();
    // The save dialog of a project is modal to the window, as the Open Media dialog is.
    expect(
      planNativeMenuCommand(
        "saveProjectAs",
        { isOverlayOpen: false, isFileDialogOpen: true },
        withClip,
      ),
    ).toBeNull();
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

  it("does nothing while the native Open Media dialog or the project save dialog is open", () => {
    // A second Open Media, or a second Save As, would queue a second dialog behind the first.
    const context: NativeMenuContext = { isOverlayOpen: false, isFileDialogOpen: true };
    for (const action of NATIVE_MENU_ACTIONS) {
      expect(planNativeMenuCommand(action, context, createSnapshot())).toBeNull();
    }
  });

  it("exports no frame while a press on a segment edge is armed (ADR 069)", () => {
    const media = { path: "/media/clip.mp4", fileName: "clip.mp4", size: 1, mtime: 2 };
    const snapshot: ShortcutSnapshot = {
      ...createSnapshot(),
      frameExport: {
        playback: {
          isAttached: true,
          isReady: true,
          calibrationStatus: "ready",
          presentedFrame: { mediaTime: 1, inferredSourcePts: pts("90000") },
          decodeStall: null,
          isRecalibrating: false,
          attachedSourceRevisionKey: getSourceRevisionKey(media),
        },
        attachedMedia: media,
        sessionSourcePaths: [media.path],
        displayedTime: "00:00:01.000",
        isBusy: false,
      },
    };
    expect(planNativeMenuCommand("exportFrame", FREE, snapshot)).toMatchObject({
      kind: "exportFrame",
    });
    expect(
      planNativeMenuCommand("exportFrame", FREE, { ...snapshot, isTrimArmed: true }),
    ).toBeNull();
    expect(
      planNativeMenuCommand("exportFrame", FREE, { ...snapshot, isTrimDragging: true }),
    ).toBeNull();
  });

  it("does nothing for a payload that names no command item", () => {
    expect(planNativeMenuCommand("markIn", FREE, createSnapshot())).toBeNull();
    expect(planNativeMenuCommand(null, FREE, createSnapshot())).toBeNull();
  });
});

describe("the command items of the Rust menu", () => {
  it("send exactly the actions that the frontend runs", () => {
    const items = readRustCommandItems();
    // Guards the parse itself: a reformatted item would otherwise read as no item. The
    // Settings item is the one item that sends nothing.
    expect(items).toHaveLength(NATIVE_MENU_ACTIONS.length + 1);
    expect(items.filter((item) => !item.sent).map((item) => item.action)).toEqual([
      "openSettings",
    ]);
    expect(
      items
        .filter((item) => item.sent)
        .map((item) => item.action)
        .sort(),
    ).toEqual([...NATIVE_MENU_ACTIONS].sort());
  });

  it("carry the macOS key of their action in the key table", () => {
    for (const item of readRustCommandItems()) {
      const action = item.sent ? parseNativeMenuAction(item.action) : "openSettings";
      expect(action).not.toBeNull();
      const binding = action === null ? null : shortcutFor(action, "macos");
      // An action with no key has an item with no accelerator (ADR 067, Save As of ADR 072).
      if (action !== null && UNBOUND.has(action)) {
        expect(binding).toBeNull();
        expect(item.accelerator).toBeNull();
        continue;
      }
      expect(binding).not.toBeNull();
      if (binding === null) {
        continue;
      }
      // `CmdOrCtrl` is Cmd on macOS, which is `primary` there. Shift is the one other modifier
      // that a command item holds (Export Frame, ADR 069).
      expect(binding.modifiers[0]).toBe("primary");
      expect(binding.modifiers.slice(1).every((modifier) => modifier === "shift")).toBe(
        true,
      );
      const key =
        binding.key.kind === "letter"
          ? binding.key.letter
          : binding.key.kind === "character"
            ? binding.key.character
            : null;
      const shift = binding.modifiers.includes("shift") ? "Shift+" : "";
      expect(item.accelerator).toBe(`CmdOrCtrl+${shift}${key}`);
    }
  });

  it("use the labels of the File menu of the title bar", () => {
    const labels = new Map(
      readRustCommandItems().map((item) => [item.action, item.label]),
    );
    expect(labels.get("openMedia")).toBe(en.titleBar.menu.openMedia);
    expect(labels.get("saveProject")).toBe(en.titleBar.menu.save);
    expect(labels.get("saveProjectAs")).toBe(en.titleBar.menu.saveAs);
    expect(labels.get("export")).toBe(en.titleBar.menu.export);
    // The title bar has no Export Frame item. The label is the name of the action in the
    // transport bar, with the ellipsis of an item that opens a dialog (ADR 069).
    expect(labels.get("exportFrame")).toBe(`${en.transport.action.exportFrame}…`);
    // The title bar has no Settings item. The label is the standard macOS label, with the
    // ellipsis character of the catalogs.
    expect(labels.get("openSettings")).toBe(`${en.settings.title}…`);
  });
});
