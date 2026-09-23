/**
 * Pure presenter for the status bar export indicator.
 *
 * Implements status bar indicator visibility and view model derivation according to ADR 025.
 * The indicator is hidden when the export dialog is open or when status is idle.
 */

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

/** The last path segment, split on "/" and "\\". Null for null or an empty result. */
export function outputNameOf(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  return segments[segments.length - 1] ?? null;
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
