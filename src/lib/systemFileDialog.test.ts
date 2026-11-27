import { describe, expect, it } from "vitest";
import { isSystemFileDialogOpen, trackSystemFileDialog } from "./systemFileDialog";

describe("trackSystemFileDialog", () => {
  it("counts each dialog until its call settles", async () => {
    let answerFirst: (value: string) => void = () => {};
    let answerSecond: (value: string) => void = () => {};
    expect(isSystemFileDialogOpen()).toBe(false);

    const first = trackSystemFileDialog(
      () =>
        new Promise<string>((resolve) => {
          answerFirst = resolve;
        }),
    );
    const second = trackSystemFileDialog(
      () =>
        new Promise<string>((resolve) => {
          answerSecond = resolve;
        }),
    );
    expect(isSystemFileDialogOpen()).toBe(true);

    answerFirst("a");
    await expect(first).resolves.toBe("a");
    expect(isSystemFileDialogOpen()).toBe(true);

    answerSecond("b");
    await expect(second).resolves.toBe("b");
    expect(isSystemFileDialogOpen()).toBe(false);
  });

  it("counts a dialog that rejects or throws as closed after the call", async () => {
    await expect(
      trackSystemFileDialog(() => Promise.reject(new Error("no dialog"))),
    ).rejects.toThrow("no dialog");
    expect(isSystemFileDialogOpen()).toBe(false);

    await expect(
      trackSystemFileDialog(() => {
        throw new Error("no plugin");
      }),
    ).rejects.toThrow("no plugin");
    expect(isSystemFileDialogOpen()).toBe(false);
  });
});
