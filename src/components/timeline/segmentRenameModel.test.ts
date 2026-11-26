import { describe, expect, it } from "vitest";
import { createOneClipTimelineStore } from "@/features/timeline/storeTestSupport";
import type { Pts } from "@/types/project";
import {
  belongsToInputMethod,
  canRunSegmentRenameConfirm,
  initialSegmentRenameText,
  planSegmentRenameConfirm,
  readSegmentRenameText,
  resolveSegmentRenameKey,
  returnSegmentRenameFocus,
  spliceSegmentRenamePaste,
  type SegmentRenameConfirmInput,
  type SegmentRenameFocusTarget,
} from "./segmentRenameModel";
import { createSegmentRenameDialogStore } from "./segmentRenameDialogStore";

const pts = (value: string) => value as Pts;

const LIVE = new Set(["a", "b"]);

describe("initialSegmentRenameText", () => {
  it("holds the name, or empty text for no name or an unknown segment", () => {
    const segments = [{ id: "a", name: "Intro" }, { id: "b" }];
    expect(initialSegmentRenameText(segments, "a")).toBe("Intro");
    expect(initialSegmentRenameText(segments, "b")).toBe("");
    expect(initialSegmentRenameText(segments, "ghost")).toBe("");
  });
});

describe("the keys of the field (ADR 065)", () => {
  const press = (key: string, isComposing = false, keyCode = 0) => ({
    key,
    isComposing,
    keyCode,
  });

  it("confirms on Enter and cancels on Escape", () => {
    expect(resolveSegmentRenameKey(press("Enter", false, 13))).toBe("confirm");
    expect(resolveSegmentRenameKey(press("Escape", false, 27))).toBe("cancel");
    expect(resolveSegmentRenameKey(press("a", false, 65))).toBeNull();
  });

  it("leaves Enter and Escape to the input method while it composes text", () => {
    expect(resolveSegmentRenameKey(press("Enter", true, 13))).toBeNull();
    expect(resolveSegmentRenameKey(press("Escape", true, 27))).toBeNull();
    // WebKit ends a composition with an Enter whose `isComposing` is false and whose keyCode
    // is 229.
    expect(resolveSegmentRenameKey(press("Enter", false, 229))).toBeNull();
    expect(resolveSegmentRenameKey(press("Escape", false, 229))).toBeNull();
    expect(belongsToInputMethod({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(belongsToInputMethod({ isComposing: true, keyCode: 0 })).toBe(true);
    expect(belongsToInputMethod({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("readSegmentRenameText", () => {
  it("says why a text that is too long cannot be a name", () => {
    expect(readSegmentRenameText("a".repeat(80))).toStrictEqual({ kind: "ok" });
    expect(readSegmentRenameText(`  ${"a".repeat(80)}  `)).toStrictEqual({
      kind: "ok",
    });
    expect(readSegmentRenameText("a".repeat(81))).toStrictEqual({
      kind: "tooLong",
      length: 81,
      max: 80,
    });
    // 80 characters outside the BMP are 160 UTF-16 code units, and still a name.
    expect(readSegmentRenameText("\u{1f600}".repeat(80))).toStrictEqual({ kind: "ok" });
  });
});

/** The confirm of the dialog of `segmentId`, open as open 1, with nothing else holding it. */
function confirmOf(
  text: string,
  segmentId: string,
  overrides: Partial<SegmentRenameConfirmInput> = {},
) {
  return planSegmentRenameConfirm({
    text,
    segmentId,
    liveSegmentIds: LIVE,
    dialog: { segmentId, openCount: 1 },
    openCount: 1,
    isTrimLocked: false,
    ...overrides,
  });
}

describe("planSegmentRenameConfirm (ADR 065)", () => {
  it("gives the segment the text without the forbidden characters and the edge spaces", () => {
    expect(confirmOf("  Intro\t ", "a")).toStrictEqual({
      kind: "rename",
      segmentId: "a",
      name: "Intro",
    });
    expect(confirmOf("Part\none", "a")).toStrictEqual({
      kind: "rename",
      segmentId: "a",
      name: "Partone",
    });
  });

  it("removes the name for text that is empty after the two steps", () => {
    expect(confirmOf("", "a")).toStrictEqual({
      kind: "rename",
      segmentId: "a",
      name: null,
    });
    expect(confirmOf(" \u3000\t", "b")).toStrictEqual({
      kind: "rename",
      segmentId: "b",
      name: null,
    });
  });

  it("refuses text that is too long after the two steps, and keeps the dialog open", () => {
    expect(confirmOf("a".repeat(81), "a")).toStrictEqual({ kind: "refuse" });
  });

  it("changes nothing when no segment has the id of the dialog", () => {
    expect(confirmOf("Intro", "ghost")).toStrictEqual({ kind: "close" });
  });

  it("does nothing once Escape closed the dialog, also during its exit animation", () => {
    // Escape closed the store, and an Enter reaches the field that is still mounted.
    expect(
      confirmOf("Discarded", "a", { dialog: { segmentId: null, openCount: 1 } }),
    ).toStrictEqual({ kind: "ignore" });
    // The dialog opened again meanwhile: the content of the first open does nothing.
    expect(
      confirmOf("Discarded", "a", { dialog: { segmentId: "a", openCount: 2 } }),
    ).toStrictEqual({ kind: "ignore" });
    expect(canRunSegmentRenameConfirm({ segmentId: "a", openCount: 1 }, 1)).toBe(true);
    expect(canRunSegmentRenameConfirm({ segmentId: null, openCount: 1 }, 1)).toBe(
      false,
    );
    expect(canRunSegmentRenameConfirm({ segmentId: "b", openCount: 2 }, 1)).toBe(false);
  });

  it("refuses while an edge press is armed or a trim drags, and keeps the dialog open", () => {
    expect(confirmOf("Intro", "a", { isTrimLocked: true })).toStrictEqual({
      kind: "refuse",
    });
  });

  it("renames the segment of the dialog, not the current one, through the store", () => {
    const timeline = createOneClipTimelineStore({
      segments: [
        { id: "a", inPts: pts("0"), outPts: pts("10") },
        { id: "b", inPts: pts("20"), outPts: pts("30") },
      ],
      currentSegmentId: "a",
    });
    const dialog = createSegmentRenameDialogStore();
    dialog.getState().open("a");
    // The current segment changes while the dialog is open.
    timeline.getState().selectSegment("b");
    const segmentId = dialog.getState().segmentId ?? "";
    const plan = planSegmentRenameConfirm({
      text: " Intro ",
      segmentId,
      liveSegmentIds: new Set(
        timeline.getState().segments.map((segment) => segment.id),
      ),
      dialog: dialog.getState(),
      openCount: 1,
      isTrimLocked: false,
    });
    expect(plan).toStrictEqual({ kind: "rename", segmentId: "a", name: "Intro" });
    if (plan.kind === "rename") {
      timeline.getState().renameSegment(plan.segmentId, plan.name);
    }
    expect(timeline.getState().segments.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "a", name: "Intro" },
      { id: "b", name: undefined },
    ]);
  });
});

describe("spliceSegmentRenamePaste (ADR 065)", () => {
  it("keeps a name of 80 characters that a pasted line break would make 81", () => {
    const pasted = `${"a".repeat(40)}\n${"b".repeat(40)}`;
    const next = spliceSegmentRenamePaste("", 0, 0, pasted);
    expect(next).toStrictEqual({
      text: `${"a".repeat(40)}${"b".repeat(40)}`,
      caret: 80,
      changed: true,
    });
    expect(readSegmentRenameText(next.text)).toStrictEqual({ kind: "ok" });
    // A field that turned the line break into a space would hold 81 characters.
    expect(readSegmentRenameText(pasted.replace("\n", " "))).toMatchObject({
      kind: "tooLong",
    });
  });

  it("replaces the selection and puts the caret after the pasted text", () => {
    expect(spliceSegmentRenamePaste("Hello world", 6, 11, "there\r\n")).toStrictEqual({
      text: "Hello there",
      caret: 11,
      changed: true,
    });
    expect(spliceSegmentRenamePaste("ab", 1, 1, "\tX\u2028")).toStrictEqual({
      text: "aXb",
      caret: 2,
      changed: true,
    });
  });

  it("reads a backward selection and clamps a selection outside the text", () => {
    expect(spliceSegmentRenamePaste("abcd", 3, 1, "-")).toStrictEqual({
      text: "a-d",
      caret: 2,
      changed: true,
    });
    expect(spliceSegmentRenamePaste("ab", 5, 9, "c")).toStrictEqual({
      text: "abc",
      caret: 3,
      changed: true,
    });
  });

  it("places the caret after a paste that leaves the text as it was", () => {
    // F2 selected all of "Intro", and the user pastes "Intro" and a line break.
    expect(spliceSegmentRenamePaste("Intro", 0, 5, "Intro\n")).toStrictEqual({
      text: "Intro",
      caret: 5,
      changed: false,
    });
    // The caret moves to the end of the paste, also in the middle of the text.
    expect(spliceSegmentRenamePaste("abab", 0, 2, "ab")).toStrictEqual({
      text: "abab",
      caret: 2,
      changed: false,
    });
  });

  it("counts the caret in UTF-16 code units, as the selection of a field does", () => {
    expect(spliceSegmentRenamePaste("x", 1, 1, "\u{1f600}")).toStrictEqual({
      text: "x\u{1f600}",
      caret: 3,
      changed: true,
    });
  });
});

describe("returnSegmentRenameFocus (ADR 065)", () => {
  /** A candidate that records the focus calls. `refuses` makes its `focus()` do nothing. */
  const target = (
    name: string,
    overrides: Partial<SegmentRenameFocusTarget> = {},
    refuses = false,
  ) => {
    const candidate = {
      name,
      calls: 0,
      focused: false,
      isConnected: true,
      isRendered: true,
      isDisabled: false,
      get hasFocus() {
        return this.focused;
      },
      focus() {
        this.calls += 1;
        this.focused = !refuses;
      },
    };
    return Object.assign(candidate, overrides);
  };

  it("gives the focus back to the element that held it when the dialog opened", () => {
    const opener = target("opener");
    const bar = target("bar");
    expect(returnSegmentRenameFocus(opener, [bar])).toBe(opener);
    expect(opener.calls).toBe(1);
    expect(bar.calls).toBe(0);
  });

  it("tries the next candidate when the focus does not land", () => {
    // The seek slider opened the dialog, and lost its tabIndex while the dialog was open: it is
    // still in the document, and its focus() does nothing.
    const slider = target("slider", {}, true);
    const bar = target("bar");
    expect(returnSegmentRenameFocus(slider, [bar])).toBe(bar);
    expect(slider.calls).toBe(1);
    expect(bar.calls).toBe(1);
  });

  it("falls back to the bar of the segment, then to the timeline, when the opener is gone", () => {
    const bar = target("bar");
    const timeline = target("timeline");
    expect(
      returnSegmentRenameFocus(target("opener", { isConnected: false }), [
        bar,
        timeline,
      ]),
    ).toBe(bar);
    // The focus rested on the body at the open, and the segment left the timeline.
    expect(returnSegmentRenameFocus(null, [null, timeline])).toBe(timeline);
    const hidden = target("bar", { isRendered: false });
    expect(
      returnSegmentRenameFocus(null, [hidden, target("slider", {}, true)]),
    ).toBeNull();
    expect(hidden.calls).toBe(0);
  });
});

describe("createSegmentRenameDialogStore", () => {
  it("opens for one segment, counts the opens, and closes", () => {
    const dialog = createSegmentRenameDialogStore();
    expect(dialog.getState()).toMatchObject({ segmentId: null, openCount: 0 });
    dialog.getState().open("a");
    expect(dialog.getState()).toMatchObject({ segmentId: "a", openCount: 1 });
    // A late open does not move an open dialog to another segment.
    dialog.getState().open("b");
    expect(dialog.getState()).toMatchObject({ segmentId: "a", openCount: 1 });
    dialog.getState().close();
    expect(dialog.getState().segmentId).toBeNull();
    dialog.getState().open("a");
    expect(dialog.getState()).toMatchObject({ segmentId: "a", openCount: 2 });
  });
});
