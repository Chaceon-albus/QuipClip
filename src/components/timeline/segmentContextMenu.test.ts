import { describe, expect, it, vi } from "vitest";
import {
  createOneClipTimelineStore,
  TEST_CLIP_ID,
  TEST_SEQUENCE_SOURCE_ID,
  type OneSourceSegment,
} from "@/features/timeline/storeTestSupport";
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

const SOURCE_ID = TEST_SEQUENCE_SOURCE_ID;

/**
 * Walks a dotted key through the English catalog, the way i18next resolves it. A count picks
 * the plural form, `_one` or `_other`, and fills `{{count}}`.
 */
function translate(key: string, values?: { readonly count: number }): string {
  if (values !== undefined) {
    const form = values.count === 1 ? "_one" : "_other";
    return translate(`${key}${form}`).replaceAll("{{count}}", String(values.count));
  }
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

function createHarness(extraSegments: readonly OneSourceSegment[] = []) {
  const timeline = createOneClipTimelineStore(
    {
      segments: [
        { id: "a", sourceId: SOURCE_ID, inPts: pts("90000"), outPts: pts("180000") },
        { id: "b", sourceId: SOURCE_ID, inPts: pts("270000"), outPts: pts("360000") },
        ...extraSegments,
      ],
      currentSegmentId: "a",
    },
    { generateId: () => "unused" },
  );
  const facts: {
    isTrimDragging: boolean;
    isOverlayOpen: boolean;
    isImporting: boolean;
    playback: ShortcutSnapshot["playback"];
  } = {
    isTrimDragging: false,
    isOverlayOpen: false,
    isImporting: false,
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
    isImporting: facts.isImporting,
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
  // The timer of the dialog hand-off: the test runs the pending callbacks.
  const timers: { callback: () => void; delayMs: number; stopped: boolean }[] = [];
  const schedule = (callback: () => void, delayMs: number) => {
    const entry = { callback, delayMs, stopped: false };
    timers.push(entry);
    return () => {
      entry.stopped = true;
    };
  };
  /** Runs every pending timer, as if its delay passed. */
  const fireTimers = () => {
    for (const entry of [...timers]) {
      if (!entry.stopped) {
        entry.stopped = true;
        entry.callback();
      }
    }
  };
  const liveTimers = () => timers.filter((entry) => !entry.stopped);
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
    schedule,
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
    fireTimers,
    liveTimers,
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
      harness.timeline.setState({
        currentSegmentId: null,
        selectedSegmentIds: [],
        pendingIn: { clipId: TEST_CLIP_ID, pts: pts("30000") },
        pendingInPts: pts("30000"),
      });
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
        "Rename…\tF2",
        // ADR 067: the item has no binding, so no key after a tab.
        "Export Segment…",
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
      const timeline = createOneClipTimelineStore({
        segments: [
          { id: "b", sourceId: SOURCE_ID, inPts: pts("0"), outPts: pts("90000") },
        ],
      });
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

  describe("a selection of several segments (ADR 045)", () => {
    function selectBoth() {
      const harness = createHarness();
      harness.timeline.getState().selectAllSegments();
      expect(harness.timeline.getState().selectedSegmentIds).toEqual(["a", "b"]);
      return harness;
    }

    it("keeps the selection when the request names one of its segments", () => {
      const harness = selectBoth();
      expect(harness.open({ segmentId: "b" })).not.toBeNull();
      expect(harness.timeline.getState()).toMatchObject({
        selectedSegmentIds: ["a", "b"],
        currentSegmentId: null,
      });
      const { entries } = harness.lastShow();
      expect(itemOf(entries, "deleteSegment")).toMatchObject({
        text: "Delete 2 Segments\tDelete",
        enabled: true,
      });
      for (const action of [
        "goToSegmentIn",
        "goToSegmentOut",
        "playSegment",
        "renameSegment",
      ] as const) {
        expect(itemOf(entries, action).enabled).toBe(false);
      }
    });

    it("deletes every selected segment through the command of the key", () => {
      const harness = selectBoth();
      void harness.open({ segmentId: "a" });
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "deleteSegment",
      });
    });

    it("runs nothing when the selection changed while the menu was open", () => {
      const harness = selectBoth();
      void harness.open({ segmentId: "b" });
      harness.timeline.getState().toggleSegmentSelection("a");
      harness.lastShow().select("deleteSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("selects only the segment of a request outside the selection", () => {
      const harness = createHarness([
        { id: "c", sourceId: SOURCE_ID, inPts: pts("540000"), outPts: pts("630000") },
      ]);
      harness.timeline.getState().toggleSegmentSelection("b");
      expect(harness.timeline.getState().selectedSegmentIds).toEqual(["a", "b"]);
      void harness.open({ segmentId: "c" });
      expect(harness.timeline.getState()).toMatchObject({
        selectedSegmentIds: ["c"],
        currentSegmentId: "c",
      });
    });
  });

  describe("Export Segment… (ADR 067)", () => {
    it("exports the segment of the menu after the menu closes, when the choice came first", async () => {
      const harness = createHarness();
      const menuOpenAtRun: boolean[] = [];
      harness.runCommand.mockImplementation(() => {
        menuOpenAtRun.push(harness.menuState.isOpen());
      });
      const closed = harness.open();
      const show = harness.lastShow();
      expect(itemOf(show.entries, "exportSelectedSegments")).toMatchObject({
        text: "Export Segment…",
        enabled: true,
        commandKind: "exportSelectedSegments",
      });
      show.popup();
      show.select("exportSelectedSegments");
      expect(harness.runCommand).not.toHaveBeenCalled();
      show.close();
      await closed;
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "exportSelectedSegments",
        segmentIds: ["b"],
      });
      expect(menuOpenAtRun).toStrictEqual([false]);
    });

    it("exports the selection of the menu after the menu closes", async () => {
      const harness = createHarness();
      harness.timeline.getState().selectAllSegments();
      const closed = harness.open({ segmentId: "a" });
      const show = harness.lastShow();
      expect(itemOf(show.entries, "exportSelectedSegments")).toMatchObject({
        text: "Export 2 Segments…",
        enabled: true,
      });
      show.select("exportSelectedSegments");
      show.close();
      await closed;
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith({
        kind: "exportSelectedSegments",
        segmentIds: ["a", "b"],
      });
    });

    it("runs nothing when the selection is no longer the one of the menu as the menu ends", async () => {
      const harness = createHarness();
      harness.timeline.getState().selectAllSegments();
      const closed = harness.open({ segmentId: "a" });
      const show = harness.lastShow();
      show.select("exportSelectedSegments");
      harness.timeline.getState().toggleSegmentSelection("a");
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("runs nothing for one segment when another segment became current", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.select("exportSelectedSegments");
      harness.timeline.getState().selectSegment("a");
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("is disabled while an import runs, and runs nothing when an import starts before the menu ends", async () => {
      const harness = createHarness();
      harness.facts.isImporting = true;
      void harness.open();
      expect(itemOf(harness.lastShow().entries, "exportSelectedSegments").enabled).toBe(
        false,
      );
      harness.lastShow().close();

      const next = createHarness();
      const closed = next.open();
      const show = next.lastShow();
      show.select("exportSelectedSegments");
      next.facts.isImporting = true;
      show.close();
      await closed;
      expect(next.runCommand).not.toHaveBeenCalled();
    });
  });

  describe("Rename… (ADR 065)", () => {
    const RENAME_B: ShortcutCommand = { kind: "renameSegment", segmentId: "b" };

    it("opens the dialog after the menu closes, when the choice came first", async () => {
      const harness = createHarness();
      const menuOpenAtRun: boolean[] = [];
      harness.runCommand.mockImplementation(() => {
        menuOpenAtRun.push(harness.menuState.isOpen());
      });
      const closed = harness.open();
      const show = harness.lastShow();
      expect(itemOf(show.entries, "renameSegment").enabled).toBe(true);
      show.popup();
      show.select("renameSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
      show.close();
      await closed;
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
      // The window keyboard layer has the keys back when the dialog opens.
      expect(menuOpenAtRun).toStrictEqual([false]);
    });

    it("opens the dialog at once when the choice comes after the end of the menu", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.popup();
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
      show.select("renameSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
    });

    it("opens the dialog at the first input after the grace period of a lost popup reply", () => {
      const harness = createHarness();
      void harness.open();
      const lost = harness.lastShow();
      lost.popup();
      lost.select("renameSegment");
      // The menu may still show within the grace period, so the dialog waits.
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS - 1);
      expect(harness.runCommand).not.toHaveBeenCalled();
      harness.input(1);
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
      // The popup settles late, and nothing runs twice.
      lost.close();
      expect(harness.runCommand).toHaveBeenCalledOnce();
    });

    it("opens the dialog for a late choice after the input closed a lost popup", () => {
      const harness = createHarness();
      void harness.open();
      const lost = harness.lastShow();
      lost.popup();
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS);
      expect(harness.menuState.isOpen()).toBe(false);
      lost.select("renameSegment");
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
    });

    it("checks its target again when the dialog would open", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.select("renameSegment");
      // The segment of the menu is no longer current when the menu ends.
      harness.timeline.getState().selectSegment("a");
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("opens no dialog while a dialog of the page is open when the menu ends", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.select("renameSegment");
      harness.facts.isOverlayOpen = true;
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("does not wait for the end of the menu for an item that opens no dialog", () => {
      const harness = createHarness();
      void harness.open();
      harness.lastShow().select("goToSegmentIn");
      expect(harness.runCommand).toHaveBeenCalledOnce();
    });

    it("does not open the dialog during a drag trim", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.select("renameSegment");
      harness.facts.isTrimDragging = true;
      show.close();
      await closed;
      expect(harness.runCommand).not.toHaveBeenCalled();
    });

    it("opens the dialog when the popup reply never comes, after the grace period, once", () => {
      const harness = createHarness();
      void harness.open();
      const lost = harness.lastShow();
      lost.popup();
      lost.select("renameSegment");
      expect(harness.runCommand).not.toHaveBeenCalled();
      // No input follows: the timer of the hand-off ends the wait.
      expect(harness.liveTimers().map((entry) => entry.delayMs)).toStrictEqual([
        NATIVE_CONTEXT_MENU_GRACE_MS,
      ]);
      harness.fireTimers();
      expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
      // The item event proved that the menu has gone, so the page has its keys back.
      expect(harness.menuState.isOpen()).toBe(false);
      // A popup reply after the timer changes nothing.
      lost.close();
      harness.fireTimers();
      expect(harness.runCommand).toHaveBeenCalledOnce();
    });

    it("stops the timer when the popup reply comes in time", async () => {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.popup();
      show.select("renameSegment");
      show.close();
      await closed;
      expect(harness.runCommand).toHaveBeenCalledOnce();
      expect(harness.liveTimers()).toHaveLength(0);
    });

    it("leaves no timer of an earlier menu when a later menu opens", () => {
      const harness = createHarness();
      void harness.open({ segmentId: "a" });
      const first = harness.lastShow();
      first.popup();
      first.select("renameSegment");
      expect(harness.liveTimers()).toHaveLength(1);
      // A later menu can open only after the mark of the first one closed, here by the input
      // after the grace period. The first choice runs then, and its timer stops.
      harness.input(NATIVE_CONTEXT_MENU_GRACE_MS);
      expect(harness.runCommand).toHaveBeenCalledOnce();
      expect(harness.liveTimers()).toHaveLength(0);
      expect(harness.open({ segmentId: "b" })).not.toBeNull();
      harness.fireTimers();
      first.close();
      expect(harness.runCommand).toHaveBeenCalledOnce();
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

describe("the choice of a menu reaches its item before anything that waits for the menu (ADR 073)", () => {
  const RENAME_B: ShortcutCommand = { kind: "renameSegment", segmentId: "b" };

  it("keeps the choice pending from a popup reply that came first until a dialog item ran", async () => {
    const harness = createHarness();
    const pendingAtRun: boolean[] = [];
    harness.runCommand.mockImplementation(() => {
      pendingAtRun.push(harness.menuState.isChoicePending());
    });
    const closed = harness.open();
    const show = harness.lastShow();
    show.popup();
    show.close();
    await closed;
    // The menu is closed, and its choice can still come.
    expect(harness.menuState.isOpen()).toBe(false);
    expect(harness.menuState.isChoicePending()).toBe(true);

    show.select("renameSegment");
    expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
    // The item ran while the choice was still pending, and the pending choice ended after it.
    expect(pendingAtRun).toStrictEqual([true]);
    expect(harness.menuState.isChoicePending()).toBe(false);
  });

  it("keeps the choice pending from a popup reply that came first until an ordinary item ran", async () => {
    const harness = createHarness();
    const pendingAtRun: boolean[] = [];
    harness.runCommand.mockImplementation(() => {
      pendingAtRun.push(harness.menuState.isChoicePending());
    });
    const closed = harness.open();
    const show = harness.lastShow();
    show.popup();
    show.close();
    await closed;

    show.select("goToSegmentIn");
    expect(pendingAtRun).toStrictEqual([true]);
    expect(harness.menuState.isChoicePending()).toBe(false);
  });

  it("runs a dialog item at the close when the choice came first, and keeps nothing pending", async () => {
    const harness = createHarness();
    const stateAtRun: { open: boolean; pending: boolean }[] = [];
    harness.runCommand.mockImplementation(() => {
      stateAtRun.push({
        open: harness.menuState.isOpen(),
        pending: harness.menuState.isChoicePending(),
      });
    });
    const closed = harness.open();
    const heard: { open: boolean; pending: boolean }[] = [];
    harness.menuState.subscribe(() => {
      heard.push({
        open: harness.menuState.isOpen(),
        pending: harness.menuState.isChoicePending(),
      });
    });
    const show = harness.lastShow();
    show.popup();
    show.select("renameSegment");
    show.close();
    await closed;

    expect(harness.runCommand).toHaveBeenCalledExactlyOnceWith(RENAME_B);
    expect(stateAtRun).toStrictEqual([{ open: false, pending: false }]);
    // The state tells the close after the item ran, and keeps no choice pending.
    expect(heard).toStrictEqual([{ open: false, pending: false }]);
  });

  it("ends the pending choice after the grace period of a menu that the user dismissed", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const closed = harness.open();
      const show = harness.lastShow();
      show.popup();
      show.close();
      await closed;
      expect(harness.menuState.isChoicePending()).toBe(true);

      vi.advanceTimersByTime(NATIVE_CONTEXT_MENU_GRACE_MS - 1);
      expect(harness.menuState.isChoicePending()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(harness.menuState.isChoicePending()).toBe(false);
      expect(harness.runCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
