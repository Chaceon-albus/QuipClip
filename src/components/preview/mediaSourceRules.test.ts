import { describe, expect, it } from "vitest";
import { MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED } from "./decodeFailure";
import {
  addMediaSourceNotice,
  dismissMediaSourceNotice,
  mediaSourceNoticesFor,
  mediaSourcePanelTrigger,
  NO_MEDIA_SOURCE_NOTICES,
  rescansAtAttach,
  resolveMediaSourceFailure,
  shownMediaSourceNotices,
  whenStoreReady,
} from "./mediaSourceRules";

describe("resolveMediaSourceFailure", () => {
  it("shows the panel for a missing FFmpeg, also after the source showed a frame", () => {
    expect(resolveMediaSourceFailure({ kind: "ffmpegMissing" }, true)).toEqual({
      stall: null,
      trigger: { kind: "ffmpegMissing" },
    });
  });

  it("stops the preview at a refused codec after a frame, and shows the panel before", () => {
    const failure = {
      kind: "codecRejected",
      type: 'video/mp4; codecs="avc1.64003d"',
    } as const;
    expect(resolveMediaSourceFailure(failure, true)).toEqual({
      stall: {},
      trigger: { kind: "codecRejected", detail: failure.type },
    });
    expect(resolveMediaSourceFailure(failure, false).stall).toBeNull();
  });

  it("stops the preview with the read message at a failed window after a frame", () => {
    const failure = {
      kind: "windowFailed",
      code: "readFailed",
      detail: "Operation timed out",
    } as const;
    expect(resolveMediaSourceFailure(failure, true)).toEqual({
      stall: { cause: "read" },
      trigger: { kind: "windowFailed", detail: "readFailed: Operation timed out" },
    });
    expect(
      resolveMediaSourceFailure(
        { kind: "windowFailed", code: "noFrames", detail: null },
        false,
      ),
    ).toEqual({ stall: null, trigger: { kind: "windowFailed", detail: "noFrames" } });
  });
});

describe("mediaSourcePanelTrigger", () => {
  it("names a refused source a refused codec, not a container", () => {
    expect(mediaSourcePanelTrigger(MEDIA_ERR_SRC_NOT_SUPPORTED)).toEqual({
      kind: "codecRejected",
    });
    expect(mediaSourcePanelTrigger(MEDIA_ERR_DECODE)).toEqual({
      kind: "mediaError",
      code: MEDIA_ERR_DECODE,
    });
    expect(mediaSourcePanelTrigger(null)).toEqual({ kind: "mediaError", code: null });
  });
});

describe("whenStoreReady", () => {
  function fakeStore(ready: boolean) {
    const listeners = new Set<(state: { isReady: boolean }) => void>();
    const state = { isReady: ready };
    return {
      getState: () => state,
      subscribe: (listener: (value: { isReady: boolean }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      becomeReady: (during?: () => void) => {
        state.isReady = true;
        for (const listener of [...listeners]) {
          listener(state);
        }
        during?.();
      },
      listenerCount: () => listeners.size,
    };
  }

  it("runs after the action that made the store ready has ended", async () => {
    const store = fakeStore(false);
    const order: string[] = [];
    whenStoreReady(store, () => order.push("gap seek"));
    store.becomeReady(() => order.push("rest of syncReady"));
    expect(order).toEqual(["rest of syncReady"]);
    await Promise.resolve();
    expect(order).toEqual(["rest of syncReady", "gap seek"]);
    expect(store.listenerCount()).toBe(0);
  });

  it("runs in a microtask when the store is ready now", async () => {
    const store = fakeStore(true);
    let runs = 0;
    whenStoreReady(store, () => runs++);
    expect(runs).toBe(0);
    await Promise.resolve();
    expect(runs).toBe(1);
  });

  it("does not run after a cancel, before or after the store became ready", async () => {
    const waiting = fakeStore(false);
    let runs = 0;
    whenStoreReady(waiting, () => runs++)();
    expect(waiting.listenerCount()).toBe(0);
    waiting.becomeReady();

    const queued = fakeStore(false);
    const cancel = whenStoreReady(queued, () => runs++);
    queued.becomeReady();
    cancel();
    await Promise.resolve();
    expect(runs).toBe(0);
  });
});

describe("the notices of a MediaSource source", () => {
  const decrease = "preview.mediaSource.timestampsDecrease" as const;
  const noSound = "preview.mediaSource.noSound" as const;

  it("shows each notice once for its source", () => {
    let notices = addMediaSourceNotice(NO_MEDIA_SOURCE_NOTICES, "a", decrease);
    notices = addMediaSourceNotice(notices, "a", decrease);
    notices = addMediaSourceNotice(notices, "a", noSound);
    expect(shownMediaSourceNotices(notices, "a")).toEqual([decrease, noSound]);
    expect(shownMediaSourceNotices(notices, "b")).toEqual([]);
  });

  it("does not show a dismissed notice again for the same source", () => {
    let notices = addMediaSourceNotice(NO_MEDIA_SOURCE_NOTICES, "a", decrease);
    notices = dismissMediaSourceNotice(notices, decrease);
    expect(shownMediaSourceNotices(notices, "a")).toEqual([]);
    // The element of a reload reports again.
    notices = addMediaSourceNotice(notices, "a", decrease);
    expect(shownMediaSourceNotices(notices, "a")).toEqual([]);
    // Another source starts again.
    notices = addMediaSourceNotice(notices, "b", decrease);
    expect(shownMediaSourceNotices(notices, "b")).toEqual([decrease]);
  });

  it("keeps the notices for a new import of the open file, and drops them for another", () => {
    const notices = addMediaSourceNotice(NO_MEDIA_SOURCE_NOTICES, "a", noSound);
    expect(mediaSourceNoticesFor(notices, "a")).toBe(notices);
    expect(shownMediaSourceNotices(mediaSourceNoticesFor(notices, "b"), "b")).toEqual(
      [],
    );
  });

  it("ignores the dismissal of a notice that does not show", () => {
    expect(dismissMediaSourceNotice(NO_MEDIA_SOURCE_NOTICES, noSound)).toBe(
      NO_MEDIA_SOURCE_NOTICES,
    );
  });
});

describe("rescansAtAttach", () => {
  it("scans only for the element of the reload that the stall asked for", () => {
    const generations = new Map([["a", 3]]);
    expect(rescansAtAttach(generations, "a", 3)).toBe(true);
    expect(rescansAtAttach(generations, "a", 2)).toBe(false);
    expect(rescansAtAttach(generations, "a", 4)).toBe(false);
    expect(rescansAtAttach(generations, "b", 3)).toBe(false);
  });
});
