import { describe, expect, it } from "vitest";
import { TIMELINE_ZOOM_STEP_FACTOR } from "./viewport";
import {
  createTimelineViewportStore,
  timelineViewportStore,
  useTimelineViewportStore,
  type TimelineZoomAnchor,
} from "./viewportStore";

const POINT: TimelineZoomAnchor = {
  kind: "point",
  point: { ratio: 0.4, viewportOffsetPx: 300 },
};

describe("timeline viewport store", () => {
  it("starts at zoom 1 with a ceiling of 1 and no anchor", () => {
    const store = createTimelineViewportStore();
    expect(store.getState().zoom).toBe(1);
    expect(store.getState().maxZoom).toBe(1);
    expect(store.getState().anchor).toBeNull();
  });

  it("settles the initial state to the bounds", () => {
    expect(createTimelineViewportStore({ zoom: 20, maxZoom: 8 }).getState().zoom).toBe(
      8,
    );
    expect(createTimelineViewportStore({ zoom: 0.5, maxZoom: 8 }).getState().zoom).toBe(
      1,
    );
    expect(
      createTimelineViewportStore({ maxZoom: Number.NaN }).getState().maxZoom,
    ).toBe(1);
  });

  describe("zoomIn and zoomOut", () => {
    it("step by the step factor and anchor on the playhead or the centre by default", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomIn();
      expect(store.getState().zoom).toBe(TIMELINE_ZOOM_STEP_FACTOR);
      expect(store.getState().anchor).toEqual({ kind: "playheadOrCentre" });

      store.getState().takeAnchor();
      store.getState().zoomOut();
      expect(store.getState().zoom).toBe(1);
      expect(store.getState().anchor).toEqual({ kind: "playheadOrCentre" });
    });

    it("record the anchor they are given", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomIn(POINT);
      expect(store.getState().anchor).toBe(POINT);
    });

    it("stop at the limits, and a step at a limit records no anchor", () => {
      const store = createTimelineViewportStore({ maxZoom: 2 });
      store.getState().zoomOut();
      expect(store.getState().zoom).toBe(1);
      expect(store.getState().anchor).toBeNull();

      for (let i = 0; i < 10; i++) {
        store.getState().zoomIn();
      }
      expect(store.getState().zoom).toBe(2);
      store.getState().takeAnchor();
      store.getState().zoomIn();
      expect(store.getState().zoom).toBe(2);
      expect(store.getState().anchor).toBeNull();
    });

    it("do nothing on an indeterminate extent, whose ceiling is 1", () => {
      const store = createTimelineViewportStore();
      store.getState().zoomIn();
      expect(store.getState().zoom).toBe(1);
      expect(store.getState().anchor).toBeNull();
    });

    it("notify no listener for a step that changes nothing", () => {
      const store = createTimelineViewportStore({ maxZoom: 1 });
      let notifications = 0;
      const unsubscribe = store.subscribe(() => {
        notifications++;
      });
      store.getState().zoomIn();
      store.getState().zoomOut();
      store.getState().fit();
      store.getState().reset();
      unsubscribe();
      expect(notifications).toBe(0);
    });
  });

  describe("zoomBy", () => {
    it("multiplies the zoom and clamps it, for the wheel", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomBy(3, POINT);
      expect(store.getState().zoom).toBe(3);
      expect(store.getState().anchor).toBe(POINT);
      store.getState().zoomBy(10, POINT);
      expect(store.getState().zoom).toBe(8);
      store.getState().zoomBy(0.001, POINT);
      expect(store.getState().zoom).toBe(1);
    });

    it("reads the zoom that an earlier call advanced, before any render", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomBy(2, POINT);
      const second: TimelineZoomAnchor = {
        kind: "point",
        point: { ratio: 0.6, viewportOffsetPx: 500 },
      };
      store.getState().zoomBy(2, second);
      expect(store.getState().zoom).toBe(4);
      // The later anchor replaces the earlier one.
      expect(store.getState().anchor).toBe(second);
    });

    it("ignores a factor that is not a positive finite number", () => {
      const store = createTimelineViewportStore({ zoom: 2, maxZoom: 8 });
      for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        store.getState().zoomBy(factor, POINT);
        expect(store.getState().zoom).toBe(2);
        expect(store.getState().anchor).toBeNull();
      }
    });
  });

  describe("fit", () => {
    it("returns to zoom 1 and anchors on the start of the lane", () => {
      const store = createTimelineViewportStore({ zoom: 5, maxZoom: 8 });
      store.getState().fit();
      expect(store.getState().zoom).toBe(1);
      expect(store.getState().anchor).toEqual({ kind: "start" });
    });

    it("does nothing at zoom 1", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().fit();
      expect(store.getState().anchor).toBeNull();
    });
  });

  describe("setMaxZoom", () => {
    it("clamps the zoom to a smaller ceiling and keeps a pending anchor", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomBy(6, POINT);
      store.getState().setMaxZoom(4);
      expect(store.getState().maxZoom).toBe(4);
      expect(store.getState().zoom).toBe(4);
      expect(store.getState().anchor).toBe(POINT);
    });

    it("keeps the zoom under a larger ceiling", () => {
      const store = createTimelineViewportStore({ zoom: 3, maxZoom: 4 });
      store.getState().setMaxZoom(10);
      expect(store.getState().maxZoom).toBe(10);
      expect(store.getState().zoom).toBe(3);
    });

    it("takes a ceiling that is not usable as 1", () => {
      const store = createTimelineViewportStore({ zoom: 3, maxZoom: 4 });
      store.getState().setMaxZoom(Number.NaN);
      expect(store.getState().maxZoom).toBe(1);
      expect(store.getState().zoom).toBe(1);
      store.getState().setMaxZoom(0.5);
      expect(store.getState().maxZoom).toBe(1);
    });
  });

  describe("reset", () => {
    it("returns to zoom 1 with no anchor, for a new source", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomIn();
      store.getState().reset();
      expect(store.getState().zoom).toBe(1);
      expect(store.getState().anchor).toBeNull();
      // The ceiling belongs to the panel, which reports it again for the new extent.
      expect(store.getState().maxZoom).toBe(8);
    });
  });

  describe("takeAnchor", () => {
    it("returns the pending anchor once and clears it", () => {
      const store = createTimelineViewportStore({ maxZoom: 8 });
      store.getState().zoomIn(POINT);
      expect(store.getState().takeAnchor()).toBe(POINT);
      expect(store.getState().takeAnchor()).toBeNull();
      expect(store.getState().zoom).toBe(TIMELINE_ZOOM_STEP_FACTOR);
    });
  });

  it("keeps separate store instances independent", () => {
    const first = createTimelineViewportStore({ maxZoom: 8 });
    const second = createTimelineViewportStore({ maxZoom: 8 });
    first.getState().zoomIn();
    expect(second.getState().zoom).toBe(1);
  });

  it("provides the singleton store and its hook", () => {
    expect(timelineViewportStore.getState().zoom).toBe(1);
    expect(typeof timelineViewportStore.getState().zoomIn).toBe("function");
    expect(typeof useTimelineViewportStore).toBe("function");
  });
});
