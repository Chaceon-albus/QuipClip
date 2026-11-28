import { describe, expect, it } from "vitest";
import { dispatchEndedEvent, dispatchPauseEvent } from "./pauseEndedEvents";

/** Pause consumers that record their calls in order, with the value that `notePause` gets. */
function recordPause() {
  const calls: string[] = [];
  return {
    calls,
    consumers: {
      notePause: (atEnd: boolean) => {
        calls.push(`notePause(${String(atEnd)})`);
      },
      syncPause: () => {
        calls.push("syncPause");
      },
    },
  };
}

describe("dispatchPauseEvent (ADR 074)", () => {
  it("notes a pause at the end for an element at its end, before the store syncs it", () => {
    const r = recordPause();
    dispatchPauseEvent({ ended: true, seeking: false }, r.consumers);
    expect(r.calls).toEqual(["notePause(true)", "syncPause"]);
  });

  it("notes no pause at the end for an element that reports its end during a seek", () => {
    // The scrub of the system in WebKit: the element reports `ended` from the target of the seek.
    const r = recordPause();
    dispatchPauseEvent({ ended: true, seeking: true }, r.consumers);
    expect(r.calls).toEqual(["notePause(false)", "syncPause"]);
  });

  it("notes no pause at the end for an element paused away from its end", () => {
    const r = recordPause();
    dispatchPauseEvent({ ended: false, seeking: false }, r.consumers);
    expect(r.calls).toEqual(["notePause(false)", "syncPause"]);
  });
});

/** Consumers that record their calls in order, with the answer of `handleEnded`. */
function record(goesOn: boolean) {
  const calls: string[] = [];
  return {
    calls,
    consumers: {
      handleEnded: () => {
        calls.push("handleEnded");
        return goesOn;
      },
      syncEnded: () => {
        calls.push("syncEnded");
      },
      dropEnded: () => {
        calls.push("dropEnded");
      },
    },
  };
}

describe("dispatchEndedEvent (ADR 074)", () => {
  it("passes the event of an element at its end to the sequence and then to the store", () => {
    const r = record(false);
    dispatchEndedEvent({ ended: true, seeking: false }, r.consumers);
    expect(r.calls).toEqual(["handleEnded", "syncEnded"]);
  });

  it("passes the event to the sequence alone when the sequence goes on at the next clip", () => {
    const r = record(true);
    dispatchEndedEvent({ ended: true }, r.consumers);
    expect(r.calls).toEqual(["handleEnded"]);
  });

  it("drops the event of an element that a seek moved away from its end", () => {
    const r = record(true);
    dispatchEndedEvent({ ended: false, seeking: true }, r.consumers);
    expect(r.calls).toEqual(["dropEnded"]);
  });

  it("drops the event of an element that reports no end", () => {
    const r = record(true);
    dispatchEndedEvent({}, r.consumers);
    expect(r.calls).toEqual(["dropEnded"]);
  });

  it("drops the event of an element that reports its end during a seek", () => {
    // The scrub of the system in WebKit: the element reports `ended` from the target of the seek.
    const r = record(true);
    dispatchEndedEvent({ ended: true, seeking: true }, r.consumers);
    expect(r.calls).toEqual(["dropEnded"]);
  });
});
