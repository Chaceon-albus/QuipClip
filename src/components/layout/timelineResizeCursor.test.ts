import { describe, expect, it } from "vitest";
import {
  RESIZING_TIMELINE_ATTRIBUTE,
  createTimelineResizeCursor,
  holdTimelineResizeCursor,
  type TimelineResizeCursorRoot,
} from "./timelineResizeCursor";

interface FakeRoot extends TimelineResizeCursorRoot {
  readonly attributes: Map<string, string>;
  readonly writes: string[];
}

function createFakeRoot(): FakeRoot {
  const attributes = new Map<string, string>();
  const writes: string[] = [];
  return {
    attributes,
    writes,
    setAttribute(name, value) {
      attributes.set(name, value);
      writes.push(`set ${name}`);
    },
    removeAttribute(name) {
      attributes.delete(name);
      writes.push(`remove ${name}`);
    },
  };
}

describe("timelineResizeCursor", () => {
  it("names the attribute that the cursor rule in globals.css reads", () => {
    expect(RESIZING_TIMELINE_ATTRIBUTE).toBe("data-resizing-timeline");
  });

  it("sets the attribute for a hold and removes it on the release", () => {
    const root = createFakeRoot();
    const hold = createTimelineResizeCursor(() => root);

    const release = hold();
    expect(root.attributes.get(RESIZING_TIMELINE_ATTRIBUTE)).toBe("");

    release();
    expect(root.attributes.has(RESIZING_TIMELINE_ATTRIBUTE)).toBe(false);
    expect(root.writes).toEqual([
      `set ${RESIZING_TIMELINE_ATTRIBUTE}`,
      `remove ${RESIZING_TIMELINE_ATTRIBUTE}`,
    ]);
  });

  it("keeps the attribute until the last of several holds ends", () => {
    const root = createFakeRoot();
    const hold = createTimelineResizeCursor(() => root);

    const first = hold();
    const second = hold();
    first();
    expect(root.attributes.has(RESIZING_TIMELINE_ATTRIBUTE)).toBe(true);

    second();
    expect(root.attributes.has(RESIZING_TIMELINE_ATTRIBUTE)).toBe(false);
    expect(root.writes).toEqual([
      `set ${RESIZING_TIMELINE_ATTRIBUTE}`,
      `remove ${RESIZING_TIMELINE_ATTRIBUTE}`,
    ]);
  });

  it("ignores a second call of the same release", () => {
    const root = createFakeRoot();
    const hold = createTimelineResizeCursor(() => root);

    const first = hold();
    const second = hold();
    first();
    first();
    expect(root.attributes.has(RESIZING_TIMELINE_ATTRIBUTE)).toBe(true);

    second();
    expect(root.attributes.has(RESIZING_TIMELINE_ATTRIBUTE)).toBe(false);
  });

  it("does nothing with a null root", () => {
    const hold = createTimelineResizeCursor(() => null);
    const release = hold();
    expect(() => release()).not.toThrow();
  });

  it("does nothing outside a document", () => {
    const release = holdTimelineResizeCursor();
    expect(() => release()).not.toThrow();
  });
});
