/**
 * The page side of the measurement of loudness (ADR 061): `start_loudness_measurement` and its
 * channel, and `cancel_loudness_measurement`.
 *
 * The progress and the end of a measurement can arrive before the start command returns the id of
 * the job, so the job holds a cancel until it knows the id.
 */

import { Channel } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import {
  parseLoudnessMessage,
  parseLoudnessStarted,
  toLoudnessError,
} from "./protocol";
import {
  LoudnessError,
  type LoudnessEnd,
  type LoudnessProgress,
  type LoudnessScope,
  type LoudnessStarted,
} from "./types";

/**
 * Receives the output of one measurement. The client calls the handlers only from the channel or
 * from a timer, never during `startLoudnessMeasurement` or `cancel`, so a caller can attach the
 * job before its first call.
 */
export interface LoudnessHandlers {
  readonly onProgress: (progress: LoudnessProgress) => void;
  /**
   * The last call. A message of the wrong shape ends the job as failed with `invalidResponse`,
   * when Rust ends the job or after `INVALID_END_WAIT_MS`.
   */
  readonly onEnd: (end: LoudnessEnd) => void;
}

/** One measurement, from its request to its end. */
export interface LoudnessJob {
  /** Resolves when Rust accepted the request, and rejects with a LoudnessError. */
  readonly started: Promise<LoudnessStarted>;
  /** Asks Rust to cancel the job. The handlers still get the end message, as `canceled`. */
  readonly cancel: () => void;
}

/** The narrow surface of a Tauri channel that the client needs. */
export interface LoudnessChannel {
  onmessage: (message: unknown) => void;
}

export interface LoudnessClientOptions {
  readonly invoke?: InvokeFn;
  readonly createChannel?: () => LoudnessChannel;
  /** The clock of the request numbers, in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Reports a cancel that failed. */
  readonly onBackgroundError?: (error: unknown) => void;
  /**
   * How long the job waits for the end message of Rust after a message of the wrong shape, in
   * milliseconds. Defaults to `INVALID_END_WAIT_MS`.
   */
  readonly invalidEndWaitMs?: number;
}

/**
 * How long a job waits for the end message of Rust after a message of the wrong shape. Rust frees
 * the slot before it sends its end, so the job reports its end only then, and the next start does
 * not meet `busy`. An end message that also has the wrong shape never comes, so the wait ends.
 */
export const INVALID_END_WAIT_MS = 3000;

let lastSequence = 0;

/**
 * The next request number: microseconds since the Unix epoch, or one more than the last number
 * when that is higher, so it always rises (ADR 061, as ADR 056).
 */
export function nextLoudnessSequence(now: () => number = Date.now): number {
  const next = Math.max(Math.floor(now() * 1000), lastSequence + 1);
  lastSequence = next;
  return next;
}

function defaultChannel(): LoudnessChannel {
  return new Channel<unknown>();
}

const INVALID_END: LoudnessEnd = {
  status: "failed",
  code: "invalidResponse",
  detail: null,
};

/**
 * Requests the measurement of `scope` and returns the job at once. The handlers get the progress
 * in order, and then the end exactly once.
 *
 * A start that Rust refuses rejects `started`, and the handlers get no call: Rust holds no job,
 * so no end message comes.
 */
export function startLoudnessMeasurement(
  scope: LoudnessScope,
  handlers: LoudnessHandlers,
  options: LoudnessClientOptions = {},
): LoudnessJob {
  const invoke = options.invoke;
  const createChannel = options.createChannel ?? defaultChannel;
  const reportBackground =
    options.onBackgroundError ??
    ((error: unknown) => {
      console.warn("loudness: a cancel failed", error);
    });
  // The handlers got their last call.
  let ended = false;
  // Rust sent the end message, so the job holds no slot to cancel.
  let rustEnded = false;
  let cancelRequested = false;
  let cancelSent = false;
  let jobId: number | null = null;

  const sendCancel = (): void => {
    if (cancelSent || rustEnded || jobId === null) {
      return;
    }
    cancelSent = true;
    cancelLoudnessMeasurement(jobId, { invoke }).catch(reportBackground);
  };

  // A message had the wrong shape: the job ends as `invalidResponse` when Rust ends it.
  let invalid = false;
  let invalidTimer: ReturnType<typeof setTimeout> | null = null;
  const end = (message: LoudnessEnd): void => {
    if (ended) {
      return;
    }
    ended = true;
    if (invalidTimer !== null) {
      clearTimeout(invalidTimer);
    }
    handlers.onEnd(message);
  };

  const channel = createChannel();
  channel.onmessage = (raw) => {
    if (ended) {
      return;
    }
    const message = parseLoudnessMessage(raw);
    switch (message.kind) {
      case "progress":
        if (!invalid) {
          handlers.onProgress(message.progress);
        }
        return;
      case "end":
        rustEnded = true;
        end(invalid ? INVALID_END : message.end);
        return;
      case "invalid":
        if (invalid) {
          return;
        }
        // The page can no longer trust the job, so it stops it, also when the id comes later.
        invalid = true;
        cancelRequested = true;
        sendCancel();
        invalidTimer = setTimeout(() => {
          end(INVALID_END);
        }, options.invalidEndWaitMs ?? INVALID_END_WAIT_MS);
        return;
    }
  };

  // The five fields of the scope and the number, and nothing more: Rust refuses another key.
  const request = {
    sources: scope.sources,
    pieces: scope.pieces,
    segmentCount: scope.segmentCount,
    preset: scope.preset,
    streams: scope.streams,
    sequence: nextLoudnessSequence(options.now),
  };
  const started = invokeCommand<unknown>(
    BACKEND_COMMANDS.START_LOUDNESS_MEASUREMENT,
    { request, channel },
    invoke,
  ).then(
    (reply) => {
      const parsed = parseLoudnessStarted(reply);
      if (parsed === null) {
        // A job that Rust started still holds the slot, so it gets the cancel.
        const id = (reply as { jobId?: unknown } | null)?.jobId;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
          jobId = id;
          cancelRequested = true;
          sendCancel();
        }
        throw new LoudnessError("invalidResponse");
      }
      jobId = parsed.jobId;
      if (cancelRequested) {
        sendCancel();
      }
      return parsed;
    },
    (error: unknown) => {
      throw toLoudnessError(error);
    },
  );

  return {
    started,
    cancel: () => {
      if (cancelRequested) {
        return;
      }
      cancelRequested = true;
      sendCancel();
    },
  };
}

/** Cancels the measurement `jobId`. Rust ignores an id that it does not know. */
export async function cancelLoudnessMeasurement(
  jobId: number,
  options: { readonly invoke?: InvokeFn } = {},
): Promise<void> {
  try {
    await invokeCommand<void>(
      BACKEND_COMMANDS.CANCEL_LOUDNESS_MEASUREMENT,
      { jobId },
      options.invoke,
    );
  } catch (error) {
    throw toLoudnessError(error);
  }
}
