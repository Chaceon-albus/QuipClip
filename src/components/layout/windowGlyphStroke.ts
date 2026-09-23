import { useSyncExternalStore } from "react";

/**
 * The stroke width of a window glyph, in CSS pixels.
 *
 * The glyphs use `crispEdges`, so each edge covers a whole number of device pixels. At a
 * fractional scale factor, a 1 CSS pixel stroke is 1.25 or 1.5 device pixels wide, and each
 * edge rounds to 1 or 2 device pixels by its position. One square then has thin and thick
 * sides. A stroke of a whole number of device pixels covers the same count at every position.
 *
 * The count is the scale factor rounded to the nearest integer, and at least 1. The stroke is
 * therefore 1 CSS pixel at 100 % and 200 %, and it stays near 1 CSS pixel at the other factors.
 */
export function glyphStrokeWidth(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(devicePixelRatio)) / devicePixelRatio;
}

/** The scale factor of the window. A missing or zero value reads as 1. */
export function readDevicePixelRatio(): number {
  return window.devicePixelRatio || 1;
}

/**
 * Calls `onChange` when the scale factor changes. A resolution query matches one value only,
 * so each change replaces the query with one for the new value.
 */
export function subscribeDevicePixelRatio(onChange: () => void): () => void {
  let query = window.matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`);
  const handleChange = () => {
    query.removeEventListener("change", handleChange);
    query = window.matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`);
    query.addEventListener("change", handleChange);
    onChange();
  };
  query.addEventListener("change", handleChange);
  return () => {
    query.removeEventListener("change", handleChange);
  };
}

/**
 * The scale factor of the display under the window. It changes when the window moves to a
 * display with another scale factor, and when the user changes the scale factor.
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeDevicePixelRatio, readDevicePixelRatio, () => 1);
}
