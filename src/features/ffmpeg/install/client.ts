/**
 * The page side of the download of FFmpeg (ADR 059): `ffmpeg_download_offer`,
 * `start_ffmpeg_install` and its channel, and `cancel_ffmpeg_install`. Only the Settings window
 * may call them.
 *
 * The progress and the end of an install can arrive before the start command returns the id of
 * the job, so the job holds a cancel until it knows the id.
 */

import { Channel } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import {
  parseFfmpegDownloadOffer,
  parseFfmpegInstallMessage,
  parseFfmpegInstallStarted,
  toFfmpegInstallError,
} from "./protocol";
import {
  FfmpegInstallError,
  type FfmpegDownloadOffer,
  type FfmpegInstallEnd,
  type FfmpegInstallProgress,
  type FfmpegInstallStarted,
} from "./types";

/** Receives the output of one install. */
export interface FfmpegInstallHandlers {
  readonly onProgress: (progress: FfmpegInstallProgress) => void;
  /** The last call. A message of the wrong shape ends the install as failed with `invalidResponse`. */
  readonly onEnd: (end: FfmpegInstallEnd) => void;
}

/** One install, from its request to its end. */
export interface FfmpegInstallJob {
  /** Resolves when Rust accepted the request, and rejects with an FfmpegInstallError. */
  readonly started: Promise<FfmpegInstallStarted>;
  /** Asks Rust to cancel the install. The handlers still get the end message, as `canceled`. */
  readonly cancel: () => void;
}

/** The narrow surface of a Tauri channel that the client needs. */
export interface FfmpegInstallChannel {
  onmessage: (message: unknown) => void;
}

export interface FfmpegInstallClientOptions {
  readonly invoke?: InvokeFn;
  readonly createChannel?: () => FfmpegInstallChannel;
  /** The clock of the request numbers, in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Reports a cancel that failed. */
  readonly onBackgroundError?: (error: unknown) => void;
}

let lastSequence = 0;

/**
 * The next request number: microseconds since the Unix epoch, or one more than the last number
 * when that is higher, so it always rises. A page load of the Settings window sets a floor at
 * its own time, so Rust refuses each late request of the page before (ADR 059, as ADR 056).
 */
export function nextFfmpegInstallSequence(now: () => number = Date.now): number {
  const next = Math.max(Math.floor(now() * 1000), lastSequence + 1);
  lastSequence = next;
  return next;
}

function defaultChannel(): FfmpegInstallChannel {
  return new Channel<unknown>();
}

const INVALID_END: FfmpegInstallEnd = {
  outcome: "failed",
  code: "invalidResponse",
  detail: null,
};

/**
 * The offer of the download, or null when the FFmpeg tab may not offer it. Rejects with an
 * FfmpegInstallError.
 */
export async function ffmpegDownloadOffer(
  options: { readonly invoke?: InvokeFn } = {},
): Promise<FfmpegDownloadOffer | null> {
  let reply: unknown;
  try {
    reply = await invokeCommand<unknown>(
      BACKEND_COMMANDS.FFMPEG_DOWNLOAD_OFFER,
      undefined,
      options.invoke,
    );
  } catch (error) {
    throw toFfmpegInstallError(error);
  }
  if (reply === null) {
    return null;
  }
  const offer = parseFfmpegDownloadOffer(reply);
  if (offer === null) {
    throw new FfmpegInstallError("invalidResponse");
  }
  return offer;
}

/**
 * Starts the install and returns the job at once. The handlers get the progress in order until
 * the end message. Rust can take some seconds before it accepts the request (ADR 059).
 */
export function startFfmpegInstall(
  handlers: FfmpegInstallHandlers,
  options: FfmpegInstallClientOptions = {},
): FfmpegInstallJob {
  const invoke = options.invoke;
  const createChannel = options.createChannel ?? defaultChannel;
  const reportBackground =
    options.onBackgroundError ??
    ((error: unknown) => {
      console.warn("ffmpeg install: a cancel failed", error);
    });
  // The handlers got their last call.
  let ended = false;
  // Rust sent the end message, so the install holds no slot to cancel.
  let rustEnded = false;
  let cancelRequested = false;
  let cancelSent = false;
  let jobId: number | null = null;

  const sendCancel = (): void => {
    if (cancelSent || rustEnded || jobId === null) {
      return;
    }
    cancelSent = true;
    cancelFfmpegInstall(jobId, { invoke }).catch(reportBackground);
  };

  const channel = createChannel();
  channel.onmessage = (raw) => {
    if (ended) {
      return;
    }
    const message = parseFfmpegInstallMessage(raw);
    switch (message.kind) {
      case "progress":
        handlers.onProgress(message.progress);
        return;
      case "end":
        ended = true;
        rustEnded = true;
        handlers.onEnd(message.end);
        return;
      case "invalid":
        // The page can no longer trust the install, so it stops it, also when the id comes
        // later.
        cancelRequested = true;
        sendCancel();
        ended = true;
        handlers.onEnd(INVALID_END);
        return;
    }
  };

  const started = invokeCommand<unknown>(
    BACKEND_COMMANDS.START_FFMPEG_INSTALL,
    { sequence: nextFfmpegInstallSequence(options.now), channel },
    invoke,
  ).then(
    (reply) => {
      const parsed = parseFfmpegInstallStarted(reply);
      if (parsed === null) {
        // The reply holds no id that the page can read, so nothing can be canceled.
        throw new FfmpegInstallError("invalidResponse");
      }
      jobId = parsed.jobId;
      if (cancelRequested) {
        sendCancel();
      }
      return parsed;
    },
    (error: unknown) => {
      throw toFfmpegInstallError(error);
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

/** Cancels install `jobId`. Rust ignores an id that it does not know. */
export async function cancelFfmpegInstall(
  jobId: number,
  options: { readonly invoke?: InvokeFn } = {},
): Promise<void> {
  try {
    await invokeCommand<void>(
      BACKEND_COMMANDS.CANCEL_FFMPEG_INSTALL,
      { jobId },
      options.invoke,
    );
  } catch (error) {
    throw toFfmpegInstallError(error);
  }
}
