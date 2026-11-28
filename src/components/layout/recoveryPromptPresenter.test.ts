import { describe, expect, it } from "vitest";
import { createI18nInstance } from "@/i18n";
import type { RecoveryOfferSummary } from "@/features/recovery/types";
import { formatRecoveryTime, presentRecoveryPrompt } from "./recoveryPromptPresenter";

/** 2026-11-27 15:04 UTC. */
const WRITTEN_AT = Date.UTC(2026, 10, 27, 15, 4);

function offer(projectPath: string | null): RecoveryOfferSummary {
  return { id: "00000000000000a1", writtenAtMs: WRITTEN_AT, projectPath };
}

const UTC = { timeZone: "UTC" };

describe("formatRecoveryTime", () => {
  it("gives a short date and a short time in the format of the language", () => {
    const expected = (locale: string) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(WRITTEN_AT));
    expect(formatRecoveryTime(WRITTEN_AT, "en", UTC)).toBe(expected("en"));
    expect(formatRecoveryTime(WRITTEN_AT, "zh-CN", UTC)).toBe(expected("zh-CN"));
    // The two languages give two formats.
    expect(formatRecoveryTime(WRITTEN_AT, "en", UTC)).not.toBe(
      formatRecoveryTime(WRITTEN_AT, "zh-CN", UTC),
    );
  });
});

describe("presentRecoveryPrompt", () => {
  it("names the project file of the offer, and shows the time of its last write", () => {
    expect(
      presentRecoveryPrompt(offer("/Users/me/Cuts/Stream.qcproj"), "en", UTC),
    ).toEqual({
      title: { key: "recovery.title" },
      lines: [
        { key: "recovery.file", values: { name: "Stream.qcproj" } },
        {
          key: "recovery.savedAt",
          values: { time: formatRecoveryTime(WRITTEN_AT, "en", UTC) },
        },
      ],
      restore: { key: "recovery.restore" },
      discard: { key: "recovery.discard" },
      notNow: { key: "recovery.notNow" },
    });
  });

  it("names the file of a Windows path", () => {
    expect(
      presentRecoveryPrompt(offer("C:\\Cuts\\Stream.qcproj"), "en", UTC).lines[0],
    ).toEqual({ key: "recovery.file", values: { name: "Stream.qcproj" } });
  });

  it("says that the project had no file, also for a path with no name", () => {
    for (const path of [null, "/Users/me/Cuts/"]) {
      expect(presentRecoveryPrompt(offer(path), "en", UTC).lines[0]).toEqual({
        key: "recovery.noFile",
      });
    }
  });

  it("formats the time in the language that it gets", () => {
    expect(presentRecoveryPrompt(offer(null), "zh-CN", UTC).lines[1]).toEqual({
      key: "recovery.savedAt",
      values: { time: formatRecoveryTime(WRITTEN_AT, "zh-CN", UTC) },
    });
  });
});

describe("the catalog messages of the recovery prompt", () => {
  it("renders each message in English and in Chinese", async () => {
    const english = await createI18nInstance({
      initialPreference: "en",
      storage: null,
    });
    const chinese = await createI18nInstance({
      initialPreference: "zh-CN",
      storage: null,
    });
    const t = (instance: typeof english) =>
      instance.t as unknown as (
        key: string,
        options?: Readonly<Record<string, string | number>>,
      ) => string;
    const en = t(english);
    const zh = t(chinese);

    expect(en("recovery.title")).toBe("Restore the work that was not saved?");
    expect(en("recovery.file", { name: "Stream.qcproj" })).toBe(
      "QuipClip ended before the changes to “Stream.qcproj” were saved. It kept that work.",
    );
    expect(en("recovery.noFile")).toBe(
      "QuipClip ended before a project with no file was saved. It kept that work.",
    );
    expect(en("recovery.savedAt", { time: "11/27/26, 3:04 PM" })).toBe(
      "Saved for recovery: 11/27/26, 3:04 PM",
    );
    expect(en("recovery.restore")).toBe("Restore");
    expect(en("recovery.discard")).toBe("Discard");
    expect(en("recovery.notNow")).toBe("Not Now");

    for (const key of [
      "recovery.title",
      "recovery.noFile",
      "recovery.restore",
      "recovery.discard",
      "recovery.notNow",
    ]) {
      expect(zh(key)).not.toBe(en(key));
      expect(zh(key)).not.toBe(key);
    }
    expect(zh("recovery.file", { name: "Stream.qcproj" })).toContain("“Stream.qcproj”");
    expect(zh("recovery.savedAt", { time: "2026/11/27 15:04" })).toBe(
      "恢复文件保存于：2026/11/27 15:04",
    );
  });
});
