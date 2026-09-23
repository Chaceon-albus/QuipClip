import { describe, expect, it } from "vitest";
import type { CalibrationStatus, PresentedFrame } from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
  getCurrentSegmentTarget,
  type CurrentSegmentTarget,
} from "@/features/timeline";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import type { Pts } from "@/types/project";
import {
  EDIT_REASON_PENDING,
  presentEditDisabledReason,
  presentStepDisabledReason,
  settleDisabledReason,
  type EditDisabledReason,
  type EditReasonContext,
  type EditReasonControl,
  type TransportDisabledReasonKey,
  type TransportReasonPlayback,
} from "./transportDisabledReason";

const pts = (value: number) => String(value) as Pts;

const frameAt = (value: number): PresentedFrame => ({
  mediaTime: value / 1000,
  inferredSourcePts: pts(value),
});

// The current segment is [1000, 3000).
const segmentTarget: CurrentSegmentTarget = getCurrentSegmentTarget({
  index: 0,
  segment: { id: "a", sourceId: "s", inPts: pts(1000), outPts: pts(3000) },
});
const noSegment: CurrentSegmentTarget = getCurrentSegmentTarget(null);
const malformedSegment: CurrentSegmentTarget = getCurrentSegmentTarget({
  index: 0,
  segment: { id: "a", sourceId: "s", inPts: "x" as Pts, outPts: pts(3000) },
});

function playbackAt(
  value: number | null,
  overrides: Partial<TransportReasonPlayback> = {},
): TransportReasonPlayback {
  return {
    calibrationStatus: "ready",
    presentedFrame: value === null ? null : frameAt(value),
    seekTargetSeconds: null,
    ...overrides,
  };
}

/** The state between a seek request and the frame callback that answers it (ADR 022). */
const pendingSeek = (): TransportReasonPlayback =>
  playbackAt(null, { seekTargetSeconds: 2 });

function context(overrides: Partial<EditReasonContext> = {}): EditReasonContext {
  return {
    hasActiveSource: true,
    pendingInPts: null,
    currentTarget: noSegment,
    ...overrides,
  };
}

function isEnabled(
  control: EditReasonControl,
  playback: TransportReasonPlayback,
  ctx: EditReasonContext,
): boolean {
  switch (control) {
    case "markIn":
      return canMarkIn(
        playback.calibrationStatus,
        playback.presentedFrame,
        ctx.hasActiveSource,
        ctx.currentTarget,
      );
    case "markOut":
      return canMarkOut(
        playback.calibrationStatus,
        playback.presentedFrame,
        ctx.pendingInPts,
        ctx.hasActiveSource,
        ctx.currentTarget,
      );
    case "split":
      return canSplitCurrentSegment(
        ctx.currentTarget,
        playback.calibrationStatus,
        playback.presentedFrame,
        ctx.hasActiveSource,
      );
  }
}

/**
 * Plays a sequence of presented values through `settleDisabledReason`, the way the transport
 * bar does on each render, and returns the reason shown after each one.
 */
function settleAll(presented: readonly EditDisabledReason[]): (string | null)[] {
  let shown: TransportDisabledReasonKey | null = null;
  return presented.map((value) => {
    shown = settleDisabledReason(shown, value);
    return shown;
  });
}

function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

const CONTROLS: readonly EditReasonControl[] = ["markIn", "markOut", "split"];

describe("transportDisabledReason", () => {
  describe("presentEditDisabledReason", () => {
    it("gives no reason with no active source", () => {
      for (const control of CONTROLS) {
        expect(
          presentEditDisabledReason(
            control,
            playbackAt(2000, { calibrationStatus: "unavailable" }),
            context({ hasActiveSource: false }),
          ),
        ).toBeNull();
      }
    });

    it("says precise marking is unavailable for every control while calibration is unavailable", () => {
      for (const control of CONTROLS) {
        for (const playback of [
          playbackAt(2000, { calibrationStatus: "unavailable" }),
          playbackAt(null, { calibrationStatus: "unavailable" }),
          playbackAt(null, { calibrationStatus: "unavailable", seekTargetSeconds: 1 }),
        ]) {
          expect(
            presentEditDisabledReason(
              control,
              playback,
              context({ currentTarget: segmentTarget }),
            ),
          ).toBe("transport.disabledReason.preciseMarkingUnavailable");
        }
      }
    });

    it("gives no reason while the calibration is still running", () => {
      for (const control of CONTROLS) {
        expect(
          presentEditDisabledReason(
            control,
            playbackAt(null, { calibrationStatus: "calibrating" }),
            context({ currentTarget: segmentTarget }),
          ),
        ).toBeNull();
      }
    });

    describe("a pending seek", () => {
      // A reason that holds at every playhead position stays through the seek, so the
      // tooltip does not switch between one line and two on each frame step.
      it("keeps Mark an In point first, which does not depend on the playhead", () => {
        for (const playback of [pendingSeek(), playbackAt(null), playbackAt(500)]) {
          expect(presentEditDisabledReason("markOut", playback, context())).toBe(
            "transport.disabledReason.markInFirst",
          );
        }
        expect(
          presentEditDisabledReason(
            "markOut",
            playbackAt(500, { seekTargetSeconds: 2 }),
            context(),
          ),
        ).toBe("transport.disabledReason.markInFirst");
      });

      it("keeps Select a segment first, which does not depend on the playhead", () => {
        for (const playback of [
          pendingSeek(),
          playbackAt(null),
          playbackAt(2000),
          playbackAt(2000, { seekTargetSeconds: 2 }),
        ]) {
          expect(presentEditDisabledReason("split", playback, context())).toBe(
            "transport.disabledReason.selectSegment",
          );
        }
      });

      it("returns the pending value for a reason that depends on the playhead", () => {
        for (const control of CONTROLS) {
          expect(
            presentEditDisabledReason(
              control,
              pendingSeek(),
              context({ currentTarget: segmentTarget }),
            ),
          ).toBe(EDIT_REASON_PENDING);
        }
        // Mark In with no segment is disabled only by the seek. Mark Out after a pending In
        // depends on the playhead.
        expect(presentEditDisabledReason("markIn", pendingSeek(), context())).toBe(
          EDIT_REASON_PENDING,
        );
        expect(
          presentEditDisabledReason(
            "markOut",
            pendingSeek(),
            context({ pendingInPts: pts(1000) }),
          ),
        ).toBe(EDIT_REASON_PENDING);
      });

      it("returns the pending value while a seek target is set, even with a presented frame", () => {
        expect(
          presentEditDisabledReason(
            "split",
            playbackAt(500, { seekTargetSeconds: 2 }),
            context({ currentTarget: segmentTarget }),
          ),
        ).toBe(EDIT_REASON_PENDING);
      });
    });

    describe("Mark In", () => {
      it("gives no reason with no current segment, where it is enabled", () => {
        expect(
          presentEditDisabledReason("markIn", playbackAt(500), context()),
        ).toBeNull();
      });

      it("says the playhead is already at the In point", () => {
        expect(
          presentEditDisabledReason(
            "markIn",
            playbackAt(1000),
            context({ currentTarget: segmentTarget }),
          ),
        ).toBe("transport.disabledReason.atInPoint");
      });

      it("asks for the playhead before the Out point at or after it", () => {
        for (const value of [3000, 4000]) {
          expect(
            presentEditDisabledReason(
              "markIn",
              playbackAt(value),
              context({ currentTarget: segmentTarget }),
            ),
          ).toBe("transport.disabledReason.playheadBeforeOut");
        }
      });

      it("gives no reason while it would move the In point", () => {
        for (const value of [500, 2000]) {
          expect(
            presentEditDisabledReason(
              "markIn",
              playbackAt(value),
              context({ currentTarget: segmentTarget }),
            ),
          ).toBeNull();
        }
      });
    });

    describe("Mark Out", () => {
      it("asks for an In point first with no current segment and no pending In", () => {
        expect(presentEditDisabledReason("markOut", playbackAt(2000), context())).toBe(
          "transport.disabledReason.markInFirst",
        );
      });

      it("asks for the playhead after a pending In at or before it", () => {
        for (const value of [1000, 500]) {
          expect(
            presentEditDisabledReason(
              "markOut",
              playbackAt(value),
              context({ pendingInPts: pts(1000) }),
            ),
          ).toBe("transport.disabledReason.playheadAfterIn");
        }
      });

      it("gives no reason after a pending In, where it is enabled", () => {
        expect(
          presentEditDisabledReason(
            "markOut",
            playbackAt(2000),
            context({ pendingInPts: pts(1000) }),
          ),
        ).toBeNull();
      });

      it("says the playhead is already at the Out point of the current segment", () => {
        expect(
          presentEditDisabledReason(
            "markOut",
            playbackAt(3000),
            context({ currentTarget: segmentTarget }),
          ),
        ).toBe("transport.disabledReason.atOutPoint");
      });

      it("asks for the playhead after the In point of the current segment", () => {
        for (const value of [1000, 500]) {
          expect(
            presentEditDisabledReason(
              "markOut",
              playbackAt(value),
              context({ currentTarget: segmentTarget }),
            ),
          ).toBe("transport.disabledReason.playheadAfterIn");
        }
      });
    });

    describe("Split", () => {
      it("asks for a selected segment with no current segment", () => {
        expect(presentEditDisabledReason("split", playbackAt(2000), context())).toBe(
          "transport.disabledReason.selectSegment",
        );
      });

      it("asks for the playhead between the In and Out points outside them or on one", () => {
        for (const value of [500, 1000, 3000, 4000]) {
          expect(
            presentEditDisabledReason(
              "split",
              playbackAt(value),
              context({ currentTarget: segmentTarget }),
            ),
          ).toBe("transport.disabledReason.playheadInsideSegment");
        }
      });

      it("gives no reason inside the current segment, where it is enabled", () => {
        expect(
          presentEditDisabledReason(
            "split",
            playbackAt(2000),
            context({ currentTarget: segmentTarget }),
          ),
        ).toBeNull();
      });
    });

    it("gives no reason for a current segment whose stored PTS does not parse", () => {
      for (const control of CONTROLS) {
        for (const playback of [playbackAt(2000), pendingSeek()]) {
          expect(
            presentEditDisabledReason(
              control,
              playback,
              context({ currentTarget: malformedSegment }),
            ),
          ).toBeNull();
        }
      }
    });

    it("gives no reason for a pending In that does not parse", () => {
      for (const playback of [playbackAt(2000), pendingSeek()]) {
        expect(
          presentEditDisabledReason(
            "markOut",
            playback,
            context({ pendingInPts: "x" as Pts }),
          ),
        ).toBeNull();
      }
    });

    // The reason and the condition read the same facts. A reason for an enabled control
    // would contradict the button, and a missing reason for a stable disable leaves the
    // user without one.
    it("matches the condition of the control in every state", () => {
      const statuses: readonly CalibrationStatus[] = [
        "ready",
        "calibrating",
        "unavailable",
      ];
      const frames = [null, 0, 500, 1000, 1500, 2000, 3000, 4000];
      const targets = [noSegment, segmentTarget, malformedSegment];
      const pendings = [null, pts(1000), pts(2000)];
      for (const control of CONTROLS) {
        for (const calibrationStatus of statuses) {
          for (const frame of frames) {
            for (const seekTargetSeconds of [null, 1]) {
              for (const hasActiveSource of [false, true]) {
                for (const currentTarget of targets) {
                  // The store never holds a pending In beside a current segment (ADR 007).
                  for (const pendingInPts of currentTarget.hasSegment
                    ? [null]
                    : pendings) {
                    const playback = playbackAt(frame, {
                      calibrationStatus,
                      seekTargetSeconds,
                    });
                    const ctx = context({
                      hasActiveSource,
                      currentTarget,
                      pendingInPts,
                    });
                    const reason = presentEditDisabledReason(control, playback, ctx);
                    const seekPending = frame === null || seekTargetSeconds !== null;

                    if (isEnabled(control, playback, ctx) || !hasActiveSource) {
                      expect(reason).toBeNull();
                    } else if (calibrationStatus === "unavailable") {
                      expect(reason).toBe(
                        "transport.disabledReason.preciseMarkingUnavailable",
                      );
                    } else if (
                      calibrationStatus === "calibrating" ||
                      currentTarget === malformedSegment
                    ) {
                      expect(reason).toBeNull();
                    } else if (control === "split" && !currentTarget.hasSegment) {
                      expect(reason).toBe("transport.disabledReason.selectSegment");
                    } else if (
                      control === "markOut" &&
                      !currentTarget.hasSegment &&
                      pendingInPts === null
                    ) {
                      expect(reason).toBe("transport.disabledReason.markInFirst");
                    } else if (seekPending) {
                      expect(reason).toBe(EDIT_REASON_PENDING);
                    } else {
                      expect(reason).not.toBeNull();
                      expect(reason).not.toBe(EDIT_REASON_PENDING);
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  describe("settleDisabledReason", () => {
    it("keeps the reason shown before while the presented value is pending", () => {
      expect(
        settleDisabledReason(
          "transport.disabledReason.atOutPoint",
          EDIT_REASON_PENDING,
        ),
      ).toBe("transport.disabledReason.atOutPoint");
      expect(settleDisabledReason(null, EDIT_REASON_PENDING)).toBeNull();
    });

    it("takes every value that is not pending, null included", () => {
      expect(
        settleDisabledReason(
          "transport.disabledReason.atOutPoint",
          "transport.disabledReason.playheadAfterIn",
        ),
      ).toBe("transport.disabledReason.playheadAfterIn");
      expect(
        settleDisabledReason("transport.disabledReason.atOutPoint", null),
      ).toBeNull();
    });

    // A frame step from the Out point of the current segment: the reason stays on screen
    // through the seek, and the frame callback settles the next one.
    it("keeps a playhead reason through a frame step until the frame answers", () => {
      const ctx = context({ currentTarget: segmentTarget });
      const presented = [
        presentEditDisabledReason("markOut", playbackAt(3000), ctx),
        presentEditDisabledReason("markOut", pendingSeek(), ctx),
        presentEditDisabledReason("markOut", playbackAt(null), ctx),
        presentEditDisabledReason("markOut", playbackAt(4000), ctx),
      ];
      expect(settleAll(presented)).toStrictEqual([
        "transport.disabledReason.atOutPoint",
        "transport.disabledReason.atOutPoint",
        "transport.disabledReason.atOutPoint",
        null,
      ]);
    });

    // A frame step with no segment and no pending In: the reason holds at every position,
    // so no render in the step shows one line instead of two.
    it("never drops a stable reason during a frame step", () => {
      const presented = [
        presentEditDisabledReason("markOut", playbackAt(2000), context()),
        presentEditDisabledReason("markOut", pendingSeek(), context()),
        presentEditDisabledReason("markOut", playbackAt(null), context()),
        presentEditDisabledReason("markOut", playbackAt(2040), context()),
      ];
      expect(settleAll(presented)).toStrictEqual(
        Array(4).fill("transport.disabledReason.markInFirst"),
      );
      const split = [
        presentEditDisabledReason("split", playbackAt(2000), context()),
        presentEditDisabledReason("split", pendingSeek(), context()),
        presentEditDisabledReason("split", playbackAt(2040), context()),
      ];
      expect(settleAll(split)).toStrictEqual(
        Array(3).fill("transport.disabledReason.selectSegment"),
      );
    });

    it("shows no reason during a step from an enabled position", () => {
      const presented = [
        presentEditDisabledReason("markIn", playbackAt(2000), context()),
        presentEditDisabledReason("markIn", pendingSeek(), context()),
        presentEditDisabledReason("markIn", playbackAt(2040), context()),
      ];
      expect(settleAll(presented)).toStrictEqual([null, null, null]);
    });
  });

  describe("presentStepDisabledReason", () => {
    it("says the source reports no frame rate for an active source without one", () => {
      expect(presentStepDisabledReason(true, false)).toBe(
        "transport.disabledReason.noFrameRate",
      );
    });

    it("gives no reason when the step is enabled or no source is active", () => {
      expect(presentStepDisabledReason(true, true)).toBeNull();
      expect(presentStepDisabledReason(false, false)).toBeNull();
      expect(presentStepDisabledReason(false, true)).toBeNull();
    });
  });

  describe("the reason keys", () => {
    const keys: readonly TransportDisabledReasonKey[] = [
      "transport.disabledReason.preciseMarkingUnavailable",
      "transport.disabledReason.markInFirst",
      "transport.disabledReason.selectSegment",
      "transport.disabledReason.playheadInsideSegment",
      "transport.disabledReason.playheadBeforeOut",
      "transport.disabledReason.playheadAfterIn",
      "transport.disabledReason.atInPoint",
      "transport.disabledReason.atOutPoint",
      "transport.disabledReason.noFrameRate",
    ];

    it("name a message in both catalogs", () => {
      for (const key of keys) {
        expect(typeof lookup(en, key)).toBe("string");
        expect(typeof lookup(zhCN, key)).toBe("string");
      }
    });

    it("cover every key of the disabled-reason group", () => {
      const group = Object.keys(en.transport.disabledReason).map(
        (name) => `transport.disabledReason.${name}`,
      );
      expect([...keys]).toStrictEqual(group);
    });

    it("hold the pending value apart from every key", () => {
      expect(keys).not.toContain(EDIT_REASON_PENDING);
    });
  });
});
