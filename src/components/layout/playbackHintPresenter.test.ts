import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import type { Pts } from "@/types/project";
import { createPlaybackStore } from "@/features/playback";
import {
  presentApproximatePosition,
  presentPlaybackHint,
  selectCalibrationStatus,
  selectCanRecalibrate,
  selectHasReadySource,
  selectIsRecalibrating,
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
        recalibrates: false,
      });
    });

    it("returns the neutral Preparing view, not the warning, while calibration is still running", () => {
      expect(
        presentPlaybackHint(createHintState({ calibrationStatus: "calibrating" })),
      ).toStrictEqual({
        lineKey: "statusBar.preparingPosition",
        detail: [
          "statusBar.preparingPositionDetail",
          "statusBar.preparingPositionMarks",
        ],
        tone: "neutral",
        recalibrates: false,
      });
    });

    it("returns null with no ready source while calibration is still running", () => {
      expect(
        presentPlaybackHint(
          createHintState({ hasReadySource: false, calibrationStatus: "calibrating" }),
        ),
      ).toBeNull();
    });

    // The three seek actions null presentedFrame and wait for RVFC. A calibrated source is
    // approximate for that window, and the hint must not flash on every ruler click.
    it("stays null between a seek of a calibrated source and the next presented frame", () => {
      expect(
        presentPlaybackHint({ hasReadySource: true, calibrationStatus: "ready" }),
      ).toBeNull();
    });

    it("returns the warning button with the retry text while a recalibration can help (ADR 063)", () => {
      expect(
        presentPlaybackHint(createHintState({ canRecalibrate: true })),
      ).toStrictEqual({
        lineKey: "statusBar.approximatePositionRetry",
        detail: [
          "statusBar.approximatePositionDetail",
          "statusBar.approximatePositionRetryMarks",
        ],
        tone: "warning",
        recalibrates: true,
      });
    });

    it("ignores canRecalibrate outside the unavailable state", () => {
      expect(
        presentPlaybackHint(
          createHintState({ calibrationStatus: "calibrating", canRecalibrate: true }),
        )?.recalibrates,
      ).toBe(false);
      expect(
        presentPlaybackHint(
          createHintState({ calibrationStatus: "ready", canRecalibrate: true }),
        ),
      ).toBeNull();
    });

    it("says Preparing while a recalibration replaces the element, also before it is ready", () => {
      const preparing = {
        lineKey: "statusBar.preparingPosition",
        detail: [
          "statusBar.preparingPositionDetail",
          "statusBar.preparingPositionMarks",
        ],
        tone: "neutral",
        recalibrates: false,
      };
      // The old element still reports its unavailable calibration.
      expect(
        presentPlaybackHint(createHintState({ isRecalibrating: true })),
      ).toStrictEqual(preparing);
      // The new element has no metadata yet.
      expect(
        presentPlaybackHint(
          createHintState({ hasReadySource: false, isRecalibrating: true }),
        ),
      ).toStrictEqual(preparing);
    });
  });

  describe("presentApproximatePosition", () => {
    it("gives the ADR 003 text and no button when a recalibration cannot help", () => {
      expect(presentApproximatePosition(false)).toStrictEqual({
        lineKey: "statusBar.approximatePosition",
        detail: [
          "statusBar.approximatePositionDetail",
          "statusBar.approximatePositionMarks",
        ],
        recalibrates: false,
      });
    });

    it("gives the retry text and a button when a recalibration can help", () => {
      expect(presentApproximatePosition(true)).toStrictEqual({
        lineKey: "statusBar.approximatePositionRetry",
        detail: [
          "statusBar.approximatePositionDetail",
          "statusBar.approximatePositionRetryMarks",
        ],
        recalibrates: true,
      });
    });
  });

  describe("selectCanRecalibrate and selectIsRecalibrating", () => {
    it("read the two flags of the store", () => {
      const store = createPlaybackStore({
        canRecalibrate: true,
        isRecalibrating: true,
      });
      expect(selectCanRecalibrate(store.getState())).toBe(true);
      expect(selectIsRecalibrating(store.getState(), true)).toBe(true);
      expect(selectIsRecalibrating(store.getState(), false)).toBe(false);
      expect(selectCanRecalibrate(createPlaybackStore().getState())).toBe(false);
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
      "statusBar.approximatePositionRetry",
      "statusBar.approximatePositionRetryMarks",
      "statusBar.preparingPosition",
      "statusBar.preparingPositionDetail",
      "statusBar.preparingPositionMarks",
    ];

    it.each(emittedKeys)(
      "resolves key '%s' to a non-empty string in the English catalog",
      (key) => {
        const resolved = resolveCatalogKey(en, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      },
    );

    it.each(emittedKeys)(
      "resolves key '%s' to a non-empty string in the Chinese catalog",
      (key) => {
        const resolved = resolveCatalogKey(zhCN, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      },
    );

    // ADR 063 gives the text of the recoverable state.
    it("holds the text of the recoverable state in both languages", () => {
      expect(en.statusBar.approximatePositionRetry).toBe(
        "Approximate position · click to try again",
      );
      expect(zhCN.statusBar.approximatePositionRetry).toBe("近似位置 · 点击重试");
      expect(en.statusBar.approximatePositionRetryMarks).toBe(
        "Mark In, Mark Out, and Split are unavailable until the preview reads the exact frame timestamps. Click to load the preview of this video again.",
      );
      expect(zhCN.statusBar.approximatePositionRetryMarks).toBe(
        "在预览取得精确的帧时间戳之前，无法使用标记入点、标记出点和分割。点击可重新加载此视频的预览。",
      );
    });
  });
});
