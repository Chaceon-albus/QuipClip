import { describe, expect, it } from "vitest";

import { createI18nInstance } from "@/i18n";
import type { BuildInfo, BuildSource } from "@/lib/buildInfo";
import { presentVersionLine } from "./aboutPresenter";

function info(source: BuildSource | null): BuildInfo {
  return { version: "0.1.1", source };
}

/** Every shape of the version line, with the text of each language. */
const CASES: {
  name: string;
  source: BuildSource | null;
  en: string;
  zhCN: string;
}[] = [
  {
    name: "a build with no git checkout",
    source: null,
    en: "Version 0.1.1",
    zhCN: "版本 0.1.1",
  },
  {
    name: "a build of the default branch",
    source: { commit: "a1b2c3d", branch: null, modified: false },
    en: "Version 0.1.1 (a1b2c3d)",
    zhCN: "版本 0.1.1（a1b2c3d）",
  },
  {
    name: "a build of another branch",
    source: { commit: "a1b2c3d", branch: "feature/trim", modified: false },
    en: "Version 0.1.1 (feature/trim a1b2c3d)",
    zhCN: "版本 0.1.1（feature/trim a1b2c3d）",
  },
  {
    name: "a modified build of the default branch",
    source: { commit: "a1b2c3d", branch: null, modified: true },
    en: "Version 0.1.1 (a1b2c3d, modified)",
    zhCN: "版本 0.1.1（a1b2c3d，含未提交改动）",
  },
  {
    name: "a modified build of another branch",
    source: { commit: "a1b2c3d", branch: "feature/trim", modified: true },
    en: "Version 0.1.1 (feature/trim a1b2c3d, modified)",
    zhCN: "版本 0.1.1（feature/trim a1b2c3d，含未提交改动）",
  },
];

describe("presentVersionLine", () => {
  it.each(CASES)("renders $name in both languages", async ({ source, en, zhCN }) => {
    const view = presentVersionLine(info(source));
    const translator = async (language: "en" | "zh-CN") =>
      (await createI18nInstance({ initialPreference: language })).t as (
        key: string,
        options?: Record<string, string>,
      ) => string;

    // A missing key or a placeholder without a value would show here as raw text.
    expect((await translator("en"))(view.key, view.values)).toBe(en);
    expect((await translator("zh-CN"))(view.key, view.values)).toBe(zhCN);
  });

  it("gives each shape its own message", () => {
    const keys = CASES.map(({ source }) => presentVersionLine(info(source)).key);
    expect(new Set(keys).size).toBe(CASES.length);
  });

  it("passes only the values that the message names", () => {
    expect(presentVersionLine(info(null)).values).toEqual({ version: "0.1.1" });
    expect(
      presentVersionLine(info({ commit: "a1b2c3d", branch: null, modified: true }))
        .values,
    ).toEqual({ version: "0.1.1", commit: "a1b2c3d" });
  });
});
