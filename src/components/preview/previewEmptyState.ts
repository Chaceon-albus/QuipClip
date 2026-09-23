/**
 * Pure helpers for the preview empty state.
 */

/**
 * Display names for the extensions whose format name is not the extension in capitals.
 */
const FORMAT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  webm: "WebM",
};

/** Separator between two format names. It is not localized: the names are identifiers. */
const FORMAT_SEPARATOR = " · ";

/**
 * Formats file extensions as one line of format names, such as `MP4 · MOV · WebM`.
 *
 * The line keeps the order of the input. It has no localized words, so it is the same in
 * every interface language (ADR 011: technical identifiers keep their original format).
 *
 * @param extensions File extensions without the leading dot, in any letter case.
 */
export function formatSupportedVideoFormats(extensions: readonly string[]): string {
  return extensions
    .map((extension) => {
      const key = extension.toLowerCase();
      return FORMAT_DISPLAY_NAMES[key] ?? key.toUpperCase();
    })
    .join(FORMAT_SEPARATOR);
}
