import { describe, expect, it, vi } from "vitest";
import {
  resolveShortcut,
  type ShortcutKeyEvent,
} from "@/components/layout/keyboardShortcutController";
import {
  NATIVE_CONTEXT_MENU_GRACE_MS,
  createNativeContextMenuState,
  isPageOverlayOpen,
  type NativeContextMenuInputEvent,
} from "@/components/layout/nativeContextMenuState";
import {
  planShortcutCommand,
  type ShortcutCommand,
  type ShortcutProbe,
  type ShortcutSnapshot,
} from "@/components/layout/shortcutCommands";
import { createTimelineStore } from "@/features/timeline";
import { en } from "@/i18n/locales/en";
import type { Pts, TickCount } from "@/types/project";
import type { SegmentMenuBackend } from "./nativeSegmentMenu";
import {
  createSegmentContextMenu,
  type SegmentContextMenuRequest,
} from "./segmentContextMenu";
import type {
  SegmentMenuAction,
  SegmentMenuEntry,
  SegmentMenuItem,
  SegmentMenuPosition,
} from "./segmentMenuModel";

const pts = (value: string): Pts => value as Pts;
const ticks = (value: string): TickCount => value as TickCount;

const SOURCE_ID = "source-1";

/** Walks a dotted key through the English catalog, the way i18next resolves it. */
function translate(key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, en);
  if (typeof value !== "string") {
    throw new Error(`missing catalog key ${key}`);
  }
  return value;
}

const PROBE: ShortcutProbe = {
  videoStartPts: pts("0"),
  videoTimeBase: { n: 1, d: 90_000 },
  videoDurationTicks: ticks("900000"),
  approximateDurationSeconds: 10.01,
  avgFrameRate: { n: 30, d: 1 },
  rFrameRate: { n: 30, d: 1 },
};

/** One show of the fake menu. The test settles it, as the user closes a native menu. */
interface Show {
  readonly entries: readonly SegmentMenuEntry[];
  readonly position: SegmentMenuPosition | null;
  readonly select: (action: SegmentMenuAction) => void;
  /** Reports the popup call, as the backend does once the call is sent. */
  readonly popup: () => void;
  readonly close: () => void;
  readonly fail: (error: Error) => void;
}

function createHarness() {
  const timeline = createTimelineStore(
    { generateId: () => "unused" },
    {
      sourceId: SOURCE_ID,
      segments: [
        { id: "a", sourceId: SOURCE_ID, inPts: pts("90000"), outPts: pts("180000") },
        { id: "b", sourceId: SOURCE_ID, inPts: pts("270000"), outPts: pts("360000") },
      ],
      currentSegmentId: "a",
    },
  );
  const facts: {
    isTrimDragging: boolean;
    isOverlayOpen: boolean;
    playback: ShortcutSnapshot["playback"];
  } = {
    isTrimDragging: false,
    isOverlayOpen: false,
    // The frame at 5 s is on screen, outside both segments.
    playback: {
      isAttached: true,
      isReady: true,
      isPlaying: false,
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 5, inferredSourcePts: pts("450000") },
      seekTargetSeconds: null,
      runtimeBrowserDurationSeconds: 10.02,
      approximateBrowserTimeSeconds: 5,
    },
  };
  const readSnapshot = (): ShortcutSnapshot => ({
    probe: PROBE,
    playback: facts.playback,
    timeline: timeline.getState(),
    viewport: { zoom: 1, maxZoom: 8 },
    isTrimDragging: facts.isTrimDragging,
  });
  const runCommand = vi.fn<(command: ShortcutCommand) => void>();
  // The state listens on a fake window with a manual clock, for the fallback of a popup that
  // never settles.
  const inputListeners: ((event: NativeContextMenuInputEvent) => void)[] = [];
  let time = 0;
  const menuState = createNativeContextMenuState({
    input: {
      addEventListener: (_type, listener) => {
        inputListeners.push(listener);
      },
      removeEventListener: () => {},
    },
    now: () => time,
  });
  /** A trusted press or key press that reaches the window, after `elapsedMs`. */
  const input = (elapsedMs: number) => {
    time += elapsedMs;
    for (const listener of inputListeners) {
      listener({ isTrusted: true });
    }
  };
  const shows: Show[] = [];
  const backend: SegmentMenuBackend = {
    show: (entries, position, { onSelect, onPopup }) =>
      new Promise<void>((resolve, reject) => {
        shows.push({
          entries,
          position,
          select: onSelect,
          popup: onPopup,
          close: resolve,
          fail: reject,
        });
      }),
  };
  const onError = vi.fn<(error: unknown) => void>();
  const menu = createSegmentContextMenu({
    timeline,
    readSnapshot,
    runCommand,
    isOverlayOpen: () => facts.isOverlayOpen,
    menuState,
    backend,
    platform: "windows",
    translate,
    onError,
  });
  const open = (request: Partial<SegmentContextMenuRequest> = {}) =>
    menu.open({
      segmentId: "b",
      position: null,
      isPointerGestureActive: false,
      ...request,
    });
  const lastShow = (): Show => {
    const show = shows[shows.length - 1];
    if (show === undefined) {
      throw new Error("the menu did not show");
    }
    return show;
  };
  return {
    timeline,
    facts,
    readSnapshot,
    runCommand,
    menuState,
    input,
    shows,
    lastShow,
    onError,
    menu,
    open,
  };
}

function itemOf(entries: readonly SegmentMenuEntry[], action: SegmentMenuAction) {
  const item = entries.find(
    (entry): entry is SegmentMenuItem =>
      entry.kind === "item" && entry.action === action,
  );
  if (item === undefined) {
    throw new Error(`no item ${action}`);
  }
  return item;
}

/** A key press on the body that the window keyboard layer would own, such as Delete. */
function keyEvent(key: string, isOverlayOpen: boolean): ShortcutKeyEvent {
  return {
    key,
    code: key,
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    isOverlayOpen,
    isTooltipOpen: false,
  };
}

describe("createSegmentContextMenu", () => {
  describe("open", () => {
    it("selects the segment as a click does, and runs no command, so nothing seeks", () => {
      const harness = createHarness();
      harness.timeline.setState({ currentSegmentId: null, pendingInPts: pts("30000") });
      expect(harness.open()).not.toBeNull();
      // A selection clears the pending In mark (ADR 007) and pushes no history entry.
      expect(harness.timeline.getState()).toMatchObject({
        currentSegmentId: "b",
        pendingInPts: null,
        canUndo: false,
      });
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("builds the items after the selection, so they name the segment of the menu", () => {
      const harness = createHarness();
      void harness.open();
      const { entries } = harness.lastShow();
      expect(
        entries.map((entry) => (entry.kind === "item" ? entry.text : "|")),
      ).toEqual([
        "Go to In\tShift+I",
        "Go to Out\tShift+O",
        "Play Segment\t/",
        "|",
        "Delete Segment\tDelete",
      ]);
      for (const action of [
        "goToSegmentIn",
        "goToSegmentOut",
        "deleteSegment",
      ] as const) {
        expect(itemOf(entries, action).enabled).toBe(
          planShortcutCommand(action, harness.readSnapshot()) !== null,
        );
      }
      expect(itemOf(entries, "deleteSegment").enabled).toBe(true);
    });

    it("disables an item whose key would not act, and still shows it", () => {
      const harness = createHarness();
      // The In frame of "b" is on screen, so Shift+I would do nothing.
      harness.facts.playback = {
        ...harness.facts.playback,
        presentedFrame: { mediaTime: 3, inferredSourcePts: pts("270000") },
      };
      void harness.open();
      const { entries } = harness.lastShow();
      expect(itemOf(entries, "goToSegmentIn").enabled).toBe(false);
      expect(itemOf(entries, "goToSegmentOut").enabled).toBe(true);
    });

    it("passes the position of the request to the menu", async () => {
      const harness = createHarness();
      const closed = harness.open({ position: { x: 120, y: 480 } });
      expect(harness.lastShow().position).toStrictEqual({ x: 120, y: 480 });
      harness.lastShow().close();
      await closed;
      void harness.open({ position: null });
      expect(harness.shows).toHaveLength(2);
      expect(harness.lastShow().position).toBeNull();
    });

    it("opens no second menu until the first one has closed", async () => {
      const harness = createHarness();
      const closed = harness.open();
      expect(harness.open({ segmentId: "a" })).toBeNull();
      harness.lastShow().close();
      // The mark clears when the promise of the menu settles, and not in the same task.
      expect(harness.open({ segmentId: "a" })).toBeNull();
      await closed;
      expect(harness.open({ segmentId: "a" })).not.toBeNull();
      expect(harness.shows).toHaveLength(2);
    });

    it("marks a menu as open until the menu closes", async () => {
      const harness = createHarness();
      const closed = harness.open();
      expect(harness.menuState.isOpen()).toBe(true);
      harness.lastShow().close();
      await closed;
      expect(harness.menuState.isOpen()).toBe(false);
    });

    it("clears the mark and reports the error when the menu fails", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const error = new Error("no menu");
      harness.lastShow().fail(error);
      await expect(closed).resolves.toBeUndefined();
      expect(harness.menuState.isOpen()).toBe(false);
      expect(harness.onError).toHaveBeenCalledExactlyOnceWith(error);
    });

    it("clears the mark when the menu throws before it returns a promise", async () => {
      const menuState = createNativeContextMenuState();
      const onError = vi.fn<(error: unknown) => void>();
      const timeline = createTimelineStore(
        {},
        {
          sourceId: SOURCE_ID,
          segments: [
            { id: "b", sourceId: SOURCE_ID, inPts: pts("0"), outPts: pts("90000") },
          ],
        },
      );
      const menu = createSegmentContextMenu({
        timeline,
        readSnapshot: () => ({
          probe: null,
          playback: createHarness().facts.playback,
          timeline: timeline.getState(),
          viewport: { zoom: 1, maxZoom: 1 },
        }),
        runCommand: () => {},
        isOverlayOpen: () => false,
        menuState,
        backend: {
          show: () => {
            throw new Error("no runtime");
          },
        },
        platform: "macos",
        translate,
        onError,
      });
      await menu.open({
        segmentId: "b",
        position: null,
        isPointerGestureActive: false,
      });
      expect(menuState.isOpen()).toBe(false);
      expect(onError).toHaveBeenCalledOnce();
      // The selection still happened, as a click would make it.
      expect(timeline.getState().currentSegmentId).toBe("b");
    });

    it.each<[string, (harness: ReturnType<typeof createHarness>) => void]>([
      ["the pointer gesture runs", () => {}],
      [
        "a drag trims an edge",
        (harness) => {
          harness.facts.isTrimDragging = true;
        },
      ],
      [
        "a dialog or a menu of the page is open",
        (harness) => {
          harness.facts.isOverlayOpen = true;
        },
      ],
      [
        "a native context menu is open",
        (harness) => {
          harness.menuState.open();
        },
      ],
    ])("does nothing while %s", (name, arrange) => {
      const harness = createHarness();
      arrange(harness);
      const request =
        name === "the pointer gesture runs" ? { isPointerGestureActive: true } : {};
      expect(harness.open(request)).toBeNull();
      expect(harness.shows).toHaveLength(0);
      // The selection does not change either.
      expect(harness.timeline.getState().currentSegmentId).toBe("a");
    });

    it("does nothing for a segment that the active source does not hold", () => {
      const harness = createHarness();
      expect(harness.open({ segmentId: "missing" })).toBeNull();
      harness.timeline.setState({ sourceId: "source-2" });
      expect(harness.open({ segmentId: "b" })).toBeNull();
      expect(harness.shows).toHaveLength(0);
    });
  });

  describe("a popup that never settles", () => {
    it("clears the mark at the first input after the popup call and its grace period", () => {
      const harness = createHarness();
      void harness.open();
      harness.lastShow().popup();
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS - 1);
      expect(harness.menuState.isOpen()).toBe(true);
      harness.input(1);
      expect(harness.menuState.isOpen()).toBe(false);
      // The page works again: a new request opens a menu.
      expect(harness.open({ segmentId: "a" })).not.toBeNull();
    });

    it("keeps the pending choice, because a lost popup reply can still bring the item event", () => {
      const harness = createHarness();
      void harness.open();
      const lost = harness.lastShow();
      lost.popup();
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS);
      expect(harness.menuState.isOpen()).toBe(false);
      lost.select("deleteSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "deleteSegment",
      });
    });

    it("still guards a late choice with the checks of every item", () => {
      const harness = createHarness();
      void harness.open();
      const lost = harness.lastShow();
      lost.popup();
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS);
      // The press that closed the mark selected another segment, so the choice names a segment
      // that is no longer current.
      harness.timeline.getState().selectSegment("a");
      lost.select("deleteSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("keeps the mark while the page builds the menu, before the popup call", () => {
      const harness = createHarness();
      void harness.open();
      harness.input(10 * NATIVE_CONTEXT_MENU_GRACE_MS);
      expect(harness.menuState.isOpen()).toBe(true);
      // The choice of the menu still runs once the menu shows.
      harness.lastShow().popup();
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "deleteSegment",
      });
    });

    it("changes nothing when the popup settles first", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.popup();
      show.close();
      await closed;
      expect(harness.menuState.isOpen()).toBe(false);
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS);
      // The late event of the chosen item still runs after a popup that settled.
      show.select("deleteSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "deleteSegment",
      });
    });
  });

  describe("an item", () => {
    it("runs the command that its key plans, through the command runner", () => {
      const harness = createHarness();
      void harness.open();
      const { select } = harness.lastShow();

      select("goToSegmentIn");
      expect(harness.runCommand).toHaveBeenLastCalledWith({
        kind: "seekToPts",
        pts: pts("270000"),
      });
      select("goToSegmentOut");
      expect(harness.runCommand).toHaveBeenLastCalledWith({
        kind: "seekToPts",
        pts: pts("360000"),
      });
      select("deleteSegment");
      expect(harness.runCommand).toHaveBeenLastCalledWith({ kind: "deleteSegment" });
      for (const [index, action] of (
        ["goToSegmentIn", "goToSegmentOut", "deleteSegment"] as const
      ).entries()) {
        expect(harness.runCommand.mock.calls[index]?.[0]).toStrictEqual(
          planShortcutCommand(action, harness.readSnapshot()),
        );
      }
    });

    it("runs while the menu is still marked open, because its event can come first", () => {
      const harness = createHarness();
      void harness.open();
      expect(harness.menuState.isOpen()).toBe(true);
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "deleteSegment",
      });
    });

    it("reads the condition when it runs, and not when the menu opened", () => {
      const harness = createHarness();
      void harness.open();
      // The playback reached the In frame while the menu was open.
      harness.facts.playback = {
        ...harness.facts.playback,
        presentedFrame: { mediaTime: 3, inferredSourcePts: pts("270000") },
      };
      harness.lastShow().select("goToSegmentIn");
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("runs nothing when another segment became current", () => {
      const harness = createHarness();
      void harness.open();
      harness.timeline.getState().selectSegment("a");
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("runs nothing while a dialog or a menu of the page is open", () => {
      const harness = createHarness();
      void harness.open();
      harness.facts.isOverlayOpen = true;
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
    });
  });

  describe("Play Segment", () => {
    it("plays the segment of the menu through the command of its key", () => {
      const harness = createHarness();
      void harness.open();
      harness.lastShow().select("playSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "playSegment",
        inPts: pts("270000"),
        outPts: pts("360000"),
      });
    });

    it("pauses a segment that plays, and runs nothing once it has stopped", () => {
      const harness = createHarness();
      const playing = {
        ...harness.facts.playback,
        isPlaying: true,
        playbackStop: {
          phase: "playing" as const,
          inPts: pts("270000"),
          outPts: pts("360000"),
        },
      };
      harness.facts.playback = playing;
      void harness.open();
      const show = harness.lastShow();
      const item = itemOf(show.entries, "playSegment");
      expect(item.label).toBe("Pause");

      // The segment reached its stop while the menu was open.
      harness.facts.playback = {
        ...playing,
        isPlaying: false,
        playbackStop: undefined,
      };
      show.select("playSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();

      harness.facts.playback = playing;
      show.select("playSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({ kind: "pause" });
    });
  });

  describe("the window keyboard layer", () => {
    it("does nothing with a key press while the menu is marked open", async () => {
      const harness = createHarness();
      const context = { platform: "windows" as const, isActionAvailable: () => true };
      const closed = harness.open();
      // `useKeyboardShortcuts` passes `isPageOverlayOpen()` as the overlay test, which reads
      // the mark (ADR 021). The tests run with no document, so no modal layer is open.
      const overlay = () => isPageOverlayOpen(harness.menuState, () => false);
      expect(overlay()).toBe(true);
      expect(resolveShortcut(keyEvent("Delete", overlay()), context)).toStrictEqual({
        claimed: false,
        action: null,
      });

      harness.lastShow().close();
      await closed;
      expect(overlay()).toBe(false);
      expect(resolveShortcut(keyEvent("Delete", overlay()), context)).toStrictEqual({
        claimed: true,
        action: "deleteSegment",
      });
    });
  });
});
