/**
 * Pure rules for the result of a finished export: where the file is, how long the export
 * took, and the labels of the show and open actions.
 */

import type { ExportOutputErrorCode } from "@/features/export";
import { splitFileName, splitFilePath } from "@/lib/fileName";
import { formatRemaining } from "./exportProgressPresenter";

/**
 * "m:ss" below one hour and "h:mm:ss" from one hour, rounded down to whole seconds.
 *
 * `exportElapsedMs` in `exportRunPresenter.ts` gives the time, for the finished panel and for
 * the readout of an active run.
 */
export function formatElapsed(milliseconds: number): string {
  return formatRemaining(Math.floor(milliseconds / 1000));
}

export interface OutputFileView {
  fileName: string;
  /**
   * The file name before its extension, and the extension. A display truncates the stem and
   * keeps the extension visible, as the title bar does.
   */
  fileStem: string;
  fileExtension: string;
  /** The complete path, for the tooltip of the file name. */
  fullPath: string;
  folderName: string | null;
}

/**
 * Splits the output path for display. The finished panel and the readout of an active run
 * both show the name this way. Null when the path is unknown or has no segment.
 */
export function presentOutputFile(outputPath: string | null): OutputFileView | null {
  if (outputPath === null) {
    return null;
  }
  const parts = splitFilePath(outputPath);
  if (parts === null) {
    return null;
  }
  const { stem, extension } = splitFileName(parts.name);
  return {
    fileName: parts.name,
    fileStem: stem,
    fileExtension: extension,
    fullPath: outputPath,
    folderName: parts.folderName,
  };
}

export interface FinishedExportView extends OutputFileView {
  /** Null when the time is unknown. */
  elapsed: string | null;
}

/** Null when the output path is unknown or has no segment. */
export function presentFinishedExport(
  outputPath: string | null,
  elapsedMs: number | null,
): FinishedExportView | null {
  const file = presentOutputFile(outputPath);
  if (file === null) {
    return null;
  }
  return { ...file, elapsed: elapsedMs === null ? null : formatElapsed(elapsedMs) };
}

export type RevealLabelKey = "export.action.revealMac" | "export.action.revealWindows";

/** Finder on macOS, File Explorer everywhere else. */
export function revealLabelKey(macOS: boolean): RevealLabelKey {
  return macOS ? "export.action.revealMac" : "export.action.revealWindows";
}

export type OutputActionErrorKey = `exportOutputError.${ExportOutputErrorCode}`;

/** The catalog key of the message for a failed show or open request. */
export function outputActionErrorKey(
  code: ExportOutputErrorCode,
): OutputActionErrorKey {
  return `exportOutputError.${code}`;
}
