import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import type { Pts } from "@/types/project";
import { createPlaybackStore } from "@/features/playback";
import {
  presentPlaybackHint,
  selectCalibrationStatus,
  selectHasReadySource,
  type PlaybackHintState,
} from "./playbackHintPresenter";

/**
 * Resolves a dotted translation key path against a nested catalog object, mirroring how
 * i18next itself walks a namespaced key. Follows the same convention as
 * `presetPresenter.test.ts`'s guard.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createHintState(
  overrides: Partial<PlaybackHintState> = {},
): PlaybackHintState {
  return { hasReadySource: true, calibrationStatus: "unavailable", ...overrides };
}

describe("playbackHintPresenter", () => {
  describe("presentPlaybackHint", () => {
    it("returns null with no ready source, even while calibration is unavailable", () => {
      expect(
        presentPlaybackHint(createHintState({ hasReadySource: false })),
      ).toBeNull();
    });

    it("returns null while calibration is ready", () => {
      expect(
        presentPlaybackHint(createHintState({ calibrationStatus: "ready" })),
      ).toBeNull();
    });

    it("returns the warning view with both detail keys while calibration is unavailable", () => {
      expect(presentPlaybackHint(createHintState())).toStrictEqual({
        lineKey: "statusBar.approximatePosition",
        detail: [
          "statusBar.approximatePositionDetail",
          "statusBar.approximatePositionMarks",
        ],
        tone: "warning",
      });
    });

    it("returns the warning view while calibration is still running", () => {
      expect(
        presentPlaybackHint(createHintState({ calibrationStatus: "calibrating" })),
      ).not.toBeNull();
    });

    // The three seek actions null presentedFrame and wait for RVFC. A calibrated source is
    // approximate for that window, and the hint must not flash on every ruler click.
    it("stays null between a seek of a calibrated source and the next presented frame", () => {
      expect(
        presentPlaybackHint({ hasReadySource: true, calibrationStatus: "ready" }),
      ).toBeNull();
    });
  });

  describe("selectHasReadySource", () => {
    it("reports no ready source while no media is open", () => {
      const store = createPlaybackStore({ isAttached: true, isReady: true });

      expect(selectHasReadySource(store.getState(), false)).toBe(false);
    });

    it("reports a ready source for an attached element that loaded metadata", () => {
      const store = createPlaybackStore({ isAttached: true, isReady: true });

      expect(selectHasReadySource(store.getState(), true)).toBe(true);
    });

    it("reports no ready source before the attached element loads metadata", () => {
      const store = createPlaybackStore({ isAttached: true, isReady: false });

      expect(selectHasReadySource(store.getState(), true)).toBe(false);
    });
  });

  describe("selectCalibrationStatus", () => {
    it("reads the status of the active source", () => {
      const store = createPlaybackStore({
        calibrationStatus: "ready",
        presentedFrame: { mediaTime: 1, inferredSourcePts: "25" as Pts },
      });

      expect(selectCalibrationStatus(store.getState())).toBe("ready");
    });
  });

  // Every key this presenter can emit must resolve to a non-empty string in the English
  // catalog, so a renamed or deleted message fails here instead of rendering a raw key on
  // screen. Follows the same convention as `presetPresenter.test.ts`.
  describe("catalog coverage", () => {
    const emittedKeys = [
      "statusBar.approximatePosition",
      "statusBar.approximatePositionDetail",
      "statusBar.approximatePositionMarks",
    ];

    it.each(emittedKeys)(
      "resolves key '%s' to a non-empty string in the English catalog",
      (key) => {
        const resolved = resolveCatalogKey(en, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      },
    );
  });
});
