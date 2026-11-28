/**
 * The recovery controller of the page (ADR 073): "The line of the recovery commands", "When the
 * page writes the file", the page side of "A quit that the user confirmed", "The offers at the
 * start", and the page side of `finish_restore`.
 *
 * - `start` calls `start_recovery` one time and keeps the token. With no token, the controller
 *   sends no command.
 * - The **line** sends one command at a time, and the next after the answer. A client call that
 *   rejects is an answer too: the written state is then "not known". It never stops the line.
 * - The **recovery state** of the session is "nothing to recover", or "work to recover" with the
 *   content of the project and one path: the path of its file, or else its proposed path, or
 *   null. The controller reads it from the stores, and keeps its last result while the inputs did
 *   not change.
 * - The **written state** is the last answer of `write_recovery`, `clear_recovery` or
 *   `finish_restore`: a state, "nothing", or "not known". At the start it is "nothing".
 * - The **sync** is an entry of the line with no state. One sync waits in the line at most. When
 *   the line reaches it, the controller compares at that moment, and sends `clear_recovery`,
 *   `write_recovery` with the document made then, or nothing.
 * - Rules 1 to 4 of "When the page writes the file": the clear with no wait, the wait of 1 second
 *   for work, the refused state, and the series of waits after a failure (2, 4, 8 and 16 seconds,
 *   then 30 seconds each time).
 * - `finishRestore`, `discard` and `readOffer` put their command in the line.
 * - The offers: `list_recovery_offers` goes in the line after the start, and again after 2
 *   seconds and then each 30 seconds while the list is not complete. `offers` is the store of the
 *   offers to show.
 * - For the quit: `whenLineEmpty`, `isLineEmpty`, `token`, `suspend` (the hold from the call of
 *   `confirm_quit`, which a `confirm_quit` that failed ends) and `close`.
 * - An answer that says that the token is not the token of the session (`staleSession`) stops the
 *   controller: it sends no more command.
 *
 * The module has no React, DOM or Tauri dependency of its own: the clients, the stores and the
 * clock are injected, so the tests need no document.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  audioOverrideStore,
  type AudioOverrideStore,
} from "@/features/media/audioOverrideStore";
import { mediaStore, type MediaStore } from "@/features/media/store";
import {
  buildProjectDocument,
  checkProjectDocument,
  projectContentOf,
  type ProjectAudioOverrides,
  type ProjectContent,
  type ProjectTimeline,
} from "@/features/project/document";
import {
  hasChangesToSave,
  projectStore,
  type ProjectState,
  type ProjectStore,
} from "@/features/project/store";
import {
  liveSegments,
  timelineStore,
  type TimelineStore,
} from "@/features/timeline/store";
import type { Project } from "@/types/project";
import {
  clearRecovery as clearRecoveryCommand,
  discardRecovery as discardRecoveryCommand,
  finishRestore as finishRestoreCommand,
  listRecoveryOffers as listRecoveryOffersCommand,
  readRecovery as readRecoveryCommand,
  startRecovery as startRecoveryCommand,
  writeRecovery as writeRecoveryCommand,
} from "./client";
import type {
  RecoveryChangeResult,
  RecoveryDiscardResult,
  RecoveryListResult,
  RecoveryOfferSummary,
  RecoveryReadResult,
  RecoveryStartResult,
  RecoveryWork,
} from "./types";
import { normalizeRecoveryCommandError } from "./validation";

/** The wait of rule 2 before a sync for work to recover, in milliseconds. */
export const RECOVERY_WORK_WAIT_MS = 1000;

/** The waits of the series of rule 4, in milliseconds. The last one repeats. */
export const RECOVERY_RETRY_WAITS_MS: readonly number[] = [
  2000, 4000, 8000, 16000, 30000,
];

/** The first repeat of a list that is not complete, in milliseconds. */
export const RECOVERY_LIST_FIRST_REPEAT_MS = 2000;

/** Each later repeat of a list that is not complete, in milliseconds. */
export const RECOVERY_LIST_REPEAT_MS = 30000;

/** The recovery state of the session (ADR 073, "When the page writes the file"). */
export type RecoveryState =
  /** The project has no changes to save. */
  | { readonly kind: "nothing" }
  /**
   * The project has changes to save. `path` is the path of its file, or else its proposed path,
   * or null.
   */
  | {
      readonly kind: "work";
      readonly content: ProjectContent;
      readonly path: string | null;
    };

/** The written state: what `current.json` holds after the last answer, as far as the page knows. */
export type RecoveryWrittenState = RecoveryState | { readonly kind: "notKnown" };

/** The clients of the recovery commands. Each one defaults to the client of `client.ts`. */
export interface RecoveryClients {
  readonly startRecovery: () => Promise<RecoveryStartResult>;
  readonly listRecoveryOffers: (token: string) => Promise<RecoveryListResult>;
  readonly writeRecovery: (
    token: string,
    work: RecoveryWork,
  ) => Promise<RecoveryChangeResult>;
  readonly clearRecovery: (token: string) => Promise<RecoveryChangeResult>;
  readonly readRecovery: (token: string, id: string) => Promise<RecoveryReadResult>;
  readonly discardRecovery: (
    token: string,
    id: string,
  ) => Promise<RecoveryDiscardResult>;
  readonly finishRestore: (
    token: string,
    id: string,
    state: RecoveryWork | null,
  ) => Promise<RecoveryChangeResult>;
}

/** The timers of the controller. Defaults to the timers of the page. */
export interface RecoveryClock {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/** The dependencies of the recovery controller. */
export interface RecoveryControllerDependencies {
  readonly clients?: Partial<RecoveryClients>;
  readonly timeline?: TimelineStore;
  readonly media?: MediaStore;
  readonly audioOverrides?: AudioOverrideStore;
  readonly project?: ProjectStore;
  readonly clock?: RecoveryClock;
}

/** The state of the store of the offers to show. */
export interface RecoveryOffersState {
  /**
   * The offers to show: an offer that was put back first, and then the others, the newest first.
   * The offer of a prompt that shows, or of a restore that runs, is not in the list: `takeNext`
   * took it.
   */
  readonly offers: readonly RecoveryOfferSummary[];
  /** Removes the first offer to show from the list and answers it, or null for an empty list. */
  readonly takeNext: () => RecoveryOfferSummary | null;
  /**
   * Puts an offer back in the list when its restore stopped before step 8. It is the next offer
   * to show, before each other offer, also before a newer offer that a later answer adds: the
   * prompt shows again for the same offer (ADR 073). An offer that is in the list already moves
   * to the front, and stays one time.
   */
  readonly putBack: (offer: RecoveryOfferSummary) => void;
  /**
   * Adds offers that are not in the list, at their place by time, after an offer that was put
   * back. The controller calls it with the offers that no earlier answer gave.
   */
  readonly add: (offers: readonly RecoveryOfferSummary[]) => void;
}

/** The store of the offers to show. */
export type RecoveryOffersStore = StoreApi<RecoveryOffersState>;

/** The recovery controller of a page. */
export interface RecoveryController {
  /**
   * Calls `start_recovery` one time and keeps the token. Then it puts `list_recovery_offers` in
   * the line and compares. A second call does nothing and answers the promise of the first. It
   * never rejects: a failure leaves the controller with no token.
   */
  readonly start: () => Promise<void>;
  /** The token of the session, for `confirm_quit`, or null with no token. */
  readonly token: () => string | null;
  /** The store of the offers to show. */
  readonly offers: RecoveryOffersStore;
  /**
   * Puts `read_recovery` of offer `id` in the line, and answers its answer. With no token, or
   * after `close` or a stale token, it sends nothing and answers `staleSession`. The restore uses
   * it in its step 4.
   */
  readonly readOffer: (id: string) => Promise<RecoveryReadResult>;
  /**
   * Puts `finish_restore` of offer `id` in the line. When the line reaches it, the controller
   * sends it with the recovery state at that moment: the document and the path, or null only for
   * a session with no changes to save. For a refused state it sends nothing, the offer stays, and
   * the sync rules handle `current.json`. Answers the answer, or null when it sent nothing. The
   * command goes at the end of the line, and a sync that waits there goes out of it: the command
   * sends the state that a sync would send.
   */
  readonly finishRestore: (id: string) => Promise<RecoveryChangeResult | null>;
  /**
   * Puts `discard_recovery` of offer `id` in the line, and answers its answer when it ended. With
   * no token, or after `close` or a stale token, it sends nothing and answers `staleSession`.
   */
  readonly discard: (id: string) => Promise<RecoveryDiscardResult>;
  /**
   * Resolves with true when no command runs and none waits in the line, or with false after
   * `maxMs`. A wait of the controller between two commands (the 1 second, the series, the repeat
   * of the list) is not in the line.
   */
  readonly whenLineEmpty: (maxMs: number) => Promise<boolean>;
  /**
   * True when no command runs and none waits in the line, now. The quit reads it to decide in the
   * same call when the line is empty.
   */
  readonly isLineEmpty: () => boolean;
  /**
   * Holds the controller from the call of `confirm_quit` (ADR 073, "A quit that the user
   * confirmed"): it stops each timer, sends no command, and puts no new entry in the line. A
   * command that runs ends as it is. The entries that wait, such as a `finish_restore` or a
   * discard, stay in the line: `close` drops them and answers them as it does, and the function
   * that `suspend` answers ends the hold, for a `confirm_quit` that failed, and sends them in
   * their order. The controller then lists the offers again when the list was not complete, and
   * compares. A second hold while one runs, and a hold after `close` or a stale token, does
   * nothing and answers a function that does nothing.
   */
  readonly suspend: () => () => void;
  /**
   * Stops each timer and each subscription. The controller then puts no more command in the line,
   * and the entries that wait there are dropped. A command that runs ends as it is.
   */
  readonly close: () => void;
}

const NOTHING: RecoveryState = { kind: "nothing" };
const NOT_KNOWN: RecoveryWrittenState = { kind: "notKnown" };
const STALE: RecoveryReadResult & RecoveryDiscardResult = {
  owner: false,
  status: "staleSession",
};

/** True when two states are equal by value. */
export function sameRecoveryState(
  a: RecoveryWrittenState,
  b: RecoveryWrittenState,
): boolean {
  if (a.kind === "work" && b.kind === "work") {
    return a.content === b.content && a.path === b.path;
  }
  return a.kind === b.kind;
}

/** The facts of the project that the recovery state reads. */
type RecoveryProject = Pick<
  ProjectState,
  "file" | "savedContent" | "located" | "proposedPath"
>;

/** Reads the recovery state from the facts of the project and the inputs of the content. */
export type RecoveryStateReader = (
  project: RecoveryProject,
  timeline: ProjectTimeline,
  overrides: ProjectAudioOverrides,
) => RecoveryState;

/**
 * Creates a reader of the recovery state that keeps its last result, as the reader of the title
 * does (`createProjectTitleReader`). While each input compares equal by reference to the last
 * call, it returns its last result with no new content string. A project with no file and no
 * segment builds no content. A result equal by value to the last result is the last result.
 *
 * @param contentOf The builder of the content. A test passes a counter.
 */
export function createRecoveryStateReader(
  contentOf: typeof projectContentOf = projectContentOf,
): RecoveryStateReader {
  let last: {
    readonly project: RecoveryProject;
    readonly clips: ProjectTimeline["clips"];
    readonly segments: ProjectTimeline["sequenceSegments"];
    readonly sources: ProjectTimeline["sequenceSources"];
    readonly overrides: ProjectAudioOverrides;
    readonly result: RecoveryState;
  } | null = null;

  return (project, timeline, overrides) => {
    if (
      last !== null &&
      last.project.file === project.file &&
      last.project.savedContent === project.savedContent &&
      last.project.located === project.located &&
      last.project.proposedPath === project.proposedPath &&
      last.clips === timeline.clips &&
      last.segments === timeline.sequenceSegments &&
      last.sources === timeline.sequenceSources &&
      last.overrides === overrides
    ) {
      return last.result;
    }
    let next: RecoveryState = NOTHING;
    const segmentCount = liveSegments(timeline).length;
    // A project with no file has changes to save only with a segment, so it needs no content
    // without one (ADR 072).
    if (project.file !== null || segmentCount > 0) {
      const content = contentOf(timeline, overrides);
      if (hasChangesToSave(project, content, segmentCount)) {
        next = {
          kind: "work",
          content,
          path: project.file?.path ?? project.proposedPath,
        };
      }
    }
    const result =
      last !== null && sameRecoveryState(last.result, next) ? last.result : next;
    last = {
      project: {
        file: project.file,
        savedContent: project.savedContent,
        located: project.located,
        proposedPath: project.proposedPath,
      },
      clips: timeline.clips,
      segments: timeline.sequenceSegments,
      sources: timeline.sequenceSources,
      overrides,
      result,
    };
    return result;
  };
}

/** Creates the store of the offers to show, with no offer. */
export function createRecoveryOffersStore(): RecoveryOffersStore {
  /** The id of the offer that was put back and is first in the list, or null. */
  let putBackId: string | null = null;
  return createStore<RecoveryOffersState>()((set, get) => ({
    offers: [],
    takeNext: () => {
      const [first, ...rest] = get().offers;
      if (first === undefined) {
        return null;
      }
      putBackId = null;
      set({ offers: rest });
      return first;
    },
    putBack: (offer) => {
      const others = get().offers.filter((entry) => entry.id !== offer.id);
      putBackId = offer.id;
      set({ offers: [offer, ...others] });
    },
    add: (added) => {
      const offers = get().offers;
      const fresh = added.filter(
        (offer) => !offers.some((entry) => entry.id === offer.id),
      );
      if (fresh.length === 0) {
        return;
      }
      const head = offers[0]?.id === putBackId ? offers.slice(0, 1) : [];
      set({
        offers: [...head, ...newestFirst([...offers.slice(head.length), ...fresh])],
      });
    },
  }));
}

/** The offers, the newest first. Offers with the same time keep their order. */
function newestFirst(offers: readonly RecoveryOfferSummary[]): RecoveryOfferSummary[] {
  return offers
    .map((offer, index) => ({ offer, index }))
    .sort((a, b) => b.offer.writtenAtMs - a.offer.writtenAtMs || a.index - b.index)
    .map((entry) => entry.offer);
}

/** An entry of the line. */
type LineEntry =
  | { readonly kind: "sync" }
  | { readonly kind: "list" }
  | {
      readonly kind: "finish";
      readonly id: string;
      readonly done: (result: RecoveryChangeResult | null) => void;
    }
  | {
      readonly kind: "discard";
      readonly id: string;
      readonly done: (result: RecoveryDiscardResult) => void;
    }
  | {
      readonly kind: "read";
      readonly id: string;
      readonly done: (result: RecoveryReadResult) => void;
    };

/** The answer of a change command that rejected. */
function rejectedChange(error: unknown): RecoveryChangeResult {
  return {
    owner: false,
    status: "failed",
    current: "notKnown",
    error: normalizeRecoveryCommandError(error),
  };
}

const defaultClock: RecoveryClock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Creates a recovery controller over the clients, the stores and the clock of `dependencies`. */
export function createRecoveryController(
  dependencies: RecoveryControllerDependencies = {},
): RecoveryController {
  const timeline = dependencies.timeline ?? timelineStore;
  const media = dependencies.media ?? mediaStore;
  const audioOverrides = dependencies.audioOverrides ?? audioOverrideStore;
  const project = dependencies.project ?? projectStore;
  const clock = dependencies.clock ?? defaultClock;
  const given = dependencies.clients ?? {};
  const clients: RecoveryClients = {
    startRecovery: given.startRecovery ?? (() => startRecoveryCommand()),
    listRecoveryOffers:
      given.listRecoveryOffers ?? ((token) => listRecoveryOffersCommand(token)),
    writeRecovery:
      given.writeRecovery ?? ((token, work) => writeRecoveryCommand(token, work)),
    clearRecovery: given.clearRecovery ?? ((token) => clearRecoveryCommand(token)),
    readRecovery: given.readRecovery ?? ((token, id) => readRecoveryCommand(token, id)),
    discardRecovery:
      given.discardRecovery ?? ((token, id) => discardRecoveryCommand(token, id)),
    finishRestore:
      given.finishRestore ??
      ((token, id, state) => finishRestoreCommand(token, id, state)),
  };

  const offers = createRecoveryOffersStore();
  const readState = createRecoveryStateReader();

  let started: Promise<void> | null = null;
  let token: string | null = null;
  /** True after `close`. */
  let closed = false;
  /** True after an answer that refused the token. */
  let stopped = false;
  /** True while a hold of `suspend` runs. */
  let suspended = false;

  let written: RecoveryWrittenState = NOTHING;
  /**
   * The last refused state (rule 3) with the identity of the project of that state, or null. A
   * refused state belongs to one project: after an open or a restore, the same content can have
   * a document that the page can make, because the sources of the session have other facts.
   */
  let refused: { readonly state: RecoveryState; readonly identity: number } | null =
    null;
  /**
   * The recovery state and the identity of the project at the last store event, to compare only
   * after a change of one of them. A new identity with the same state can drop a refused state.
   */
  let seen: { readonly state: RecoveryState; readonly identity: number } = {
    state: NOTHING,
    identity: 0,
  };

  const queue: LineEntry[] = [];
  let running = false;
  /** True while a sync waits in the line. A sync that runs does not count. */
  let syncQueued = false;

  let workTimer: unknown = null;
  let retryTimer: unknown = null;
  /** The number of the answers of the series so far (rule 4). */
  let retryCount = 0;
  let listTimer: unknown = null;
  let listRepeats = 0;
  /** True after a list answer that was complete. */
  let listComplete = false;
  /**
   * True while a `list_recovery_offers` runs. The end of a hold adds no second list then: the
   * answer of the list that runs starts its own repeat when it is not complete.
   */
  let listRunning = false;

  /** The ids of the offers that an answer of this life of the page gave. */
  const knownOffers = new Set<string>();
  const emptyWaiters = new Set<() => void>();
  let releases: (() => void)[] = [];

  const active = (): boolean => token !== null && !closed && !stopped && !suspended;

  const snapshot = () => ({
    project: project.getState(),
    timeline: timeline.getState(),
    overrides: audioOverrides.getState().overrides,
  });

  const stateOf = (snap: ReturnType<typeof snapshot>): RecoveryState =>
    readState(snap.project, snap.timeline, snap.overrides);

  /**
   * True when `state` is the last refused state of the project of `identity`. A refused state of
   * another identity goes.
   */
  const isRefused = (state: RecoveryState, identity: number): boolean => {
    if (refused !== null && refused.identity !== identity) {
      refused = null;
    }
    return refused !== null && sameRecoveryState(state, refused.state);
  };

  /** Rule 3: while the state is equal to the last refused state, it counts as nothing. */
  const effective = (state: RecoveryState, identity: number): RecoveryState =>
    isRefused(state, identity) ? NOTHING : state;

  /** True when the state and the written state differ: always for "not known". */
  const differs = (state: RecoveryState): boolean =>
    written.kind === "notKnown" || !sameRecoveryState(state, written);

  /** The document of the state, as a save makes it in its steps 1 and 2, or null. */
  const documentOf = (snap: ReturnType<typeof snapshot>): Project | null => {
    const built = buildProjectDocument(
      snap.timeline,
      media.getState().sources,
      snap.overrides,
    );
    if (!built.ok || !checkProjectDocument(built.project).ok) {
      return null;
    }
    return built.project;
  };

  const clearTimer = (handle: unknown): null => {
    if (handle !== null) {
      clock.clearTimeout(handle);
    }
    return null;
  };

  const notifyEmpty = (): void => {
    if (running || queue.length > 0) {
      return;
    }
    const waiters = [...emptyWaiters];
    emptyWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  };

  /** Drops each entry that waits in the line, and answers it with no command. */
  const drain = (): void => {
    const entries = queue.splice(0, queue.length);
    syncQueued = false;
    for (const entry of entries) {
      switch (entry.kind) {
        case "finish":
          entry.done(null);
          break;
        case "discard":
        case "read":
          entry.done(STALE);
          break;
        default:
          break;
      }
    }
    notifyEmpty();
  };

  /** Stops each timer and subscription, and drops the line. */
  const shutDown = (): void => {
    workTimer = clearTimer(workTimer);
    retryTimer = clearTimer(retryTimer);
    listTimer = clearTimer(listTimer);
    for (const release of releases) {
      release();
    }
    releases = [];
    drain();
  };

  const stop = (): void => {
    stopped = true;
    shutDown();
  };

  const enqueue = (entry: LineEntry): void => {
    queue.push(entry);
    pump();
  };

  const enqueueSync = (): void => {
    if (!active() || syncQueued) {
      return;
    }
    syncQueued = true;
    enqueue({ kind: "sync" });
  };

  /**
   * Compares the recovery state with the written state, and acts by rules 1 to 4: nothing to
   * recover puts a sync in the line with no wait, and work to recover starts the wait of 1 second
   * when none runs. While a wait of the series runs, it does nothing.
   */
  const compare = (): void => {
    if (!active() || retryTimer !== null) {
      return;
    }
    const snap = snapshot();
    const state = effective(stateOf(snap), snap.project.identity);
    if (!differs(state)) {
      return;
    }
    if (state.kind === "nothing") {
      enqueueSync();
      return;
    }
    // A sync that waits sends the state that the line finds when it reaches it.
    if (workTimer === null && !syncQueued) {
      workTimer = clock.setTimeout(() => {
        workTimer = null;
        enqueueSync();
      }, RECOVERY_WORK_WAIT_MS);
    }
  };

  /** Takes a sync that waits out of the line. */
  const removeQueuedSync = (): void => {
    const index = queue.findIndex((entry) => entry.kind === "sync");
    if (index >= 0) {
      queue.splice(index, 1);
    }
    syncQueued = false;
  };

  /**
   * Starts the next wait of the series (rule 4), when none runs. While it runs no sync goes in the
   * line, so the wait of 1 second stops, and a sync that waits in the line goes out of it: the
   * sync at the end of the series takes their place.
   */
  const startSeries = (): void => {
    if (retryTimer !== null || !active()) {
      return;
    }
    workTimer = clearTimer(workTimer);
    removeQueuedSync();
    const wait =
      RECOVERY_RETRY_WAITS_MS[Math.min(retryCount, RECOVERY_RETRY_WAITS_MS.length - 1)];
    retryCount += 1;
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      enqueueSync();
    }, wait);
  };

  /** Ends the series: a command succeeded. */
  const endSeries = (): void => {
    retryCount = 0;
    retryTimer = clearTimer(retryTimer);
  };

  /**
   * Sends one change command, and takes its answer: the written state, the refused state, the
   * series, and a stale token. `sent` is the state that the command carries, and `identity` the
   * identity of the project of that state.
   */
  const sendChange = async (
    call: () => Promise<RecoveryChangeResult>,
    sent: RecoveryState,
    identity: number,
  ): Promise<RecoveryChangeResult> => {
    let result: RecoveryChangeResult;
    try {
      result = await call();
    } catch (error) {
      result = rejectedChange(error);
    }
    // `written` for a command that carried nothing does not say what the file holds.
    const writtenForNothing = result.current === "written" && sent.kind !== "work";
    if (result.current === "written") {
      written = sent.kind === "work" ? sent : NOT_KNOWN;
    } else if (result.current === "nothing") {
      written = NOTHING;
    } else {
      written = NOT_KNOWN;
    }
    if (result.status === "staleSession") {
      stop();
      return result;
    }
    if (result.status === "refused" && sent.kind === "work") {
      refused = { state: sent, identity };
    }
    // A refusal whose removal of `current.json` failed counts as a failure of a step, and so does
    // an answer `written` for a command that carried nothing: the series waits before the next
    // try, so the page does not send the same command again and again.
    const failure =
      result.status === "failed" ||
      result.status === "notOwner" ||
      (result.status === "refused" && result.current === "notKnown") ||
      writtenForNothing;
    if (failure) {
      startSeries();
    } else {
      endSeries();
    }
    return result;
  };

  /** The sync: compares now, and sends the command for the state now, or nothing. */
  const runSync = async (current: string): Promise<void> => {
    const snap = snapshot();
    const identity = snap.project.identity;
    const raw = stateOf(snap);
    let state = effective(raw, identity);
    if (!differs(state)) {
      return;
    }
    if (state.kind === "work") {
      const document = documentOf(snap);
      if (document !== null) {
        const work = state;
        await sendChange(
          () =>
            clients.writeRecovery(current, {
              projectPath: work.path,
              project: document,
            }),
          work,
          identity,
        );
        return;
      }
      // Rule 3: the page cannot make the document. The state is refused, and counts as nothing.
      refused = { state: raw, identity };
      state = NOTHING;
      if (!differs(state)) {
        return;
      }
    }
    await sendChange(() => clients.clearRecovery(current), NOTHING, identity);
  };

  /** `finish_restore` with the state now, or nothing for a refused state. */
  const runFinish = async (
    current: string,
    id: string,
  ): Promise<RecoveryChangeResult | null> => {
    const snap = snapshot();
    const identity = snap.project.identity;
    const raw = stateOf(snap);
    if (raw.kind === "nothing") {
      return sendChange(
        () => clients.finishRestore(current, id, null),
        NOTHING,
        identity,
      );
    }
    if (isRefused(raw, identity)) {
      return null;
    }
    const document = documentOf(snap);
    if (document === null) {
      refused = { state: raw, identity };
      return null;
    }
    return sendChange(
      () =>
        clients.finishRestore(current, id, {
          projectPath: raw.path,
          project: document,
        }),
      raw,
      identity,
    );
  };

  /** Adds the offers that no earlier answer gave to the offers to show. */
  const addOffers = (listed: readonly RecoveryOfferSummary[]): void => {
    const added = listed.filter((offer) => !knownOffers.has(offer.id));
    for (const offer of added) {
      knownOffers.add(offer.id);
    }
    offers.getState().add(added);
  };

  const runList = async (current: string): Promise<void> => {
    let result: RecoveryListResult;
    listRunning = true;
    try {
      result = await clients.listRecoveryOffers(current);
    } catch (error) {
      result = {
        owner: false,
        status: "failed",
        complete: false,
        offers: [],
        error: normalizeRecoveryCommandError(error),
      };
    } finally {
      listRunning = false;
    }
    if (result.status === "staleSession") {
      stop();
      return;
    }
    addOffers(result.offers);
    if (result.complete) {
      listComplete = true;
    }
    if (!result.complete && active() && listTimer === null) {
      const wait =
        listRepeats === 0 ? RECOVERY_LIST_FIRST_REPEAT_MS : RECOVERY_LIST_REPEAT_MS;
      listRepeats += 1;
      listTimer = clock.setTimeout(() => {
        listTimer = null;
        if (active()) {
          enqueue({ kind: "list" });
        }
      }, wait);
    }
  };

  const runRead = async (current: string, id: string): Promise<RecoveryReadResult> => {
    let result: RecoveryReadResult;
    try {
      result = await clients.readRecovery(current, id);
    } catch (error) {
      result = {
        owner: false,
        status: "failed",
        error: normalizeRecoveryCommandError(error),
      };
    }
    if (result.status === "staleSession") {
      stop();
    }
    return result;
  };

  const runDiscard = async (
    current: string,
    id: string,
  ): Promise<RecoveryDiscardResult> => {
    let result: RecoveryDiscardResult;
    try {
      result = await clients.discardRecovery(current, id);
    } catch (error) {
      result = {
        owner: false,
        status: "failed",
        error: normalizeRecoveryCommandError(error),
      };
    }
    if (result.status === "staleSession") {
      stop();
    }
    return result;
  };

  /** Runs one entry of the line. It never rejects. */
  const execute = async (entry: LineEntry): Promise<void> => {
    const current = token;
    if (current === null || !active()) {
      // The line drops its entries when the controller stops, so this is a guard only.
      if (entry.kind === "finish") {
        entry.done(null);
      } else if (entry.kind === "discard" || entry.kind === "read") {
        entry.done(STALE);
      }
      return;
    }
    switch (entry.kind) {
      case "sync":
        await runSync(current);
        return;
      case "list":
        await runList(current);
        return;
      case "finish":
        entry.done(await runFinish(current, entry.id));
        return;
      case "discard":
        entry.done(await runDiscard(current, entry.id));
        return;
      case "read":
        entry.done(await runRead(current, entry.id));
        return;
    }
  };

  /** Starts the next entry of the line when none runs. A hold keeps the entries that wait. */
  function pump(): void {
    if (running || suspended) {
      return;
    }
    const entry = queue.shift();
    if (entry === undefined) {
      notifyEmpty();
      return;
    }
    if (entry.kind === "sync") {
      // A sync that runs is not a sync that waits: a change from now on can put the next one.
      syncQueued = false;
    }
    running = true;
    void execute(entry)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        // The page compares after each answer of the line.
        compare();
        pump();
      });
  }

  /** The recovery state and the identity of the project now. */
  const observe = (): { readonly state: RecoveryState; readonly identity: number } => {
    const snap = snapshot();
    return { state: stateOf(snap), identity: snap.project.identity };
  };

  /**
   * Compares after each change of the recovery state, and after each change of the identity of
   * the project: an open or a restore can give the same state, whose refused state of the
   * identity before then goes.
   */
  const onStoreChange = (): void => {
    const now = observe();
    if (now.identity === seen.identity && sameRecoveryState(now.state, seen.state)) {
      return;
    }
    seen = now;
    compare();
  };

  const start = async (): Promise<void> => {
    if (closed) {
      return;
    }
    let answer: RecoveryStartResult;
    try {
      answer = await clients.startRecovery();
    } catch {
      // No token: the controller sends no command.
      return;
    }
    token = answer.token;
    if (closed || stopped) {
      return;
    }
    releases = [
      timeline.subscribe(onStoreChange),
      audioOverrides.subscribe(onStoreChange),
      project.subscribe(onStoreChange),
    ];
    seen = observe();
    // A hold that started before the token came lists and compares at its end.
    if (suspended) {
      return;
    }
    enqueue({ kind: "list" });
    compare();
  };

  /**
   * Ends a hold of `suspend`: sends the entries that waited, in their order, lists again when the
   * list was not complete, and compares.
   */
  const resume = (): void => {
    suspended = false;
    pump();
    if (!active()) {
      return;
    }
    if (
      !listComplete &&
      !listRunning &&
      listTimer === null &&
      !queue.some((entry) => entry.kind === "list")
    ) {
      enqueue({ kind: "list" });
    }
    seen = observe();
    compare();
  };

  /** Puts an entry with an answer in the line, or answers at once with no token. */
  function request<T>(
    make: (done: (result: T) => void) => LineEntry,
    idle: T,
  ): Promise<T> {
    if (!active()) {
      return Promise.resolve(idle);
    }
    return new Promise<T>((resolve) => {
      enqueue(make(resolve));
    });
  }

  return {
    start: () => {
      started ??= start();
      return started;
    },
    token: () => token,
    offers,
    readOffer: (id) => request((done) => ({ kind: "read", id, done }), STALE),
    finishRestore: (id) => {
      if (!active()) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        // The command sends the state that the line finds when it reaches it, as a sync does, so
        // a sync that waits goes out of the line. The command goes at the end of the line, and it
        // does not pass the entries that were put in the line before it.
        removeQueuedSync();
        enqueue({ kind: "finish", id, done: resolve });
      });
    },
    discard: (id) => request((done) => ({ kind: "discard", id, done }), STALE),
    whenLineEmpty: (maxMs) => {
      if (!running && queue.length === 0) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        let bound: unknown = null;
        const waiter = (): void => {
          bound = clearTimer(bound);
          resolve(true);
        };
        emptyWaiters.add(waiter);
        bound = clock.setTimeout(() => {
          emptyWaiters.delete(waiter);
          resolve(false);
        }, maxMs);
      });
    },
    isLineEmpty: () => !running && queue.length === 0,
    suspend: () => {
      if (closed || stopped || suspended) {
        return () => undefined;
      }
      suspended = true;
      // The subscriptions stay, so the end of the hold needs no new one. While the hold runs,
      // `compare` and each timer do nothing, because the controller is not active, and the line
      // starts no entry. The entries that wait stay in the line: `close` drops them, and the end
      // of the hold sends them in their order.
      workTimer = clearTimer(workTimer);
      retryTimer = clearTimer(retryTimer);
      listTimer = clearTimer(listTimer);
      let ended = false;
      return () => {
        if (ended || closed || stopped) {
          return;
        }
        ended = true;
        resume();
      };
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      shutDown();
    },
  };
}
