/**
 * Platform detection helpers.
 *
 * Reports whether the web view runs on macOS or on Windows, by user agent substring, and
 * writes the platform branch on the document root for CSS.
 */

/** True when the given user agent string identifies macOS. */
export function isMacOSUserAgent(userAgent: string): boolean {
  return userAgent.includes("Mac");
}

/** Reads the current environment. False when there is no navigator. */
export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && isMacOSUserAgent(navigator.userAgent);
}

/**
 * True when the given user agent string identifies Windows.
 *
 * WebView2 reports the Chromium desktop user agent, which names the platform as
 * `Windows NT <version>`.
 */
export function isWindowsUserAgent(userAgent: string): boolean {
  return userAgent.includes("Windows");
}

/** Reads the current environment. False when there is no navigator. */
export function isWindows(): boolean {
  return typeof navigator !== "undefined" && isWindowsUserAgent(navigator.userAgent);
}

/**
 * The platform branch of the interface. Everything that is not macOS takes the Windows branch,
 * as the title bar does (ADR 020), so Linux gets the Windows branch.
 */
export type InterfacePlatform = "macos" | "windows";

/** Maps a user agent string to its platform branch. */
export function interfacePlatformOf(userAgent: string): InterfacePlatform {
  return isMacOSUserAgent(userAgent) ? "macos" : "windows";
}

/**
 * The attribute on <html> that names the platform branch. A CSS rule that differs by
 * platform reads it, such as the scroll bar rules in `globals.css`.
 */
export const PLATFORM_ATTRIBUTE = "data-platform";

/** The part of the document root that the platform attribute writes. */
export interface PlatformRoot {
  setAttribute(name: string, value: string): void;
}

/**
 * Writes the platform branch on the document root. `main.tsx` calls it before the first
 * render, so no frame shows the rules of the other platform.
 *
 * @param root The document root. Undefined uses `document.documentElement`; null does
 *   nothing.
 * @param userAgent The user agent. Undefined reads the navigator; with no navigator, the
 *   branch is Windows.
 */
export function applyPlatformAttribute(
  root?: PlatformRoot | null,
  userAgent?: string,
): void {
  const target =
    root !== undefined
      ? root
      : typeof document !== "undefined"
        ? document.documentElement
        : null;
  if (!target) {
    return;
  }
  const agent =
    userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  target.setAttribute(PLATFORM_ATTRIBUTE, interfacePlatformOf(agent));
}
