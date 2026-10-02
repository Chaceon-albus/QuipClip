/**
 * The colour theme of the interface.
 *
 * The user selects `system`, `light` or `dark` in Settings. `system` follows the
 * `prefers-color-scheme` media query of the web view. The resolved theme toggles the `dark`
 * class on the document root, which selects the dark palette in `globals.css`. It also sets
 * the `color-scheme` of the root, so native controls and scroll bars follow the theme.
 *
 * `public/theme-init.js` applies the same rule before the first paint. It is a plain script
 * and cannot import this module, so it repeats the storage key and the rule.
 * `theme.test.ts` runs that script and compares its result with `resolveTheme`.
 *
 * Inside Tauri, the sync also sets the native window theme, so native context menus, file
 * dialogs and the macOS window buttons match an explicit preference. `system` sets no native
 * theme, and the window follows the system again.
 *
 * In the main window, the sync also sends the resolved theme to `set_window_border_theme`, so
 * the 1 pixel border that Windows 11 draws around the undecorated window takes the `--border`
 * colour of the theme that the page shows. Rust maps the theme to the colour, and does nothing
 * on Windows 10 and on macOS. The Settings window has the frame of the system (ADR 038).
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BACKEND_COMMANDS, invokeCommand } from "./ipc";
import { getCurrentWindowRole } from "./windowRole";

/** The theme that the user selects in Settings. */
export type ThemePreference = "system" | "light" | "dark";

/** The theme that the interface shows. */
export type ResolvedTheme = "light" | "dark";

/** Every theme preference, in the order the settings control lists them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
] as const;

/** The media query that tells whether the system uses a dark appearance. */
export const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** The class on the document root that selects the dark palette. */
export const DARK_THEME_CLASS = "dark";

/** Type guard for a preference that arrives as a plain string, such as a Select value. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * Resolves a preference to the theme the interface shows.
 *
 * @param preference The preference of the user.
 * @param systemPrefersDark True when the system uses a dark appearance. Only `system`
 *   reads it.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

/**
 * The part of the document root that the theme writes. `document.documentElement`
 * satisfies it. Tests inject a plain object instead of a DOM.
 */
export interface ThemeRoot {
  readonly classList: Pick<DOMTokenList, "toggle">;
  readonly style: { colorScheme: string };
}

/**
 * The part of a `MediaQueryList` that the theme reads. The result of
 * `window.matchMedia(DARK_COLOR_SCHEME_QUERY)` satisfies it.
 */
export interface ColorSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** Writes a resolved theme to the document root. */
export function applyResolvedTheme(root: ThemeRoot, theme: ResolvedTheme): void {
  root.classList.toggle(DARK_THEME_CLASS, theme === "dark");
  root.style.colorScheme = theme;
}

export interface ThemeController {
  /**
   * Applies a preference at once. While the preference is `system`, the controller also
   * applies each change of the system appearance.
   */
  setPreference(preference: ThemePreference): void;
  /** Stops following the system appearance. The document root keeps its last theme. */
  dispose(): void;
}

/**
 * Creates a controller that writes the theme to a document root.
 *
 * The controller listens to the media query only while the preference is `system`. A null
 * query reads as a light system.
 *
 * @param onApply Runs after each write with the resolved theme, also when the theme did not
 *   change, so a change of the system appearance reaches it too.
 */
export function createThemeController(
  root: ThemeRoot,
  query: ColorSchemeQuery | null,
  onApply?: (theme: ResolvedTheme) => void,
): ThemeController {
  let preference: ThemePreference = "system";
  let listening = false;

  const apply = () => {
    const theme = resolveTheme(preference, query?.matches ?? false);
    applyResolvedTheme(root, theme);
    onApply?.(theme);
  };

  const listen = (enabled: boolean) => {
    if (!query || enabled === listening) {
      return;
    }
    if (enabled) {
      query.addEventListener("change", apply);
    } else {
      query.removeEventListener("change", apply);
    }
    listening = enabled;
  };

  return {
    setPreference(next) {
      preference = next;
      listen(next === "system");
      apply();
    },
    dispose() {
      listen(false);
    },
  };
}

/** The state that the theme sync reads. The theme preference store satisfies it. */
export interface ThemePreferenceSource {
  getState(): { readonly preference: ThemePreference };
  subscribe(
    listener: (state: { readonly preference: ThemePreference }) => void,
  ): () => void;
}

/**
 * The native window theme: a fixed theme, or null to follow the system. It is the argument
 * of `getCurrentWindow().setTheme`.
 */
export type NativeWindowTheme = ResolvedTheme | null;

/** Sets the native window theme. `getCurrentWindow().setTheme` satisfies it. */
export type SetWindowTheme = (theme: NativeWindowTheme) => Promise<void>;

/**
 * Maps a preference to the native window theme. `system` maps to null, so the window
 * follows the system appearance again.
 */
export function nativeWindowThemeFor(preference: ThemePreference): NativeWindowTheme {
  return preference === "system" ? null : preference;
}

/**
 * Sets the colour of the native window border to the border colour of a resolved theme. The
 * command `set_window_border_theme` satisfies it.
 */
export type SetWindowBorderTheme = (theme: ResolvedTheme) => Promise<void>;

export interface ThemeSyncOptions {
  /** The document root. Undefined uses `document.documentElement`; null does nothing. */
  root?: ThemeRoot | null;
  /** The system query. Undefined uses `window.matchMedia`; null reads as a light system. */
  query?: ColorSchemeQuery | null;
  /**
   * Sets the native window theme. Undefined uses `getCurrentWindow().setTheme` inside Tauri
   * and nothing outside it; null sets nothing.
   */
  setWindowTheme?: SetWindowTheme | null;
  /**
   * Sets the colour of the native window border. Undefined uses `set_window_border_theme`
   * inside Tauri in the main window, and nothing in the Settings window or outside Tauri; null
   * sets nothing.
   */
  setWindowBorderTheme?: SetWindowBorderTheme | null;
}

function getDefaultRoot(): ThemeRoot | null {
  if (typeof document !== "undefined" && document.documentElement) {
    return document.documentElement;
  }
  return null;
}

function getDefaultQuery(): ColorSchemeQuery | null {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia(DARK_COLOR_SCHEME_QUERY);
    }
  } catch {
    // A web view without media queries reads as a light system.
  }
  return null;
}

function getDefaultSetWindowTheme(): SetWindowTheme | null {
  if (!isTauri()) {
    return null;
  }
  return (theme) => getCurrentWindow().setTheme(theme);
}

function getDefaultSetWindowBorderTheme(): SetWindowBorderTheme | null {
  // Only the main window holds the grant of the command (`capabilities/default.json`).
  if (!isTauri() || getCurrentWindowRole() !== "main") {
    return null;
  }
  return (theme) =>
    invokeCommand<void>(BACKEND_COMMANDS.SET_WINDOW_BORDER_THEME, { theme });
}

/**
 * Sends a theme of the native window, such as the native window theme or the border theme,
 * through an async command.
 *
 * Two calls sent back to back have no guaranteed order, so at most one call is in flight.
 * When it settles, the latest theme is sent if it differs from the theme of the settled
 * call. A failure, such as a missing permission, is ignored and is not sent again: the
 * interface theme does not depend on the native one.
 */
function createWindowThemeSender<T extends NativeWindowTheme>(
  setWindowTheme: (theme: T) => Promise<void>,
): {
  send(theme: T): void;
  stop(): void;
} {
  // Undefined means that no theme was requested or sent yet. Null is a real theme.
  let latest: T | undefined;
  let sent: T | undefined;
  let inFlight = false;
  let stopped = false;

  function settle(): void {
    inFlight = false;
    if (!stopped) {
      flush();
    }
  }

  function flush(): void {
    if (inFlight || latest === undefined || latest === sent) {
      return;
    }
    sent = latest;
    inFlight = true;
    let pending: Promise<void>;
    try {
      pending = setWindowTheme(latest);
    } catch {
      settle();
      return;
    }
    void pending.then(settle, settle);
  }

  return {
    send(theme) {
      latest = theme;
      if (!stopped) {
        flush();
      }
    },
    stop() {
      stopped = true;
    },
  };
}

/**
 * Applies the preference of a source to the document root at once, and again on each
 * change of the source. Inside Tauri it also sets the native window theme, and in the main
 * window the colour of the window border.
 *
 * `public/theme-init.js` already wrote the same theme before the first paint, so the first
 * write here changes nothing on screen. The native theme is sent once at start, also for
 * `system`: a web view reload keeps the native theme of the last session, and a preference
 * that storage did not keep can now read as `system`.
 *
 * The border follows the resolved theme and not the preference: under `system`, a change of
 * the system appearance changes the border too. It is also sent once at start.
 *
 * On macOS the native theme also sets the appearance that the web view reports to
 * `prefers-color-scheme`. The controller ignores the media query while the preference is
 * explicit. A return to `system` can first show the forced theme, until the window follows
 * the system again and the media query reports the change.
 *
 * @returns A function that stops the sync.
 */
export function startThemeSync(
  source: ThemePreferenceSource,
  options?: ThemeSyncOptions,
): () => void {
  const root = options?.root !== undefined ? options.root : getDefaultRoot();
  if (!root) {
    return () => {};
  }
  const query = options?.query !== undefined ? options.query : getDefaultQuery();
  const setWindowTheme =
    options?.setWindowTheme !== undefined
      ? options.setWindowTheme
      : getDefaultSetWindowTheme();
  const setWindowBorderTheme =
    options?.setWindowBorderTheme !== undefined
      ? options.setWindowBorderTheme
      : getDefaultSetWindowBorderTheme();
  const windowTheme = setWindowTheme ? createWindowThemeSender(setWindowTheme) : null;
  const borderTheme = setWindowBorderTheme
    ? createWindowThemeSender(setWindowBorderTheme)
    : null;
  const controller = createThemeController(root, query, (theme) => {
    borderTheme?.send(theme);
  });

  const apply = (preference: ThemePreference) => {
    controller.setPreference(preference);
    windowTheme?.send(nativeWindowThemeFor(preference));
  };

  apply(source.getState().preference);
  const unsubscribe = source.subscribe((state) => {
    apply(state.preference);
  });

  return () => {
    unsubscribe();
    controller.dispose();
    windowTheme?.stop();
    borderTheme?.stop();
  };
}
