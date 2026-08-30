import { describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  FALLBACK_LANGUAGE,
  LANGUAGE_PREFERENCES,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  createI18nInstance,
  en,
  getLanguagePreference,
  getResolvedLanguage,
  getStoredPreference,
  initI18n,
  parseCatalogKey,
  resolveLanguage,
  resolveSystemLanguage,
  setLanguagePreference,
  setStoredPreference,
  validateCatalogParity,
  validatePlaceholderSyntax,
  zhCN,
  type PreferenceStorage,
} from "./index";

/**
 * Creates an in-memory PreferenceStorage for isolated testing.
 */
function createMockStorage(
  initialData: Record<string, string> = {},
): PreferenceStorage {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("i18n constants and schema definitions", () => {
  it("defines supported and fallback language constants correctly", () => {
    expect(FALLBACK_LANGUAGE).toBe("en");
    expect(DEFAULT_LANGUAGE_PREFERENCE).toBe("system");
    expect(LANGUAGE_PREFERENCES).toEqual(["system", "en", "zh-CN"]);
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "zh-CN"]);
    expect(LANGUAGE_STORAGE_KEY).toBe("quipclip.language_preference");
  });
});

describe("ADR 011 key normalization and plural parity validator", () => {
  it("normalizes recognized cardinal and ordinal suffixes to candidate semantic base keys", () => {
    expect(parseCatalogKey("timeline.clip_one")).toEqual({
      baseKey: "timeline.clip",
      pluralType: "cardinal",
      category: "one",
      rawPath: "timeline.clip_one",
    });
    expect(parseCatalogKey("timeline.clip_other")).toEqual({
      baseKey: "timeline.clip",
      pluralType: "cardinal",
      category: "other",
      rawPath: "timeline.clip_other",
    });
    expect(parseCatalogKey("timeline.clip_zero")).toEqual({
      baseKey: "timeline.clip",
      pluralType: "cardinal",
      category: "zero",
      rawPath: "timeline.clip_zero",
    });
    expect(parseCatalogKey("ranking.item_ordinal_few")).toEqual({
      baseKey: "ranking.item",
      pluralType: "ordinal",
      category: "few",
      rawPath: "ranking.item_ordinal_few",
    });
    expect(parseCatalogKey("ranking.item_ordinal_other")).toEqual({
      baseKey: "ranking.item",
      pluralType: "ordinal",
      category: "other",
      rawPath: "ranking.item_ordinal_other",
    });
    expect(parseCatalogKey("titleBar.menu.file")).toEqual({
      baseKey: "titleBar.menu.file",
      pluralType: null,
      category: null,
      rawPath: "titleBar.menu.file",
    });
  });

  it("passes parity validation for production en and zh-CN catalogs", () => {
    const result = validateCatalogParity({
      en,
      "zh-CN": zhCN,
    });

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("verifies ADR 011 required settings and autonym labels", () => {
    expect(en.settings.language.label).toBe("Language");
    expect(zhCN.settings.language.label).toBe("语言");

    expect(en.settings.language.system).toBe("System Default");
    expect(zhCN.settings.language.system).toBe("系统默认");

    // Both catalogs must show autonyms for language options
    expect(en.settings.language.en).toBe("English");
    expect(zhCN.settings.language.en).toBe("English");
    expect(en.settings.language.zhCN).toBe("简体中文");
    expect(zhCN.settings.language.zhCN).toBe("简体中文");
  });

  it("preserves technical identifiers in both catalogs", () => {
    expect(en.app.name).toBe("QuipClip");
    expect(zhCN.app.name).toBe("QuipClip");
  });

  describe("evidence-based plural family detection and false-positive prevention", () => {
    it("does not classify ordinary exact semantic keys such as tone_one, status_other, or phase_ordinal_one as plural solely from suffix", () => {
      const ordinarySemanticKeys = {
        en: {
          tone_one: "Warm Tone",
          status_other: "Pending Review",
          phase_ordinal_one: "Stage 1",
        },
        "zh-CN": {
          tone_one: "暖色调",
          status_other: "等待审核",
          phase_ordinal_one: "阶段 1",
        },
      };

      const result = validateCatalogParity(ordinarySemanticKeys);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("does not treat sibling shapes without {{count}} as plural and ensures ordinary tone_one and tone_other remain ordinary exact keys in both catalogs", () => {
      const siblingOrdinaryKeys = {
        en: {
          tone_one: "Warm Tone",
          tone_other: "Cool Tone",
        },
        "zh-CN": {
          tone_one: "暖色调",
          tone_other: "冷色调",
        },
      };

      const result = validateCatalogParity(siblingOrdinaryKeys);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("catches identically incomplete plural families via count placeholder evidence", () => {
      const incompleteWithCount = {
        en: {
          items_one: "{{count}} item",
        },
        "zh-CN": {
          items_one: "{{count}} 项",
        },
      };

      const result = validateCatalogParity(incompleteWithCount);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required cardinal plural category 'other'",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' is missing required cardinal plural category 'other'",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' contains unexpected cardinal plural category 'one'",
          ),
        ),
      ).toBe(true);
    });

    it("catches identically incomplete plural families via explicit typed validator metadata when count is absent", () => {
      const incompleteWithoutCount = {
        en: {
          items_one: "one item",
        },
        "zh-CN": {
          items_one: "一项",
        },
      };

      const resultRecord = validateCatalogParity(incompleteWithoutCount, {
        declaredPlurals: { items: "cardinal" },
      });
      expect(resultRecord.isValid).toBe(false);
      expect(
        resultRecord.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required cardinal plural category 'other'",
          ),
        ),
      ).toBe(true);
      expect(
        resultRecord.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' is missing required cardinal plural category 'other'",
          ),
        ),
      ).toBe(true);

      const resultMap = validateCatalogParity(incompleteWithoutCount, {
        declaredPlurals: new Map([["items", "cardinal"]]),
      });
      expect(resultMap.isValid).toBe(false);
    });

    it("allows both complete cardinal and ordinal plural families at the same base key without overwriting each other", () => {
      const bothComplete = {
        en: {
          clip_one: "{{count}} clip",
          clip_other: "{{count}} clips",
          clip_ordinal_one: "{{count}}st clip",
          clip_ordinal_two: "{{count}}nd clip",
          clip_ordinal_few: "{{count}}rd clip",
          clip_ordinal_other: "{{count}}th clip",
        },
        "zh-CN": {
          clip_other: "{{count}} 个片段",
          clip_ordinal_other: "第 {{count}} 个片段",
        },
      };

      // Auto-detected via {{count}} on suffixed forms
      const resultAuto = validateCatalogParity(bothComplete);
      expect(resultAuto.isValid).toBe(true);
      expect(resultAuto.errors).toEqual([]);

      // Explicitly declared as 'both'
      const resultDeclaredBoth = validateCatalogParity(bothComplete, {
        declaredPlurals: { clip: "both" },
      });
      expect(resultDeclaredBoth.isValid).toBe(true);
      expect(resultDeclaredBoth.errors).toEqual([]);

      // Explicitly declared via Map with array
      const resultMapDeclared = validateCatalogParity(bothComplete, {
        declaredPlurals: new Map([["clip", ["cardinal", "ordinal"]]]),
      });
      expect(resultMapDeclared.isValid).toBe(true);
      expect(resultMapDeclared.errors).toEqual([]);
    });

    it("proves an incomplete family is rejected when both cardinal and ordinal families share the same base key", () => {
      const incompleteOrdinalCompleteCardinal = {
        en: {
          clip_one: "{{count}} clip",
          clip_other: "{{count}} clips",
          clip_ordinal_one: "{{count}}st clip",
          clip_ordinal_two: "{{count}}nd clip",
          // missing clip_ordinal_few
          clip_ordinal_other: "{{count}}th clip",
        },
        "zh-CN": {
          clip_other: "{{count}} 个片段",
          clip_ordinal_other: "第 {{count}} 个片段",
        },
      };

      const result = validateCatalogParity(incompleteOrdinalCompleteCardinal, {
        declaredPlurals: { clip: "both" },
      });
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required ordinal plural category 'few' for base key 'clip'",
          ),
        ),
      ).toBe(true);
      // Cardinal family is complete and must not produce category errors
      expect(
        result.errors.some((err) => err.includes("cardinal plural category")),
      ).toBe(false);
    });

    it("enforces declared plural family when only regular unsuffixed messages exist", () => {
      const unsuffixedCatalogs = {
        en: {
          alert: "An alert occurred",
        },
        "zh-CN": {
          alert: "发生警报",
        },
      };

      const result = validateCatalogParity(unsuffixedCatalogs, {
        declaredPlurals: { alert: "cardinal" },
      });
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required cardinal plural category 'one' for base key 'alert' (expected key 'alert_one')",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required cardinal plural category 'other' for base key 'alert' (expected key 'alert_other')",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' is missing required cardinal plural category 'other' for base key 'alert' (expected key 'alert_other')",
          ),
        ),
      ).toBe(true);
    });

    it("enforces declared plural family when no forms at all exist for declared base key and type", () => {
      const emptyCatalogs = {
        en: {
          title: "QuipClip",
        },
        "zh-CN": {
          title: "QuipClip",
        },
      };

      const result = validateCatalogParity(emptyCatalogs, {
        declaredPlurals: { rank: "ordinal" },
      });
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required ordinal plural category 'one' for base key 'rank' (expected key 'rank_ordinal_one')",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required ordinal plural category 'few' for base key 'rank' (expected key 'rank_ordinal_few')",
          ),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' is missing required ordinal plural category 'other' for base key 'rank' (expected key 'rank_ordinal_other')",
          ),
        ),
      ).toBe(true);
    });
  });

  describe("exact-count _zero and ordinal plural rules", () => {
    it("accepts complete synthetic cardinal catalogs with exact-count _zero override", () => {
      const cardinalWithZero = {
        en: {
          items_zero: "No items",
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items_zero: "无项目",
          items_other: "{{count}} 项",
        },
      };

      const result = validateCatalogParity(cardinalWithZero);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects dead English ordinal zero form _ordinal_zero", () => {
      const enOrdinalZero = {
        en: {
          rank_ordinal_zero: "0th place",
          rank_ordinal_one: "{{count}}st place",
          rank_ordinal_two: "{{count}}nd place",
          rank_ordinal_few: "{{count}}rd place",
          rank_ordinal_other: "{{count}}th place",
        },
        "zh-CN": {
          rank_ordinal_other: "第 {{count}} 名",
        },
      };

      const result = validateCatalogParity(enOrdinalZero);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' contains unexpected ordinal plural category 'zero' for base key 'rank'",
          ),
        ),
      ).toBe(true);
    });

    it("rejects dead Simplified Chinese ordinal zero form _ordinal_zero", () => {
      const zhOrdinalZero = {
        en: {
          rank_ordinal_one: "{{count}}st place",
          rank_ordinal_two: "{{count}}nd place",
          rank_ordinal_few: "{{count}}rd place",
          rank_ordinal_other: "{{count}}th place",
        },
        "zh-CN": {
          rank_ordinal_zero: "第 0 名",
          rank_ordinal_other: "第 {{count}} 名",
        },
      };

      const result = validateCatalogParity(zhOrdinalZero);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'zh-CN' contains unexpected ordinal plural category 'zero' for base key 'rank'",
          ),
        ),
      ).toBe(true);
    });
  });

  describe("exact placeholder parity per semantic form", () => {
    it("detects missing {{count}} placeholder in target catalog plural form", () => {
      const missingCountInTarget = {
        en: {
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items_other: "多个项目", // missing {{count}}
        },
      };

      const result = validateCatalogParity(missingCountInTarget);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some(
          (err) =>
            err.includes("placeholder mismatch in 'items_other'") &&
            err.includes("expected [count], found []"),
        ),
      ).toBe(true);
    });

    it("validates category-specific placeholders against mapped source categories", () => {
      const validCategoryPlaceholders = {
        en: {
          message_one: "Deleted {{count}} {{itemSingular}}",
          message_other: "Deleted {{count}} {{itemPlural}}",
        },
        "zh-CN": {
          message_other: "已删除 {{count}} {{itemPlural}}", // maps to source 'other'
        },
      };

      const validResult = validateCatalogParity(validCategoryPlaceholders);
      expect(validResult.isValid).toBe(true);
      expect(validResult.errors).toEqual([]);

      const invalidCategoryPlaceholders = {
        en: {
          message_one: "Deleted {{count}} {{itemSingular}}",
          message_other: "Deleted {{count}} {{itemPlural}}",
        },
        "zh-CN": {
          message_other: "已删除 {{count}} {{itemSingular}}", // target 'other' should map to source 'other' (itemPlural)
        },
      };

      const invalidResult = validateCatalogParity(invalidCategoryPlaceholders);
      expect(invalidResult.isValid).toBe(false);
      expect(
        invalidResult.errors.some(
          (err) =>
            err.includes("placeholder mismatch in 'message_other'") &&
            err.includes("expected [count, itemPlural], found [count, itemSingular]"),
        ),
      ).toBe(true);
    });

    it("maps target optional cardinal _zero to source _zero if present, otherwise to source _other", () => {
      // 1. Source has _zero with no placeholders, target _zero matches
      const sourceWithZero = {
        en: {
          items_zero: "Zero items",
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items_zero: "零项",
          items_other: "{{count}} 项",
        },
      };
      expect(validateCatalogParity(sourceWithZero).isValid).toBe(true);

      // 2. Source has no _zero, so target _zero maps to source _other (expecting count)
      const sourceWithoutZeroValid = {
        en: {
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items_zero: "共 {{count}} 项（零）",
          items_other: "{{count}} 项",
        },
      };
      expect(validateCatalogParity(sourceWithoutZeroValid).isValid).toBe(true);

      const sourceWithoutZeroMismatch = {
        en: {
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items_zero: "无项目", // Missing count compared to source 'other'
          items_other: "{{count}} 项",
        },
      };
      const result = validateCatalogParity(sourceWithoutZeroMismatch);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("placeholder mismatch in 'items_zero'"),
        ),
      ).toBe(true);
    });
  });

  describe("placeholder syntax and positional placeholder rejection", () => {
    it("rejects positional placeholders like {0} even if used in all catalogs", () => {
      const positionalCatalogs = {
        en: {
          greeting: "Hello {0}",
        },
        "zh-CN": {
          greeting: "你好 {0}",
        },
      };

      const result = validateCatalogParity(positionalCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("forbidden positional placeholder '{0}'"),
        ),
      ).toBe(true);
    });

    it("rejects printf format specifiers like %s, %d, %1$s even if used in all catalogs", () => {
      const printfCatalogs = {
        en: {
          status: "Processing %s of %d clips",
        },
        "zh-CN": {
          status: "正在处理 %s / %d 个片段",
        },
      };

      const result = validateCatalogParity(printfCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("forbidden positional format specifier '%s'"),
        ),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes("forbidden positional format specifier '%d'"),
        ),
      ).toBe(true);
    });

    it("rejects single-brace named placeholders like {name}", () => {
      const singleBraceCatalogs = {
        en: {
          welcome: "Welcome {name}",
        },
        "zh-CN": {
          welcome: "欢迎 {name}",
        },
      };

      const result = validateCatalogParity(singleBraceCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("invalid single-brace placeholder '{name}'"),
        ),
      ).toBe(true);
    });

    it("rejects empty mustache {{}} and malformed unclosed mustache syntax", () => {
      const malformedCatalogs = {
        en: {
          empty: "Hello {{}}",
          unclosed: "Hello {{name",
        },
        "zh-CN": {
          empty: "你好 {{}}",
          unclosed: "你好 {{name",
        },
      };

      const result = validateCatalogParity(malformedCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) => err.includes("empty mustache placeholder '{{}}'")),
      ).toBe(true);
      expect(
        result.errors.some((err) =>
          err.includes("malformed or unclosed mustache syntax"),
        ),
      ).toBe(true);
    });

    it("allows legitimate literal single braces such as object syntax while rejecting invalid placeholders", () => {
      const literalBraceCatalogs = {
        en: {
          codeHelp: "Use object syntax { key: value }.",
          setExample: "Set { a, b }",
          userConfig: "Config for {{name}}: { active: true }",
        },
        "zh-CN": {
          codeHelp: "使用对象语法 { key: value }。",
          setExample: "集合 { a, b }",
          userConfig: "用户 {{name}} 配置：{ active: true }",
        },
      };

      const result = validateCatalogParity(literalBraceCatalogs);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("validates placeholder syntax unit helper standalone", () => {
      expect(validatePlaceholderSyntax("Hello {{name}}", "msg", "en")).toEqual([]);
      expect(validatePlaceholderSyntax("Zoom 50% 100%", "msg", "en")).toEqual([]);
      expect(
        validatePlaceholderSyntax("Use object syntax { key: value }.", "msg", "en"),
      ).toEqual([]);
      expect(validatePlaceholderSyntax("Set { a, b }", "msg", "en")).toEqual([]);
      expect(
        validatePlaceholderSyntax("Hello {0}", "msg", "en").length,
      ).toBeGreaterThan(0);
      expect(
        validatePlaceholderSyntax("Hello {name}", "msg", "en").length,
      ).toBeGreaterThan(0);
      expect(validatePlaceholderSyntax("Hello %s", "msg", "en").length).toBeGreaterThan(
        0,
      );
      expect(
        validatePlaceholderSyntax("Hello {{}}", "msg", "en").length,
      ).toBeGreaterThan(0);
      expect(
        validatePlaceholderSyntax("Hello {{name", "msg", "en").length,
      ).toBeGreaterThan(0);
      expect(
        validatePlaceholderSyntax("Hello name}}", "msg", "en").length,
      ).toBeGreaterThan(0);
      expect(
        validatePlaceholderSyntax("Hello {{{name}}}", "msg", "en").length,
      ).toBeGreaterThan(0);
    });
  });

  describe("missing categories and schema errors", () => {
    it("catches missing cardinal plural categories for English ('other' missing)", () => {
      const invalidCatalogs = {
        en: {
          items_one: "{{count}} item",
        },
        "zh-CN": {
          items_other: "{{count}} 项",
        },
      };

      const result = validateCatalogParity(invalidCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes(
            "Locale 'en' is missing required cardinal plural category 'other'",
          ),
        ),
      ).toBe(true);
    });

    it("catches missing ordinal plural categories for English ('few' missing)", () => {
      const invalidCatalogs = {
        en: {
          rank_ordinal_one: "{{count}}st",
          rank_ordinal_two: "{{count}}nd",
          rank_ordinal_other: "{{count}}th",
        },
        "zh-CN": {
          rank_ordinal_other: "第 {{count}}",
        },
      };

      const result = validateCatalogParity(invalidCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("Locale 'en' is missing required ordinal plural category 'few'"),
        ),
      ).toBe(true);
    });

    it("catches base key type mismatch (cardinal in en vs regular in zh-CN)", () => {
      const invalidCatalogs = {
        en: {
          items_one: "{{count}} item",
          items_other: "{{count}} items",
        },
        "zh-CN": {
          items: "{{count}} 项",
        },
      };

      const result = validateCatalogParity(invalidCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("plural type mismatch for base key 'items'"),
        ),
      ).toBe(true);
    });

    it("catches missing base key in secondary catalog", () => {
      const invalidCatalogs = {
        en: {
          title: "QuipClip",
          footer: "Footer",
        },
        "zh-CN": {
          title: "QuipClip",
        },
      };

      const result = validateCatalogParity(invalidCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("Locale 'zh-CN' is missing base key 'footer'"),
        ),
      ).toBe(true);
    });

    it("catches empty string leaf values", () => {
      const invalidCatalogs = {
        en: {
          title: "   ",
        },
        "zh-CN": {
          title: "标题",
        },
      };

      const result = validateCatalogParity(invalidCatalogs);
      expect(result.isValid).toBe(false);
      expect(
        result.errors.some((err) =>
          err.includes("invalid or empty string at leaf path 'title'"),
        ),
      ).toBe(true);
    });
  });
});

describe("system language resolution and environment independence", () => {
  it("resolves English for en, en-US, en-GB, and case/separator variations", () => {
    expect(resolveSystemLanguage(["en"])).toBe("en");
    expect(resolveSystemLanguage(["en-US"])).toBe("en");
    expect(resolveSystemLanguage(["en-GB"])).toBe("en");
    expect(resolveSystemLanguage(["en_CA"])).toBe("en");
    expect(resolveSystemLanguage(["EN-us"])).toBe("en");
    expect(resolveSystemLanguage(["  en-AU  "])).toBe("en");
  });

  it("resolves Simplified Chinese for zh, zh-CN, and zh-Hans", () => {
    expect(resolveSystemLanguage(["zh"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-CN"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-Hans"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-Hans-CN"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["ZH_cn"])).toBe("zh-CN");
  });

  it("resolves Traditional Chinese locales (zh-TW, zh-HK, zh-Hant) to zh-CN (ADR 011)", () => {
    expect(resolveSystemLanguage(["zh-TW"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-HK"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-MO"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-Hant"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh-Hant-TW"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["zh_TW"])).toBe("zh-CN");
  });

  it("resolves according to list priority order", () => {
    expect(resolveSystemLanguage(["fr-FR", "zh-TW", "en-US"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["de-DE", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveSystemLanguage(["es-ES", "it-IT", "zh-CN"])).toBe("zh-CN");
    expect(resolveSystemLanguage(["ja-JP", "ko-KR", "en-US"])).toBe("en");
  });

  it("falls back to English for unsupported or empty languages list", () => {
    expect(resolveSystemLanguage([])).toBe(FALLBACK_LANGUAGE);
    expect(resolveSystemLanguage(["ja-JP", "ko-KR", "ru-RU"])).toBe(FALLBACK_LANGUAGE);
    expect(resolveSystemLanguage(["", "   ", "???"])).toBe(FALLBACK_LANGUAGE);
  });

  it("restores original navigator property descriptor faithfully in tests", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

    try {
      // Mock navigator.languages to Simplified Chinese
      Object.defineProperty(globalThis, "navigator", {
        value: { languages: ["zh-CN", "zh"], language: "zh-CN" },
        configurable: true,
        writable: true,
        enumerable: true,
      });

      // Explicit null MUST ignore navigator.languages and return English fallback
      expect(resolveSystemLanguage(null)).toBe("en");

      // Only undefined should read navigator
      expect(resolveSystemLanguage(undefined)).toBe("zh-CN");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "navigator", originalDescriptor);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  it("resolveLanguage respects explicit preference overrides and falls back to system resolution", () => {
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("system", ["fr-FR"])).toBe("en");
    expect(resolveLanguage("system", null)).toBe("en");
  });
});

describe("preference storage persistence (injectable storage)", () => {
  it("reads and writes preference to storage", () => {
    const storage = createMockStorage();
    expect(getStoredPreference(storage)).toBe("system");

    setStoredPreference("zh-CN", storage);
    expect(getStoredPreference(storage)).toBe("zh-CN");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");

    setStoredPreference("en", storage);
    expect(getStoredPreference(storage)).toBe("en");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");

    setStoredPreference("system", storage);
    expect(getStoredPreference(storage)).toBe("system");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("system");
  });

  it("defaults to 'system' on corrupt or unknown stored value", () => {
    const storage = createMockStorage({
      [LANGUAGE_STORAGE_KEY]: "invalid-preference",
    });
    expect(getStoredPreference(storage)).toBe("system");
  });

  it("handles null or throwing storage gracefully", () => {
    expect(getStoredPreference(null)).toBe("system");
    expect(() => setStoredPreference("en", null)).not.toThrow();

    const throwingStorage: PreferenceStorage = {
      getItem: () => {
        throw new Error("QuotaExceededError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };

    expect(getStoredPreference(throwingStorage)).toBe("system");
    expect(() => setStoredPreference("zh-CN", throwingStorage)).not.toThrow();
  });
});

describe("i18next runtime initialization and fallback behavior", () => {
  it("asynchronously initializes instance and verifies isInitialized state in English", async () => {
    const instance = await createI18nInstance({
      initialPreference: "en",
      systemLanguages: [],
    });

    expect(instance.isInitialized).toBe(true);
    expect(instance.t("app.name")).toBe("QuipClip");
    expect(instance.t("titleBar.menu.file")).toBe("File");
    expect(instance.t("settings.language.label")).toBe("Language");
    expect(instance.t("transport.action.markOut")).toBe("Out (Exclusive)");
    expect(
      instance.t("statusBar.projectResolution", {
        width: 1920,
        height: 1080,
      }),
    ).toBe("Project Resolution: 1920 × 1080");
  });

  it("asynchronously initializes instance and verifies isInitialized state in Simplified Chinese", async () => {
    const instance = await createI18nInstance({
      initialPreference: "zh-CN",
      systemLanguages: [],
    });

    expect(instance.isInitialized).toBe(true);
    expect(instance.t("app.name")).toBe("QuipClip");
    expect(instance.t("titleBar.menu.file")).toBe("文件");
    expect(instance.t("settings.language.label")).toBe("语言");
    expect(instance.t("transport.action.markOut")).toBe("出点（不含）");
    expect(
      instance.t("statusBar.projectResolution", {
        width: 1920,
        height: 1080,
      }),
    ).toBe("项目分辨率：1920 × 1080");
  });

  it("actually exercises i18next fallbackLng by switching to an unsupported language and proves failure if fallbackLng is missing", async () => {
    // 1. Instance with fallbackLng: 'en'
    const instanceWithFallback = await createI18nInstance({
      initialPreference: "en",
      systemLanguages: [],
    });
    expect(instanceWithFallback.isInitialized).toBe(true);

    // Switch active language to an unsupported language like French ('fr')
    await instanceWithFallback.changeLanguage("fr");
    expect(instanceWithFallback.language).toBe("fr");

    // i18next fallbackLng must kick in and return the English source message
    expect(instanceWithFallback.t("titleBar.menu.newProject")).toBe("New Project");
    expect(instanceWithFallback.t("app.name")).toBe("QuipClip");

    // 2. Control instance without fallbackLng to prove fallbackLng is essential
    const instanceWithoutFallback = (await import("i18next")).default.createInstance();
    await instanceWithoutFallback.init({
      lng: "fr",
      fallbackLng: false, // Explicitly disable fallback
      resources: {
        en: {
          translation: en,
        },
      },
    });

    // Without fallbackLng, i18next returns the raw key instead of "New Project"
    expect(instanceWithoutFallback.t("titleBar.menu.newProject")).toBe(
      "titleBar.menu.newProject",
    );
  });
});

describe("immediate language change, event subscription, and persistence across relaunch", () => {
  it("switches language immediately, persists to storage, and notifies languageChanged subscribers", async () => {
    const storage = createMockStorage();
    const instance = await createI18nInstance({
      storage,
      systemLanguages: ["en-US"],
      initialPreference: "en",
    });

    expect(instance.isInitialized).toBe(true);
    expect(instance.t("titleBar.menu.openProject")).toBe("Open Project...");

    // Setup languageChanged event subscriber
    const languageChangeEvents: string[] = [];
    const subscriber = vi.fn((lng: string) => {
      languageChangeEvents.push(lng);
    });
    instance.on("languageChanged", subscriber);

    // Change to Simplified Chinese
    const resolvedZh = await setLanguagePreference("zh-CN", {
      storage,
      instance,
    });
    expect(resolvedZh).toBe("zh-CN");
    expect(getResolvedLanguage(instance)).toBe("zh-CN");
    expect(instance.t("titleBar.menu.openProject")).toBe("打开项目...");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect(subscriber).toHaveBeenCalledWith("zh-CN");

    // Change back to English
    const resolvedEn = await setLanguagePreference("en", {
      storage,
      instance,
    });
    expect(resolvedEn).toBe("en");
    expect(getResolvedLanguage(instance)).toBe("en");
    expect(instance.t("titleBar.menu.openProject")).toBe("Open Project...");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(subscriber).toHaveBeenCalledWith("en");

    expect(languageChangeEvents).toEqual(["zh-CN", "en"]);
  });

  it("persists language override across a recreated runtime", async () => {
    const storage = createMockStorage();

    // Set preference to zh-CN in first session
    setStoredPreference("zh-CN", storage);

    // Recreate runtime from storage (simulating app relaunch)
    const recreatedInstance = await createI18nInstance({
      storage,
      systemLanguages: ["en-US"],
    });

    expect(recreatedInstance.isInitialized).toBe(true);
    expect(recreatedInstance.resolvedLanguage).toBe("zh-CN");
    expect(recreatedInstance.t("titleBar.menu.save")).toBe("保存");
    expect(getLanguagePreference(storage)).toBe("zh-CN");
  });

  it("returns the setting to system and verifies system resolution dictates active language", async () => {
    const storage = createMockStorage();

    // 1. Start with system setting on a Traditional Chinese system -> should resolve to zh-CN
    const instance = await createI18nInstance({
      storage,
      systemLanguages: ["zh-TW", "en"],
      initialPreference: "system",
    });
    expect(instance.resolvedLanguage).toBe("zh-CN");
    expect(instance.t("titleBar.menu.export")).toBe("导出...");

    // 2. Override explicitly to English
    await setLanguagePreference("en", {
      storage,
      systemLanguages: ["zh-TW", "en"],
      instance,
    });
    expect(getResolvedLanguage(instance)).toBe("en");
    expect(instance.t("titleBar.menu.export")).toBe("Export...");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");

    // 3. Return setting to 'system'
    await setLanguagePreference("system", {
      storage,
      systemLanguages: ["zh-TW", "en"],
      instance,
    });
    expect(getLanguagePreference(storage)).toBe("system");
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("system");

    // 4. Verify system resolution dictates active language (zh-CN for zh-TW)
    expect(getResolvedLanguage(instance)).toBe("zh-CN");
    expect(instance.t("titleBar.menu.export")).toBe("导出...");

    // 5. Recreate runtime with system setting on an English system -> should resolve to en
    const enSystemInstance = await createI18nInstance({
      storage,
      systemLanguages: ["en-GB"],
    });
    expect(enSystemInstance.resolvedLanguage).toBe("en");
    expect(enSystemInstance.t("titleBar.menu.export")).toBe("Export...");
  });
});

describe("global singleton runtime initI18n concurrency and retry safety", () => {
  it("serializes concurrent default initI18n calls so requested languages apply in invocation order and latest call wins", async () => {
    const storage = createMockStorage();

    // Launch genuinely concurrent initI18n calls with different languages
    const [instance1, instance2] = await Promise.all([
      initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "en",
      }),
      initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "zh-CN",
      }),
    ]);

    expect(instance1).toBe(i18next);
    expect(instance2).toBe(i18next);
    // The second (latest) invocation must win
    expect(getResolvedLanguage()).toBe("zh-CN");
    expect(i18next.t("titleBar.menu.file")).toBe("文件");

    // Repeat in reverse order to ensure symmetry
    await Promise.all([
      initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "zh-CN",
      }),
      initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "en",
      }),
    ]);

    expect(getResolvedLanguage()).toBe("en");
    expect(i18next.t("titleBar.menu.file")).toBe("File");
  });

  it("ensures a failed initialization does not poison future retries", async () => {
    const storage = createMockStorage();

    // Mock changeLanguage to fail temporarily
    const originalChangeLanguage = i18next.changeLanguage.bind(i18next);
    let shouldFail = true;

    vi.spyOn(i18next, "changeLanguage").mockImplementation((...args) => {
      if (shouldFail) {
        return Promise.reject(new Error("Simulated network/initialization error"));
      }
      return originalChangeLanguage(...args);
    });

    try {
      // First attempt fails
      await expect(
        initI18n({
          storage,
          systemLanguages: ["zh-CN"],
          initialPreference: "zh-CN",
        }),
      ).rejects.toThrow("Simulated network/initialization error");

      // Repair underlying condition
      shouldFail = false;

      // Retry must succeed cleanly and not be poisoned by the previous failure
      const recoveredInstance = await initI18n({
        storage,
        systemLanguages: ["zh-CN"],
        initialPreference: "zh-CN",
      });

      expect(recoveredInstance.isInitialized).toBe(true);
      expect(getResolvedLanguage()).toBe("zh-CN");
    } finally {
      vi.restoreAllMocks();
      // Reset back to English
      await setLanguagePreference("en", { storage });
    }
  });
});

describe("application shell localization and status bar formatting", () => {
  it("translates all shell interface semantic keys in both English and Simplified Chinese", async () => {
    const instance = await createI18nInstance({
      initialPreference: "en",
      systemLanguages: [],
    });

    // TitleBar
    expect(instance.t("app.name")).toBe("QuipClip");
    expect(instance.t("titleBar.menu.file")).toBe("File");
    expect(instance.t("titleBar.menu.newProject")).toBe("New Project");
    expect(instance.t("titleBar.menu.openProject")).toBe("Open Project...");
    expect(instance.t("titleBar.menu.save")).toBe("Save");
    expect(instance.t("titleBar.menu.export")).toBe("Export...");
    expect(instance.t("titleBar.project.untitled")).toBe("Untitled Project");
    expect(instance.t("titleBar.project.saved")).toBe("Saved");
    expect(instance.t("window.minimize")).toBe("Minimize");
    expect(instance.t("window.toggleMaximize")).toBe("Toggle maximize/restore");
    expect(instance.t("window.close")).toBe("Close");

    // PreviewPane
    expect(instance.t("preview.noMedia")).toBe("No media loaded");
    expect(instance.t("preview.zoom.fit")).toBe("Fit");
    expect(instance.t("preview.zoom.zoom50")).toBe("50%");
    expect(instance.t("preview.zoom.zoom100")).toBe("100%");
    expect(instance.t("preview.zoom.zoom200")).toBe("200%");
    expect(instance.t("preview.action.toggleFullscreen")).toBe("Toggle Fullscreen");
    expect(instance.t("preview.action.fullscreen")).toBe("Fullscreen");

    // TransportBar
    expect(instance.t("transport.action.undo")).toBe("Undo");
    expect(instance.t("transport.action.redo")).toBe("Redo");
    expect(instance.t("transport.action.markIn")).toBe("In");
    expect(instance.t("transport.action.markInDetail")).toBe("Mark In");
    expect(instance.t("transport.action.markInAria")).toBe("Mark In Point");
    expect(instance.t("transport.action.markOut")).toBe("Out (Exclusive)");
    expect(instance.t("transport.action.markOutDetail")).toBe("Mark Out (Exclusive)");
    expect(instance.t("transport.action.markOutAria")).toBe(
      "Mark Out Point (Exclusive)",
    );
    expect(instance.t("transport.action.split")).toBe("Split");
    expect(instance.t("transport.action.splitDetail")).toBe("Cut Clip");
    expect(instance.t("transport.action.splitAria")).toBe("Split Segment");
    expect(instance.t("transport.action.play")).toBe("Play");
    expect(instance.t("transport.action.previousFrame")).toBe("Previous Frame");
    expect(instance.t("transport.action.nextFrame")).toBe("Next Frame");

    // Dialog
    expect(instance.t("dialog.videoFilter")).toBe("Video Files");

    // TimelinePanel
    expect(instance.t("timeline.sourceLane")).toBe("Source Media");

    // Switch to Simplified Chinese
    await instance.changeLanguage("zh-CN");

    // TitleBar
    expect(instance.t("app.name")).toBe("QuipClip");
    expect(instance.t("titleBar.menu.file")).toBe("文件");
    expect(instance.t("titleBar.menu.newProject")).toBe("新建项目");
    expect(instance.t("titleBar.menu.openProject")).toBe("打开项目...");
    expect(instance.t("titleBar.menu.save")).toBe("保存");
    expect(instance.t("titleBar.menu.export")).toBe("导出...");
    expect(instance.t("titleBar.project.untitled")).toBe("未命名项目");
    expect(instance.t("titleBar.project.saved")).toBe("已保存");
    expect(instance.t("window.minimize")).toBe("最小化");
    expect(instance.t("window.toggleMaximize")).toBe("切换最大化/还原");
    expect(instance.t("window.close")).toBe("关闭");

    // PreviewPane
    expect(instance.t("preview.noMedia")).toBe("未加载媒体");
    expect(instance.t("preview.zoom.fit")).toBe("适应窗口");
    expect(instance.t("preview.zoom.zoom50")).toBe("50%");
    expect(instance.t("preview.zoom.zoom100")).toBe("100%");
    expect(instance.t("preview.zoom.zoom200")).toBe("200%");
    expect(instance.t("preview.action.toggleFullscreen")).toBe("切换全屏");
    expect(instance.t("preview.action.fullscreen")).toBe("全屏");

    // TransportBar
    expect(instance.t("transport.action.undo")).toBe("撤销");
    expect(instance.t("transport.action.redo")).toBe("重做");
    expect(instance.t("transport.action.markIn")).toBe("入点");
    expect(instance.t("transport.action.markInDetail")).toBe("标记入点");
    expect(instance.t("transport.action.markInAria")).toBe("标记入点");
    expect(instance.t("transport.action.markOut")).toBe("出点（不含）");
    expect(instance.t("transport.action.markOutDetail")).toBe("标记出点（不含）");
    expect(instance.t("transport.action.markOutAria")).toBe("标记出点（不含）");
    expect(instance.t("transport.action.split")).toBe("分割");
    expect(instance.t("transport.action.splitDetail")).toBe("裁剪片段");
    expect(instance.t("transport.action.splitAria")).toBe("分割片段");
    expect(instance.t("transport.action.play")).toBe("播放");
    expect(instance.t("transport.action.previousFrame")).toBe("上一帧");
    expect(instance.t("transport.action.nextFrame")).toBe("下一帧");

    // Dialog
    expect(instance.t("dialog.videoFilter")).toBe("视频文件");

    // TimelinePanel
    expect(instance.t("timeline.sourceLane")).toBe("源媒体");
  });

  it("formats resolution and frame rate numbers with Intl under resolved locale", async () => {
    const instance = await createI18nInstance({
      initialPreference: "en",
      systemLanguages: [],
    });

    const enFormatter = new Intl.NumberFormat("en");
    expect(
      instance.t("statusBar.projectResolution", {
        width: enFormatter.format(1920),
        height: enFormatter.format(1080),
      }),
    ).toBe("Project Resolution: 1,920 × 1,080");

    expect(
      instance.t("statusBar.frameRate", {
        fps: enFormatter.format(25),
      }),
    ).toBe("Frame Rate: 25 fps");

    await instance.changeLanguage("zh-CN");
    const zhFormatter = new Intl.NumberFormat("zh-CN");

    expect(
      instance.t("statusBar.projectResolution", {
        width: zhFormatter.format(1920),
        height: zhFormatter.format(1080),
      }),
    ).toBe("项目分辨率：1,920 × 1,080");

    expect(
      instance.t("statusBar.frameRate", {
        fps: zhFormatter.format(25),
      }),
    ).toBe("帧率：25 fps");
  });
});
