import { describe, expect, it } from "vitest";
import type { LandingFocusTarget } from "@/components/common/focusTarget";
import { MODAL_LAYER_SELECTOR } from "@/components/layout/keyboardShortcutController";
import { selectExportSegmentIds } from "@/features/timeline/exportSegments";
import type { BigIntRational } from "@/features/timeline/math";
import {
  formatSegmentTotal,
  totalExportSegments,
} from "@/features/timeline/segmentTotal";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { MILLISECONDS_TIMECODE_DISPLAY, type TimecodeDisplay } from "@/lib/timecode";
import type { Clip, Pts, Segment, SequenceSegment } from "@/types/project";
import {
  buildExportOrderRows,
  canMoveExportOrderFocusToRow,
  canRunExportOrderConfirm,
  compareSequenceTimes,
  EXPORT_ORDER_TRIGGER_ATTRIBUTE,
  EXPORT_ORDER_UNKNOWN_TIME,
  exportOrderListState,
  exportSegmentStarts,
  focusIndexAfter,
  followExportOrderTimeline,
  isSameExportOrder,
  isSameExportSegmentSet,
  moveExportOrderRow,
  planExportOrderConfirm,
  resolveExportOrderKey,
  resolveExportOrderMoveMessage,
  resolveExportOrderRowName,
  sortExportOrderByTimelinePosition,
  syncExportOrderDraft,
  type ExportOrderKeyPress,
  type ExportOrderRow,
  type ExportOrderRowFacts,
} from "./exportOrderModel";
import { formatSegmentTimes } from "./segmentLabels";
import { returnSegmentRenameFocus } from "./segmentRenameModel";

const pts = (value: string) => value as Pts;
const time = (n: bigint, d: bigint = 1n): BigIntRational => ({ n, d });

const frames25: TimecodeDisplay = {
  format: "frames",
  rate: { n: 25, d: 1 },
  videoTimeBase: { n: 1, d: 1000 },
};

const source = (id: string, end: string | null): SequenceSource => ({
  id,
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: end === null ? null : pts(end),
  videoDurationTicks: null,
  approximateDurationSeconds: end === null ? 10 : null,
});

const on = (
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
  name?: string,
): SequenceSegment => ({
  id,
  inClipId,
  inPts: pts(inPts),
  outClipId,
  outPts: pts(outPts),
  ...(name === undefined ? {} : { name }),
});

/** Looks up a key of a catalog, such as `timeline.exportOrder.moved`. */
function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    node =
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  return node;
}

/** The named placeholders of a message, such as `{{position}}`. */
function placeholders(message: unknown): string[] {
  return typeof message === "string"
    ? [...message.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? "").sort()
    : [];
}

describe("the draft", () => {
  it("compares orders and sets of ids", () => {
    expect(isSameExportOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(isSameExportOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(isSameExportOrder(["a"], ["a", "b"])).toBe(false);
    expect(isSameExportSegmentSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(isSameExportSegmentSet(["a", "b"], ["a", "c"])).toBe(false);
    expect(isSameExportSegmentSet(["a", "b"], ["a", "b", "c"])).toBe(false);
    // An id two times is not a set of the segments.
    expect(isSameExportSegmentSet(["a", "a"], ["a", "b"])).toBe(false);
    expect(isSameExportSegmentSet(["a", "b"], ["a", "a"])).toBe(false);
  });

  it("moves a row to the index that it takes in the new list", () => {
    const draft = ["a", "b", "c", "d"];
    expect(moveExportOrderRow(draft, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveExportOrderRow(draft, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveExportOrderRow(draft, 1, 2)).toEqual(["a", "c", "b", "d"]);
    // No move, and an index out of range, keep the same list.
    expect(moveExportOrderRow(draft, 1, 1)).toBe(draft);
    expect(moveExportOrderRow(draft, -1, 1)).toBe(draft);
    expect(moveExportOrderRow(draft, 0, 4)).toBe(draft);
    expect(moveExportOrderRow(draft, 0.5, 1)).toBe(draft);
  });

  it("keeps the draft while it names the segments of the export, in any order", () => {
    expect(syncExportOrderDraft(["b", "a"], ["a", "b"])).toEqual({ kind: "keep" });
  });

  it("discards the draft when the segments of the export change", () => {
    // A split, a delete or a clip edit that a late import made changes the set.
    expect(syncExportOrderDraft(["b", "a"], ["a", "b", "c"])).toEqual({
      kind: "reset",
      draft: ["a", "b", "c"],
    });
    expect(syncExportOrderDraft(["b", "a"], ["a"])).toEqual({
      kind: "reset",
      draft: ["a"],
    });
    expect(syncExportOrderDraft(["b", "a"], ["a", "c"])).toEqual({
      kind: "reset",
      draft: ["a", "c"],
    });
  });
});

describe("a timeline that changes while the dialog is open", () => {
  const clips: Clip[] = [
    { id: "a1", sourceId: "A" },
    { id: "b1", sourceId: "B" },
  ];
  const SOURCES = {
    A: source("A", "10000"),
    B: source("B", "5000"),
    C: source("C", "3000"),
  };

  /** Two clips with `x` on A, `cross` across the junction, and `y` on B. */
  function openTimeline() {
    let next = 0;
    return createTimelineStore(
      { generateId: () => `new${++next}` },
      {
        clips,
        sequenceSources: { A: SOURCES.A, B: SOURCES.B },
        sequenceSegments: [
          on("x", "a1", "1000", "a1", "2000"),
          on("cross", "a1", "9000", "b1", "1000"),
          on("y", "b1", "2000", "b1", "3000"),
        ],
        attachedClipId: "a1",
        generation: 1,
      },
    );
  }

  it("discards the draft when an import that ends splits a segment at a junction", () => {
    const store = openTimeline();
    const atOpen = selectExportSegmentIds(store.getState());
    expect(atOpen).toEqual(["x", "cross", "y"]);
    // The user changed the draft, and the focus is on `y`.
    const draft = ["y", "x", "cross"];
    expect(followExportOrderTimeline(draft, "y", atOpen)).toEqual({ kind: "keep" });

    // The import that started before the open ends: its clip goes into the junction that
    // `cross` crosses, which splits `cross` in two.
    expect(
      store.getState().insertClips(1, [{ id: "c1", sourceId: "C" }], [SOURCES.C]),
    ).toBe(true);
    const now = selectExportSegmentIds(store.getState());
    expect(now).toEqual(["x", "cross", "new1", "y"]);
    expect(followExportOrderTimeline(draft, "y", now)).toEqual({
      kind: "reset",
      draft: ["x", "cross", "new1", "y"],
      focusId: "y",
    });
    // A focused row that is gone gives the focus to the first row.
    expect(followExportOrderTimeline(draft, "gone", now)).toMatchObject({
      focusId: "x",
    });
  });

  it("keeps the draft for an import at the end and for a trim that commits", () => {
    const store = openTimeline();
    const atOpen = selectExportSegmentIds(store.getState());
    const draft = ["y", "x", "cross"];
    // A clip at the end crosses no segment.
    expect(
      store.getState().insertClips(2, [{ id: "c1", sourceId: "C" }], [SOURCES.C]),
    ).toBe(true);
    // A released trim writes its boundary.
    store.getState().trimSegmentEdge("x", "out", pts("1500"));
    const state = store.getState();
    expect(state.sequenceSegments.find((segment) => segment.id === "x")?.outPts).toBe(
      "1500",
    );
    const now = selectExportSegmentIds(state);
    expect(now).toEqual(atOpen);
    expect(followExportOrderTimeline(draft, "x", now)).toEqual({ kind: "keep" });
  });

  it("discards the draft when a delete under the open dialog removes a segment", () => {
    const store = openTimeline();
    const draft = ["y", "x", "cross"];
    store.getState().selectSegment("x");
    store.getState().deleteSelectedSegments();
    expect(
      followExportOrderTimeline(draft, "x", selectExportSegmentIds(store.getState())),
    ).toEqual({ kind: "reset", draft: ["cross", "y"], focusId: "cross" });
  });
});

describe("the list box of a closing dialog", () => {
  /**
   * Answers whether `MODAL_LAYER_SELECTOR` matches an element with `role` and `state`. Each part
   * of the selector must be `[role="R"]:not([data-state="closed"])`, so the test stays exact.
   */
  function matchesModalLayer(role: string, state: string | null): boolean {
    return MODAL_LAYER_SELECTOR.split(",").some((part) => {
      const match = /^\[role="(\w+)"\]:not\(\[data-state="closed"\]\)$/.exec(part);
      if (match === null) {
        throw new Error(`unexpected selector part: ${part}`);
      }
      return match[1] === role && state !== "closed";
    });
  }

  it("blocks the window commands while the dialog is open, and not while it closes", () => {
    expect(exportOrderListState(true)).toBe("open");
    expect(exportOrderListState(false)).toBe("closed");
    expect(matchesModalLayer("listbox", exportOrderListState(true))).toBe(true);
    // Radix keeps the content during the exit animation, and marks only the dialog closed.
    expect(matchesModalLayer("dialog", "closed")).toBe(false);
    expect(matchesModalLayer("listbox", exportOrderListState(false))).toBe(false);
    // A list box with no state, as the list was before, still blocks them.
    expect(matchesModalLayer("listbox", null)).toBe(true);
  });
});

describe("the focus after the end of a drag", () => {
  it("goes to the row from the list, from a lost focus or from a disabled control", () => {
    expect(canMoveExportOrderFocusToRow("list")).toBe(true);
    // The node of the dragged row moved in the document and lost the focus, and Radix gave it to
    // the dialog: Up and Down would no longer reach the list.
    expect(canMoveExportOrderFocusToRow("lost")).toBe(true);
    expect(canMoveExportOrderFocusToRow("disabledControl")).toBe(true);
    // The user moved the focus to Cancel with Tab during the drag.
    expect(canMoveExportOrderFocusToRow("control")).toBe(false);
  });
});

describe("the sort by timeline position", () => {
  it("compares exact sequence times", () => {
    expect(compareSequenceTimes(time(1n, 3n), time(1n, 2n))).toBeLessThan(0);
    expect(compareSequenceTimes(time(2n, 4n), time(1n, 2n))).toBe(0);
    // Two values that one double cannot tell apart.
    expect(
      compareSequenceTimes(
        time(9007199254740993n, 1000n),
        time(9007199254740992n, 1000n),
      ),
    ).toBeGreaterThan(0);
  });

  it("orders by the start, keeps equal starts and puts unknown starts last", () => {
    const starts = new Map<string, BigIntRational | null>([
      ["late", time(5n)],
      ["unknown1", null],
      ["early", time(1n)],
      ["tieFirst", time(3n)],
      ["unknown2", null],
      ["tieSecond", time(6n, 2n)],
    ]);
    const draft = ["late", "unknown1", "early", "tieFirst", "unknown2", "tieSecond"];
    expect(sortExportOrderByTimelinePosition(draft, starts)).toEqual([
      "early",
      "tieFirst",
      "tieSecond",
      "late",
      "unknown1",
      "unknown2",
    ]);
    // The other order of the tie stays as the draft has it.
    expect(
      sortExportOrderByTimelinePosition(["tieSecond", "tieFirst"], starts),
    ).toEqual(["tieSecond", "tieFirst"]);
  });

  it("returns the same draft when it is already in that order", () => {
    const starts = new Map<string, BigIntRational | null>([
      ["a", time(1n)],
      ["b", time(2n)],
      ["x", null],
    ]);
    const draft = ["a", "b", "x"];
    expect(sortExportOrderByTimelinePosition(draft, starts)).toBe(draft);
    // An id with no entry has no known start.
    const missing = ["a", "gone", "b"];
    expect(sortExportOrderByTimelinePosition(missing, starts)).toEqual([
      "a",
      "b",
      "gone",
    ]);
  });

  it("reads the exact start of the In of each segment on the sequence", () => {
    const clips: Clip[] = [
      { id: "a1", sourceId: "A" },
      { id: "b1", sourceId: "B" },
    ];
    const starts = exportSegmentStarts(
      {
        clips,
        sequenceSources: { A: source("A", "10000"), B: source("B", "5000") },
        sequenceSegments: [
          on("onB", "b1", "1000", "b1", "2000"),
          on("onA", "a1", "500", "a1", "900"),
          on("dormant", "c1", "0", "c1", "100"),
        ],
        browserDurations: {},
      },
      ["onB", "onA", "dormant", "missing"],
    );
    // B starts at 10 s, so its 1 s is 11 s on the sequence.
    expect(starts.get("onB")).toEqual({ n: 11n, d: 1n });
    expect(starts.get("onA")).toEqual({ n: 1n, d: 2n });
    expect(starts.get("dormant")).toBeNull();
    expect(starts.get("missing")).toBeNull();
  });

  it("knows no start when the layout of the sequence is not known", () => {
    const starts = exportSegmentStarts(
      {
        // Two clips, and the first has no extent: ADR 052 refuses that layout.
        clips: [
          { id: "a1", sourceId: "A" },
          { id: "b1", sourceId: "B" },
        ],
        sequenceSources: {
          A: { ...source("A", null), approximateDurationSeconds: null },
          B: source("B", "5000"),
        },
        sequenceSegments: [on("onB", "b1", "0", "b1", "1000")],
        browserDurations: {},
      },
      ["onB"],
    );
    expect(starts.get("onB")).toBeNull();
  });
});

describe("the rows", () => {
  const clips: Clip[] = [
    { id: "a1", sourceId: "A" },
    { id: "b1", sourceId: "B" },
  ];
  const sources = new Map(
    Object.entries({ A: source("A", "10000"), B: source("B", "5000") }),
  );
  const placedA: Segment = {
    id: "a",
    sourceId: "sequence:1",
    inPts: pts("1000"),
    outPts: pts("2000"),
    name: "Intro",
  };
  const placedB: Segment = {
    id: "b",
    sourceId: "sequence:1",
    inPts: pts("12000"),
    outPts: pts("13000"),
  };
  const facts = (display: TimecodeDisplay): ExportOrderRowFacts => ({
    placed: new Map([
      ["a", placedA],
      ["b", placedB],
    ]),
    anchored: new Map([
      ["a", on("a", "a1", "1000", "a1", "2000", "Intro")],
      ["b", on("b", "b1", "2000", "b1", "3000")],
      // `derive` could not place this one: it has no derived segment.
      ["cross", on("cross", "a1", "9000", "b1", "1000", "Cross")],
    ]),
    clips,
    sources,
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 1000 },
    display,
  });

  it("numbers the rows in the order of the draft, and follows each change of it", () => {
    const rows = buildExportOrderRows(["b", "a"], facts(frames25));
    expect(rows.map((row) => [row.id, row.number])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    const moved = buildExportOrderRows(
      moveExportOrderRow(["b", "a"], 0, 1),
      facts(frames25),
    );
    expect(moved.map((row) => [row.id, row.number])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("shows the times of a placed segment as its tooltip does", () => {
    for (const display of [frames25, MILLISECONDS_TIMECODE_DISPLAY]) {
      const [row] = buildExportOrderRows(["a"], facts(display));
      const times = formatSegmentTimes(placedA, pts("0"), { n: 1, d: 1000 }, display);
      expect(row).toEqual({
        id: "a",
        number: 1,
        name: "Intro",
        inTime: times?.inTime,
        outTime: times?.outTime,
        duration: times?.duration,
      });
    }
    const [row] = buildExportOrderRows(["a"], facts(frames25));
    expect(row?.inTime).toBe("00:00:01:00");
    expect(row?.duration).toBe("00:00:01:00");
  });

  it("shows no times for a segment with no place, and its duration from its pieces", () => {
    const [row] = buildExportOrderRows(["cross"], facts(frames25));
    // 1 s on A and 1 s on B.
    expect(row).toEqual({
      id: "cross",
      number: 1,
      name: "Cross",
      inTime: null,
      outTime: null,
      duration: "00:00:02:00",
    });
    const [unknown] = buildExportOrderRows(["gone"], facts(frames25));
    expect(unknown).toEqual({
      id: "gone",
      number: 1,
      name: undefined,
      inTime: null,
      outTime: null,
      duration: null,
    });
    // The dash is a mark and not a word.
    expect(EXPORT_ORDER_UNKNOWN_TIME).toBe("–");
  });

  it("shows the durations that the total of the summary adds", () => {
    const rows = buildExportOrderRows(["a", "cross", "b"], facts(frames25));
    expect(rows.map((row) => row.duration)).toEqual([
      "00:00:01:00",
      "00:00:02:00",
      "00:00:01:00",
    ]);
    // The same segments as the store holds them: the derived timeline places `a` and `b` only.
    const total = totalExportSegments(
      {
        clips,
        sequenceSources: Object.fromEntries(sources),
        sequenceSegments: [
          on("a", "a1", "1000", "a1", "2000", "Intro"),
          on("cross", "a1", "9000", "b1", "1000", "Cross"),
          on("b", "b1", "2000", "b1", "3000"),
        ],
        segments: [placedA, placedB],
        sourceId: "sequence:1",
      },
      { videoTimeBase: { n: 1, d: 1000 }, videoStartPts: pts("0") },
      frames25,
    );
    // 25 + 50 + 25 frames: the sum of the three rows.
    expect(total).toBe(100n);
    expect(formatSegmentTotal(total, frames25)).toBe("00:00:04:00");
  });

  it("names each row with its number, its name and its times", () => {
    const row = (overrides: Partial<ExportOrderRow>): ExportOrderRow => ({
      id: "a",
      number: 2,
      name: undefined,
      inTime: "00:00:01:00",
      outTime: "00:00:02:00",
      duration: "00:00:01:00",
      ...overrides,
    });
    expect(resolveExportOrderRowName(row({}))).toEqual({
      key: "timeline.segmentLabel",
      values: {
        index: 2,
        inTime: "00:00:01:00",
        outTime: "00:00:02:00",
        duration: "00:00:01:00",
      },
    });
    expect(resolveExportOrderRowName(row({ name: "Intro" }))).toEqual({
      key: "timeline.segmentLabelNamed",
      values: {
        index: 2,
        name: "Intro",
        inTime: "00:00:01:00",
        outTime: "00:00:02:00",
        duration: "00:00:01:00",
      },
    });
    expect(resolveExportOrderRowName(row({ inTime: null, outTime: null }))).toEqual({
      key: "timeline.exportOrder.rowDuration",
      values: { index: 2, duration: "00:00:01:00" },
    });
    expect(
      resolveExportOrderRowName(row({ inTime: null, outTime: null, name: "Intro" })),
    ).toEqual({
      key: "timeline.exportOrder.rowDurationNamed",
      values: { index: 2, name: "Intro", duration: "00:00:01:00" },
    });
    expect(
      resolveExportOrderRowName(row({ inTime: null, outTime: null, duration: null })),
    ).toEqual({ key: "timeline.segment", values: { index: 2 } });
  });

  it("has the catalog messages with the named placeholders in both languages", () => {
    for (const catalog of [en, zhCN]) {
      expect(placeholders(lookup(catalog, "timeline.exportOrder.rowDuration"))).toEqual(
        ["duration", "index"],
      );
      expect(
        placeholders(lookup(catalog, "timeline.exportOrder.rowDurationNamed")),
      ).toEqual(["duration", "index", "name"]);
      expect(placeholders(lookup(catalog, "timeline.exportOrder.moved"))).toEqual([
        "position",
        "total",
      ]);
      for (const key of [
        "title",
        "open",
        "description",
        "list",
        "moveHintMac",
        "moveHintWindows",
        "sort",
        "confirm",
        "changed",
      ]) {
        expect(typeof lookup(catalog, `timeline.exportOrder.${key}`)).toBe("string");
      }
    }
    expect(lookup(en, "timeline.exportOrder.title")).toBe("Export Order");
    expect(lookup(zhCN, "timeline.exportOrder.title")).toBe("导出顺序");
  });
});

describe("the announcement of a move", () => {
  it("names the new place from 1 and the number of rows", () => {
    expect(resolveExportOrderMoveMessage(0, 3)).toEqual({
      key: "timeline.exportOrder.moved",
      values: { position: 1, total: 3 },
    });
  });
});

describe("the keys of a focused row", () => {
  const press = (overrides: Partial<ExportOrderKeyPress>): ExportOrderKeyPress => ({
    key: "ArrowDown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 40,
    ...overrides,
  });

  it("moves the focus with Up, Down, Home and End and no modifier", () => {
    expect(resolveExportOrderKey(press({ key: "ArrowUp" }))).toEqual({
      kind: "focus",
      target: "previous",
    });
    expect(resolveExportOrderKey(press({ key: "ArrowDown" }))).toEqual({
      kind: "focus",
      target: "next",
    });
    expect(resolveExportOrderKey(press({ key: "Home" }))).toEqual({
      kind: "focus",
      target: "first",
    });
    expect(resolveExportOrderKey(press({ key: "End" }))).toEqual({
      kind: "focus",
      target: "last",
    });
  });

  it("moves the focused row with Alt and Up or Down, and no other modifier", () => {
    expect(resolveExportOrderKey(press({ key: "ArrowUp", altKey: true }))).toEqual({
      kind: "move",
      delta: -1,
    });
    expect(resolveExportOrderKey(press({ key: "ArrowDown", altKey: true }))).toEqual({
      kind: "move",
      delta: 1,
    });
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(
        resolveExportOrderKey(press({ key: "ArrowUp", altKey: true, ...extra })),
      ).toBeNull();
      expect(resolveExportOrderKey(press({ key: "ArrowUp", ...extra }))).toBeNull();
    }
    // Alt with Home or End is no key of the list.
    expect(resolveExportOrderKey(press({ key: "Home", altKey: true }))).toBeNull();
  });

  it("does nothing for Enter, Space, another key, or a key of the input method", () => {
    for (const key of ["Enter", " ", "Tab", "Escape", "a", "PageDown"]) {
      expect(resolveExportOrderKey(press({ key }))).toBeNull();
    }
    expect(resolveExportOrderKey(press({ isComposing: true }))).toBeNull();
    expect(resolveExportOrderKey(press({ keyCode: 229 }))).toBeNull();
  });

  it("stops the focus at the first and the last row", () => {
    expect(focusIndexAfter("previous", 0, 3)).toBe(0);
    expect(focusIndexAfter("previous", 2, 3)).toBe(1);
    expect(focusIndexAfter("next", 2, 3)).toBe(2);
    expect(focusIndexAfter("next", 0, 3)).toBe(1);
    expect(focusIndexAfter("first", 2, 3)).toBe(0);
    expect(focusIndexAfter("last", 0, 3)).toBe(2);
    expect(focusIndexAfter("next", 0, 0)).toBeNull();
  });
});

describe("the confirm", () => {
  const open = { isOpen: true, openCount: 4 };
  const input = (overrides: Partial<Parameters<typeof planExportOrderConfirm>[0]>) => ({
    draft: ["b", "a"],
    exportIds: ["a", "b"],
    dialog: open,
    openCount: 4,
    isTrimLocked: false,
    ...overrides,
  });

  it("applies a draft in a new order", () => {
    expect(planExportOrderConfirm(input({}))).toEqual({
      kind: "apply",
      ids: ["b", "a"],
    });
  });

  it("makes no edit for the order of the array, and closes", () => {
    expect(planExportOrderConfirm(input({ draft: ["a", "b"] }))).toEqual({
      kind: "close",
    });
  });

  it("acts only for the open that mounted the content", () => {
    expect(canRunExportOrderConfirm(open, 4)).toBe(true);
    // The dialog is closing: Escape came first.
    expect(
      planExportOrderConfirm(input({ dialog: { isOpen: false, openCount: 4 } })),
    ).toEqual({ kind: "ignore" });
    // A later open owns the store now.
    expect(
      planExportOrderConfirm(input({ dialog: { isOpen: true, openCount: 5 } })),
    ).toEqual({ kind: "ignore" });
  });

  it("refuses while a trim holds the edit lock", () => {
    expect(planExportOrderConfirm(input({ isTrimLocked: true }))).toEqual({
      kind: "refuse",
    });
  });
});

describe("the focus at the close", () => {
  /** A fake target that takes the focus unless it refuses it. */
  function target(name: string, log: string[], refuses = false): LandingFocusTarget {
    let focused = false;
    return {
      isConnected: true,
      isRendered: true,
      isDisabled: false,
      get hasFocus() {
        return focused;
      },
      focus: () => {
        log.push(name);
        focused = !refuses;
      },
    };
  }

  it("tries the opener, then the Export Order button, then the timeline", () => {
    const log: string[] = [];
    const landed = returnSegmentRenameFocus(target("opener", log, true), [
      target("summary", log),
      target("timeline", log),
    ]);
    expect(log).toEqual(["opener", "summary"]);
    expect(landed).not.toBeNull();
    expect(EXPORT_ORDER_TRIGGER_ATTRIBUTE).toBe("data-export-order-trigger");
  });
});
