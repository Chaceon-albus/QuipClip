/**
 * Pure rules for the FFmpeg tab of the settings dialog: where the FFmpeg in use comes from,
 * which controls the tab shows, where the focus goes when a control finishes its action,
 * which icon the status line carries, what the screen reader announcement says, and which
 * install instructions a missing FFmpeg gets.
 *
 * The status line and its detail come from `presentFfmpegStatus`. This module decides only
 * what the tab adds around them. Like the other presenters, it returns catalog keys and never
 * calls the i18n runtime. See ADR 005, ADR 006, ADR 011, and ADR 012.
 */

import type {
  FfmpegStatusDetailEntry,
  FfmpegStatusLineKey,
  FfmpegStatusView,
} from "@/components/layout/ffmpegStatusPresenter";
import type { FfmpegState, FfmpegStatus } from "@/features/ffmpeg/types";
import { isSameDisplayPath, stripVerbatimPrefix } from "@/lib/fileName";
import type { FfmpegPathView } from "./ffmpegPathController";
import {
  canTakeFocus,
  isFocusLost,
  type FocusHolderProbe,
  type PromptFocusTarget,
} from "./presetDraftGuard";

/** The platform whose install instructions and PATH rules apply. */
export type FfmpegPlatform = "macos" | "windows" | "other";

/** Maps the results of `isMacOS()` and `isWindows()` to one platform. */
export function toFfmpegPlatform(macOS: boolean, windows: boolean): FfmpegPlatform {
  if (macOS) {
    return "macos";
  }
  if (windows) {
    return "windows";
  }
  return "other";
}

// ---------------------------------------------------------------------------------------
// Where FFmpeg comes from
// ---------------------------------------------------------------------------------------

export type FfmpegOriginKey =
  | "settings.ffmpeg.origin.path"
  | "settings.ffmpeg.origin.pathMac"
  | "settings.ffmpeg.origin.appData";

/**
 * The sentence that says where automatic detection found FFmpeg.
 *
 * The backend reports one of three origin classes and nothing finer. On macOS it gives the
 * standard Homebrew folders the same `path` origin as the folders of the process `PATH`
 * (ADR 012), so the macOS sentence names both and never claims which one held the program.
 */
export function automaticOriginKey(
  origin: "path" | "appData",
  platform: FfmpegPlatform,
): FfmpegOriginKey {
  if (origin === "appData") {
    return "settings.ffmpeg.origin.appData";
  }
  return platform === "macos"
    ? "settings.ffmpeg.origin.pathMac"
    : "settings.ffmpeg.origin.path";
}

/** An FFmpeg that automatic detection found, and the sentence that says where. */
export type AutomaticFfmpeg = {
  /** The program path for display, without the Windows verbatim prefix. */
  path: string;
  originKey: FfmpegOriginKey;
};

/** The part of the ffmpeg store that the location block reads. */
export type FfmpegSourceState = Pick<FfmpegState, "status" | "paths" | "origin">;

/**
 * What the "FFmpeg in Use" block says. Each kind claims only what the store knows: a program
 * shows as in use only after discovery accepted it.
 */
export type FfmpegSourceView =
  /** Discovery is still running, so no program is known yet. */
  | { kind: "locating" }
  /** No user path is known, and discovery found this FFmpeg. */
  | ({ kind: "automatic" } & AutomaticFfmpeg)
  /** No user path is known, and discovery found no FFmpeg in any location. */
  | { kind: "notDetected" }
  /**
   * The check stopped before discovery reported a program, for example because the
   * application data folder is unavailable. No program is known. The status block gives the
   * reason. `chosenPath` is the user path, or null when none is known.
   */
  | { kind: "unknown"; chosenPath: string | null }
  /**
   * No user path is set, and the last result came from a user path that the settings no
   * longer hold. The next probe replaces that result.
   */
  | { kind: "unset" }
  | {
      kind: "user";
      /**
       * The path that the user chose, as the settings hold it. Null before the settings
       * load: the store knows only the program that the chosen path resolved to.
       */
      path: string | null;
      /**
       * The program that the chosen path resolved to, for display, when it is not the same
       * path. A chosen folder, or a file behind a symbolic link, resolves to another path.
       */
      programPath: string | null;
    }
  /**
   * A user path is set, but it holds no usable pair, so discovery moved on to the next
   * location in the ADR 005 order. The FFmpeg that it found there is the one in use.
   */
  | ({ kind: "fallback"; chosenPath: string } & AutomaticFfmpeg)
  /**
   * A user path is set, and discovery accepted no candidate: not the chosen path, and no
   * other location. No FFmpeg is in use.
   */
  | { kind: "unusable"; chosenPath: string };

function automaticResult(
  ffmpeg: FfmpegSourceState,
  platform: FfmpegPlatform,
): AutomaticFfmpeg | null {
  if (
    ffmpeg.paths === null ||
    ffmpeg.origin === null ||
    ffmpeg.origin === "configured"
  ) {
    return null;
  }
  return {
    path: stripVerbatimPrefix(ffmpeg.paths.ffmpeg),
    originKey: automaticOriginKey(ffmpeg.origin, platform),
  };
}

/**
 * Says where the FFmpeg in use comes from.
 *
 * The settings give the user path. The ffmpeg store gives the program that discovery
 * resolved and its origin class. A user path that holds no usable pair does not stop
 * discovery: the backend moves on to `PATH` and the application data folder, so the view then
 * reports the fallback that is in use.
 *
 * The backend returns canonical paths, which on Windows carry the verbatim prefix `\\?\`.
 * The view shows each program path without it. On Windows it also compares the chosen path
 * with the program path in the other forms of one path (see `isSameDisplayPath`).
 *
 * The view follows the store, also while a choose, a clear, or a check is in flight. `path`
 * comes from `FfmpegPathController`, which keeps the shown path fixed while an operation runs
 * and gives the new path only after it started the probe that checks it. So while the file
 * picker is open and while the save runs, the path and the store result both belong to the
 * path that was checked last, and the result stays true.
 *
 * Before the settings load, the view says what the store knows. It never claims that no user
 * path is set.
 */
export function presentFfmpegSource(
  path: FfmpegPathView,
  ffmpeg: FfmpegSourceState,
  platform: FfmpegPlatform,
): FfmpegSourceView {
  const detected = automaticResult(ffmpeg, platform);
  const locating = ffmpeg.status === "idle" || ffmpeg.status === "locating";

  if (path.ready && path.path !== null) {
    const chosenPath = path.path;
    if (locating) {
      return { kind: "locating" };
    }
    // `missing` means that discovery accepted no candidate, the chosen path included.
    if (ffmpeg.status === "missing") {
      return { kind: "unusable", chosenPath };
    }
    if (ffmpeg.origin === "configured" && ffmpeg.paths !== null) {
      const program = stripVerbatimPrefix(ffmpeg.paths.ffmpeg);
      const programPath = isSameDisplayPath(program, chosenPath, platform === "windows")
        ? null
        : program;
      return { kind: "user", path: chosenPath, programPath };
    }
    if (detected !== null) {
      return { kind: "fallback", chosenPath, ...detected };
    }
    return { kind: "unknown", chosenPath };
  }

  if (locating) {
    return { kind: "locating" };
  }

  if (detected !== null) {
    return { kind: "automatic", ...detected };
  }

  if (ffmpeg.origin === "configured" && ffmpeg.paths !== null) {
    // The settings are not loaded yet, so the store is the only source. It says that the
    // program came from a user path, but it holds the program, not the path that the user
    // chose, which can be a folder. So the view shows the program as the program.
    if (!path.ready) {
      return {
        kind: "user",
        path: null,
        programPath: stripVerbatimPrefix(ffmpeg.paths.ffmpeg),
      };
    }
    // Also while an operation is in flight: a choose or a check that starts here keeps this
    // state while the file picker is open, and a probe that starts shows `locating` above.
    return { kind: "unset" };
  }

  if (ffmpeg.status === "missing") {
    return { kind: "notDetected" };
  }

  // The check stopped before discovery reported a program.
  return { kind: "unknown", chosenPath: null };
}

// ---------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------

export type FfmpegSectionActions = {
  /** Choose File... and Choose Folder... */
  chooseDisabled: boolean;
  /** Null when no user path is set, because automatic detection is then already in use. */
  useAutomatic: { disabled: boolean } | null;
  /** Check Again. */
  reprobeDisabled: boolean;
};

/**
 * Which controls the tab shows, and which of them are disabled.
 *
 * Every control is disabled while the settings are not loaded, and while a choose, a clear,
 * or a check is in flight. Check Again is also disabled while a probe that started elsewhere
 * still runs: a new probe adds nothing to a probe in progress.
 */
export function presentFfmpegActions(
  path: FfmpegPathView,
  status: FfmpegStatus,
): FfmpegSectionActions {
  const blocked = !path.ready || path.pending;
  return {
    chooseDisabled: blocked,
    useAutomatic: path.path !== null ? { disabled: blocked } : null,
    reprobeDisabled: blocked || status === "locating" || status === "probing",
  };
}

/** The control that started the last action of the tab. */
export type FfmpegSectionControl =
  "chooseFolder" | "chooseFile" | "useAutomatic" | "reprobe";

/**
 * True when the action that `control` started has ended.
 *
 * A choose or a clear ends when the controller is no longer pending. Check Again ends later,
 * when the probe that it started ends and the button is enabled again.
 */
export function hasFfmpegControlActionEnded(
  control: FfmpegSectionControl,
  pending: boolean,
  reprobeDisabled: boolean,
): boolean {
  if (pending) {
    return false;
  }
  return control !== "reprobe" || !reprobeDisabled;
}

/**
 * Returns the control that takes the focus when an action of the tab ends, or null when the
 * focus must stay where it is.
 *
 * Every control of the tab is disabled while its action runs. A disabled button loses the
 * focus to the document body, and the Radix focus scope of the modal dialog then moves it to
 * the dialog element. So the focus is lost (see `isFocusLost`) when the action ends, and the
 * control that started the action takes it back. Use Automatic Detection is gone after a
 * clear that succeeded, so Choose Folder, the first control of the tab, takes the focus then.
 *
 * The focus cannot move to Choose Folder when the clear starts instead: Choose Folder is
 * disabled for the whole clear too, so it would lose the focus at once.
 *
 * When the focus is on a control, the user moved it there while the action ran, and it
 * stays there.
 */
export function pickFfmpegActionEndFocus<T extends PromptFocusTarget>(
  started: T | null,
  fallback: T | null,
  active: FocusHolderProbe | null,
): T | null {
  if (!isFocusLost(active)) {
    return null;
  }
  if (canTakeFocus(started)) {
    return started;
  }
  return canTakeFocus(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------------------
// Status block
// ---------------------------------------------------------------------------------------

/** The statuses in which discovery or the capability probe runs. */
export type FfmpegBusyStatus = Extract<FfmpegStatus, "idle" | "locating" | "probing">;

/** True while discovery or the capability probe runs. */
export function isFfmpegStatusBusy(status: FfmpegStatus): status is FfmpegBusyStatus {
  return status === "idle" || status === "locating" || status === "probing";
}

export type FfmpegStatusIcon = "spinner" | "check" | "warning";

/**
 * The icon in front of the status line. The icon shape carries the state, so the colour of
 * the line is never the only cue.
 */
export function ffmpegStatusIcon(
  status: FfmpegStatus,
  tone: FfmpegStatusView["tone"],
): FfmpegStatusIcon {
  if (isFfmpegStatusBusy(status)) {
    return "spinner";
  }
  return tone === "ready" ? "check" : "warning";
}

const SEARCHED_KEY_PREFIX = "ffmpeg.detail.searchedPair.";

/**
 * Splits the status detail into the entries that explain the state and the list of searched
 * locations. The tab shows the install instructions between the two, because the searched
 * list names every `PATH` folder and can be long.
 */
export function splitFfmpegStatusDetail(detail: readonly FfmpegStatusDetailEntry[]): {
  leading: FfmpegStatusDetailEntry[];
  searched: FfmpegStatusDetailEntry[];
} {
  const leading: FfmpegStatusDetailEntry[] = [];
  const searched: FfmpegStatusDetailEntry[] = [];
  for (const entry of detail) {
    (entry.key.startsWith(SEARCHED_KEY_PREFIX) ? searched : leading).push(entry);
  }
  return { leading, searched };
}

// ---------------------------------------------------------------------------------------
// Screen reader announcement
// ---------------------------------------------------------------------------------------

/** One stage of the check, as the announcement reports it. */
export type FfmpegAnnouncementPhase = "checking" | "ready" | "missing" | "failed";

export type FfmpegAnnouncement = {
  phase: FfmpegAnnouncementPhase;
  key: "settings.ffmpeg.checking" | FfmpegStatusLineKey;
  values: Record<string, string>;
};

/**
 * What the live region of the tab says for the current state.
 *
 * Locating and each step of the probe are one phase, with one constant message, so the
 * encoder count that the visible line updates is not read at each step. A finished check
 * says the complete status line.
 */
export function presentFfmpegAnnouncement(
  status: FfmpegStatus,
  view: Pick<FfmpegStatusView, "lineKey" | "lineValues">,
): FfmpegAnnouncement {
  if (isFfmpegStatusBusy(status)) {
    return { phase: "checking", key: "settings.ffmpeg.checking", values: {} };
  }
  return {
    phase: status,
    key: view.lineKey,
    values: view.lineValues,
  };
}

/**
 * Returns the announcement to put in the live region, or null when the region keeps what it
 * says. The region changes only when the phase changes. `previous` is the phase that the tab
 * saw last. When the tab opens, it sees the phase of that moment and announces nothing, because
 * the visible status line already shows it.
 */
export function nextFfmpegAnnouncement(
  previous: FfmpegAnnouncementPhase,
  current: FfmpegAnnouncement,
): FfmpegAnnouncement | null {
  return current.phase === previous ? null : current;
}

// ---------------------------------------------------------------------------------------
// Install instructions
// ---------------------------------------------------------------------------------------

export const HOMEBREW_INSTALL_COMMAND = "brew install ffmpeg";
export const HOMEBREW_URL = "https://brew.sh";
// `-e` matches the package identifier exactly. `--source winget` searches only the winget
// community repository, not the Microsoft Store source.
export const WINGET_INSTALL_COMMAND =
  "winget install -e --id Gyan.FFmpeg --source winget";

export type FfmpegInstallGuide =
  | {
      platform: "macos";
      /** Homebrew must be installed first. The message takes the URL as `{{url}}`. */
      prerequisiteKey: "settings.ffmpeg.install.macPrerequisite";
      url: typeof HOMEBREW_URL;
      introKey: "settings.ffmpeg.install.macIntro";
      command: typeof HOMEBREW_INSTALL_COMMAND;
      afterKey: "settings.ffmpeg.install.macAfter";
    }
  | {
      platform: "windows";
      introKey: "settings.ffmpeg.install.windowsIntro";
      command: typeof WINGET_INSTALL_COMMAND;
      afterKey: "settings.ffmpeg.install.windowsAfter";
    };

/**
 * The install instructions for a missing FFmpeg, for the current platform only. Null in every
 * other state, and on a platform that has no instructions. The fields are in display order.
 *
 * What to do after the install follows from discovery (`locate.rs`). Discovery reads `PATH`
 * from the environment of the QuipClip process, and that environment does not change after the
 * process starts.
 *
 * - macOS: discovery always adds `/opt/homebrew/bin` and `/usr/local/bin` after the `PATH`
 *   folders (ADR 012). A Homebrew install with the standard prefix links `ffmpeg` and
 *   `ffprobe` into one of the two, so Check Again finds them with no restart.
 * - Windows: winget can add a folder to `PATH`. The running process does not see that change,
 *   so QuipClip must start again. A start from the Start menu gets the new `PATH`. A start
 *   from a terminal that was open before the install gets the old one.
 */
export function presentFfmpegInstallGuide(
  status: FfmpegStatus,
  platform: FfmpegPlatform,
): FfmpegInstallGuide | null {
  if (status !== "missing") {
    return null;
  }
  switch (platform) {
    case "macos":
      return {
        platform: "macos",
        prerequisiteKey: "settings.ffmpeg.install.macPrerequisite",
        url: HOMEBREW_URL,
        introKey: "settings.ffmpeg.install.macIntro",
        command: HOMEBREW_INSTALL_COMMAND,
        afterKey: "settings.ffmpeg.install.macAfter",
      };
    case "windows":
      return {
        platform: "windows",
        introKey: "settings.ffmpeg.install.windowsIntro",
        command: WINGET_INSTALL_COMMAND,
        afterKey: "settings.ffmpeg.install.windowsAfter",
      };
    case "other":
      return null;
  }
}
