/**
 * Mirrors the open file, or the project file, in the native window title.
 *
 * The application draws its own title bar (ADR 020), so the native title is not drawn on
 * either platform. The system still reads it: Mission Control, the Window menu and the Dock
 * menu on macOS, and the task bar thumbnail and Alt+Tab on Windows. On macOS the window keeps
 * `hiddenTitle: true`, and a new title does not make the system draw it.
 *
 * When the project has a file, the title names that file and not the video, with a dot in front
 * for a modified project (ADR 072, "The name in the title").
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StoreApi } from "zustand/vanilla";
import type { MediaStoreState } from "@/features/media";
import {
  createProjectTitleSource,
  type ProjectTitle,
  type ProjectTitleSource,
} from "@/features/project/projectTitle";
import { attachedMediaStore } from "@/features/sequence/attachedMedia";

/**
 * The product name. It is the `title` of the window in `tauri.conf.json` and in each platform
 * configuration file, and a test keeps them equal. The catalogs do not translate it.
 */
export const APP_TITLE = "QuipClip";

/**
 * Pure mapping from the open file name and the title state of the project to the window title.
 * A project with a file gives `<project file name> — QuipClip`, with `• ` in front for a modified
 * project (ADR 072). Otherwise the title names the open file, or the application alone.
 */
export function resolveWindowTitle(
  fileName: string | null | undefined,
  project: ProjectTitle | null = null,
): string {
  if (project !== null) {
    return `${project.modified ? "• " : ""}${project.fileName} — ${APP_TITLE}`;
  }
  return fileName ? `${fileName} — ${APP_TITLE}` : APP_TITLE;
}

export interface WindowTitleSyncOptions {
  /** Defaults to the production `attachedMediaStore`: the file of the clip that the preview shows. */
  store?: StoreApi<MediaStoreState>;
  /**
   * The title state of the project. It follows the project store, the timeline store and the
   * audio overrides. Defaults to the source of the production stores.
   */
  project?: ProjectTitleSource;
  /** Defaults to `(title) => getCurrentWindow().setTitle(title)`. */
  setTitle?: (title: string) => Promise<void>;
  /** Defaults to `isTauri()`. When false, the sync does nothing. */
  enabled?: boolean;
}

/**
 * Subscribes to the media store and to the title state of the project, and mirrors the open file
 * or the project file in the window title. Returns the unsubscribe function.
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
  const store = options.store ?? attachedMediaStore;
  const project = options.project ?? createProjectTitleSource();
  const setTitle =
    options.setTitle ?? ((title: string) => getCurrentWindow().setTitle(title));

  const titleNow = () =>
    resolveWindowTitle(store.getState().media?.fileName ?? null, project.read());

  let latest = titleNow();
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

  const onChange = () => {
    latest = titleNow();
    flush();
  };

  flush();
  const unsubscribeMedia = store.subscribe(onChange);
  const unsubscribeProject = project.subscribe(onChange);
  return () => {
    stopped = true;
    unsubscribeMedia();
    unsubscribeProject();
  };
}
