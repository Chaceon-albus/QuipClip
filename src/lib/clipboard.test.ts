import { describe, expect, it, vi } from "vitest";

import { COPIED_FEEDBACK_MS, copyText, type ClipboardWriter } from "./clipboard";

describe("copyText", () => {
  it("writes the text unchanged and answers copied", async () => {
    const writeText = vi
      .fn<ClipboardWriter["writeText"]>()
      .mockResolvedValue(undefined);
    const text = "[mp4 @ 0x1] Could not write header\n  exit status 1";

    await expect(copyText(text, { writeText })).resolves.toBe("copied");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("answers failed when the write rejects", async () => {
    const writeText = vi
      .fn<ClipboardWriter["writeText"]>()
      .mockRejectedValue(
        new DOMException("Document is not focused.", "NotAllowedError"),
      );

    await expect(copyText("detail", { writeText })).resolves.toBe("failed");
  });

  it("answers failed when the write throws before it returns a promise", async () => {
    const writeText = vi.fn<ClipboardWriter["writeText"]>().mockImplementation(() => {
      throw new TypeError("Illegal invocation");
    });

    await expect(copyText("detail", { writeText })).resolves.toBe("failed");
  });

  it("answers failed when no clipboard exists", async () => {
    await expect(copyText("detail", null)).resolves.toBe("failed");
  });

  it("answers failed when the clipboard has no writeText", async () => {
    const clipboard = {} as unknown as ClipboardWriter;

    await expect(copyText("detail", clipboard)).resolves.toBe("failed");
  });

  it("uses the clipboard of the web view when the caller passes none", async () => {
    const writeText = vi
      .fn<ClipboardWriter["writeText"]>()
      .mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await expect(copyText("detail")).resolves.toBe("copied");
      expect(writeText).toHaveBeenCalledWith("detail");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers failed when the web view has no clipboard and the caller passes none", async () => {
    vi.stubGlobal("navigator", {});
    try {
      await expect(copyText("detail")).resolves.toBe("failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("COPIED_FEEDBACK_MS", () => {
  it("keeps the confirmation for about two seconds", () => {
    expect(COPIED_FEEDBACK_MS).toBe(2000);
  });
});
