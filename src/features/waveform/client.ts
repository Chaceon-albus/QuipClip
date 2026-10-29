/**
 * The page side of the envelope jobs (ADR 056): `start_waveform` and its channel,
 * `cancel_waveform`, and the two commands of the cache.
 *
 * The data and the end of a job can arrive before the start command returns the id of the job,
 * so the job holds a cancel until it knows the id.
 */

import { Channel } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import {
  parseWaveformCacheCleared,
  parseWaveformCacheUsage,
  parseWaveformMessage,
  parseWaveformStarted,
  toWaveformError,
} from "./protocol";
import {
  NO_WAVEFORM_FLAGS,
  WaveformError,
  type WaveformCacheCleared,
  type WaveformCacheUsage,
  type WaveformChunk,
  type WaveformEnd,
  type WaveformProgress,
  type WaveformRequest,
  type WaveformStarted,
} from "./types";

/** Receives the output of one job. */
export interface WaveformHandlers {
  readonly onChunk: (chunk: WaveformChunk) => void;
  readonly onProgress: (progress: WaveformProgress) => void;
  /** The last call. A message of the wrong shape ends the job as failed with `invalidResponse`. */
  readonly onEnd: (end: WaveformEnd) => void;
}

/** One job, from its request to its end. */
export interface WaveformJob {
  /** Resolves when Rust accepted the request, and rejects with a WaveformError. */
  readonly started: Promise<WaveformStarted>;
  /** Asks Rust to cancel the job. The handlers still get the end message, as `canceled`. */
  readonly cancel: () => void;
  /** Cancels the job and drops each later message. */
  readonly close: () => void;
  readonly isClosed: () => boolean;
}

/** The narrow surface of a Tauri channel that the client needs. */
export interface WaveformChannel {
  onmessage: (message: unknown) => void;
}

export interface WaveformClientOptions {
  readonly invoke?: InvokeFn;
  readonly createChannel?: () => WaveformChannel;
  /** The clock of the request numbers, in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Reports a cancel that failed. */
  readonly onBackgroundError?: (error: unknown) => void;
}

let lastSequence = 0;

/**
 * The next request number: microseconds since the Unix epoch, or one more than the last number
 * when that is higher, so it always rises (ADR 056, as ADR 046).
 */
export function nextWaveformSequence(now: () => number = Date.now): number {
  const next = Math.max(Math.floor(now() * 1000), lastSequence + 1);
  lastSequence = next;
  return next;
}

function defaultChannel(): WaveformChannel {
  return new Channel<unknown>();
}

const INVALID_END: WaveformEnd = {
  status: "failed",
  code: "invalidResponse",
  detail: null,
  bucketCount: 0,
  cached: false,
  flags: NO_WAVEFORM_FLAGS,
};

/**
 * Requests the envelope of a source and returns the job at once. The handlers get the output in
 * order until the end message, or until `close`.
 */
export function startWaveform(
  request: WaveformRequest,
  handlers: WaveformHandlers,
  options: WaveformClientOptions = {},
): WaveformJob {
  const invoke = options.invoke;
  const createChannel = options.createChannel ?? defaultChannel;
  const reportBackground =
    options.onBackgroundError ??
    ((error: unknown) => {
      console.warn("waveform: a cancel failed", error);
    });
  let closed = false;
  // The handlers got their last call.
  let ended = false;
  // Rust sent the end message, so the job holds no slot to cancel.
  let rustEnded = false;
  let cancelRequested = false;
  let cancelSent = false;
  let jobId: number | null = null;

  const sendCancel = (): void => {
    // A cache hit has id 0 and holds no slot: its data ends on its own, and the page drops it.
    if (cancelSent || rustEnded || jobId === null || jobId === 0) {
      return;
    }
    cancelSent = true;
    cancelWaveform(jobId, { invoke }).catch(reportBackground);
  };

  const channel = createChannel();
  channel.onmessage = (raw) => {
    if (closed || ended) {
      return;
    }
    const message = parseWaveformMessage(raw);
    switch (message.kind) {
      case "chunk":
        handlers.onChunk(message.chunk);
        return;
      case "progress":
        handlers.onProgress(message.progress);
        return;
      case "end":
        ended = true;
        rustEnded = true;
        handlers.onEnd(message.end);
        return;
      case "invalid":
        // The page can no longer trust the job, so it stops it, also when the id comes later.
        cancelRequested = true;
        sendCancel();
        ended = true;
        handlers.onEnd(INVALID_END);
        return;
    }
  };

  const started = invokeCommand<unknown>(
    BACKEND_COMMANDS.START_WAVEFORM,
    {
      request: { ...request, sequence: nextWaveformSequence(options.now) },
      channel,
    },
    invoke,
  ).then(
    (reply) => {
      const parsed = parseWaveformStarted(reply);
      if (parsed === null) {
        // A job that Rust started still holds the slot, so it gets the cancel.
        const id = (reply as { jobId?: unknown } | null)?.jobId;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
          jobId = id;
          cancelRequested = true;
          sendCancel();
        }
        throw new WaveformError("invalidResponse");
      }
      jobId = parsed.jobId;
      if (cancelRequested) {
        sendCancel();
      }
      return parsed;
    },
    (error: unknown) => {
      throw toWaveformError(error);
    },
  );

  const cancel = (): void => {
    if (cancelRequested) {
      return;
    }
    cancelRequested = true;
    sendCancel();
  };

  return {
    started,
    cancel,
    close: () => {
      if (closed) {
        return;
      }
      cancel();
      closed = true;
    },
    isClosed: () => closed,
  };
}

/** Cancels the job `jobId`. Rust ignores an id that it does not know. */
export async function cancelWaveform(
  jobId: number,
  options: { readonly invoke?: InvokeFn } = {},
): Promise<void> {
  try {
    await invokeCommand<void>(
      BACKEND_COMMANDS.CANCEL_WAVEFORM,
      { jobId },
      options.invoke,
    );
  } catch (error) {
    throw toWaveformError(error);
  }
}

/** The size of the envelope cache, for the Settings window. */
export async function waveformCacheUsage(
  options: { readonly invoke?: InvokeFn } = {},
): Promise<WaveformCacheUsage> {
  let reply: unknown;
  try {
    reply = await invokeCommand<unknown>(
      BACKEND_COMMANDS.WAVEFORM_CACHE_USAGE,
      undefined,
      options.invoke,
    );
  } catch (error) {
    throw toWaveformError(error);
  }
  const parsed = parseWaveformCacheUsage(reply);
  if (parsed === null) {
    throw new WaveformError("invalidResponse");
  }
  return parsed;
}

/** Deletes every entry of the envelope cache. */
export async function clearWaveformCache(
  options: { readonly invoke?: InvokeFn } = {},
): Promise<WaveformCacheCleared> {
  let reply: unknown;
  try {
    reply = await invokeCommand<unknown>(
      BACKEND_COMMANDS.CLEAR_WAVEFORM_CACHE,
      undefined,
      options.invoke,
    );
  } catch (error) {
    throw toWaveformError(error);
  }
  const parsed = parseWaveformCacheCleared(reply);
  if (parsed === null) {
    throw new WaveformError("invalidResponse");
  }
  return parsed;
}
