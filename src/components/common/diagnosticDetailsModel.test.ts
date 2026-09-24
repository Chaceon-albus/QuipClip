import { describe, expect, it } from "vitest";

import { zhCN } from "@/i18n";
import { en } from "@/i18n/locales/en";
import { COPIED_FEEDBACK_MS } from "@/lib/clipboard";
import {
  ANNOUNCE_GAP_MS,
  copyFeedbackDurationMs,
  copyFeedbackOf,
  selectedHintKey,
} from "./diagnosticDetailsModel";

/** Resolves a dotted key against a nested catalog, the way i18next walks it. */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

describe("copyFeedbackOf", () => {
  it("confirms a write that succeeded", () => {
    expect(copyFeedbackOf("copied")).toBe("copied");
  });

  it("falls back to the selected text when the write failed", () => {
    expect(copyFeedbackOf("failed")).toBe("selected");
  });
});

describe("copyFeedbackDurationMs", () => {
  it("keeps the confirmation for the copied feedback time", () => {
    expect(copyFeedbackDurationMs("copied")).toBe(COPIED_FEEDBACK_MS);
  });

  it("keeps the hint until the next click", () => {
    expect(copyFeedbackDurationMs("selected")).toBeNull();
  });
});

describe("ANNOUNCE_GAP_MS", () => {
  it("leaves about 100 ms between the empty live region and the result", () => {
    expect(ANNOUNCE_GAP_MS).toBe(100);
  });

  it("ends well before the confirmation does", () => {
    expect(ANNOUNCE_GAP_MS).toBeLessThan(COPIED_FEEDBACK_MS);
  });
});

describe("selectedHintKey", () => {
  it("names ⌘C on macOS and Ctrl+C elsewhere", () => {
    expect(selectedHintKey(true)).toBe("common.diagnostic.selectedMac");
    expect(selectedHintKey(false)).toBe("common.diagnostic.selectedWindows");
  });

  it("uses keys that both catalogs hold, with the shortcut of the platform", () => {
    for (const catalog of [en, zhCN]) {
      const mac = resolveCatalogKey(catalog, selectedHintKey(true));
      const windows = resolveCatalogKey(catalog, selectedHintKey(false));
      expect(mac).toEqual(expect.stringContaining("⌘C"));
      expect(mac).toEqual(expect.not.stringContaining("Cmd"));
      expect(windows).toEqual(expect.stringContaining("Ctrl+C"));
    }
  });
});
