import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioOverrideStore } from "@/features/media/audioOverrideStore";
import { createMediaStore } from "@/features/media/store";
import type { ImportMediaResult } from "@/features/media/types";
import { projectContentOf } from "@/features/project/document";
import { flush, held, mediaAt, type Held } from "@/features/project/projectTestSupport";
import {
  createProjectStore,
  installProjectSequenceRule,
} from "@/features/project/store";
import { ProjectCommandError } from "@/features/project/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { Pts } from "@/types/project";
import {
  createRecoveryController,
  createRecoveryStateReader,
  type RecoveryClients,
} from "./controller";
import {
  RecoveryCommandError,
  type RecoveryChangeResult,
  type RecoveryDiscardResult,
  type RecoveryListResult,
  type RecoveryOfferSummary,
  type RecoveryReadResult,
  type RecoveryWork,
} from "./types";

const pts = (value: string) => value as Pts;

const CLIP = mediaAt("/media/clip.mp4");
const FILE = { path: "/projects/cut.qcproj", name: "cut.qcproj" };

function sequenceSourceOf(id: string, media: ImportMediaResult): SequenceSource {
  return {
    id,
    videoTimeBase: media.probe.videoTimeBase,
    videoStartPts: media.probe.videoStartPts,
    videoEndPts: media.probe.videoEndPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
  };
}

const WRITTEN: RecoveryChangeResult = {
  owner: true,
  status: "done",
  current: "written",
};
const CLEARED: RecoveryChangeResult = {
  owner: true,
  status: "done",
  current: "nothing",
};
const FAILED: RecoveryChangeResult = {
  owner: true,
  status: "failed",
  current: "notKnown",
  error: new RecoveryCommandError({ code: "writeFailed" }),
};
const NOT_OWNER: RecoveryChangeResult = {
  owner: false,
  status: "notOwner",
  current: "notKnown",
};
const STALE_CHANGE: RecoveryChangeResult = {
  owner: false,
  status: "staleSession",
  current: "notKnown",
};

function refusedAnswer(current: "nothing" | "notKnown"): RecoveryChangeResult {
  return {
    owner: true,
    status: "refused",
    current,
    error: new RecoveryCommandError({
      code: "documentRefused",
      project: new ProjectCommandError({ code: "tooLarge" }),
    }),
  };
}

const COMPLETE: RecoveryListResult = {
  owner: true,
  status: "done",
  complete: true,
  offers: [],
};

function offer(id: string, writtenAtMs: number): RecoveryOfferSummary {
  return { id: id.padStart(16, "0"), writtenAtMs, projectPath: null };
}

function partial(offers: RecoveryOfferSummary[]): RecoveryListResult {
  return {
    owner: true,
    status: "failed",
    complete: false,
    offers,
    error: new RecoveryCommandError({ code: "readFailed" }),
  };
}

/** A scripted answer: a value, a held promise, or an error to reject with. */
type Scripted<T> = T | Held<T> | { readonly reject: Error };

function isHeld<T>(value: unknown): value is Held<T> {
  return typeof value === "object" && value !== null && "promise" in value;
}

function answerOf<T>(script: Scripted<T>[], fallback: T): Promise<T> {
  const next = script.shift();
  if (next === undefined) {
    return Promise.resolve(fallback);
  }
  if (isHeld<T>(next)) {
    return next.promise;
  }
  if (typeof next === "object" && next !== null && "reject" in next) {
    return Promise.reject((next as { reject: Error }).reject);
  }
  return Promise.resolve(next as T);
}

interface HarnessOptions {
  readonly start?: "fail";
}

/** A session with the source `a`, the stores, fake clients, and a controller over them. */
function harness(options: HarnessOptions = {}) {
  let next = 0;
  const timeline = createTimelineStore({ generateId: () => `g-${++next}` });
  const media = createMediaStore(
    {},
    { sources: { a: CLIP }, media: CLIP, status: "ready" },
  );
  const audioOverrides = createAudioOverrideStore();
  const project = createProjectStore({
    sequenceHasClips: () => timeline.getState().clips.length > 0,
  });
  installProjectSequenceRule(project, timeline);

  /** Each command that a client received, in order. */
  const log: string[] = [];
  const script = {
    write: [] as Scripted<RecoveryChangeResult>[],
    clear: [] as Scripted<RecoveryChangeResult>[],
    finish: [] as Scripted<RecoveryChangeResult>[],
    list: [] as Scripted<RecoveryListResult>[],
    read: [] as Scripted<RecoveryReadResult>[],
    discard: [] as Scripted<RecoveryDiscardResult>[],
  };
  const clients = {
    startRecovery: vi.fn(() => {
      log.push("start");
      return options.start === "fail"
        ? Promise.reject(new RecoveryCommandError({ code: "unknown" }))
        : Promise.resolve({ token: "7" });
    }),
    listRecoveryOffers: vi.fn((token: string) => {
      log.push(`list ${token}`);
      return answerOf(script.list, COMPLETE);
    }),
    writeRecovery: vi.fn((_token: string, work: RecoveryWork) => {
      log.push(`write ${work.projectPath ?? "null"}`);
      return answerOf(script.write, WRITTEN);
    }),
    clearRecovery: vi.fn((_token: string) => {
      log.push("clear");
      return answerOf(script.clear, CLEARED);
    }),
    readRecovery: vi.fn((_token: string, id: string) => {
      log.push(`read ${id}`);
      return answerOf<RecoveryReadResult>(script.read, {
        owner: true,
        status: "failed",
        error: new RecoveryCommandError({ code: "offerNotFound" }),
      });
    }),
    discardRecovery: vi.fn((_token: string, id: string) => {
      log.push(`discard ${id}`);
      return answerOf<RecoveryDiscardResult>(script.discard, {
        owner: true,
        status: "done",
      });
    }),
    finishRestore: vi.fn((_token: string, id: string, state: RecoveryWork | null) => {
      log.push(`finish ${id} ${state === null ? "null" : "work"}`);
      return answerOf(script.finish, state === null ? CLEARED : WRITTEN);
    }),
  } satisfies RecoveryClients;

  const controller = createRecoveryController({
    clients,
    timeline,
    media,
    audioOverrides,
    project,
  });

  const content = () =>
    projectContentOf(timeline.getState(), audioOverrides.getState().overrides);

  /** One clip of `a` with one segment: work to recover for a project with no file. */
  const markWork = (): void => {
    timeline
      .getState()
      .insertClips(
        timeline.getState().clips.length,
        [{ id: `c-${++next}`, sourceId: "a" }],
        [sequenceSourceOf("a", CLIP)],
      );
    timeline.getState().setAttachedClip(timeline.getState().clips[0]?.id ?? null);
    timeline.getState().markIn(pts("1000"));
    timeline.getState().markOut(pts("2000"));
  };

  /** Renames the first segment: a new content. */
  const rename = (name: string): void => {
    const segment = timeline.getState().sequenceSegments[0];
    timeline.getState().renameSegment(segment.id, name);
  };

  /** Saves the session into FILE, as a save step does when its write succeeded. */
  const save = (): void => {
    project.getState().completeSave({
      file: FILE,
      savedContent: content(),
      identity: project.getState().identity,
    });
  };

  /** Adds a clip of `b`, a source of which the media store has no import. */
  const addUnsavableClip = (): void => {
    timeline
      .getState()
      .insertClips(
        timeline.getState().clips.length,
        [{ id: "bad", sourceId: "b" }],
        [sequenceSourceOf("b", CLIP)],
      );
  };

  /** Starts the controller, and lets the list of the start answer. */
  const started = async (): Promise<void> => {
    await controller.start();
    await flush();
  };

  /** The names of the sent commands, with no start and no list. */
  const changes = () => log.filter((entry) => !/^(start|list)/.test(entry));

  return {
    timeline,
    media,
    audioOverrides,
    project,
    clients,
    script,
    log,
    controller,
    content,
    markWork,
    rename,
    save,
    addUnsavableClip,
    started,
    changes,
  };
}

/** The segment names of the document of the last write. */
function lastWrittenNames(h: ReturnType<typeof harness>): (string | undefined)[] {
  const calls = h.clients.writeRecovery.mock.calls;
  const call = calls[calls.length - 1];
  return call === undefined
    ? []
    : call[1].project.segments.map((segment) => segment.name);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the start of the recovery controller", () => {
  it("calls start_recovery one time, keeps the token, and lists the offers", async () => {
    const h = harness();
    expect(h.controller.token()).toBeNull();
    const first = h.controller.start();
    const second = h.controller.start();
    expect(second).toBe(first);
    await h.started();
    expect(h.clients.startRecovery).toHaveBeenCalledTimes(1);
    expect(h.controller.token()).toBe("7");
    expect(h.log).toEqual(["start", "list 7"]);
  });

  it("sends no command after a start that failed", async () => {
    const h = harness({ start: "fail" });
    await expect(h.controller.start()).resolves.toBeUndefined();
    expect(h.controller.token()).toBeNull();
    h.markWork();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toBeNull();
    await expect(h.controller.discard("0000000000000001")).resolves.toEqual({
      owner: false,
      status: "staleSession",
    });
    await expect(h.controller.readOffer("0000000000000001")).resolves.toEqual({
      owner: false,
      status: "staleSession",
    });
    expect(h.log).toEqual(["start"]);
    await expect(h.controller.whenLineEmpty(100)).resolves.toBe(true);
  });

  it("follows the work that came before the answer of start_recovery", async () => {
    const h = harness();
    h.markWork();
    await h.started();
    expect(h.changes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null"]);
  });
});

describe("when the page writes the recovery file", () => {
  it("waits 1 second for work, and writes one time for many edits", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(400);
    h.rename("A");
    await vi.advanceTimersByTimeAsync(400);
    h.rename("B");
    await vi.advanceTimersByTimeAsync(199);
    expect(h.changes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["write null"]);
    // The write carries the state when the line reached the sync, as a save makes it.
    expect(lastWrittenNames(h)).toEqual(["B"]);
    const [token, work] = h.clients.writeRecovery.mock.calls[0];
    expect(token).toBe("7");
    expect(work.projectPath).toBeNull();
    expect(work.project.clips).toHaveLength(1);
    expect(work.project.sources[0]?.path).toBe(CLIP.path);
    // The written state is the recovery state: no more command.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null"]);
  });

  it("writes nothing for a save during the wait", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(500);
    h.save();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.changes()).toEqual([]);
  });

  it("clears with no wait after a save when a file was written", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null"]);
    h.rename("A");
    await vi.advanceTimersByTimeAsync(500);
    h.save();
    await flush();
    expect(h.changes()).toEqual(["write null", "clear"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.changes()).toEqual(["write null", "clear"]);
  });

  it("clears with no wait when the work goes", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    // Undo of Mark Out removes the segment: a project with no file and no segment.
    h.timeline.getState().undo();
    await flush();
    expect(h.changes()).toEqual(["write null", "clear"]);
  });

  it("writes the path of the file of a modified project", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.save();
    h.rename("A");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual([`write ${FILE.path}`]);
  });

  it("writes the proposed path of a restored project", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.project.getState().completeRestore({ proposedPath: "/old/cut.qcproj" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write /old/cut.qcproj"]);
  });

  it("follows a change of the audio overrides", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.save();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.changes()).toEqual([]);
    h.audioOverrides.getState().replaceOverrides({
      a: { index: 2, codec: "aac", sampleRate: 48000, channels: 2 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual([`write ${FILE.path}`]);
    expect(h.clients.writeRecovery.mock.calls[0]?.[1].project.sources[0]).toMatchObject(
      {
        audioStreamIndex: 2,
      },
    );
  });

  it("sends one command at a time, and the next after the answer", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    const read = h.controller.readOffer("0000000000000002");
    await flush();
    expect(h.changes()).toEqual(["write null"]);
    write.resolve(WRITTEN);
    await expect(discarded).resolves.toEqual({ owner: true, status: "done" });
    await read;
    expect(h.changes()).toEqual([
      "write null",
      "discard 0000000000000001",
      "read 0000000000000002",
    ]);
  });

  it("writes afterwards a state that changed during a command", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.rename("Later");
    await vi.advanceTimersByTimeAsync(1000);
    // The sync of the new state waits for the answer.
    expect(h.changes()).toEqual(["write null"]);
    write.resolve(WRITTEN);
    await flush();
    expect(h.changes()).toEqual(["write null", "write null"]);
    expect(lastWrittenNames(h)).toEqual(["Later"]);
  });

  it("takes a rejected client call as an answer with a state that is not known", async () => {
    const h = harness();
    await h.started();
    h.script.write.push({ reject: new Error("ipc") });
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    await expect(discarded).resolves.toEqual({ owner: true, status: "done" });
    // The written state is not known, so the series writes again after 2 seconds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.changes()).toEqual([
      "write null",
      "discard 0000000000000001",
      "write null",
    ]);
  });
});

describe("the refused state", () => {
  it("sends no write for a state whose document the page cannot make, and clears an old file", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null"]);
    h.addUnsavableClip();
    // A refused state counts as nothing to recover, but the page knows it only at the sync.
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null", "clear"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null", "clear"]);
    // A new state that the page can make is written again.
    h.timeline.getState().removeClip(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null", "clear", "write null"]);
  });

  it("sends nothing for a refused state when no file was written", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.addUnsavableClip();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual([]);
  });

  it("takes a document that the backend refuses as a refused state", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(refusedAnswer("nothing"));
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null"]);
    // Another state is not the refused state.
    h.rename("A");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null", "write null"]);
  });

  it("writes a refused state again when the identity of the project changes, with no edit", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(refusedAnswer("nothing"));
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null"]);
    // A restore gives a new identity with the same content and the same path.
    const content = h.content();
    const identity = h.project.getState().identity;
    h.project.getState().completeRestore({ proposedPath: null });
    expect(h.project.getState().identity).toBe(identity + 1);
    expect(h.content()).toBe(content);
    // The refused state of the identity before goes: the wait of 1 second starts.
    await vi.advanceTimersByTimeAsync(999);
    expect(h.changes()).toEqual(["write null"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["write null", "write null"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null", "write null"]);
  });

  it("clears after a refusal whose removal failed, after the wait of the series", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(refusedAnswer("notKnown"));
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.changes()).toEqual(["write null"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["write null", "clear"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null", "clear"]);
  });
});

describe("the series of waits", () => {
  for (const [name, answer] of [
    ["a failure", FAILED],
    ["an answer of a process that is not the owner", NOT_OWNER],
  ] as const) {
    it(`waits 2, 4, 8, 16 and then 30 seconds after ${name}`, async () => {
      const h = harness();
      await h.started();
      for (let index = 0; index < 7; index += 1) {
        h.script.write.push(answer);
      }
      h.markWork();
      await vi.advanceTimersByTimeAsync(1000);
      const writes = () => h.clients.writeRecovery.mock.calls.length;
      expect(writes()).toBe(1);
      // An edit during a wait of the series puts no sync in the line.
      h.rename("A");
      const waits = [2000, 4000, 8000, 16000, 30000, 30000];
      for (const [index, wait] of waits.entries()) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(writes()).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(writes()).toBe(index + 2);
      }
      // The sync after the first wait sent the state at that moment.
      expect(h.clients.writeRecovery.mock.calls[1]?.[1].project.segments[0]?.name).toBe(
        "A",
      );
    });
  }

  it("ends the series with a command that succeeds", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(FAILED, FAILED, WRITTEN, FAILED);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.clients.writeRecovery).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.clients.writeRecovery).toHaveBeenCalledTimes(3);
    // The next failure starts the series again at 2 seconds.
    h.rename("A");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.clients.writeRecovery).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.clients.writeRecovery).toHaveBeenCalledTimes(5);
  });

  it("takes a sync that waits out of the line when the series starts", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    // An edit during the write: its wait of 1 second ends, and a sync waits in the line.
    h.rename("B");
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    write.resolve(FAILED);
    // The discard behind the sync goes at once, and no write starts before the series wait ends.
    await expect(discarded).resolves.toEqual({ owner: true, status: "done" });
    expect(h.changes()).toEqual(["write null", "discard 0000000000000001"]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.changes()).toEqual(["write null", "discard 0000000000000001"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual([
      "write null",
      "discard 0000000000000001",
      "write null",
    ]);
    expect(lastWrittenNames(h)).toEqual(["B"]);
  });

  it("waits before it tries again after an answer `written` for a clear", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.script.clear.push(WRITTEN);
    h.timeline.getState().undo();
    await flush();
    expect(h.changes()).toEqual(["write null", "clear"]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.changes()).toEqual(["write null", "clear"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["write null", "clear", "clear"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null", "clear", "clear"]);
  });

  it("waits before it tries again after an answer `written` for a finish with nothing", async () => {
    const h = harness();
    await h.started();
    h.script.finish.push(WRITTEN);
    await h.controller.finishRestore("0000000000000001");
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.changes()).toEqual(["finish 0000000000000001 null"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["finish 0000000000000001 null", "clear"]);
  });

  it("stops at a token that the backend refuses", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(STALE_CHANGE);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.rename("A");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null"]);
    await expect(h.controller.discard("0000000000000001")).resolves.toEqual({
      owner: false,
      status: "staleSession",
    });
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toBeNull();
    expect(h.changes()).toEqual(["write null"]);
  });
});

describe("finishRestore", () => {
  it("sends the state at the moment the line reaches it", async () => {
    const h = harness();
    await h.started();
    const discard = held<RecoveryDiscardResult>();
    h.script.discard.push(discard);
    void h.controller.discard("0000000000000009");
    await flush();
    const finished = h.controller.finishRestore("0000000000000001");
    h.markWork();
    h.rename("Now");
    discard.resolve({ owner: true, status: "done" });
    await expect(finished).resolves.toEqual(WRITTEN);
    const [token, id, state] = h.clients.finishRestore.mock.calls[0];
    expect([token, id]).toEqual(["7", "0000000000000001"]);
    expect(state?.project.segments.map((segment) => segment.name)).toEqual(["Now"]);
    // The written state is the state: the wait of 1 second sends nothing more.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual([
      "discard 0000000000000009",
      "finish 0000000000000001 work",
    ]);
  });

  it("sends nothing as the state for a session with no changes to save", async () => {
    const h = harness();
    await h.started();
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toEqual(
      CLEARED,
    );
    expect(h.clients.finishRestore).toHaveBeenCalledWith("7", "0000000000000001", null);
  });

  it("takes a sync that waits out of the line, so no older write comes after it", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.rename("Second");
    await vi.advanceTimersByTimeAsync(1000);
    // A sync waits behind the write that runs.
    const finished = h.controller.finishRestore("0000000000000001");
    h.rename("Third");
    write.resolve(WRITTEN);
    await finished;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual(["write null", "finish 0000000000000001 work"]);
    const state = h.clients.finishRestore.mock.calls[0][2];
    expect(state?.project.segments.map((segment) => segment.name)).toEqual(["Third"]);
  });

  it("goes at the end of the line, behind the entries that were put there before it", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.rename("Second");
    await vi.advanceTimersByTimeAsync(1000);
    // The line: the write that runs, a sync, a discard and a read.
    void h.controller.discard("0000000000000009");
    void h.controller.readOffer("0000000000000008");
    const finished = h.controller.finishRestore("0000000000000001");
    write.resolve(WRITTEN);
    await finished;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.changes()).toEqual([
      "write null",
      "discard 0000000000000009",
      "read 0000000000000008",
      "finish 0000000000000001 work",
    ]);
  });

  it("sends the document of a state that was refused for another project identity", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.addUnsavableClip();
    await vi.advanceTimersByTimeAsync(60_000);
    // The media store has no import of `b`: the state is refused, and nothing is written.
    expect(h.changes()).toEqual([]);
    // A restore gives the session the source `b` and a new identity, with the same content and
    // the same path. The page can now make the document.
    h.media.setState({ sources: { a: CLIP, b: mediaAt("/media/b.mp4") } });
    const identity = h.project.getState().identity;
    h.project.getState().completeRestore({ proposedPath: null });
    expect(h.project.getState().identity).toBe(identity + 1);
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toEqual(
      WRITTEN,
    );
    const state = h.clients.finishRestore.mock.calls[0]?.[2];
    expect(state?.project.sources.map((source) => source.path)).toEqual([
      CLIP.path,
      "/media/b.mp4",
    ]);
    expect(h.changes()).toEqual(["finish 0000000000000001 work"]);
  });

  it("sends no finish_restore for a refused state, and the sync rules clear the file", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    h.addUnsavableClip();
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toBeNull();
    await flush();
    expect(h.changes()).toEqual(["write null", "clear"]);
    // A second finish for the same refused state sends nothing either.
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.clients.finishRestore).not.toHaveBeenCalled();
  });

  it("follows the answer of a finish_restore that failed", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    h.script.finish.push(FAILED);
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toEqual(
      FAILED,
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.changes()).toEqual(["finish 0000000000000001 work"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.changes()).toEqual(["finish 0000000000000001 work", "write null"]);
  });
});

describe("discard and readOffer", () => {
  it("puts discard_recovery in the line and answers when it ended", async () => {
    const h = harness();
    await h.started();
    const answer: RecoveryDiscardResult = {
      owner: true,
      status: "failed",
      error: new RecoveryCommandError({ code: "removeFailed" }),
    };
    h.script.discard.push(answer);
    await expect(h.controller.discard("0000000000000001")).resolves.toBe(answer);
    expect(h.clients.discardRecovery).toHaveBeenCalledWith("7", "0000000000000001");
  });

  it("puts read_recovery in the line with the token", async () => {
    const h = harness();
    await h.started();
    const answer: RecoveryReadResult = { owner: false, status: "notOwner" };
    h.script.read.push(answer);
    await expect(h.controller.readOffer("0000000000000001")).resolves.toBe(answer);
    expect(h.clients.readRecovery).toHaveBeenCalledWith("7", "0000000000000001");
  });
});

describe("the offers", () => {
  it("lists again after 2 seconds and then each 30 seconds while the list is not complete", async () => {
    const h = harness();
    h.script.list.push(partial([]), partial([]), partial([]), COMPLETE);
    await h.started();
    const lists = () => h.clients.listRecoveryOffers.mock.calls.length;
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(lists()).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lists()).toBe(4);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(lists()).toBe(4);
  });

  it("keeps the offers to show, newest first, over several answers", async () => {
    const h = harness();
    const one = offer("1", 100);
    const two = offer("2", 200);
    const three = offer("3", 300);
    const four = offer("4", 150);
    h.script.list.push(partial([two, one]), partial([three, one]), {
      owner: true,
      status: "done",
      complete: true,
      offers: [three, two, four],
    });
    await h.started();
    expect(h.controller.offers.getState().offers).toEqual([two, one]);
    await vi.advanceTimersByTimeAsync(2000);
    // An answer adds the new offers and removes none.
    expect(h.controller.offers.getState().offers).toEqual([three, two, one]);

    // The offer of a prompt that shows is not in the list, and a later answer does not add it.
    expect(h.controller.offers.getState().takeNext()).toEqual(three);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.offers.getState().offers).toEqual([two, four, one]);

    // An offer whose restore stopped goes back to the front, one time.
    h.controller.offers.getState().putBack(three);
    h.controller.offers.getState().putBack(three);
    expect(h.controller.offers.getState().offers).toEqual([three, two, four, one]);
  });

  it("shows an offer that was put back before a newer offer that came meanwhile", async () => {
    const h = harness();
    const one = offer("1", 100);
    const two = offer("2", 200);
    const three = offer("3", 300);
    const zero = offer("0", 50);
    h.script.list.push(partial([one]), partial([two, one]), {
      owner: true,
      status: "done",
      complete: true,
      offers: [three, two, one, zero],
    });
    await h.started();
    const offers = h.controller.offers;
    expect(offers.getState().takeNext()).toEqual(one);
    // A newer offer arrives while the restore of `one` runs.
    await vi.advanceTimersByTimeAsync(2000);
    expect(offers.getState().offers).toEqual([two]);
    offers.getState().putBack(one);
    expect(offers.getState().offers).toEqual([one, two]);
    // A later answer adds its offers by time behind the offer that was put back.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(offers.getState().offers).toEqual([one, three, two, zero]);
    expect(offers.getState().takeNext()).toEqual(one);
    expect(offers.getState().takeNext()).toEqual(three);
    expect(offers.getState().offers).toEqual([two, zero]);
  });

  it("stops at a list answer that refuses the token", async () => {
    const h = harness();
    h.script.list.push({
      owner: false,
      status: "staleSession",
      complete: false,
      offers: [],
    });
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.log).toEqual(["start", "list 7"]);
  });

  it("answers null when no offer is left to show", async () => {
    const h = harness();
    await h.started();
    expect(h.controller.offers.getState().takeNext()).toBeNull();
  });
});

describe("for the quit", () => {
  it("resolves whenLineEmpty at once when the line is empty, also while a wait runs", async () => {
    const h = harness();
    await h.started();
    h.markWork();
    // The wait of 1 second runs, and it is not in the line.
    await expect(h.controller.whenLineEmpty(2000)).resolves.toBe(true);
    expect(h.changes()).toEqual([]);
  });

  it("resolves whenLineEmpty when the command that runs and the next one ended", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discard = held<RecoveryDiscardResult>();
    h.script.discard.push(discard);
    void h.controller.discard("0000000000000001");
    let empty: boolean | null = null;
    void h.controller.whenLineEmpty(2000).then((value) => {
      empty = value;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(empty).toBeNull();
    write.resolve(WRITTEN);
    await flush();
    // The last command started, and it did not answer yet.
    expect(h.changes()).toEqual(["write null", "discard 0000000000000001"]);
    expect(empty).toBeNull();
    discard.resolve({ owner: true, status: "done" });
    await flush();
    expect(empty).toBe(true);
  });

  it("resolves whenLineEmpty with false after its bound", async () => {
    const h = harness();
    await h.started();
    h.script.write.push(held<RecoveryChangeResult>());
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    let empty: boolean | null = null;
    void h.controller.whenLineEmpty(2000).then((value) => {
      empty = value;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(empty).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(empty).toBe(false);
  });

  it("stops each timer at close, and then puts no more command in the line", async () => {
    const h = harness();
    h.script.list.push(partial([]));
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(500);
    h.controller.close();
    await vi.advanceTimersByTimeAsync(300_000);
    h.rename("A");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.log).toEqual(["start", "list 7"]);
    await expect(h.controller.finishRestore("0000000000000001")).resolves.toBeNull();
    await expect(h.controller.discard("0000000000000001")).resolves.toEqual({
      owner: false,
      status: "staleSession",
    });
    expect(h.controller.token()).toBe("7");
  });

  it("drops the entries that wait at close, and lets the command that runs end", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    h.controller.close();
    await expect(discarded).resolves.toEqual({ owner: false, status: "staleSession" });
    let empty: boolean | null = null;
    void h.controller.whenLineEmpty(2000).then((value) => {
      empty = value;
    });
    write.resolve(WRITTEN);
    await flush();
    expect(empty).toBe(true);
    expect(h.changes()).toEqual(["write null"]);
  });
});

describe("the hold of a quit", () => {
  it("says whether the line is empty now", async () => {
    const h = harness();
    await h.started();
    expect(h.controller.isLineEmpty()).toBe(true);
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    // The wait of 1 second is not in the line.
    expect(h.controller.isLineEmpty()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.controller.isLineEmpty()).toBe(false);
    write.resolve(WRITTEN);
    await flush();
    expect(h.controller.isLineEmpty()).toBe(true);
  });

  it("sends no command while it runs, and keeps the entries that wait", async () => {
    const h = harness();
    h.script.list.push(partial([]));
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    let discarded: RecoveryDiscardResult | null = null;
    void h.controller.discard("0000000000000001").then((result) => {
      discarded = result;
    });
    h.controller.suspend();
    write.resolve(WRITTEN);
    await flush();
    h.rename("A");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.changes()).toEqual(["write null"]);
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(1);
    // The discard waits in the line, with no answer.
    expect(discarded).toBeNull();
    expect(h.controller.isLineEmpty()).toBe(false);
    // No new entry goes in the line during the hold.
    await expect(h.controller.finishRestore("0000000000000002")).resolves.toBeNull();
  });

  it("drops the entries that wait when close ends the hold", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    const finished = h.controller.finishRestore("0000000000000002");
    h.controller.suspend();
    h.controller.close();
    await expect(discarded).resolves.toEqual({ owner: false, status: "staleSession" });
    await expect(finished).resolves.toBeNull();
    write.resolve(WRITTEN);
    await flush();
    expect(h.changes()).toEqual(["write null"]);
  });

  it("sends the entries that waited in their order when the hold ends", async () => {
    const h = harness();
    await h.started();
    const write = held<RecoveryChangeResult>();
    h.script.write.push(write);
    h.markWork();
    await vi.advanceTimersByTimeAsync(1000);
    const discarded = h.controller.discard("0000000000000001");
    const finished = h.controller.finishRestore("0000000000000002");
    const resume = h.controller.suspend();
    write.resolve(WRITTEN);
    await flush();
    expect(h.changes()).toEqual(["write null"]);

    resume();
    await expect(discarded).resolves.toEqual({ owner: true, status: "done" });
    await expect(finished).resolves.toEqual(WRITTEN);
    expect(h.changes()).toEqual([
      "write null",
      "discard 0000000000000001",
      "finish 0000000000000002 work",
    ]);
  });

  it("lists and writes again at its end, as after a confirm_quit that failed", async () => {
    const h = harness();
    h.script.list.push(partial([]));
    await h.started();
    h.markWork();
    const resume = h.controller.suspend();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.changes()).toEqual([]);

    resume();
    await flush();
    // The list was not complete, so it goes in the line again at once.
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.changes()).toEqual(["write null"]);
    // A second call of the same end does nothing.
    resume();
    await flush();
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(2);
  });

  it("adds no second list at its end while a list runs", async () => {
    const h = harness();
    const listing = held<RecoveryListResult>();
    h.script.list.push(listing);
    await h.controller.start();
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(1);

    const resume = h.controller.suspend();
    resume();
    listing.resolve(COMPLETE);
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(1);
  });

  it("does not list again at its end after a complete list", async () => {
    const h = harness();
    await h.started();
    const resume = h.controller.suspend();
    resume();
    await flush();
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(1);
  });

  it("lists and compares at its end when it started before the token came", async () => {
    const h = harness();
    const resume = h.controller.suspend();
    await h.started();
    h.markWork();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.log).toEqual(["start"]);
    resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.log).toEqual(["start", "list 7", "write null"]);
  });

  it("does nothing after close", async () => {
    const h = harness();
    await h.started();
    const resume = h.controller.suspend();
    h.controller.close();
    resume();
    h.markWork();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.changes()).toEqual([]);
    expect(h.clients.listRecoveryOffers).toHaveBeenCalledTimes(1);
  });
});

describe("the recovery state reader", () => {
  it("builds no content while its inputs did not change, and compares by value", () => {
    const h = harness();
    const contentOf = vi.fn(projectContentOf);
    const read = createRecoveryStateReader(contentOf);
    const readNow = () =>
      read(
        h.project.getState(),
        h.timeline.getState(),
        h.audioOverrides.getState().overrides,
      );
    expect(readNow()).toEqual({ kind: "nothing" });
    // A project with no file and no segment builds no content.
    expect(contentOf).not.toHaveBeenCalled();
    h.markWork();
    const work = readNow();
    expect(work).toEqual({ kind: "work", content: h.content(), path: null });
    const calls = contentOf.mock.calls.length;
    h.timeline.getState().selectAllSegments();
    expect(readNow()).toBe(work);
    expect(readNow()).toBe(work);
    expect(contentOf).toHaveBeenCalledTimes(calls);
    // The proposed path is a part of the state.
    h.project.getState().completeRestore({ proposedPath: "/old/cut.qcproj" });
    expect(readNow()).toEqual({
      kind: "work",
      content: h.content(),
      path: "/old/cut.qcproj",
    });
    // A saved project that is not modified has nothing to recover.
    h.save();
    expect(readNow()).toEqual({ kind: "nothing" });
  });
});
