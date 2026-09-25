import { describe, expect, it, vi } from "vitest";
import {
  describeContextMenuTarget,
  shouldSuppressContextMenu,
  type ContextMenuElement,
} from "@/components/layout/contextMenuPolicy";
import {
  SHORTCUT_ACTIONS,
  type ShortcutPlatform,
} from "@/components/layout/shortcutBindings";
import {
  planShortcutCommand,
  type ShortcutProbe,
  type ShortcutSnapshot,
} from "@/components/layout/shortcutCommands";
import {
  resolveShortcutKeyNames,
  type ShortcutKeyNames,
} from "@/components/layout/shortcutLabels";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import type { Pts, Segment, TickCount } from "@/types/project";
import {
  SEGMENT_MENU_ACTIONS,
  SEGMENT_MENU_LABEL_KEYS,
  SEGMENT_MENU_LAYOUT,
  SEGMENT_MENU_PAUSE_LABEL_KEY,
  buildSegmentMenuEntries,
  canOpenSegmentMenu,
  createSegmentMenuSourceTracker,
  isContextMenuPress,
  listenForSegmentMenuSourceReset,
  planSegmentMenuCommand,
  resolveSegmentMenuPosition,
  takeSegmentContextMenuEvent,
  type SegmentMenuEntry,
  type SegmentMenuItem,
  type SegmentMenuOpenInput,
} from "./segmentMenuModel";

const pts = (value: string): Pts => value as Pts;
const ticks = (value: string): TickCount => value as TickCount;

const SOURCE_ID = "source-1";

/** Walks a dotted key through a catalog, the way i18next resolves it. */
function lookup(catalog: unknown, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
  if (typeof value !== "string") {
    throw new Error(`missing catalog key ${key}`);
  }
  return value;
}

const enTranslate = (key: string) => lookup(en, key);
const zhTranslate = (key: string) => lookup(zhCN, key);
const EN_NAMES: ShortcutKeyNames = resolveShortcutKeyNames(enTranslate);
const ZH_NAMES: ShortcutKeyNames = resolveShortcutKeyNames(zhTranslate);

function segment(id: string, inPts: string, outPts: string): Segment {
  return { id, sourceId: SOURCE_ID, inPts: pts(inPts), outPts: pts(outPts) };
}

const SEGMENT_A = segment("a", "90000", "180000");
const SEGMENT_B = segment("b", "270000", "360000");

function probe(): ShortcutProbe {
  return {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 90_000 },
    videoDurationTicks: ticks("900000"),
    approximateDurationSeconds: 10.01,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
  };
}

interface SnapshotOverrides {
  readonly probe?: ShortcutProbe | null;
  readonly playback?: Partial<ShortcutSnapshot["playback"]>;
  readonly timeline?: Partial<ShortcutSnapshot["timeline"]>;
  readonly isTrimDragging?: boolean;
}

/**
 * A calibrated, attached, ready and paused source with the frame at 5 s (PTS 450000) on screen,
 * two segments, and segment "b" current, as the menu leaves it when it opens on "b".
 */
function snapshot(overrides: SnapshotOverrides = {}): ShortcutSnapshot {
  return {
    probe: overrides.probe === undefined ? probe() : overrides.probe,
    playback: {
      isAttached: true,
      isReady: true,
      isPlaying: false,
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 5, inferredSourcePts: pts("450000") },
      seekTargetSeconds: null,
      runtimeBrowserDurationSeconds: 10.02,
      approximateBrowserTimeSeconds: 5,
      ...overrides.playback,
    },
    timeline: {
      sourceId: SOURCE_ID,
      segments: [SEGMENT_A, SEGMENT_B],
      currentSegmentId: "b",
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
      ...overrides.timeline,
    },
    viewport: { zoom: 1, maxZoom: 8 },
    isTrimDragging: overrides.isTrimDragging ?? false,
  };
}

function items(entries: readonly SegmentMenuEntry[]): SegmentMenuItem[] {
  return entries.filter((entry): entry is SegmentMenuItem => entry.kind === "item");
}

function build(
  platform: ShortcutPlatform,
  state: ShortcutSnapshot = snapshot(),
  options: { readonly zh?: boolean; readonly segmentId?: string } = {},
) {
  return buildSegmentMenuEntries({
    segmentId: options.segmentId ?? "b",
    snapshot: state,
    platform,
    keyNames: options.zh === true ? ZH_NAMES : EN_NAMES,
    translate: options.zh === true ? zhTranslate : enTranslate,
  });
}

/** The enabled state of each item, by action. */
function enabledOf(entries: readonly SegmentMenuEntry[]): Record<string, boolean> {
  return Object.fromEntries(items(entries).map((item) => [item.action, item.enabled]));
}

describe("the layout of the segment menu", () => {
  it("holds Go to In, Go to Out, Play Segment, a separator and Delete Segment, in that order", () => {
    expect(SEGMENT_MENU_LAYOUT).toStrictEqual([
      { kind: "item", action: "goToSegmentIn" },
      { kind: "item", action: "goToSegmentOut" },
      { kind: "item", action: "playSegment" },
      { kind: "separator" },
      { kind: "item", action: "deleteSegment" },
    ]);
  });

  it("names each action of the menu once, and each is an action of the key table", () => {
    const actions = SEGMENT_MENU_LAYOUT.flatMap((slot) =>
      slot.kind === "item" ? [slot.action] : [],
    );
    expect(actions).toStrictEqual([...SEGMENT_MENU_ACTIONS]);
    for (const action of actions) {
      expect(SHORTCUT_ACTIONS).toContain(action);
    }
  });

  it("leaves out the actions that act at the playhead or that end the selection", () => {
    const actions: readonly string[] = SEGMENT_MENU_ACTIONS;
    for (const action of ["markIn", "markOut", "finishSegment"]) {
      expect(actions).not.toContain(action);
    }
  });

  it("has a label in both catalogs, with the names of the interface in English", () => {
    for (const key of Object.values(SEGMENT_MENU_LABEL_KEYS)) {
      expect(lookup(zhCN, key)).not.toBe("");
    }
    expect(lookup(en, SEGMENT_MENU_LABEL_KEYS.goToSegmentIn)).toBe("Go to In");
    expect(lookup(en, SEGMENT_MENU_LABEL_KEYS.goToSegmentOut)).toBe("Go to Out");
    expect(lookup(en, SEGMENT_MENU_LABEL_KEYS.playSegment)).toBe("Play Segment");
    // The pause label is the one of the Play button while it plays.
    expect(lookup(en, SEGMENT_MENU_PAUSE_LABEL_KEY)).toBe("Pause");
    expect(lookup(zhCN, SEGMENT_MENU_PAUSE_LABEL_KEY)).not.toBe("");
    expect(lookup(en, SEGMENT_MENU_LABEL_KEYS.deleteSegment)).toBe("Delete Segment");
  });
});

describe("buildSegmentMenuEntries", () => {
  it("gives the entries in the order of the layout", () => {
    expect(
      build("macos").map((entry) => (entry.kind === "item" ? entry.action : "|")),
    ).toEqual(["goToSegmentIn", "goToSegmentOut", "playSegment", "|", "deleteSegment"]);
  });

  it("carries the accelerator of the binding table on macOS, which AppKit draws as ⇧I and ⌫", () => {
    expect(
      items(build("macos")).map(({ label, text, shortcut, accelerator }) => ({
        label,
        text,
        shortcut,
        accelerator,
      })),
    ).toStrictEqual([
      {
        label: "Go to In",
        text: "Go to In",
        shortcut: "⇧I",
        accelerator: "Shift+KeyI",
      },
      {
        label: "Go to Out",
        text: "Go to Out",
        shortcut: "⇧O",
        accelerator: "Shift+KeyO",
      },
      {
        label: "Play Segment",
        text: "Play Segment",
        shortcut: "/",
        accelerator: "Slash",
      },
      // The Mac key labelled delete sends Backspace, so the menu shows ⌫ (`shortcutFor`).
      {
        label: "Delete Segment",
        text: "Delete Segment",
        shortcut: "⌫",
        accelerator: "Backspace",
      },
    ]);
  });

  it("puts the key of formatShortcut after a tab on Windows, and no accelerator", () => {
    expect(
      items(build("windows")).map(({ text, shortcut, accelerator }) => ({
        text,
        shortcut,
        accelerator,
      })),
    ).toStrictEqual([
      { text: "Go to In\tShift+I", shortcut: "Shift+I", accelerator: null },
      { text: "Go to Out\tShift+O", shortcut: "Shift+O", accelerator: null },
      { text: "Play Segment\t/", shortcut: "/", accelerator: null },
      { text: "Delete Segment\tDelete", shortcut: "Delete", accelerator: null },
    ]);
  });

  it("reads the labels and the key names from the catalog of the interface", () => {
    expect(
      items(build("windows", snapshot(), { zh: true })).map((item) => item.text),
    ).toEqual([
      "跳转到入点\tShift+I",
      "跳转到出点\tShift+O",
      "播放片段\t/",
      "删除片段\tDelete",
    ]);
    expect(
      items(build("macos", snapshot(), { zh: true })).map((item) => item.text),
    ).toEqual(["跳转到入点", "跳转到出点", "播放片段", "删除片段"]);
  });

  it("doubles an ampersand, so the native menu does not read it as a mnemonic", () => {
    for (const platform of ["macos", "windows"] as const) {
      const [first] = items(
        buildSegmentMenuEntries({
          segmentId: "b",
          snapshot: snapshot(),
          platform,
          keyNames: EN_NAMES,
          translate: () => "In & Out",
        }),
      );
      expect(first?.label).toBe("In & Out");
      expect(first?.text.startsWith("In && Out")).toBe(true);
    }
  });

  it("doubles an ampersand in the key after the tab on Windows too", () => {
    const [first] = items(
      buildSegmentMenuEntries({
        segmentId: "b",
        snapshot: snapshot(),
        platform: "windows",
        keyNames: { ...EN_NAMES, shift: "Sh&ift" },
        translate: enTranslate,
      }),
    );
    expect(first?.shortcut).toBe("Sh&ift+I");
    expect(first?.text).toBe("Go to In\tSh&&ift+I");
  });

  it("enables every item for a current segment away from the playhead", () => {
    expect(enabledOf(build("macos"))).toStrictEqual({
      goToSegmentIn: true,
      goToSegmentOut: true,
      playSegment: true,
      deleteSegment: true,
    });
  });

  // The one predicate of ADR 026: each item is enabled exactly when its key would act.
  it.each<[string, ShortcutSnapshot]>([
    ["a calibrated source", snapshot()],
    ["no media", snapshot({ probe: null })],
    ["no attached element", snapshot({ playback: { isAttached: false } })],
    ["no metadata yet", snapshot({ playback: { isReady: false } })],
    [
      "an open calibration",
      snapshot({ playback: { calibrationStatus: "calibrating" } }),
    ],
    ["no calibration", snapshot({ playback: { calibrationStatus: "unavailable" } })],
    [
      "the In frame on screen",
      snapshot({
        playback: {
          presentedFrame: { mediaTime: 3, inferredSourcePts: pts("270000") },
        },
      }),
    ],
    [
      "the Out frame on screen",
      snapshot({
        playback: {
          presentedFrame: { mediaTime: 4, inferredSourcePts: pts("360000") },
        },
      }),
    ],
    [
      "a pending seek",
      snapshot({ playback: { presentedFrame: null, seekTargetSeconds: 3 } }),
    ],
    ["a drag trim", snapshot({ isTrimDragging: true })],
    ["no current segment", snapshot({ timeline: { currentSegmentId: null } })],
    ["another current segment", snapshot({ timeline: { currentSegmentId: "a" } })],
  ])("enables an item exactly when its key acts, with %s", (_name, state) => {
    const isCurrent = state.timeline.currentSegmentId === "b";
    for (const item of items(build("windows", state))) {
      expect(item.enabled, item.action).toBe(
        isCurrent && planShortcutCommand(item.action, state) !== null,
      );
    }
  });

  it("disables and keeps the items whose condition is false", () => {
    // The In frame of "b" is on screen, so Go to In would seek onto the frame on screen.
    const atIn = build(
      "macos",
      snapshot({
        playback: {
          presentedFrame: { mediaTime: 3, inferredSourcePts: pts("270000") },
        },
      }),
    );
    expect(atIn).toHaveLength(SEGMENT_MENU_LAYOUT.length);
    expect(enabledOf(atIn)).toStrictEqual({
      goToSegmentIn: false,
      goToSegmentOut: true,
      playSegment: true,
      deleteSegment: true,
    });

    // A source that cannot calibrate has no exact boundary seek, and Delete still acts.
    expect(
      enabledOf(
        build("macos", snapshot({ playback: { calibrationStatus: "unavailable" } })),
      ),
    ).toStrictEqual({
      goToSegmentIn: false,
      goToSegmentOut: false,
      // Play Segment needs a ready calibration (ADR 026).
      playSegment: false,
      deleteSegment: true,
    });

    // A drag trim locks the edit keys (ADR 030).
    expect(enabledOf(build("macos", snapshot({ isTrimDragging: true })))).toMatchObject(
      {
        deleteSegment: false,
      },
    );

    // With no active source, nothing can act.
    expect(enabledOf(build("macos", snapshot({ probe: null })))).toStrictEqual({
      goToSegmentIn: false,
      goToSegmentOut: false,
      playSegment: false,
      deleteSegment: false,
    });
  });

  it("names the command that each item plans", () => {
    expect(items(build("macos")).map((item) => item.commandKind)).toStrictEqual([
      "seekToPts",
      "seekToPts",
      "playSegment",
      "deleteSegment",
    ]);
    expect(
      items(build("macos", snapshot({ probe: null }))).map((item) => item.commandKind),
    ).toStrictEqual([null, null, null, null]);
  });

  describe("Play Segment while a segment plays", () => {
    const playing = (overrides: SnapshotOverrides = {}) =>
      snapshot({
        ...overrides,
        playback: {
          isPlaying: true,
          playbackStop: {
            phase: "playing",
            inPts: SEGMENT_B.inPts,
            outPts: SEGMENT_B.outPts,
          },
          ...overrides.playback,
        },
      });
    const playItem = (entries: readonly SegmentMenuEntry[]) =>
      items(entries).find((item) => item.action === "playSegment");

    it("shows Pause with the key of Play Segment, because the key then pauses", () => {
      expect(planShortcutCommand("playSegment", playing())).toStrictEqual({
        kind: "pause",
      });
      expect(playItem(build("macos", playing()))).toMatchObject({
        label: "Pause",
        text: "Pause",
        accelerator: "Slash",
        enabled: true,
        commandKind: "pause",
      });
      expect(playItem(build("windows", playing()))?.text).toBe("Pause\t/");
      expect(playItem(build("windows", playing(), { zh: true }))?.text).toBe(
        `${lookup(zhCN, SEGMENT_MENU_PAUSE_LABEL_KEY)}\t/`,
      );
    });

    it("shows Play Segment again once the segment has stopped", () => {
      const stopped = snapshot({
        playback: {
          playbackStop: {
            phase: "stopped",
            inPts: SEGMENT_B.inPts,
            outPts: SEGMENT_B.outPts,
            restPts: pts("357000"),
            windowEndSeconds: 4.1,
          },
        },
      });
      expect(playItem(build("macos", stopped))).toMatchObject({
        label: "Play Segment",
        commandKind: "playSegment",
      });
    });

    it("keeps the other items and their conditions", () => {
      expect(
        items(build("macos", playing())).map((item) => [item.label, item.enabled]),
      ).toStrictEqual([
        ["Go to In", true],
        ["Go to Out", true],
        ["Pause", true],
        ["Delete Segment", true],
      ]);
    });
  });
});

describe("planSegmentMenuCommand", () => {
  it("plans the command of the key while the segment of the menu is current", () => {
    const state = snapshot();
    expect(planSegmentMenuCommand("goToSegmentIn", "b", state)).toStrictEqual({
      kind: "seekToPts",
      pts: SEGMENT_B.inPts,
    });
    expect(planSegmentMenuCommand("goToSegmentOut", "b", state)).toStrictEqual({
      kind: "seekToPts",
      pts: SEGMENT_B.outPts,
    });
    expect(planSegmentMenuCommand("deleteSegment", "b", state)).toStrictEqual({
      kind: "deleteSegment",
    });
    for (const action of SEGMENT_MENU_ACTIONS) {
      expect(planSegmentMenuCommand(action, "b", state)).toStrictEqual(
        planShortcutCommand(action, state),
      );
    }
  });

  it("plans only the kind of command that the item showed", () => {
    const state = snapshot();
    expect(
      planSegmentMenuCommand("playSegment", "b", state, "playSegment"),
    ).toStrictEqual({
      kind: "playSegment",
      inPts: SEGMENT_B.inPts,
      outPts: SEGMENT_B.outPts,
    });
    // The item said Pause, but the segment reached its stop while the menu was open, so the
    // key would now start a new playback.
    expect(planSegmentMenuCommand("playSegment", "b", state, "pause")).toBeNull();
    // A disabled item runs nothing, whatever the state became.
    expect(planSegmentMenuCommand("deleteSegment", "b", state, null)).toBeNull();
    expect(
      planSegmentMenuCommand("deleteSegment", "b", state, "deleteSegment"),
    ).toStrictEqual({ kind: "deleteSegment" });
  });

  it("plans nothing once another segment, or no segment, is current", () => {
    for (const currentSegmentId of ["a", null]) {
      const state = snapshot({ timeline: { currentSegmentId } });
      for (const action of SEGMENT_MENU_ACTIONS) {
        expect(planSegmentMenuCommand(action, "b", state)).toBeNull();
      }
    }
  });
});

describe("canOpenSegmentMenu", () => {
  const open: SegmentMenuOpenInput = {
    isSegmentOfActiveSource: true,
    isPointerGestureActive: false,
    isTrimDragging: false,
    isOverlayOpen: false,
    isMenuOpen: false,
  };

  it("opens for a segment of the active source with nothing else open or held", () => {
    expect(canOpenSegmentMenu(open)).toBe(true);
  });

  it.each<keyof SegmentMenuOpenInput>([
    "isPointerGestureActive",
    "isTrimDragging",
    "isOverlayOpen",
    "isMenuOpen",
  ])("does not open while %s", (key) => {
    expect(canOpenSegmentMenu({ ...open, [key]: true })).toBe(false);
  });

  it("does not open for a segment of another source", () => {
    expect(canOpenSegmentMenu({ ...open, isSegmentOfActiveSource: false })).toBe(false);
  });
});

describe("isContextMenuPress", () => {
  it("is true for the secondary button on both platforms", () => {
    for (const platform of ["macos", "windows"] as const) {
      expect(isContextMenuPress({ button: 2, ctrlKey: false }, platform)).toBe(true);
      expect(isContextMenuPress({ button: 2, ctrlKey: true }, platform)).toBe(true);
    }
  });

  it("is true for a Control press with the primary button on macOS only", () => {
    expect(isContextMenuPress({ button: 0, ctrlKey: true }, "macos")).toBe(true);
    // On Windows Ctrl with a click is a plain click, so it still selects, seeks and trims.
    expect(isContextMenuPress({ button: 0, ctrlKey: true }, "windows")).toBe(false);
  });

  it("is false for a plain primary press and for the middle button", () => {
    for (const platform of ["macos", "windows"] as const) {
      expect(isContextMenuPress({ button: 0, ctrlKey: false }, platform)).toBe(false);
      expect(isContextMenuPress({ button: 1, ctrlKey: false }, platform)).toBe(false);
    }
  });
});

describe("createSegmentMenuSourceTracker", () => {
  it("reads a request after a context-menu press as a pointer request, once", () => {
    const tracker = createSegmentMenuSourceTracker();
    tracker.press(true);
    expect(tracker.take()).toBe("pointer");
    // The next request, with no press, came from the keyboard.
    expect(tracker.take()).toBe("keyboard");
  });

  it("reads a request with no press before it as a keyboard request", () => {
    expect(createSegmentMenuSourceTracker().take()).toBe("keyboard");
  });

  it("forgets a context-menu press at a reset or at a plain press", () => {
    const tracker = createSegmentMenuSourceTracker();
    tracker.press(true);
    // Shift+F10 or the Menu key goes down on the focused segment before its request.
    tracker.reset();
    expect(tracker.take()).toBe("keyboard");

    tracker.press(true);
    tracker.press(false);
    expect(tracker.take()).toBe("keyboard");
  });
});

describe("listenForSegmentMenuSourceReset", () => {
  /** A window stand-in that records the phase of each listener. */
  function createWindow() {
    const target = new EventTarget();
    const phases = new Map<string, boolean>();
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const fake = {
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
      ) => {
        phases.set(type, typeof options === "object" && options.capture === true);
        add(type, listener, options);
      },
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
      ) => {
        phases.delete(type);
        remove(type, listener, options);
      },
      dispatch: (type: string) => target.dispatchEvent(new Event(type)),
    };
    return { fake, phases };
  }

  it.each(["pointerdown", "contextmenu", "blur"])(
    "forgets a context-menu press at a %s event of the window",
    (type) => {
      const { fake } = createWindow();
      const tracker = createSegmentMenuSourceTracker();
      const stop = listenForSegmentMenuSourceReset(fake, tracker);
      // A right-press on a segment, released off every segment. On Windows the request goes to
      // the element under the release, so no segment takes the press.
      tracker.press(true);
      fake.dispatch(type);
      // A later request from assistive technology, with no key press, is not a pointer one.
      expect(tracker.take()).toBe("keyboard");
      stop();
    },
  );

  it("listens for a press in the capture phase, before the handler of a segment", () => {
    const { fake, phases } = createWindow();
    const stop = listenForSegmentMenuSourceReset(
      fake,
      createSegmentMenuSourceTracker(),
    );
    expect(Object.fromEntries(phases)).toStrictEqual({
      pointerdown: true,
      contextmenu: false,
      blur: false,
    });
    stop();
    expect(phases.size).toBe(0);
  });

  it("keeps a press after its listeners are removed", () => {
    const { fake } = createWindow();
    const tracker = createSegmentMenuSourceTracker();
    listenForSegmentMenuSourceReset(fake, tracker)();
    tracker.press(true);
    fake.dispatch("pointerdown");
    expect(tracker.take()).toBe("pointer");
  });
});

describe("resolveSegmentMenuPosition", () => {
  const lane = { left: 96, right: 1000 };

  it("opens a pointer request at the pointer", () => {
    expect(
      resolveSegmentMenuPosition(
        "pointer",
        { left: 200, right: 300, bottom: 50 },
        lane,
      ),
    ).toBeNull();
  });

  it("opens a keyboard request at the bottom left of the segment", () => {
    expect(
      resolveSegmentMenuPosition(
        "keyboard",
        { left: 200, right: 300, bottom: 50 },
        lane,
      ),
    ).toStrictEqual({ x: 200, y: 50 });
  });

  it("moves the position into the visible lane, out from under the gutter", () => {
    // The segment starts under the sticky gutter.
    expect(
      resolveSegmentMenuPosition(
        "keyboard",
        { left: 40, right: 300, bottom: 50 },
        lane,
      ),
    ).toStrictEqual({ x: 96, y: 50 });
    // The segment starts past the right edge of the view.
    expect(
      resolveSegmentMenuPosition(
        "keyboard",
        { left: 1200, right: 1300, bottom: 50 },
        lane,
      ),
    ).toStrictEqual({ x: 1000, y: 50 });
  });

  it("falls back to the pointer when a value is not finite", () => {
    expect(
      resolveSegmentMenuPosition(
        "keyboard",
        { left: Number.NaN, right: 0, bottom: 50 },
        lane,
      ),
    ).toBeNull();
    expect(
      resolveSegmentMenuPosition(
        "keyboard",
        { left: 200, right: 300, bottom: 50 },
        { left: 96, right: Number.POSITIVE_INFINITY },
      ),
    ).toBeNull();
  });
});

describe("takeSegmentContextMenuEvent and the context menu policy", () => {
  /** A `contextmenu` event on a segment button, as the policy and the segment read it. */
  function segmentEvent() {
    const button: ContextMenuElement & {
      getBoundingClientRect(): { left: number; right: number; bottom: number };
    } = {
      tagName: "BUTTON",
      matches: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 200, right: 300, bottom: 50 }),
    };
    const event = {
      defaultPrevented: false,
      target: button,
      currentTarget: button,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true;
      }),
    };
    return event;
  }

  it("cancels the event for a pointer request and for a keyboard request", () => {
    for (const source of ["pointer", "keyboard"] as const) {
      const event = segmentEvent();
      takeSegmentContextMenuEvent(event, source, { left: 96, right: 1000 });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("returns the position of the menu, with the segment when no lane is known", () => {
    expect(
      takeSegmentContextMenuEvent(segmentEvent(), "keyboard", {
        left: 96,
        right: 1000,
      }),
    ).toStrictEqual({ x: 200, y: 50 });
    expect(takeSegmentContextMenuEvent(segmentEvent(), "keyboard", null)).toStrictEqual(
      {
        x: 200,
        y: 50,
      },
    );
    expect(takeSegmentContextMenuEvent(segmentEvent(), "pointer", null)).toBeNull();
  });

  it("leaves no web view menu on a segment in either build", () => {
    for (const isDevBuild of [false, true]) {
      const event = segmentEvent();
      // The React handler of the segment runs first.
      takeSegmentContextMenuEvent(event, "pointer", null);
      // The policy runs after it, on the window in the bubble phase (`useContextMenuPolicy`).
      if (
        shouldSuppressContextMenu(describeContextMenuTarget(event.target), isDevBuild)
      ) {
        event.preventDefault();
      }
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("keeps the rule of the policy for every other element of the timeline", () => {
    // The ruler and the track are plain elements. A release build still opens no web view
    // menu there, and a development build keeps it for inspection.
    const ruler = describeContextMenuTarget({
      tagName: "DIV",
      matches: () => false,
      closest: () => null,
    });
    expect(shouldSuppressContextMenu(ruler, false)).toBe(true);
    expect(shouldSuppressContextMenu(ruler, true)).toBe(false);
  });
});
