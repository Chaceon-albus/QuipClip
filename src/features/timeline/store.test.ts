import { describe, expect, it } from "vitest";
import type { Pts } from "@/types/project";
import { createTimelineStore } from "./store";

const pts = (value: string) => value as Pts;

function createStore() {
  let nextId = 1;
  return createTimelineStore({ generateId: () => `segment-${nextId++}` });
}

describe("timeline store source ownership", () => {
  it("keeps stable source ID separate from the revision key", () => {
    const store = createStore();
    store.getState().setSource("source-1", "/clip.mov:10:20");
    expect(store.getState()).toMatchObject({
      sourceId: "source-1",
      sourceRevisionKey: "/clip.mov:10:20",
    });
  });

  it("preserves canonical edits and history when the source revision changes", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("-10"));
    store.getState().markOut(pts("20"));
    store.getState().markIn(pts("30"));
    store.getState().setSource("source-1", "revision-1");
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().pendingInPts).toBe("30");

    store.getState().setSource("source-1", "revision-2");
    expect(store.getState()).toMatchObject({
      sourceId: "source-1",
      sourceRevisionKey: "revision-2",
      segments: [
        expect.objectContaining({ sourceId: "source-1", inPts: "-10", outPts: "20" }),
      ],
      pendingInPts: null,
      canUndo: true,
      canRedo: false,
    });
    store.getState().undo();
    expect(store.getState().segments).toEqual([]);
  });

  it("preserves ordered segments and history when the active source changes", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("20"));
    store.getState().markIn(pts("30"));

    store.getState().setSource("source-2", "revision-2");
    expect(store.getState()).toMatchObject({
      sourceId: "source-2",
      sourceRevisionKey: "revision-2",
      pendingInPts: null,
      canUndo: true,
    });
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
    ]);

    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
      "source-2",
    ]);
    store.getState().undo();
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
    ]);
  });
});

describe("timeline store half-open editing", () => {
  it("stores Mark Out directly as the first excluded PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-40"));
    expect(store.getState().segments).toEqual([
      {
        id: "segment-1",
        sourceId: "source-1",
        inPts: pts("-100"),
        outPts: pts("-40"),
      },
    ]);
  });

  it("rejects equal and earlier Out points while preserving pending In", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("50"));
    store.getState().markOut(pts("50"));
    store.getState().markOut(pts("49"));
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().pendingInPts).toBe("50");
  });

  it("represents one frame with the following distinct PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("9001"));
    expect(store.getState().segments[0]).toMatchObject({
      inPts: "9000",
      outPts: "9001",
    });
  });

  it("preserves insertion order instead of sorting raw PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-50"));
    expect(store.getState().segments.map((segment) => segment.inPts)).toEqual([
      "100",
      "-100",
    ]);
  });

  it("splits at a strict interior PTS into adjacent half-open segments", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().split(pts("18"));
    expect(
      store.getState().segments.map(({ id, inPts, outPts }) => ({ id, inPts, outPts })),
    ).toEqual([
      { id: "segment-1", inPts: pts("10"), outPts: pts("18") },
      { id: "segment-2", inPts: pts("18"), outPts: pts("30") },
    ]);
  });

  it("splits only the active source and supports undo and redo", () => {
    const store = createTimelineStore(
      { generateId: () => "new" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
          { id: "b", sourceId: "source-2", inPts: pts("10"), outPts: pts("30") },
        ],
      },
    );
    store.getState().split(pts("20"));
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
      "source-1",
      "source-2",
    ]);
    store.getState().undo();
    expect(store.getState().segments).toHaveLength(2);
    store.getState().redo();
    expect(store.getState().segments).toHaveLength(3);
  });
});
