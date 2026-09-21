/**
 * Platform detection helpers.
 *
 * Reports whether the web view runs on macOS, by user agent substring.
 */

/** True when the given user agent string identifies macOS. */
export function isMacOSUserAgent(userAgent: string): boolean {
  return userAgent.includes("Mac");
}

/** Reads the current environment. False when there is no navigator. */
export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && isMacOSUserAgent(navigator.userAgent);
}
