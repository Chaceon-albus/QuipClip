import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_ASPECT_RATIO,
  INITIAL_PREVIEW_FRAME_RATIO_STATE,
  MAX_PREVIEW_ASPECT_RATIO,
  MIN_PREVIEW_ASPECT_RATIO,
  previewFrameAspectRatio,
  previewFrameStyle,
  readPictureAspectRatio,
  stepPreviewFrameRatio,
  type PreviewFrameRatioState,
} from "./previewAspectRatio";

describe("readPictureAspectRatio", () => {
  it("divides the width by the height", () => {
    expect(readPictureAspectRatio(1920, 1080)).toBeCloseTo(16 / 9, 12);
    expect(readPictureAspectRatio(1080, 1920)).toBeCloseTo(9 / 16, 12);
    expect(readPictureAspectRatio(1080, 1080)).toBe(1);
    expect(readPictureAspectRatio(640, 480)).toBeCloseTo(4 / 3, 12);
    expect(readPictureAspectRatio(1920, 804)).toBeCloseTo(2.388, 3);
  });

  it("keeps a display size that the element already corrected", () => {
    // An anamorphic 720x576 PAL picture with a 16:15 pixel aspect ratio displays at 768x576.
    expect(readPictureAspectRatio(768, 576)).toBeCloseTo(4 / 3, 12);
    // A 1920x1080 phone recording rotated by 90 degrees displays at 1080x1920.
    expect(readPictureAspectRatio(1080, 1920)).toBeCloseTo(9 / 16, 12);
  });

  it("returns null for the size of an element with no picture", () => {
    // Before the metadata loads.
    expect(readPictureAspectRatio(0, 0)).toBeNull();
    // A web view that plays the sound but decodes no picture (ADR 003).
    expect(readPictureAspectRatio(0, 1080)).toBeNull();
    expect(readPictureAspectRatio(1920, 0)).toBeNull();
  });

  it("returns null for a negative or non-finite size", () => {
    expect(readPictureAspectRatio(-1920, 1080)).toBeNull();
    expect(readPictureAspectRatio(1920, -1080)).toBeNull();
    expect(readPictureAspectRatio(Number.NaN, 1080)).toBeNull();
    expect(readPictureAspectRatio(1920, Number.NaN)).toBeNull();
    expect(readPictureAspectRatio(Number.POSITIVE_INFINITY, 1080)).toBeNull();
    expect(readPictureAspectRatio(1920, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null when the division leaves the float range", () => {
    expect(readPictureAspectRatio(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull();
    expect(readPictureAspectRatio(Number.MIN_VALUE, Number.MAX_VALUE)).toBeNull();
  });
});

/** A state that holds a picture ratio. */
function withRatio(pictureRatio: number | null): PreviewFrameRatioState {
  return { pictureRatio };
}

/** The picture views of the pane. */
const picture = { hasMedia: true, decodeFailed: false };
const noMedia = { hasMedia: false, decodeFailed: false };
const decodeFailure = { hasMedia: true, decodeFailed: true };

describe("stepPreviewFrameRatio", () => {
  it("starts with no picture ratio", () => {
    expect(INITIAL_PREVIEW_FRAME_RATIO_STATE).toEqual({ pictureRatio: null });
  });

  it("takes the ratio of a reported picture size", () => {
    const state = stepPreviewFrameRatio(INITIAL_PREVIEW_FRAME_RATIO_STATE, {
      type: "pictureSize",
      width: 1080,
      height: 1920,
    });
    expect(state.pictureRatio).toBeCloseTo(9 / 16, 12);
  });

  it("follows a later resize of the picture", () => {
    const portrait = stepPreviewFrameRatio(INITIAL_PREVIEW_FRAME_RATIO_STATE, {
      type: "pictureSize",
      width: 1080,
      height: 1920,
    });
    const landscape = stepPreviewFrameRatio(portrait, {
      type: "pictureSize",
      width: 1920,
      height: 1080,
    });
    expect(landscape.pictureRatio).toBeCloseTo(16 / 9, 12);
  });

  it("clears the ratio for a size that is not a picture size", () => {
    // A web view that plays the sound but decodes no picture reports a width of 0 (ADR 003).
    expect(
      stepPreviewFrameRatio(withRatio(9 / 16), {
        type: "pictureSize",
        width: 0,
        height: 1080,
      }),
    ).toEqual({ pictureRatio: null });
    expect(
      stepPreviewFrameRatio(withRatio(9 / 16), {
        type: "pictureSize",
        width: 0,
        height: 0,
      }),
    ).toEqual({ pictureRatio: null });
  });

  it("resets when the media becomes null", () => {
    expect(
      stepPreviewFrameRatio(withRatio(9 / 16), {
        type: "mediaChanged",
        hasMedia: false,
      }),
    ).toEqual({ pictureRatio: null });
  });

  it("carries the ratio over when a source replaces another", () => {
    // The new element has not reported yet, so the frame keeps the shape of the previous
    // source and does not flash 16:9 between two portrait sources.
    const state = withRatio(9 / 16);
    expect(stepPreviewFrameRatio(state, { type: "mediaChanged", hasMedia: true })).toBe(
      state,
    );
  });

  it("keeps the same state object when the ratio does not change", () => {
    const state = withRatio(16 / 9);
    expect(
      stepPreviewFrameRatio(state, { type: "pictureSize", width: 1920, height: 1080 }),
    ).toBe(state);
    expect(
      stepPreviewFrameRatio(INITIAL_PREVIEW_FRAME_RATIO_STATE, {
        type: "pictureSize",
        width: 0,
        height: 0,
      }),
    ).toBe(INITIAL_PREVIEW_FRAME_RATIO_STATE);
    expect(
      stepPreviewFrameRatio(INITIAL_PREVIEW_FRAME_RATIO_STATE, {
        type: "mediaChanged",
        hasMedia: false,
      }),
    ).toBe(INITIAL_PREVIEW_FRAME_RATIO_STATE);
  });

  it("runs the lifecycle of a close and a new open", () => {
    let state = INITIAL_PREVIEW_FRAME_RATIO_STATE;
    state = stepPreviewFrameRatio(state, { type: "mediaChanged", hasMedia: true });
    state = stepPreviewFrameRatio(state, {
      type: "pictureSize",
      width: 1080,
      height: 1920,
    });
    expect(previewFrameAspectRatio(state, picture)).toBeCloseTo(9 / 16, 12);
    state = stepPreviewFrameRatio(state, { type: "mediaChanged", hasMedia: false });
    expect(previewFrameAspectRatio(state, noMedia)).toBe(DEFAULT_PREVIEW_ASPECT_RATIO);
    // A source opened after the close starts from the default, not from the closed ratio.
    state = stepPreviewFrameRatio(state, { type: "mediaChanged", hasMedia: true });
    expect(previewFrameAspectRatio(state, picture)).toBe(DEFAULT_PREVIEW_ASPECT_RATIO);
  });
});

describe("previewFrameAspectRatio", () => {
  it("is 16:9 with no media", () => {
    expect(DEFAULT_PREVIEW_ASPECT_RATIO).toBe(16 / 9);
    // The empty state, the loading state and the import-error view.
    expect(previewFrameAspectRatio(withRatio(9 / 16), noMedia)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
    expect(previewFrameAspectRatio(withRatio(null), noMedia)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
  });

  it("is 16:9 on a decode failure", () => {
    // The decode-failure panel replaces the element, so the picture ratio does not apply.
    expect(previewFrameAspectRatio(withRatio(9 / 16), decodeFailure)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
    // A decode failure with no media cannot happen, but it gives the default too.
    expect(
      previewFrameAspectRatio(withRatio(9 / 16), {
        hasMedia: false,
        decodeFailed: true,
      }),
    ).toBe(DEFAULT_PREVIEW_ASPECT_RATIO);
  });

  it("is 16:9 until the element reports a picture size", () => {
    expect(previewFrameAspectRatio(withRatio(null), picture)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
  });

  it("takes the picture ratio while the frame holds the element", () => {
    expect(previewFrameAspectRatio(withRatio(9 / 16), picture)).toBe(9 / 16);
    expect(previewFrameAspectRatio(withRatio(1), picture)).toBe(1);
    expect(previewFrameAspectRatio(withRatio(16 / 9), picture)).toBe(16 / 9);
    expect(previewFrameAspectRatio(withRatio(2.39), picture)).toBe(2.39);
    expect(previewFrameAspectRatio(withRatio(4 / 3), picture)).toBe(4 / 3);
  });

  it("holds the ratio inside the limits", () => {
    expect(previewFrameAspectRatio(withRatio(1 / 10), picture)).toBe(
      MIN_PREVIEW_ASPECT_RATIO,
    );
    expect(previewFrameAspectRatio(withRatio(10), picture)).toBe(
      MAX_PREVIEW_ASPECT_RATIO,
    );
    expect(previewFrameAspectRatio(withRatio(MIN_PREVIEW_ASPECT_RATIO), picture)).toBe(
      MIN_PREVIEW_ASPECT_RATIO,
    );
    expect(previewFrameAspectRatio(withRatio(MAX_PREVIEW_ASPECT_RATIO), picture)).toBe(
      MAX_PREVIEW_ASPECT_RATIO,
    );
  });

  it("is 16:9 for a ratio that is not a finite number", () => {
    expect(previewFrameAspectRatio(withRatio(Number.NaN), picture)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
    expect(previewFrameAspectRatio(withRatio(Number.POSITIVE_INFINITY), picture)).toBe(
      DEFAULT_PREVIEW_ASPECT_RATIO,
    );
  });
});

describe("previewFrameStyle", () => {
  it("sets the ratio as a unitless custom property", () => {
    expect(previewFrameStyle(0.5625)).toEqual({ "--preview-ar": "0.5625" });
    expect(previewFrameStyle(DEFAULT_PREVIEW_ASPECT_RATIO)).toEqual({
      "--preview-ar": String(16 / 9),
    });
  });
});
