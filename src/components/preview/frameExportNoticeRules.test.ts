import { describe, expect, it } from "vitest";
import {
  FRAME_EXPORT_SAVED_KEY,
  presentFrameExportNotice,
} from "./frameExportNoticeRules";
import {
  previewNoticeTone,
  resolveNoticeTimer,
  showsNoticeArea,
} from "./previewNoticeRules";

describe("presentFrameExportNotice (ADR 069)", () => {
  it("shows nothing without a notice", () => {
    expect(presentFrameExportNotice(null)).toBeNull();
  });

  it("names the file of a saved image", () => {
    expect(
      presentFrameExportNotice({
        id: 3,
        kind: "saved",
        fileName: "clip_00-00-01-000.png",
      }),
    ).toEqual({
      kind: "frameExport",
      id: 3,
      messageKey: FRAME_EXPORT_SAVED_KEY,
      name: "clip_00-00-01-000.png",
    });
  });

  it("gives the message of the code and the detail of a failure", () => {
    expect(
      presentFrameExportNotice({
        id: 4,
        kind: "failed",
        code: "ffmpegProcessFailed",
        detail: "Invalid data found",
      }),
    ).toEqual({
      kind: "frameExportError",
      id: 4,
      messageKey: "frameExportError.ffmpegProcessFailed",
      detail: "Invalid data found",
    });
    expect(
      presentFrameExportNotice({
        id: 5,
        kind: "failed",
        code: "noFrame",
        detail: null,
      }),
    ).toMatchObject({ messageKey: "frameExportError.noFrame", detail: null });
  });

  it("shows a saved image as a success that leaves by itself, and a failure until dismissed", () => {
    expect(previewNoticeTone("frameExport")).toBe("success");
    expect(previewNoticeTone("frameExportError")).toBe("destructive");
    expect(resolveNoticeTimer("frameExport", "shown", false)).toMatchObject({
      action: "leave",
    });
    expect(resolveNoticeTimer("frameExport", "shown", true)).toBeNull();
    expect(resolveNoticeTimer("frameExport", "leaving", false)).toMatchObject({
      action: "dismiss",
    });
    expect(resolveNoticeTimer("frameExportError", "shown", false)).toBeNull();
  });

  it("keeps the notification area for the frame notice when no clip is attached", () => {
    // The removal of the last clip while the command runs must not hide its result.
    expect(showsNoticeArea(false, true)).toBe(true);
    expect(showsNoticeArea(true, false)).toBe(true);
    expect(showsNoticeArea(true, true)).toBe(true);
    expect(showsNoticeArea(false, false)).toBe(false);
  });
});
