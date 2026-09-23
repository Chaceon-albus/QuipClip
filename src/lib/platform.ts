/**
 * Platform detection helpers.
 *
 * Reports whether the web view runs on macOS or on Windows, by user agent substring.
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
