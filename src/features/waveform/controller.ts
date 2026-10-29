/**
 * Starts, cancels and hides the envelope of a source (ADR 056).
 *
 * `show` builds the request from the import result of the source and starts one job. The data of
 * the job goes into the data registry, and its state into the store. The end of the job follows
 * the table "The end of a job" of ADR 056:
 *
 * - `complete`: the envelope shows, with the flags of the end.
 * - `canceled`: the page drops the data, and the source is idle again.
 * - `failed`: the page drops the data and shows the error.
 *
 * Each job of a source has a token. A message of a job that is no longer the current job of its
 * source changes nothing, so a late end of an older job cannot end a newer one.
 */

import type { StoreApi } from "zustand/vanilla";
import type { ImportMediaResult } from "@/features/media/types";
import { startWaveform, type WaveformHandlers, type WaveformJob } from "./client";
import { waveformData, type WaveformDataRegistry } from "./data";
import { waveformStore, selectWaveformSource, type WaveformStore } from "./store";
import {
  WAVEFORM_BUCKET_RATE,
  WaveformError,
  type WaveformEnd,
  type WaveformProgress,
  type WaveformRequest,
} from "./types";

/** The part of the media store that the controller reads. */
export interface WaveformMediaSources {
  readonly sources: Readonly<Record<string, ImportMediaResult>>;
}

export interface WaveformControllerDependencies {
  readonly start?: (
    request: WaveformRequest,
    handlers: WaveformHandlers,
  ) => WaveformJob;
  readonly mediaStore: Pick<StoreApi<WaveformMediaSources>, "getState">;
  readonly data?: WaveformDataRegistry;
  readonly store?: WaveformStore;
  /** Milliseconds since the Unix epoch, for the request numbers. */
  readonly now?: () => number;
}

export interface WaveformController {
  /** Starts the envelope of a source. Returns false when it starts nothing. */
  show: (sourceId: string) => boolean;
  /** Cancels the job of a source. Its end message returns the source to idle. */
  cancel: (sourceId: string) => void;
  /** Drops the envelope of a source that does not run, and returns it to idle. */
  hide: (sourceId: string) => void;
  dismissNotice: (sourceId: string) => void;
}

/** The request of a source, or null when the source has no audio or no start PTS. */
export function buildWaveformRequest(media: ImportMediaResult): WaveformRequest | null {
  const { probe } = media;
  if (probe.audio === null || probe.videoStartPts === null) {
    return null;
  }
  return {
    path: media.path,
    size: media.size,
    mtime: media.mtime,
    audioStreamIndex: probe.audio.index,
    videoStartPts: probe.videoStartPts,
    videoTimeBase: probe.videoTimeBase,
    durationSeconds: probe.approximateDurationSeconds,
  };
}

/**
 * The part of a job that is done: the bytes read against the size when Rust sends them, as it
 * does for an FLV, whose envelope can jump or start again; else the buckets against the
 * duration when the probe has one; else null.
 */
export function waveformProgressFraction(
  progress: WaveformProgress,
  durationSeconds: number | null,
): number | null {
  let fraction: number | null = null;
  if (
    progress.bytesRead !== null &&
    progress.totalBytes !== null &&
    progress.totalBytes > 0
  ) {
    fraction = progress.bytesRead / progress.totalBytes;
  } else if (
    durationSeconds !== null &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    fraction = progress.highWater / (durationSeconds * WAVEFORM_BUCKET_RATE);
  }
  return fraction === null ? null : Math.min(1, Math.max(0, fraction));
}

interface CurrentJob {
  readonly token: number;
  job: WaveformJob | null;
  cancelRequested: boolean;
}

export function createWaveformController(
  dependencies: WaveformControllerDependencies,
): WaveformController {
  const now = dependencies.now;
  const start =
    dependencies.start ??
    ((request: WaveformRequest, handlers: WaveformHandlers) =>
      startWaveform(request, handlers, { now }));
  const data = dependencies.data ?? waveformData;
  const store = dependencies.store ?? waveformStore;
  const current = new Map<string, CurrentJob>();
  let nextToken = 0;

  const isCurrent = (sourceId: string, token: number): boolean =>
    current.get(sourceId)?.token === token;

  const end = (sourceId: string, token: number, outcome: WaveformEnd): void => {
    const entry = current.get(sourceId);
    if (entry === undefined || entry.token !== token) {
      return;
    }
    current.delete(sourceId);
    // A cache hit cannot be canceled in Rust, so a cancel of the user drops its data here.
    if (outcome.status === "complete" && !entry.cancelRequested) {
      store.getState().finish(sourceId, {
        phase: "ready",
        cached: outcome.cached,
        flags: outcome.flags,
      });
      return;
    }
    data.drop(sourceId);
    if (outcome.status !== "failed") {
      store.getState().finish(sourceId, { phase: "idle" });
    } else {
      store.getState().finish(sourceId, {
        phase: "failed",
        errorCode: outcome.code ?? "invalidResponse",
        errorDetail: outcome.detail,
      });
    }
  };

  return {
    show: (sourceId) => {
      const state = store.getState();
      if (
        state.runningSourceId !== null ||
        selectWaveformSource(state, sourceId).phase === "ready"
      ) {
        return false;
      }
      const media = dependencies.mediaStore.getState().sources[sourceId];
      const request = media === undefined ? null : buildWaveformRequest(media);
      if (request === null) {
        return false;
      }
      const token = ++nextToken;
      const entry: CurrentJob = { token, job: null, cancelRequested: false };
      current.set(sourceId, entry);
      data.reset(sourceId);
      state.begin(sourceId);

      const job = start(request, {
        onChunk: (chunk) => {
          if (isCurrent(sourceId, token)) {
            data.write(sourceId, chunk.startBucket, chunk.pairs);
          }
        },
        onProgress: (progress) => {
          if (isCurrent(sourceId, token)) {
            store
              .getState()
              .setProgress(
                sourceId,
                waveformProgressFraction(progress, request.durationSeconds),
              );
          }
        },
        onEnd: (outcome) => {
          end(sourceId, token, outcome);
        },
      });
      // The end can come before `start` returns, for a cache hit.
      if (!isCurrent(sourceId, token)) {
        job.close();
        job.started.catch(() => undefined);
        return true;
      }
      entry.job = job;
      if (entry.cancelRequested) {
        job.cancel();
      }
      job.started.then(
        (started) => {
          if (isCurrent(sourceId, token)) {
            store.getState().setCached(sourceId, started.cached);
          }
        },
        (error: unknown) => {
          job.close();
          if (!isCurrent(sourceId, token)) {
            return;
          }
          current.delete(sourceId);
          data.drop(sourceId);
          // A cancel of the user wins over the refusal that raced it.
          if (entry.cancelRequested) {
            store.getState().finish(sourceId, { phase: "idle" });
            return;
          }
          const failure =
            error instanceof WaveformError
              ? error
              : new WaveformError("commandExecutionFailed", String(error));
          store.getState().finish(sourceId, {
            phase: "failed",
            errorCode: failure.code,
            errorDetail: failure.detail,
          });
        },
      );
      return true;
    },

    cancel: (sourceId) => {
      const entry = current.get(sourceId);
      if (entry === undefined || entry.cancelRequested) {
        return;
      }
      entry.cancelRequested = true;
      entry.job?.cancel();
    },

    hide: (sourceId) => {
      if (current.has(sourceId)) {
        return;
      }
      data.drop(sourceId);
      store.getState().reset(sourceId);
    },

    dismissNotice: (sourceId) => {
      store.getState().dismissNotice(sourceId);
    },
  };
}
