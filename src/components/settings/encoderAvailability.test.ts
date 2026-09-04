import { describe, expect, it } from "vitest";
import type { CodecKind, EncoderResult, EncoderStatus } from "@/features/ffmpeg/types";
import {
  buildEncoderOptions,
  getEncoderAvailability,
  type EncoderProbeState,
} from "./encoderAvailability";

function createState(overrides: Partial<EncoderProbeState> = {}): EncoderProbeState {
  return {
    status: "idle",
    results: [],
    ...overrides,
  };
}

function createResult(
  name: string,
  kind: CodecKind,
  status: EncoderStatus,
  extra: Partial<EncoderResult> = {},
): EncoderResult {
  return {
    name,
    kind,
    listed: status !== "notListed",
    status,
    ...extra,
  };
}

describe("encoderAvailability", () => {
  describe("getEncoderAvailability", () => {
    describe("the false-negative flash", () => {
      it("yields unknown for absent encoder when status is probing", () => {
        const state = createState({ status: "probing", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
      });

      it("yields unknown for absent encoder when status is idle", () => {
        const state = createState({ status: "idle", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
      });

      it("yields unknown for absent encoder when status is locating", () => {
        const state = createState({ status: "locating", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
      });
    });

    describe("discriminator is status, not listed boolean", () => {
      it("yields unavailable with reason failed when listed is true but status is failed", () => {
        const failedResult = createResult("libx264", "video", "failed", {
          listed: true,
          exitCode: 1,
        });
        const state = createState({
          status: "ready",
          results: [failedResult],
        });

        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unavailable",
          reason: "failed",
        });
      });
    });

    describe("settled results take precedence regardless of probe lifecycle status", () => {
      it("marks encoder available when result works during probing (settled fact mid-probe)", () => {
        const worksResult = createResult("libx264", "video", "works");
        const state = createState({
          status: "probing",
          results: [worksResult],
        });

        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "available",
        });
      });

      it("marks encoder available across all lifecycle statuses when result works", () => {
        const worksResult = createResult("aac", "audio", "works");

        for (const status of [
          "idle",
          "locating",
          "probing",
          "ready",
          "missing",
          "failed",
        ] as const) {
          const state = createState({
            status,
            results: [worksResult],
          });

          expect(getEncoderAvailability(state, "aac")).toStrictEqual({
            name: "aac",
            availability: "available",
          });
        }
      });

      it("maps timedOut status to unavailable with reason timedOut", () => {
        const timedOutResult = createResult("libsvtav1", "video", "timedOut");
        const state = createState({
          status: "ready",
          results: [timedOutResult],
        });

        const option = getEncoderAvailability(state, "libsvtav1");

        expect(option).toStrictEqual({
          name: "libsvtav1",
          availability: "unavailable",
          reason: "timedOut",
        });
      });

      it("maps notListed result to unavailable with reason notListed", () => {
        const notListedResult = createResult("h264_nvenc", "video", "notListed");
        const state = createState({
          status: "probing",
          results: [notListedResult],
        });

        const option = getEncoderAvailability(state, "h264_nvenc");

        expect(option).toStrictEqual({
          name: "h264_nvenc",
          availability: "unavailable",
          reason: "notListed",
        });
      });
    });

    describe("absent encoders across lifecycle statuses", () => {
      it("marks absent encoder unavailable with reason notListed when ready", () => {
        const state = createState({ status: "ready", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unavailable",
          reason: "notListed",
        });
      });

      it("marks absent encoder unknown when status is missing", () => {
        const state = createState({ status: "missing", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
      });

      it("marks absent encoder unknown when status is failed", () => {
        const state = createState({ status: "failed", results: [] });
        const option = getEncoderAvailability(state, "libx264");

        expect(option).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
      });
    });

    describe("reason key contract", () => {
      it("ensures available and unknown options carry NO reason key at all", () => {
        const availableOption = getEncoderAvailability(
          createState({
            status: "ready",
            results: [createResult("libx264", "video", "works")],
          }),
          "libx264",
        );
        expect(availableOption).toStrictEqual({
          name: "libx264",
          availability: "available",
        });
        expect("reason" in availableOption).toBe(false);

        const unknownOption = getEncoderAvailability(
          createState({ status: "probing", results: [] }),
          "libx264",
        );
        expect(unknownOption).toStrictEqual({
          name: "libx264",
          availability: "unknown",
        });
        expect("reason" in unknownOption).toBe(false);
      });
    });

    describe("exact-name matching", () => {
      it("distinguishes colliding encoder names using exact matching", () => {
        const state = createState({
          status: "ready",
          results: [
            createResult("aac_at", "audio", "notListed"),
            createResult("aac", "audio", "works"),
          ],
        });

        expect(getEncoderAvailability(state, "aac")).toStrictEqual({
          name: "aac",
          availability: "available",
        });

        expect(getEncoderAvailability(state, "aac_at")).toStrictEqual({
          name: "aac_at",
          availability: "unavailable",
          reason: "notListed",
        });
      });
    });
  });

  describe("buildEncoderOptions", () => {
    describe("the prepend", () => {
      it("prepends an absent currentValue FIRST when currentValue is not in results", () => {
        const state = createState({
          status: "ready",
          results: [
            createResult("libx264", "video", "works"),
            createResult("libx265", "video", "works"),
          ],
        });

        const options = buildEncoderOptions(state, "video", "h264_videotoolbox");

        expect(options[0]).toStrictEqual({
          name: "h264_videotoolbox",
          availability: "unavailable",
          reason: "notListed",
        });

        expect(options).toStrictEqual([
          {
            name: "h264_videotoolbox",
            availability: "unavailable",
            reason: "notListed",
          },
          {
            name: "libx264",
            availability: "available",
          },
          {
            name: "libx265",
            availability: "available",
          },
        ]);
      });

      it("prepends an absent currentValue with unknown availability during probing", () => {
        const state = createState({
          status: "probing",
          results: [createResult("libx264", "video", "works")],
        });

        const options = buildEncoderOptions(state, "video", "hevc_videotoolbox");

        expect(options).toStrictEqual([
          {
            name: "hevc_videotoolbox",
            availability: "unknown",
          },
          {
            name: "libx264",
            availability: "available",
          },
        ]);
      });
    });

    describe("kind filtering", () => {
      it("returns only audio entries and excludes video entries when audio kind is requested", () => {
        const state = createState({
          status: "ready",
          results: [
            createResult("libx264", "video", "works"),
            createResult("aac", "audio", "works"),
            createResult("libx265", "video", "works"),
            createResult("libopus", "audio", "timedOut"),
          ],
        });

        const options = buildEncoderOptions(state, "audio", "aac");

        expect(options).toStrictEqual([
          {
            name: "aac",
            availability: "available",
          },
          {
            name: "libopus",
            availability: "unavailable",
            reason: "timedOut",
          },
        ]);
      });
    });

    describe("currentValue position and duplication handling", () => {
      it("does not duplicate an already present currentValue and keeps its natural position", () => {
        const state = createState({
          status: "ready",
          results: [
            createResult("libx264", "video", "works"),
            createResult("libx265", "video", "works"),
            createResult("libsvtav1", "video", "failed"),
          ],
        });

        const options = buildEncoderOptions(state, "video", "libx265");

        expect(options).toStrictEqual([
          {
            name: "libx264",
            availability: "available",
          },
          {
            name: "libx265",
            availability: "available",
          },
          {
            name: "libsvtav1",
            availability: "unavailable",
            reason: "failed",
          },
        ]);
      });
    });

    describe("blank and whitespace-only currentValue handling", () => {
      it("prepends nothing when currentValue is empty string", () => {
        const state = createState({
          status: "ready",
          results: [createResult("aac", "audio", "works")],
        });

        const options = buildEncoderOptions(state, "audio", "");

        expect(options).toStrictEqual([
          {
            name: "aac",
            availability: "available",
          },
        ]);
      });

      it("prepends nothing when currentValue is whitespace-only", () => {
        const state = createState({
          status: "ready",
          results: [createResult("aac", "audio", "works")],
        });

        const spaces = buildEncoderOptions(state, "audio", "   ");
        expect(spaces).toStrictEqual([
          {
            name: "aac",
            availability: "available",
          },
        ]);

        const tabsAndNewlines = buildEncoderOptions(state, "audio", "\t \n ");
        expect(tabsAndNewlines).toStrictEqual([
          {
            name: "aac",
            availability: "available",
          },
        ]);
      });
    });

    describe("empty results array handling", () => {
      it("returns exactly one option when results is empty and currentValue is non-blank", () => {
        const state = createState({ status: "ready", results: [] });

        const options = buildEncoderOptions(state, "video", "libx264");

        expect(options).toHaveLength(1);
        expect(options).toStrictEqual([
          {
            name: "libx264",
            availability: "unavailable",
            reason: "notListed",
          },
        ]);
      });

      it("returns exactly one option with unknown availability when probe failed and results is empty", () => {
        const state = createState({ status: "failed", results: [] });

        const options = buildEncoderOptions(state, "video", "libx264");

        expect(options).toHaveLength(1);
        expect(options).toStrictEqual([
          {
            name: "libx264",
            availability: "unknown",
          },
        ]);
      });

      it("returns an empty array when results is empty and currentValue is blank", () => {
        const state = createState({ status: "ready", results: [] });

        const options = buildEncoderOptions(state, "video", "");

        expect(options).toHaveLength(0);
        expect(options).toStrictEqual([]);
      });
    });

    describe("kind mismatch between results and currentValue", () => {
      it("prepends currentValue if it is present in results but under a different kind", () => {
        const state = createState({
          status: "ready",
          results: [
            createResult("aac", "audio", "works"),
            createResult("libx264", "video", "works"),
          ],
        });

        const options = buildEncoderOptions(state, "video", "aac");

        expect(options).toStrictEqual([
          {
            name: "aac",
            availability: "available",
          },
          {
            name: "libx264",
            availability: "available",
          },
        ]);
      });
    });

    describe("raw currentValue preservation", () => {
      it("preserves raw currentValue with trailing whitespace when results contain trimmed name", () => {
        const state = createState({
          status: "ready",
          results: [createResult("libx264", "video", "works")],
        });

        const options = buildEncoderOptions(state, "video", "libx264 ");

        expect(options).toHaveLength(2);
        expect(options[0].name).toBe("libx264 ");
        expect(options[0]).toStrictEqual({
          name: "libx264 ",
          availability: "unavailable",
          reason: "notListed",
        });
        expect(options[1]).toStrictEqual({
          name: "libx264",
          availability: "available",
        });
      });
    });
  });
});
