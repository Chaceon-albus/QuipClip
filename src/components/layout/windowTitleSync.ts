/**
 * Mirrors the open file in the native window title.
 *
 * The application draws its own title bar (ADR 020), so the native title is not drawn on
 * either platform. The system still reads it: Mission Control, the Window menu and the Dock
 * menu on macOS, and the task bar thumbnail and Alt+Tab on Windows. On macOS the window keeps
 * `hiddenTitle: true`, and a new title does not make the system draw it.
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StoreApi } from "zustand/vanilla";
import { mediaStore, type MediaStoreState } from "@/features/media";

/**
 * The product name. It is the `title` of the window in `tauri.conf.json` and in each platform
 * configuration file, and a test keeps them equal. The catalogs do not translate it.
 */
export const APP_TITLE = "QuipClip";

/** Pure mapping from the open file name to the window title. */
export function resolveWindowTitle(fileName: string | null | undefined): string {
  return fileName ? `${fileName} — ${APP_TITLE}` : APP_TITLE;
}

export interface WindowTitleSyncOptions {
  /** Defaults to the production `mediaStore`. */
  store?: StoreApi<MediaStoreState>;
  /** Defaults to `(title) => getCurrentWindow().setTitle(title)`. */
  setTitle?: (title: string) => Promise<void>;
  /** Defaults to `isTauri()`. When false, the sync does nothing. */
  enabled?: boolean;
}

/**
 * Subscribes to the media store and mirrors the open file in the window title. Returns the
 * unsubscribe function.
 *
 * The resolved title is sent once at start, also when no media is open, because a web view
 * reload resets the store while the native title can still name the last file. After that, a
 * call is sent only when the resolved title changes.
 *
 * `setTitle` is an async command, so two calls sent back to back have no guaranteed order. At
 * most one call is in flight. When it settles, the latest resolved title is sent if it differs
 * from the title of the settled call.
 */
export function startWindowTitleSync(options: WindowTitleSyncOptions = {}): () => void {
  if (!(options.enabled ?? isTauri())) {
    return () => {};
  }
  const store = options.store ?? mediaStore;
  const setTitle =
    options.setTitle ?? ((title: string) => getCurrentWindow().setTitle(title));

  const titleOf = (state: MediaStoreState) =>
    resolveWindowTitle(state.media?.fileName ?? null);

  let latest = titleOf(store.getState());
  let sent: string | null = null;
  let inFlight = false;
  let stopped = false;

  function settle(): void {
    inFlight = false;
    if (!stopped) {
      flush();
    }
  }

  function flush(): void {
    if (inFlight || latest === sent) {
      return;
    }
    sent = latest;
    inFlight = true;
    // A missing permission must not break the editor. A failed title is not sent again.
    let pending: Promise<void>;
    try {
      pending = setTitle(latest);
    } catch {
      settle();
      return;
    }
    void pending.then(settle, settle);
  }

  flush();
  const unsubscribe = store.subscribe((state) => {
    latest = titleOf(state);
    flush();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
