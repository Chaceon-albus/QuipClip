/**
 * The text of the waveform cache field of the General tab (ADR 056).
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

const KIB = 1024;
const MIB = 1024 * 1024;

/**
 * A size for the user, in kilobytes below one megabyte and in megabytes above, with one
 * decimal. The cache counts binary units, as its limit of 256 MiB does, and shows them with the
 * common names.
 */
export function formatCacheSize(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const [value, unit] =
    safe < MIB ? [safe / KIB, "kilobyte"] : [safe / MIB, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    maximumFractionDigits: 1,
  }).format(value);
}
