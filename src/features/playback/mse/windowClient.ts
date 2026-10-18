/**
 * The page side of the preview remux windows (ADR 046): `open_preview_window`, its two
 * channels, `ack_preview_window` and `close_preview_window`.
 *
 * Rust sends each piece of a window as raw bytes and the end of the window as one JSON message,
 * so the client tells them apart by type. The pieces can arrive before the command returns the
 * id of the window, so the session holds the acknowledged bytes and a close until it knows
 * the id.
 */

import { Channel } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { Rational } from "@/types/project";

export type WindowLane = "video" | "audio";
export type WindowContainer = "flv" | "mpegTs" | "matroska";
/** What a window does with the audio: copy it, transcode it to AAC, or leave it out. */
export type WindowAudio = "copy" | "transcode" | "omit";

/** Where a window starts. */
export type WindowStart =
  | { readonly kind: "fileStart" }
  /** The keyframe at or before an absolute source time. */
  | { readonly kind: "time"; readonly seconds: number }
  /** The keyframe tag where the previous FLV window stopped. */
  | { readonly kind: "resume"; readonly offset: number; readonly ptsMs: number };

export interface WindowRequest {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly lane: WindowLane;
  readonly container: WindowContainer;
  readonly start: WindowStart;
  /** The container start time of the probe, for the input seek of MPEG-TS and Matroska. */
  readonly formatStartTime?: Rational | null;
  /** The seek margin of MPEG-TS and Matroska, or the margin of ADR 014 when absent. */
  readonly marginSeconds?: number;
  readonly audio: WindowAudio;
  /** The codec name of the audio stream from the probe. */
  readonly audioCodec?: string | null;
  /** On FLV, also decode the audio of the window to PCM into the second channel. */
  readonly pcm?: boolean;
  /** Scan for decoder configurations before the window, after a window failed to decode. */
  readonly rescanConfig?: boolean;
}

/** The keyframe tag where the next FLV window starts. */
export interface ResumePoint {
  readonly offset: number;
  readonly ptsMs: number;
}

/** The last message of a window, or of its PCM. */
export interface WindowEnd {
  readonly status: "complete" | "canceled" | "failed";
  /** True when an FLV window reached the end of the file. */
  readonly reachedEnd: boolean;
  /** Where the next FLV window starts, or null. */
  readonly next: ResumePoint | null;
  readonly bytesRead: number;
  /** True when the window stopped in front of a timestamp that decreases. */
  readonly nonMonotonic: boolean;
  /** True when the window stopped at a damaged tag. */
  readonly damaged: boolean;
  readonly detail: string | null;
}

/** What the command returns when it started a window. */
export interface WindowOpened {
  readonly windowId: number;
  /** How the FLV locator found the keyframe. */
  readonly method: string | null;
  /** True when the FLV reader knows that the timestamps of the file decrease. */
  readonly nonMonotonic: boolean;
  /** The presentation time in milliseconds of the first keyframe of an FLV window. */
  readonly firstKeyframePtsMs: number | null;
  /** The absolute source time of sample 0 of the PCM of the window. */
  readonly pcmStartSeconds: number | null;
  /** The input seek of an MPEG-TS or Matroska window. */
  readonly seekSeconds: number | null;
}

/** The stable error names of the command (ADR 011), and one for a reply of the wrong shape. */
export type PreviewWindowErrorCode =
  | "invalidRequest"
  | "sourceUnreadable"
  | "sourceChanged"
  | "sourceNotAllowed"
  | "appDataUnavailable"
  | "ffmpegNotFound"
  | "notFlv"
  | "noKeyframe"
  | "readFailed"
  | "spawnFailed"
  | "superseded"
  | "commandExecutionFailed"
  | "invalidResponse";

const ERROR_CODES: ReadonlySet<string> = new Set<PreviewWindowErrorCode>([
  "invalidRequest",
  "sourceUnreadable",
  "sourceChanged",
  "sourceNotAllowed",
  "appDataUnavailable",
  "ffmpegNotFound",
  "notFlv",
  "noKeyframe",
  "readFailed",
  "spawnFailed",
  "superseded",
  "commandExecutionFailed",
  "invalidResponse",
]);

export class PreviewWindowError extends Error {
  readonly code: PreviewWindowErrorCode;
  readonly detail: string | null;

  constructor(code: PreviewWindowErrorCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "PreviewWindowError";
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Receives the output of a window. */
export interface WindowListener {
  /** A piece of the fMP4 of the window, or of the PCM of an audio-lane window. */
  readonly onChunk: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly onEnd: (end: WindowEnd) => void;
  /** A piece of the PCM of an FLV window: 16-bit mono samples at 48 kHz. */
  readonly onPcmChunk?: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly onPcmEnd?: (end: WindowEnd) => void;
}

/** One window, from its request to its end. */
export interface WindowSession {
  /** Resolves when the command started the window, and rejects with a PreviewWindowError. */
  readonly opened: Promise<WindowOpened>;
  /** Counts `bytes` of the fMP4 as appended, so Rust may read more (ADR 046 credit). */
  readonly ack: (bytes: number) => void;
  /** Stops the window. Later output of it is dropped. */
  readonly close: () => void;
  readonly isClosed: () => boolean;
}

/** The narrow surface of a Tauri channel that the client needs. */
export interface WindowChannel {
  onmessage: (message: unknown) => void;
}

export interface WindowClientOptions {
  readonly invoke?: InvokeFn;
  readonly createChannel?: () => WindowChannel;
  /** The clock of the request numbers, in milliseconds since the Unix epoch. */
  readonly now?: () => number;
  /** Reports an acknowledgement or a close that failed, which the window survives. */
  readonly onBackgroundError?: (error: unknown) => void;
}

/** The last request number of each lane. */
const lastSequence: Record<WindowLane, number> = { video: 0, audio: 0 };

/**
 * The next request number of a lane: microseconds since the Unix epoch, or one more than the
 * last number when that is higher, so it always rises.
 */
export function nextSequence(lane: WindowLane, now: () => number = Date.now): number {
  const next = Math.max(Math.floor(now() * 1000), lastSequence[lane] + 1);
  lastSequence[lane] = next;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The end message of a window, or null when the message does not have its shape. */
export function parseWindowEnd(message: unknown): WindowEnd | null {
  if (!isRecord(message) || message.type !== "end") {
    return null;
  }
  const { status, reachedEnd, next, bytesRead, nonMonotonic, damaged, detail } =
    message;
  if (status !== "complete" && status !== "canceled" && status !== "failed") {
    return null;
  }
  if (
    typeof reachedEnd !== "boolean" ||
    typeof nonMonotonic !== "boolean" ||
    typeof damaged !== "boolean" ||
    !isCount(bytesRead)
  ) {
    return null;
  }
  let resume: ResumePoint | null = null;
  if (next !== null && next !== undefined) {
    if (!isRecord(next) || !isCount(next.offset) || !Number.isSafeInteger(next.ptsMs)) {
      return null;
    }
    resume = { offset: next.offset, ptsMs: next.ptsMs as number };
  }
  if (detail !== null && detail !== undefined && typeof detail !== "string") {
    return null;
  }
  return {
    status,
    reachedEnd,
    next: resume,
    bytesRead,
    nonMonotonic,
    damaged,
    detail: detail ?? null,
  };
}

/** The reply of the command, or null when it does not have its shape. */
export function parseWindowOpened(reply: unknown): WindowOpened | null {
  if (
    !isRecord(reply) ||
    !isCount(reply.windowId) ||
    typeof reply.nonMonotonic !== "boolean"
  ) {
    return null;
  }
  const method = reply.method ?? null;
  if (method !== null && typeof method !== "string") {
    return null;
  }
  const firstKeyframePtsMs = optionalNumber(reply.firstKeyframePtsMs);
  const pcmStartSeconds = optionalNumber(reply.pcmStartSeconds);
  const seekSeconds = optionalNumber(reply.seekSeconds);
  if (
    firstKeyframePtsMs === undefined ||
    pcmStartSeconds === undefined ||
    seekSeconds === undefined
  ) {
    return null;
  }
  return {
    windowId: reply.windowId,
    method,
    nonMonotonic: reply.nonMonotonic,
    firstKeyframePtsMs,
    pcmStartSeconds,
    seekSeconds,
  };
}

/** The error of a rejected command, as a PreviewWindowError. */
export function toPreviewWindowError(error: unknown): PreviewWindowError {
  if (error instanceof PreviewWindowError) {
    return error;
  }
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    ERROR_CODES.has(error.code)
  ) {
    const detail = typeof error.detail === "string" ? error.detail : null;
    return new PreviewWindowError(error.code as PreviewWindowErrorCode, detail);
  }
  return new PreviewWindowError(
    "commandExecutionFailed",
    error instanceof Error ? error.message : String(error),
  );
}

/** The bytes of a raw channel message, or null for a JSON message. */
function rawBytes(message: unknown): Uint8Array<ArrayBuffer> | null {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    const { buffer, byteOffset, byteLength } = message;
    // A SourceBuffer takes no view of shared memory, so such a view is copied.
    return buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, byteOffset, byteLength)
      : new Uint8Array(new Uint8Array(buffer, byteOffset, byteLength));
  }
  return null;
}

function defaultChannel(): WindowChannel {
  return new Channel<unknown>();
}

/**
 * Requests a window and returns its session at once. The listener gets the output in order
 * until the end message, or until `close`.
 */
export function openPreviewWindow(
  request: WindowRequest,
  listener: WindowListener,
  options: WindowClientOptions = {},
): WindowSession {
  const invoke = options.invoke;
  const createChannel = options.createChannel ?? defaultChannel;
  const reportBackground =
    options.onBackgroundError ??
    ((error: unknown) => {
      console.warn("preview: a window request failed", error);
    });
  let closed = false;
  let windowId: number | null = null;
  let pendingAck = 0;
  let videoEnded = false;
  let pcmEnded = false;

  const send = (command: "ack" | "close", args: Record<string, unknown>): void => {
    const name =
      command === "ack"
        ? BACKEND_COMMANDS.ACK_PREVIEW_WINDOW
        : BACKEND_COMMANDS.CLOSE_PREVIEW_WINDOW;
    invokeCommand<void>(name, args, invoke).catch(reportBackground);
  };

  const channel = createChannel();
  channel.onmessage = (message) => {
    if (closed || videoEnded) {
      return;
    }
    const bytes = rawBytes(message);
    if (bytes !== null) {
      listener.onChunk(bytes);
      return;
    }
    const end = parseWindowEnd(message) ?? {
      status: "failed",
      reachedEnd: false,
      next: null,
      bytesRead: 0,
      nonMonotonic: false,
      damaged: false,
      detail: "invalidResponse",
    };
    videoEnded = true;
    listener.onEnd(end);
  };
  const audioChannel = createChannel();
  audioChannel.onmessage = (message) => {
    if (closed || pcmEnded) {
      return;
    }
    const bytes = rawBytes(message);
    if (bytes !== null) {
      listener.onPcmChunk?.(bytes);
      return;
    }
    pcmEnded = true;
    const end = parseWindowEnd(message);
    if (end !== null) {
      listener.onPcmEnd?.(end);
    }
  };

  const opened = invokeCommand<unknown>(
    BACKEND_COMMANDS.OPEN_PREVIEW_WINDOW,
    {
      request: { ...request, sequence: nextSequence(request.lane, options.now) },
      channel,
      audioChannel,
    },
    invoke,
  ).then(
    (reply) => {
      const parsed = parseWindowOpened(reply);
      if (parsed === null) {
        throw new PreviewWindowError("invalidResponse");
      }
      windowId = parsed.windowId;
      if (closed) {
        send("close", { windowId });
      } else if (pendingAck > 0) {
        send("ack", { windowId, bytes: pendingAck });
        pendingAck = 0;
      }
      return parsed;
    },
    (error: unknown) => {
      throw toPreviewWindowError(error);
    },
  );

  return {
    opened,
    ack: (bytes) => {
      if (closed || !isCount(bytes) || bytes === 0) {
        return;
      }
      if (windowId === null) {
        pendingAck += bytes;
      } else {
        send("ack", { windowId, bytes });
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (windowId !== null) {
        send("close", { windowId });
      }
    },
    isClosed: () => closed,
  };
}
