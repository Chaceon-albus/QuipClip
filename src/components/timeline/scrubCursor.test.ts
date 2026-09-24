import { describe, expect, it } from "vitest";
import {
  createScrubCursor,
  SCRUBBING_ATTRIBUTE,
  type ScrubCursorRoot,
} from "./scrubCursor";

interface FakeRoot extends ScrubCursorRoot {
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

describe("scrubCursor", () => {
  it("names the attribute that the cursor rule in globals.css reads", () => {
    expect(SCRUBBING_ATTRIBUTE).toBe("data-scrubbing");
  });

  it("sets the attribute for a hold and removes it on the release", () => {
    const root = createFakeRoot();
    const hold = createScrubCursor(() => root);

    const release = hold();
    expect(root.attributes.get(SCRUBBING_ATTRIBUTE)).toBe("");

    release();
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(false);
    expect(root.writes).toEqual([
      `set ${SCRUBBING_ATTRIBUTE}`,
      `remove ${SCRUBBING_ATTRIBUTE}`,
    ]);
  });

  it("keeps the attribute until the last of several holds ends", () => {
    const root = createFakeRoot();
    const hold = createScrubCursor(() => root);

    const first = hold();
    const second = hold();
    first();
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(true);

    second();
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(false);
    // One write at the first hold and one at the last release.
    expect(root.writes).toHaveLength(2);
  });

  it("ignores a release that already ran", () => {
    const root = createFakeRoot();
    const hold = createScrubCursor(() => root);

    const first = hold();
    const second = hold();
    first();
    first();
    // The repeated release did not end the second hold.
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(true);

    second();
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(false);

    second();
    expect(root.writes).toHaveLength(2);
  });

  it("starts again after every hold ended", () => {
    const root = createFakeRoot();
    const hold = createScrubCursor(() => root);

    hold()();
    const release = hold();
    expect(root.attributes.has(SCRUBBING_ATTRIBUTE)).toBe(true);
    release();
    expect(root.writes).toEqual([
      `set ${SCRUBBING_ATTRIBUTE}`,
      `remove ${SCRUBBING_ATTRIBUTE}`,
      `set ${SCRUBBING_ATTRIBUTE}`,
      `remove ${SCRUBBING_ATTRIBUTE}`,
    ]);
  });

  it("does nothing without a root", () => {
    const hold = createScrubCursor(() => null);

    // No document, as in a test run in node: the hold and the release do not throw.
    const release = hold();
    expect(() => {
      release();
    }).not.toThrow();
  });
});
