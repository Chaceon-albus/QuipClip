/**
 * The state of the download of FFmpeg in the Settings window (ADR 059): the offer that Rust
 * gives, and the one install that the window runs.
 *
 * The state goes into no file and no web view storage. A reload or a close of the Settings
 * window cancels the install in Rust, and the new page starts from `idle`.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ffmpegStore } from "../store";
import {
  ffmpegDownloadOffer,
  startFfmpegInstall,
  type FfmpegInstallHandlers,
  type FfmpegInstallJob,
} from "./client";
import { toFfmpegInstallError } from "./protocol";
import type {
  FfmpegDownloadOffer,
  FfmpegInstallEnd,
  FfmpegInstallErrorCode,
  FfmpegInstallPhase,
} from "./types";

/** The offer, as the tab knows it. */
export type FfmpegOfferState =
  /** Not asked yet. */
  | { readonly status: "idle" }
  /**
   * Asked again. `previous` is the offer of the last answer, which the tab keeps showing: the
   * answer can take some seconds, for the version check of a pair in `bin`.
   */
  | { readonly status: "loading"; readonly previous: FfmpegDownloadOffer | null }
  /** Rust answered. A null offer means that the tab may not offer the download. */
  | { readonly status: "ready"; readonly offer: FfmpegDownloadOffer | null }
  | {
      readonly status: "failed";
      readonly code: FfmpegInstallErrorCode;
      readonly detail: string | null;
    };

/** The install, as the tab shows it. */
export type FfmpegInstallState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      /** Null until the first progress message, while Rust prepares the install. */
      readonly phase: FfmpegInstallPhase | null;
      readonly received: number | null;
      readonly total: number | null;
      /** True after the user asked for the cancel, until the end message comes. */
      readonly cancelRequested: boolean;
    }
  | { readonly status: "installed" }
  | { readonly status: "canceled" }
  | {
      readonly status: "failed";
      readonly code: FfmpegInstallErrorCode;
      readonly detail: string | null;
    };

export interface FfmpegInstallStoreState {
  readonly offer: FfmpegOfferState;
  readonly install: FfmpegInstallState;
  /**
   * Asks Rust for the offer again. The newest request wins. It does nothing while an install
   * runs: the offer runs the version check of a pair in `bin`, and on Windows a running
   * program cannot be replaced.
   */
  loadOffer: () => Promise<void>;
  /**
   * Starts the install of the offer that the tab shows. Returns false, and does nothing, when
   * an install runs or when the tab has no offer.
   */
  startInstall: () => boolean;
  /** Asks Rust to cancel the running install. The end message then sets `canceled`. */
  cancelInstall: () => void;
  /** Returns an install that ended to `idle`, so the tab no longer shows its result. */
  dismissResult: () => void;
}

/** Collaborators of the store. Tests give fakes. */
export interface FfmpegInstallStoreDependencies {
  readonly loadOffer?: () => Promise<FfmpegDownloadOffer | null>;
  readonly startInstall?: (handlers: FfmpegInstallHandlers) => FfmpegInstallJob;
  /** Starts the capability probe. Defaults to `ffmpegStore.getState().startProbe`. */
  readonly startProbe?: (force?: boolean) => Promise<unknown>;
}

const IDLE_OFFER: FfmpegOfferState = { status: "idle" };
const IDLE_INSTALL: FfmpegInstallState = { status: "idle" };

/**
 * The offer that the tab shows: the answer, or the last answer while Rust answers again. Rust
 * checks the rule again when an install starts, so a start from the last answer is safe.
 */
export function shownFfmpegOffer(offer: FfmpegOfferState): FfmpegDownloadOffer | null {
  switch (offer.status) {
    case "ready":
      return offer.offer;
    case "loading":
      return offer.previous;
    case "idle":
    case "failed":
      return null;
  }
}

export function createFfmpegInstallStore(
  dependencies: FfmpegInstallStoreDependencies = {},
): StoreApi<FfmpegInstallStoreState> {
  const loadOfferFn = dependencies.loadOffer ?? (() => ffmpegDownloadOffer());
  const startInstallFn =
    dependencies.startInstall ?? ((handlers) => startFfmpegInstall(handlers));
  const startProbeFn =
    dependencies.startProbe ?? ((force) => ffmpegStore.getState().startProbe(force));

  let offerRequest = 0;
  // The install that the state shows. A callback of another install changes nothing.
  let current: FfmpegInstallJob | null = null;

  return createStore<FfmpegInstallStoreState>()((set, get) => {
    const loadOffer = async (): Promise<void> => {
      if (get().install.status === "running") {
        return;
      }
      const request = ++offerRequest;
      set({ offer: { status: "loading", previous: shownFfmpegOffer(get().offer) } });
      try {
        const offer = await loadOfferFn();
        if (request === offerRequest) {
          set({ offer: { status: "ready", offer } });
        }
      } catch (error) {
        if (request === offerRequest) {
          const { code, detail } = toFfmpegInstallError(error);
          set({ offer: { status: "failed", code, detail } });
        }
      }
    };

    const probe = (): void => {
      startProbeFn(true).catch((error: unknown) => {
        console.warn("ffmpeg install: the probe after the install failed", error);
      });
    };

    /** The install ended: show its result, and read again what changed with it. */
    const finish = (install: FfmpegInstallState): void => {
      current = null;
      set({ install });
      if (install.status === "installed") {
        // The new pair is in `bin`, so the probe finds it. A forced probe reaches the main
        // window too (ADR 038).
        probe();
      } else if (install.status === "failed" && install.code === "alreadyFound") {
        // Discovery finds a pair that the status of the tab does not know yet.
        probe();
      }
      void loadOffer();
    };

    const endState = (end: FfmpegInstallEnd): FfmpegInstallState => {
      switch (end.outcome) {
        case "installed":
          return { status: "installed" };
        case "canceled":
          return { status: "canceled" };
        case "failed":
          return { status: "failed", code: end.code, detail: end.detail };
      }
    };

    return {
      offer: IDLE_OFFER,
      install: IDLE_INSTALL,
      loadOffer,
      startInstall: () => {
        const { offer, install } = get();
        if (install.status === "running" || shownFfmpegOffer(offer) === null) {
          return false;
        }
        // An answer of an offer request that is in flight must not replace the offer of this
        // install. The offer stays as it is shown.
        offerRequest++;
        if (offer.status === "loading") {
          set({ offer: { status: "ready", offer: offer.previous } });
        }
        set({
          install: {
            status: "running",
            phase: null,
            received: null,
            total: null,
            cancelRequested: false,
          },
        });
        let job: FfmpegInstallJob | null = null;
        let ended = false;
        const isCurrent = () => !ended && current !== null && current === job;
        try {
          job = startInstallFn({
            onProgress: (progress) => {
              if (!isCurrent()) {
                return;
              }
              const install = get().install;
              if (install.status !== "running") {
                return;
              }
              set({ install: { ...install, ...progress } });
            },
            onEnd: (end) => {
              if (!isCurrent()) {
                return;
              }
              ended = true;
              finish(endState(end));
            },
          });
        } catch (error) {
          // No request went out, so no message can come. The state must not stay `running`.
          ended = true;
          const { code, detail } = toFfmpegInstallError(error);
          finish({ status: "failed", code, detail });
          return true;
        }
        current = job;
        job.started.catch((error: unknown) => {
          // A refused request sends no end message.
          if (!isCurrent()) {
            return;
          }
          ended = true;
          const { code, detail } = toFfmpegInstallError(error);
          finish(
            code === "canceled"
              ? { status: "canceled" }
              : { status: "failed", code, detail },
          );
        });
        return true;
      },
      cancelInstall: () => {
        const install = get().install;
        if (
          current === null ||
          install.status !== "running" ||
          install.cancelRequested
        ) {
          return;
        }
        set({ install: { ...install, cancelRequested: true } });
        current.cancel();
      },
      dismissResult: () => {
        if (get().install.status !== "running") {
          set({ install: IDLE_INSTALL });
        }
      },
    };
  });
}

export type FfmpegInstallStore = ReturnType<typeof createFfmpegInstallStore>;

/** The store of the Settings window. */
export const ffmpegInstallStore: FfmpegInstallStore = createFfmpegInstallStore();

/** React hook for the store of the Settings window. */
export function useFfmpegInstallStore<T>(
  selector: (state: FfmpegInstallStoreState) => T,
): T {
  return useStore(ffmpegInstallStore, selector);
}
