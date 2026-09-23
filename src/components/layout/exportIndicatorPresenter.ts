/**
 * Pure presenter for the status bar export indicator.
 *
 * Implements status bar indicator visibility and view model derivation according to ADR 025.
 * The indicator is hidden when the export dialog is open or when status is idle.
 */

import { splitFilePath } from "@/lib/fileName";
import {
  presentExportProgress,
  type ExportProgressInput,
  type ExportProgressView,
} from "../export/exportProgressPresenter";

export type ExportIndicatorInput = ExportProgressInput & {
  panelOpen: boolean;
  outputPath: string | null;
};

export type ExportIndicatorView =
  | { kind: "active"; progress: ExportProgressView; outputName: string | null }
  | { kind: "finished" | "failed" | "canceled"; outputName: string | null };

/**
 * The file name of an output path, by the rule of `splitFilePath`, which the finished export
 * panel also uses. Null for null or a path with no segment.
 */
export function outputNameOf(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  return splitFilePath(path)?.name ?? null;
}

/** Null when the panel is open or the status is idle (ADR 025). */
export function presentExportIndicator(
  input: ExportIndicatorInput,
): ExportIndicatorView | null {
  if (input.panelOpen || input.status === "idle") {
    return null;
  }

  const outputName = outputNameOf(input.outputPath);

  if (
    input.status === "preparing" ||
    input.status === "running" ||
    input.status === "publishing"
  ) {
    const progress = presentExportProgress(input);
    if (!progress) {
      return null;
    }
    return {
      kind: "active",
      progress,
      outputName,
    };
  }

  if (
    input.status === "finished" ||
    input.status === "failed" ||
    input.status === "canceled"
  ) {
    return {
      kind: input.status,
      outputName,
    };
  }

  return null;
}
