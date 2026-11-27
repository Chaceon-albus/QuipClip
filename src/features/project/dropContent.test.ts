import { describe, expect, it, vi } from "vitest";
import { createAudioOverrideStore } from "@/features/media/audioOverrideStore";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { Pts, TickCount } from "@/types/project";
import { projectContentOf } from "./document";
import {
  confirmDropContent,
  hasChangesToSaveNow,
  type DropContentAnswer,
} from "./dropContent";
import { flush, held } from "./projectTestSupport";
import type { ProjectSaveResult } from "./saveStep";
import { createProjectStore } from "./store";

/** A fake save step, a fake prompt and a fake test of the changes. */
function harness(answers: DropContentAnswer[], changes: boolean[]) {
  const calls: string[] = [];
  const saves: ProjectSaveResult[] = [];
  const saveStep = {
    save: vi.fn(() => {
      calls.push("save");
      return Promise.resolve(
        saves.shift() ?? ({ status: "saved", path: "/p.qcproj", bound: true } as const),
      );
    }),
    whenIdle: vi.fn(() => {
      calls.push("whenIdle");
      return Promise.resolve();
    }),
  };
  const ask = vi.fn(() => {
    calls.push("ask");
    return Promise.resolve(answers.shift() ?? "cancel");
  });
  const hasChangesToSave = vi.fn(() => {
    calls.push("test");
    return changes.shift() ?? false;
  });
  return { calls, saves, saveStep, ask, hasChangesToSave };
}

describe("confirmDropContent", () => {
  it("continues with no changes to save, and asks nothing", async () => {
    const h = harness([], [false]);
    await expect(confirmDropContent(h)).resolves.toEqual({ kind: "continue" });
    expect(h.calls).toEqual(["whenIdle", "test"]);
  });

  it("continues after Don't Save, and stops after Cancel", async () => {
    const dontSave = harness(["dontSave"], [true]);
    await expect(confirmDropContent(dontSave)).resolves.toEqual({ kind: "continue" });
    expect(dontSave.saveStep.save).not.toHaveBeenCalled();
    const cancel = harness(["cancel"], [true]);
    await expect(confirmDropContent(cancel)).resolves.toEqual({
      kind: "stop",
      saveError: null,
    });
    expect(cancel.saveStep.save).not.toHaveBeenCalled();
  });

  it("saves, tests again, and continues when no changes are left", async () => {
    const h = harness(["save"], [true, false]);
    await expect(confirmDropContent(h)).resolves.toEqual({ kind: "continue" });
    expect(h.calls).toEqual(["whenIdle", "test", "ask", "save", "whenIdle", "test"]);
    expect(h.saveStep.save).toHaveBeenCalledWith("save");
  });

  it("asks again while a save left changes", async () => {
    const h = harness(["save", "save", "dontSave"], [true, true, true]);
    await expect(confirmDropContent(h)).resolves.toEqual({ kind: "continue" });
    expect(h.ask).toHaveBeenCalledTimes(3);
    expect(h.saveStep.save).toHaveBeenCalledTimes(2);
  });

  it("stops after a canceled save dialog, and after a failed save with its error", async () => {
    const canceled = harness(["save"], [true]);
    canceled.saves.push({ status: "canceled" });
    await expect(confirmDropContent(canceled)).resolves.toEqual({
      kind: "stop",
      saveError: null,
    });
    const failed = harness(["save"], [true]);
    failed.saves.push({ status: "failed", error: { kind: "noClip" } });
    await expect(confirmDropContent(failed)).resolves.toEqual({
      kind: "stop",
      saveError: { kind: "noClip" },
    });
  });

  it("waits for the save step that runs before it tests", async () => {
    const h = harness([], [false]);
    const running = held<void>();
    h.saveStep.whenIdle.mockReturnValueOnce(running.promise);
    const result = confirmDropContent(h);
    await flush();
    expect(h.hasChangesToSave).not.toHaveBeenCalled();
    running.resolve();
    await expect(result).resolves.toEqual({ kind: "continue" });
  });
});

describe("hasChangesToSaveNow", () => {
  it("reads the project, the content and the live segments", () => {
    const timeline = createTimelineStore();
    const audioOverrides = createAudioOverrideStore();
    const project = createProjectStore({ sequenceHasClips: () => true });
    const stores = { timeline, audioOverrides, project };
    expect(hasChangesToSaveNow(stores)).toBe(false);
    const source: SequenceSource = {
      id: "a",
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0" as Pts,
      videoEndPts: "10000" as Pts,
      videoDurationTicks: "10000" as TickCount,
      approximateDurationSeconds: 10,
    };
    timeline.getState().loadSequence(
      [{ id: "c1", sourceId: "a" }],
      [source],
      [
        {
          id: "s1",
          inClipId: "c1",
          inPts: "0" as Pts,
          outClipId: "c1",
          outPts: "5" as Pts,
        },
      ],
    );
    // No file and a segment.
    expect(hasChangesToSaveNow(stores)).toBe(true);
    project.getState().completeOpen({
      file: { path: "/p.qcproj", name: "p.qcproj" },
      savedContent: projectContentOf(timeline.getState(), {}),
      located: false,
    });
    expect(hasChangesToSaveNow(stores)).toBe(false);
    timeline.getState().renameSegment("s1", "Changed");
    expect(hasChangesToSaveNow(stores)).toBe(true);
  });
});

describe("confirmDropContent and a cancel", () => {
  it("starts no save for an answer that comes after a cancel", async () => {
    const h = harness([], [true]);
    const answer = held<DropContentAnswer>();
    h.ask.mockReturnValueOnce(answer.promise);
    let canceled = false;
    const result = confirmDropContent({ ...h, isCanceled: () => canceled });
    await flush();
    canceled = true;
    answer.resolve("save");
    await expect(result).resolves.toEqual({ kind: "stop", saveError: null });
    expect(h.saveStep.save).not.toHaveBeenCalled();
  });

  it("does not ask when the action was canceled before", async () => {
    const h = harness(["save"], [true]);
    await expect(confirmDropContent({ ...h, isCanceled: () => true })).resolves.toEqual(
      {
        kind: "stop",
        saveError: null,
      },
    );
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.saveStep.save).not.toHaveBeenCalled();
  });
});
