import { describe, expect, it, vi } from "vitest";
import {
  createMenuDialogHandoff,
  stepMenuDialogHandoff,
  type MenuDialogHandoffState,
} from "./menuDialogHandoff";

type Action = "rename" | "other";

const WAITING: MenuDialogHandoffState<Action> = { kind: "waiting" };

describe("stepMenuDialogHandoff (ADR 065)", () => {
  it("runs the choice when the menu ends after it", () => {
    const chosen = stepMenuDialogHandoff(WAITING, { kind: "choose", action: "rename" });
    expect(chosen).toStrictEqual({
      state: { kind: "chosen", action: "rename" },
      run: null,
    });
    expect(stepMenuDialogHandoff(chosen.state, { kind: "close" })).toStrictEqual({
      state: { kind: "done" },
      run: "rename",
    });
  });

  it("runs the choice when it arrives after the end of the menu", () => {
    const closed = stepMenuDialogHandoff(WAITING, { kind: "close" });
    expect(closed).toStrictEqual({ state: { kind: "closed" }, run: null });
    expect(
      stepMenuDialogHandoff(closed.state, { kind: "choose", action: "rename" }),
    ).toStrictEqual({ state: { kind: "done" }, run: "rename" });
  });

  it("ignores a second choice and a second end", () => {
    const chosen: MenuDialogHandoffState<Action> = { kind: "chosen", action: "rename" };
    expect(
      stepMenuDialogHandoff(chosen, { kind: "choose", action: "other" }),
    ).toStrictEqual({ state: chosen, run: null });
    const closed: MenuDialogHandoffState<Action> = { kind: "closed" };
    expect(stepMenuDialogHandoff(closed, { kind: "close" })).toStrictEqual({
      state: closed,
      run: null,
    });
    const done: MenuDialogHandoffState<Action> = { kind: "done" };
    expect(stepMenuDialogHandoff(done, { kind: "close" }).run).toBeNull();
    expect(
      stepMenuDialogHandoff(done, { kind: "choose", action: "rename" }).run,
    ).toBeNull();
  });
});

describe("createMenuDialogHandoff", () => {
  it("runs once, in both orders", () => {
    const run = vi.fn<(action: Action) => void>();
    const first = createMenuDialogHandoff(run);
    first.choose("rename");
    expect(run).not.toHaveBeenCalled();
    first.close();
    first.close();
    expect(run).toHaveBeenCalledExactlyOnceWith("rename");

    run.mockClear();
    const second = createMenuDialogHandoff(run);
    second.close();
    expect(run).not.toHaveBeenCalled();
    second.choose("rename");
    second.choose("other");
    expect(run).toHaveBeenCalledExactlyOnceWith("rename");
  });

  it("runs nothing for a menu that ends with no choice", () => {
    const run = vi.fn<(action: Action) => void>();
    createMenuDialogHandoff(run).close();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the cancel and the timer of a hand-off", () => {
  /** A manual timer: the test runs or reads the pending callbacks. */
  function manualTimer() {
    const pending: { callback: () => void; delayMs: number; stopped: boolean }[] = [];
    const schedule = (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, stopped: false };
      pending.push(entry);
      return () => {
        entry.stopped = true;
      };
    };
    const fire = () => {
      for (const entry of [...pending]) {
        if (!entry.stopped) {
          entry.stopped = true;
          entry.callback();
        }
      }
    };
    const live = () => pending.filter((entry) => !entry.stopped);
    return { schedule, fire, live };
  }

  it("ends nothing of a cancelled hand-off, in any state", () => {
    expect(stepMenuDialogHandoff(WAITING, { kind: "cancel" })).toStrictEqual({
      state: { kind: "done" },
      run: null,
    });
    const run = vi.fn<(action: Action) => void>();
    const chosen = createMenuDialogHandoff(run);
    chosen.choose("rename");
    chosen.cancel();
    chosen.close();
    const closed = createMenuDialogHandoff(run);
    closed.close();
    closed.cancel();
    closed.choose("rename");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the choice once when the end of the menu does not arrive in time", () => {
    const timer = manualTimer();
    const run = vi.fn<(action: Action) => void>();
    const onExpire = vi.fn();
    const handoff = createMenuDialogHandoff(run, {
      schedule: timer.schedule,
      delayMs: 1_000,
      onExpire,
    });
    handoff.choose("rename");
    expect(timer.live()).toHaveLength(1);
    expect(timer.live()[0]?.delayMs).toBe(1_000);
    expect(run).not.toHaveBeenCalled();
    timer.fire();
    expect(onExpire).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledExactlyOnceWith("rename");
    // A popup reply after the timer changes nothing.
    handoff.close();
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops the timer at the end of the menu, and at a cancel", () => {
    const timer = manualTimer();
    const run = vi.fn<(action: Action) => void>();
    const ended = createMenuDialogHandoff(run, {
      schedule: timer.schedule,
      delayMs: 1,
    });
    ended.choose("rename");
    ended.close();
    expect(run).toHaveBeenCalledOnce();
    expect(timer.live()).toHaveLength(0);

    const cancelled = createMenuDialogHandoff(run, {
      schedule: timer.schedule,
      delayMs: 1,
    });
    cancelled.choose("rename");
    expect(timer.live()).toHaveLength(1);
    cancelled.cancel();
    expect(timer.live()).toHaveLength(0);
    timer.fire();
    expect(run).toHaveBeenCalledOnce();
  });

  it("starts no timer for a choice after the end of the menu, which runs at once", () => {
    const timer = manualTimer();
    const run = vi.fn<(action: Action) => void>();
    const handoff = createMenuDialogHandoff(run, {
      schedule: timer.schedule,
      delayMs: 1,
    });
    handoff.close();
    handoff.choose("rename");
    expect(run).toHaveBeenCalledOnce();
    expect(timer.live()).toHaveLength(0);
  });
});
