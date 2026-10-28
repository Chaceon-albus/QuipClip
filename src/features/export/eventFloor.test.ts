import { describe, expect, it } from "vitest";
import { createExportEventFloor } from "./eventFloor";

describe("export event floor", () => {
  it("admits every event before a restore", () => {
    const floor = createExportEventFloor();
    expect(floor.value()).toBe(0);
    expect(floor.admits({ seq: 1, event: "preparing", runId: "a" })).toBe(true);
  });

  it("drops each event at or below the floor and keeps an event without a number", () => {
    const floor = createExportEventFloor();
    floor.raise(10);
    expect(floor.admits({ seq: 9, event: "preparing", runId: "a" })).toBe(false);
    expect(floor.admits({ seq: 10, event: "preparing", runId: "a" })).toBe(false);
    expect(floor.admits({ seq: 11, event: "preparing", runId: "a" })).toBe(true);
    expect(floor.admits({ event: "preparing", runId: "a" })).toBe(true);
  });

  it("only goes up", () => {
    const floor = createExportEventFloor();
    floor.raise(10);
    floor.raise(4);
    expect(floor.value()).toBe(10);
  });
});
