/**
 * Pure presenter for formatting FFmpeg readiness and capability state for the status bar.
 *
 * Implements status line and detail view model derivations according to ADR 005, ADR 006,
 * and ADR 011. Returns translation keys and values without calling the i18n runtime.
 */

import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  type FfmpegState,
  type FfmpegStoreState,
} from "@/features/ffmpeg/types";

/**
 * Picks exactly the state this presenter reads out of the ffmpeg store.
 *
 * Every consumer pairs it with `useShallow`, so a store write that changes only an action
 * identity or a field the presenter ignores no longer re-renders the component and re-runs
 * `presentFfmpegStatus`. It returns a new object on each call by design; the shallow
 * comparison, not the object identity, is what settles the equality.
 */
export function selectFfmpegState(state: FfmpegStoreState): FfmpegState {
  return {
    status: state.status,
    runId: state.runId,
    paths: state.paths,
    origin: state.origin,
    version: state.version,
    license: state.license,
    hwaccels: state.hwaccels,
    results: state.results,
    done: state.done,
    total: state.total,
    source: state.source,
    error: state.error,
    inspected: state.inspected,
  };
}

export type FfmpegStatusLineKey =
  | "ffmpeg.status.locating"
  | "ffmpeg.status.probing"
  | "ffmpeg.status.ready"
  | "ffmpeg.status.missing"
  | "ffmpeg.status.failed";

/**
 * Key of the short status bar label. Only the ready state has a label of its own; every
 * other state uses its status line, which is already short.
 */
export type FfmpegStatusLabelKey =
  Exclude<FfmpegStatusLineKey, "ffmpeg.status.ready"> | "ffmpeg.status.readyShort";

export type FfmpegStatusDetailEntry = {
  key: string;
  values?: Record<string, string>;
  /** Stable, unique React key for this entry within its array. */
  id: string;
  /** True for the entry that carries raw diagnostic text, rendered in monospace. */
  mono: boolean;
};

export type FfmpegStatusView = {
  /** The complete status line. Settings shows it as the heading of the status block. */
  lineKey: FfmpegStatusLineKey;
  lineValues: Record<string, string>;
  /**
   * The short status bar label. In the ready state it holds the short version and no
   * encoder count, so the status bar item stays narrow.
   */
  labelKey: FfmpegStatusLabelKey;
  labelValues: Record<string, string>;
  /**
   * The lines of the status bar tooltip, at most two. The first line is always the complete
   * status line. The complete diagnosis stays in `detail`, which Settings shows in full.
   */
  summary: FfmpegStatusDetailEntry[];
  detail: FfmpegStatusDetailEntry[];
  tone: "neutral" | "ready" | "warning";
};

/** The largest number of characters that `shortVersion` returns. */
export const SHORT_VERSION_MAX_LENGTH = 12;

/**
 * Returns the short form of an ffmpeg version string for the status bar label.
 *
 * The short form is the text before the first `-`: `7.1.1` stays `7.1.1`, and
 * `n7.1.1-20-g1234567890-20250901` becomes `n7.1.1`. A build from the FFmpeg master branch
 * reports `N-<revision>-g<hash>...`, where the text before the first `-` is only the marker
 * `N`. That build keeps its revision number too, so `N-121234-g1234567890-20250901` becomes
 * `N-121234`. A git build from gyan.dev reports a date first, such as
 * `2025-09-01-git-5e5a2a7a0c-full_build-www.gyan.dev`, where the text before the first `-`
 * is only the year. That build keeps the 10-character date, `2025-09-01`. The result has at
 * most `SHORT_VERSION_MAX_LENGTH` characters. When the text before the first `-` is empty,
 * the function uses the start of the whole string.
 *
 * The complete version stays in the status line and in the detail, so no information is lost.
 */
export function shortVersion(version: string): string {
  const trimmed = version.trim();
  const date = /^\d{4}-\d{2}-\d{2}/.exec(trimmed);
  if (date) {
    return date[0];
  }
  const segments = trimmed.split("-");
  let short = segments[0];
  if (short === "N" && segments.length > 1 && /^\d+$/.test(segments[1])) {
    short = `N-${segments[1]}`;
  } else if (short === "") {
    short = trimmed;
  }
  return Array.from(short).slice(0, SHORT_VERSION_MAX_LENGTH).join("");
}

/**
 * Appends one detail or summary entry, deriving its React key and monospace flag so
 * components never have to make those decisions themselves.
 *
 * The id combines the translation key with the entry's position in the array, which keeps
 * it deterministic and unique even when two entries share a key or a value.
 */
function pushDetail(
  detail: FfmpegStatusDetailEntry[],
  key: string,
  values?: Record<string, string>,
): void {
  const entry: FfmpegStatusDetailEntry = {
    key,
    id: `${key}#${detail.length}`,
    // The raw diagnostic entry is the only one rendered in monospace.
    mono: key === "ffmpeg.detail.raw",
  };
  if (values) {
    entry.values = values;
  }
  detail.push(entry);
}

/**
 * Starts a tooltip summary with the complete status line, so every state opens its tooltip
 * with the same kind of line. A line with no values gets an entry with no `values`.
 */
function startSummary(
  lineKey: FfmpegStatusLineKey,
  lineValues: Record<string, string>,
): FfmpegStatusDetailEntry[] {
  const summary: FfmpegStatusDetailEntry[] = [];
  pushDetail(
    summary,
    lineKey,
    Object.keys(lineValues).length > 0 ? lineValues : undefined,
  );
  return summary;
}

export function presentFfmpegStatus(
  state: FfmpegState,
  format: { list: Intl.ListFormat; number: Intl.NumberFormat },
): FfmpegStatusView {
  switch (state.status) {
    case "idle":
    case "locating": {
      return {
        lineKey: "ffmpeg.status.locating",
        lineValues: {},
        labelKey: "ffmpeg.status.locating",
        labelValues: {},
        summary: startSummary("ffmpeg.status.locating", {}),
        detail: [],
        tone: "neutral",
      };
    }

    case "probing": {
      const lineValues = {
        done: format.number.format(state.done),
        total: format.number.format(state.total),
      };
      return {
        lineKey: "ffmpeg.status.probing",
        lineValues,
        labelKey: "ffmpeg.status.probing",
        labelValues: lineValues,
        summary: startSummary("ffmpeg.status.probing", lineValues),
        detail: [],
        tone: "neutral",
      };
    }

    case "ready": {
      const workingResults = state.results.filter((r) => r.status === "works");
      const workingCount = workingResults.length;
      const testedCount = state.results.length;

      const detail: FfmpegStatusDetailEntry[] = [];

      // 1. Origin
      if (state.origin) {
        pushDetail(detail, `ffmpeg.detail.origin.${state.origin}`);
      }

      // 2. Program path
      if (state.paths?.ffmpeg) {
        pushDetail(detail, "ffmpeg.detail.program", { path: state.paths.ffmpeg });
      }

      // 3. Version
      if (state.version) {
        pushDetail(detail, "ffmpeg.detail.version", { version: state.version });
      }

      // 4. Licence flags
      let hasLicenseFlag = false;
      if (state.license?.gpl) {
        pushDetail(detail, "ffmpeg.detail.license.gpl");
        hasLicenseFlag = true;
      }
      if (state.license?.nonfree) {
        pushDetail(detail, "ffmpeg.detail.license.nonfree");
        hasLicenseFlag = true;
      }
      if (state.license?.version3) {
        pushDetail(detail, "ffmpeg.detail.license.version3");
        hasLicenseFlag = true;
      }
      if (!hasLicenseFlag) {
        pushDetail(detail, "ffmpeg.detail.license.none");
      }

      // 5. Hardware acceleration methods
      if (state.hwaccels && state.hwaccels.length > 0) {
        pushDetail(detail, "ffmpeg.detail.hardware", {
          methods: format.list.format(state.hwaccels),
        });
      } else {
        pushDetail(detail, "ffmpeg.detail.hardwareNone");
      }

      // 6. Working encoders
      if (workingResults.length > 0) {
        const encoderNames = workingResults.map((r) => r.name);
        pushDetail(detail, "ffmpeg.detail.workingEncoders", {
          encoders: format.list.format(encoderNames),
        });
      } else {
        pushDetail(detail, "ffmpeg.detail.noWorkingEncoders");
      }

      const lineValues = {
        version: state.version ?? "",
        working: format.number.format(workingCount),
        tested: format.number.format(testedCount),
      };

      // The tooltip gives the complete line, with the complete version and the encoder
      // count, and the program path when it is known.
      const summary = startSummary("ffmpeg.status.ready", lineValues);
      if (state.paths?.ffmpeg) {
        pushDetail(summary, "ffmpeg.detail.program", { path: state.paths.ffmpeg });
      }

      return {
        lineKey: "ffmpeg.status.ready",
        lineValues,
        labelKey: "ffmpeg.status.readyShort",
        labelValues: { version: shortVersion(state.version ?? "") },
        summary,
        detail,
        tone: workingCount === 0 ? "warning" : "ready",
      };
    }

    case "missing": {
      const detail: FfmpegStatusDetailEntry[] = [];
      pushDetail(detail, "ffmpegError.ffmpegPairMissing");

      if (state.error?.detail) {
        pushDetail(detail, "ffmpeg.detail.raw", { detail: state.error.detail });
      }

      if (state.inspected) {
        for (const candidate of state.inspected) {
          // One complete key per origin. The origin class is an application-defined value,
          // not diagnostic text, so it must not reach the message as a raw wire token
          // (ADR 011), and a whole key per origin avoids assembling the sentence from a
          // translated fragment.
          pushDetail(detail, `ffmpeg.detail.searchedPair.${candidate.origin}`, {
            path: candidate.ffmpeg,
            probe: candidate.ffprobe,
          });
        }
      }

      // The tooltip gives the state and the reason only. The searched paths stay in the
      // detail.
      const summary = startSummary("ffmpeg.status.missing", {});
      pushDetail(summary, "ffmpegError.ffmpegPairMissing");

      return {
        lineKey: "ffmpeg.status.missing",
        lineValues: {},
        labelKey: "ffmpeg.status.missing",
        labelValues: {},
        summary,
        detail,
        tone: "warning",
      };
    }

    case "failed": {
      const detail: FfmpegStatusDetailEntry[] = [];
      const rawCode = state.error?.code;
      const isKnownCode =
        typeof rawCode === "string" &&
        (BACKEND_CAPABILITY_PROBE_ERROR_CODES as readonly string[]).includes(rawCode);
      const errorCode = isKnownCode ? rawCode : "unknown";

      pushDetail(detail, `ffmpegError.${errorCode}`);

      if (state.error?.detail) {
        pushDetail(detail, "ffmpeg.detail.raw", { detail: state.error.detail });
      }

      // The tooltip gives the state and the translated reason only. The raw diagnostic
      // stays in the detail.
      const summary = startSummary("ffmpeg.status.failed", {});
      pushDetail(summary, `ffmpegError.${errorCode}`);

      return {
        lineKey: "ffmpeg.status.failed",
        lineValues: {},
        labelKey: "ffmpeg.status.failed",
        labelValues: {},
        summary,
        detail,
        tone: "warning",
      };
    }
  }
}
