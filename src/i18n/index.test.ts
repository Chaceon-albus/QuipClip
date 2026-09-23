import { describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  FALLBACK_LANGUAGE,
  LANGUAGE_PREFERENCES,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  applyDocumentLanguage,
  bindDocumentLanguage,
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
  type DocumentLanguageTarget,
  type PreferenceStorage,
} from "./index";
import { EXPORT_ERROR_CODES } from "@/features/export/types";
import { IMPORT_MEDIA_ERROR_CODES } from "@/features/media/types";
import {
  BACKEND_SETTINGS_ERROR_CODES,
  FRONTEND_SETTINGS_ERROR_CODES,
  SETTINGS_ERROR_CODES,
} from "@/features/settings/types";

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

  // BLOCKING 11-F1: ADR 011 names `navigator.languages` as the only source and requires
  // `en` when no entry matches. An empty or absent list holds no matching entry, so it must
  // resolve to `en` rather than fall back to `navigator.language`.
  it("returns English when navigator.languages is empty or absent", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { languages: [], language: "zh-TW" },
        configurable: true,
        writable: true,
        enumerable: true,
      });
      expect(resolveSystemLanguage(undefined)).toBe(FALLBACK_LANGUAGE);

      Object.defineProperty(globalThis, "navigator", {
        value: { language: "zh-TW" },
        configurable: true,
        writable: true,
        enumerable: true,
      });
      expect(resolveSystemLanguage(undefined)).toBe(FALLBACK_LANGUAGE);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "navigator", originalDescriptor);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
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
    expect(instance.t("transport.action.markOut")).toBe("Out");
    expect(
      instance.t("statusBar.source.resolution", {
        width: 1920,
        height: 1080,
      }),
    ).toBe("Source resolution: 1920 × 1080");
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
    expect(instance.t("transport.action.markOut")).toBe("出点");
    expect(
      instance.t("statusBar.source.resolution", {
        width: 1920,
        height: 1080,
      }),
    ).toBe("源分辨率：1920 × 1080");
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

describe("document language follows the resolved language", () => {
  it("writes the language tag to an injected target and ignores an explicit null target", () => {
    const target: DocumentLanguageTarget = { lang: "en" };

    applyDocumentLanguage("zh-CN", target);
    expect(target.lang).toBe("zh-CN");

    applyDocumentLanguage("en", target);
    expect(target.lang).toBe("en");

    expect(() => applyDocumentLanguage("zh-CN", null)).not.toThrow();
  });

  it("does not throw when no document exists", () => {
    vi.stubGlobal("document", undefined);

    try {
      expect(() => applyDocumentLanguage("zh-CN")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes the language at once for an initialized instance and on each languageChanged event", async () => {
    const instance = await createI18nInstance({
      initialPreference: "zh-CN",
      systemLanguages: [],
    });
    const target: DocumentLanguageTarget = { lang: "en" };

    const unbind = bindDocumentLanguage(instance, target);
    expect(target.lang).toBe("zh-CN");

    await instance.changeLanguage("en");
    expect(target.lang).toBe("en");

    await instance.changeLanguage("zh-CN");
    expect(target.lang).toBe("zh-CN");

    // A language without a catalog resolves to the fallback, never to the raw tag.
    await instance.changeLanguage("fr");
    expect(target.lang).toBe(FALLBACK_LANGUAGE);

    unbind();
    await instance.changeLanguage("zh-CN");
    expect(target.lang).toBe(FALLBACK_LANGUAGE);
  });

  it("sets the first language from the event that init emits when bound before init", async () => {
    const instance = i18next.createInstance();
    const target: DocumentLanguageTarget = { lang: "en" };

    const unbind = bindDocumentLanguage(instance, target);
    // Not initialized yet: the binding must not write a guess.
    expect(target.lang).toBe("en");

    await instance.init({
      lng: "zh-CN",
      fallbackLng: FALLBACK_LANGUAGE,
      resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    });
    expect(target.lang).toBe("zh-CN");

    unbind();
  });

  it("drives document.documentElement.lang from the default instance at init and on every change", async () => {
    const storage = createMockStorage();
    const documentElement: DocumentLanguageTarget = { lang: "en" };
    vi.stubGlobal("document", { documentElement });

    try {
      // At init.
      await initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "zh-CN",
      });
      expect(documentElement.lang).toBe("zh-CN");

      // At init, when the requested language is already active and no event fires.
      documentElement.lang = "en";
      await initI18n({
        storage,
        systemLanguages: ["en-US"],
        initialPreference: "zh-CN",
      });
      expect(documentElement.lang).toBe("zh-CN");

      // On a settings change.
      await setLanguagePreference("en", { storage });
      expect(documentElement.lang).toBe("en");

      // On a return to the system setting.
      await setLanguagePreference("system", { storage, systemLanguages: ["zh-TW"] });
      expect(documentElement.lang).toBe("zh-CN");

      // On a direct change of the default instance.
      await i18next.changeLanguage("en");
      expect(documentElement.lang).toBe("en");

      // An isolated instance leaves the document alone.
      const isolated = await createI18nInstance({
        initialPreference: "en",
        systemLanguages: [],
      });
      await setLanguagePreference("zh-CN", { storage, instance: isolated });
      expect(getResolvedLanguage(isolated)).toBe("zh-CN");
      expect(documentElement.lang).toBe("en");
    } finally {
      await setLanguagePreference("en", { storage });
      vi.unstubAllGlobals();
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
    expect(instance.t("titleBar.action.export")).toBe("Export");
    expect(instance.t("titleBar.source.segmentCount", { count: 1 })).toBe("1 segment");
    expect(instance.t("titleBar.source.segmentCount", { count: 3 })).toBe("3 segments");
    expect(instance.t("window.minimize")).toBe("Minimize");
    expect(instance.t("window.toggleMaximize")).toBe("Toggle maximize/restore");
    expect(instance.t("window.close")).toBe("Close");

    // PreviewPane
    expect(instance.t("preview.empty.title")).toBe(
      "Open a video to start marking segments",
    );
    expect(instance.t("preview.empty.openVideo")).toBe("Open Video...");

    // TransportBar
    expect(instance.t("transport.action.undo")).toBe("Undo");
    expect(instance.t("transport.action.redo")).toBe("Redo");
    expect(instance.t("transport.action.markIn")).toBe("In");
    expect(instance.t("transport.action.markInAria")).toBe("Mark In Point");
    expect(instance.t("transport.action.markOut")).toBe("Out");
    expect(instance.t("transport.action.markOutAria")).toBe(
      "Mark Out Point (Exclusive)",
    );
    expect(instance.t("transport.action.split")).toBe("Split");
    expect(instance.t("transport.action.splitAria")).toBe("Split Segment at Playhead");
    expect(instance.t("transport.action.play")).toBe("Play");
    expect(instance.t("transport.action.pause")).toBe("Pause");
    expect(instance.t("transport.action.previousStep")).toBe("Step Back One Frame");
    expect(instance.t("transport.action.nextStep")).toBe("Step Forward One Frame");
    expect(instance.t("transport.disabledReason.markInFirst")).toBe(
      "Mark an In point first.",
    );
    expect(instance.t("transport.disabledReason.noFrameRate")).toBe(
      "The source reports no frame rate.",
    );
    expect(instance.t("shortcut.key.space")).toBe("Space");
    expect(instance.t("shortcut.key.escape")).toBe("Esc");
    expect(instance.t("preview.approximate")).toBe("Approx.");

    // Dialog
    expect(instance.t("dialog.videoFilter")).toBe("Video Files");

    // TimelinePanel
    expect(instance.t("timeline.sourceLane")).toBe("Source Media");
    expect(instance.t("timeline.emptyHint")).toBe("Marked segments appear here.");
    expect(instance.t("timeline.durationUnknown")).toBe(
      "Duration unknown — seeking is unavailable",
    );

    // Settings: FFmpeg location
    expect(instance.t("settings.ffmpeg.section")).toBe("FFmpeg Location");
    expect(instance.t("settings.ffmpeg.pathLabel")).toBe("Current Path");
    expect(instance.t("settings.ffmpeg.pathUnset")).toBe("No path set");
    expect(instance.t("settings.ffmpeg.chooseFolder")).toBe("Choose Folder...");
    expect(instance.t("settings.ffmpeg.chooseFile")).toBe("Choose File...");
    expect(instance.t("settings.ffmpeg.clear")).toBe("Clear");
    expect(instance.t("settings.ffmpeg.hint")).toBe(
      "Choose a folder or a single file. A folder that holds both FFmpeg and FFprobe is preferred.",
    );

    // Settings: export presets
    expect(instance.t("settings.preset.section")).toBe("Export Presets");
    expect(instance.t("settings.preset.newName")).toBe("New Preset");
    expect(instance.t("settings.preset.add")).toBe("Add Preset");
    expect(instance.t("settings.preset.delete")).toBe("Delete Preset");
    expect(instance.t("settings.preset.restoreDefaults")).toBe("Restore Defaults");
    expect(instance.t("settings.preset.setActive")).toBe("Set Active");
    expect(instance.t("settings.preset.activeBadge")).toBe("Active");
    expect(instance.t("settings.preset.empty")).toBe("No presets yet.");
    expect(instance.t("settings.preset.limitReached", { max: 100 })).toBe(
      "Limit of 100 presets reached.",
    );
    expect(instance.t("settings.preset.unsaved")).toBe("Unsaved changes");
    expect(instance.t("settings.preset.nameLabel")).toBe("Name");
    expect(instance.t("settings.preset.containerLabel")).toBe("Container");
    expect(instance.t("settings.preset.videoEncoderLabel")).toBe("Video Encoder");
    expect(instance.t("settings.preset.audioEncoderLabel")).toBe("Audio Encoder");
    expect(instance.t("settings.preset.qualityKindLabel")).toBe("Quality Type");
    expect(instance.t("settings.preset.qualityValueLabel")).toBe("Quality Value");
    expect(instance.t("settings.preset.resolutionLabel")).toBe("Resolution");
    expect(instance.t("settings.preset.frameRateLabel")).toBe("Frame Rate");
    expect(instance.t("settings.preset.widthLabel")).toBe("Width");
    expect(instance.t("settings.preset.heightLabel")).toBe("Height");
    expect(instance.t("settings.preset.frameRateNumeratorLabel")).toBe("Numerator");
    expect(instance.t("settings.preset.frameRateDenominatorLabel")).toBe("Denominator");
    expect(instance.t("settings.preset.sourceOption")).toBe("Same as Source");
    expect(instance.t("settings.preset.customOption")).toBe("Custom");

    // Settings: quality kinds
    expect(instance.t("settings.quality.crf")).toBe("Constant Quality (CRF)");
    expect(instance.t("settings.quality.bitrate")).toBe("Bitrate (kbps)");
    expect(instance.t("settings.quality.qualityScale")).toBe("Quality Scale");

    // Settings: encoder availability
    expect(instance.t("settings.encoder.available")).toBe("Available");
    expect(instance.t("settings.encoder.unavailable")).toBe("Unavailable");
    expect(instance.t("settings.encoder.unknown")).toBe("Not checked");
    expect(
      instance.t("settings.encoder.optionLabelAvailable", { name: "libx264" }),
    ).toBe("libx264 (Available)");
    expect(
      instance.t("settings.encoder.optionLabelUnavailable", { name: "libx264" }),
    ).toBe("libx264 (Unavailable)");
    expect(instance.t("settings.encoder.optionLabelUnknown", { name: "libx264" })).toBe(
      "libx264 (Not checked)",
    );
    expect(instance.t("settings.encoder.reasonNotListed")).toBe(
      "This FFmpeg build does not include the encoder.",
    );
    expect(instance.t("settings.encoder.reasonFailed")).toBe(
      "The encoder failed its test on this machine.",
    );
    expect(instance.t("settings.encoder.reasonTimedOut")).toBe(
      "The encoder did not respond in time.",
    );
    expect(instance.t("settings.encoder.customLabel")).toBe("Custom Encoder Name");
    expect(instance.t("settings.encoder.customHint")).toBe(
      "Use 1 to 64 characters. Start with a letter or digit. After that, use only letters, digits, underscores, periods, or hyphens.",
    );

    // Settings: field validation messages
    expect(instance.t("settings.field.required")).toBe("This field is required.");
    expect(instance.t("settings.field.tooLong", { max: 120 })).toBe(
      "Use 120 characters or fewer.",
    );
    expect(instance.t("settings.field.charset")).toBe(
      "Use 1 to 64 characters. Start with a letter or digit. After that, use only letters, digits, underscores, periods, or hyphens.",
    );
    expect(instance.t("settings.field.outOfRange", { min: 0, max: 63 })).toBe(
      "Enter a value from 0 to 63.",
    );
    expect(instance.t("settings.field.positive")).toBe(
      "Enter a whole number above zero.",
    );
    expect(instance.t("settings.field.notInteger")).toBe("Enter a whole number.");

    // Switch to Simplified Chinese
    await instance.changeLanguage("zh-CN");

    // TitleBar
    expect(instance.t("app.name")).toBe("QuipClip");
    expect(instance.t("titleBar.menu.file")).toBe("文件");
    expect(instance.t("titleBar.menu.newProject")).toBe("新建项目");
    expect(instance.t("titleBar.menu.openProject")).toBe("打开项目...");
    expect(instance.t("titleBar.menu.save")).toBe("保存");
    expect(instance.t("titleBar.menu.export")).toBe("导出...");
    expect(instance.t("titleBar.action.export")).toBe("导出");
    expect(instance.t("titleBar.source.segmentCount", { count: 1 })).toBe("1 个片段");
    expect(instance.t("titleBar.source.segmentCount", { count: 3 })).toBe("3 个片段");
    expect(instance.t("window.minimize")).toBe("最小化");
    expect(instance.t("window.toggleMaximize")).toBe("切换最大化/还原");
    expect(instance.t("window.close")).toBe("关闭");

    // PreviewPane
    expect(instance.t("preview.empty.title")).toBe("打开视频，开始标记片段");
    expect(instance.t("preview.empty.openVideo")).toBe("打开视频...");

    // TransportBar
    expect(instance.t("transport.action.undo")).toBe("撤销");
    expect(instance.t("transport.action.redo")).toBe("重做");
    expect(instance.t("transport.action.markIn")).toBe("入点");
    expect(instance.t("transport.action.markInAria")).toBe("标记入点");
    expect(instance.t("transport.action.markOut")).toBe("出点");
    expect(instance.t("transport.action.markOutAria")).toBe("标记出点（不含）");
    expect(instance.t("transport.action.split")).toBe("分割");
    expect(instance.t("transport.action.splitAria")).toBe("在播放头处分割片段");
    expect(instance.t("transport.action.play")).toBe("播放");
    expect(instance.t("transport.action.pause")).toBe("暂停");
    expect(instance.t("transport.action.previousStep")).toBe("后退一帧");
    expect(instance.t("transport.action.nextStep")).toBe("前进一帧");
    expect(instance.t("transport.disabledReason.markInFirst")).toBe("请先标记入点。");
    expect(instance.t("transport.disabledReason.noFrameRate")).toBe("源未报告帧率。");
    expect(instance.t("shortcut.key.space")).toBe("空格");
    expect(instance.t("shortcut.key.escape")).toBe("Esc");
    expect(instance.t("preview.approximate")).toBe("（近似）");

    // Dialog
    expect(instance.t("dialog.videoFilter")).toBe("视频文件");

    // TimelinePanel
    expect(instance.t("timeline.sourceLane")).toBe("源媒体");
    expect(instance.t("timeline.emptyHint")).toBe("标记的片段会显示在这里。");
    expect(instance.t("timeline.durationUnknown")).toBe("无法确定时长，暂不可定位");

    // Settings: FFmpeg location
    expect(instance.t("settings.ffmpeg.section")).toBe("FFmpeg 位置");
    expect(instance.t("settings.ffmpeg.pathLabel")).toBe("当前路径");
    expect(instance.t("settings.ffmpeg.pathUnset")).toBe("未设置路径");
    expect(instance.t("settings.ffmpeg.chooseFolder")).toBe("选择文件夹...");
    expect(instance.t("settings.ffmpeg.chooseFile")).toBe("选择文件...");
    expect(instance.t("settings.ffmpeg.clear")).toBe("清除");
    expect(instance.t("settings.ffmpeg.hint")).toBe(
      "可以选择文件夹，也可以选择单个文件；建议选择同时包含 FFmpeg 和 FFprobe 的文件夹。",
    );

    // Settings: export presets
    expect(instance.t("settings.preset.section")).toBe("导出预设");
    expect(instance.t("settings.preset.newName")).toBe("新预设");
    expect(instance.t("settings.preset.add")).toBe("添加预设");
    expect(instance.t("settings.preset.delete")).toBe("删除预设");
    expect(instance.t("settings.preset.restoreDefaults")).toBe("恢复默认预设");
    expect(instance.t("settings.preset.setActive")).toBe("设为当前预设");
    expect(instance.t("settings.preset.activeBadge")).toBe("当前");
    expect(instance.t("settings.preset.empty")).toBe("暂无预设。");
    expect(instance.t("settings.preset.limitReached", { max: 100 })).toBe(
      "已达到 100 个预设的上限。",
    );
    expect(instance.t("settings.preset.unsaved")).toBe("有未保存的更改");
    expect(instance.t("settings.preset.nameLabel")).toBe("名称");
    expect(instance.t("settings.preset.containerLabel")).toBe("容器");
    expect(instance.t("settings.preset.videoEncoderLabel")).toBe("视频编码器");
    expect(instance.t("settings.preset.audioEncoderLabel")).toBe("音频编码器");
    expect(instance.t("settings.preset.qualityKindLabel")).toBe("质量类型");
    expect(instance.t("settings.preset.qualityValueLabel")).toBe("质量数值");
    expect(instance.t("settings.preset.resolutionLabel")).toBe("分辨率");
    expect(instance.t("settings.preset.frameRateLabel")).toBe("帧率");
    expect(instance.t("settings.preset.widthLabel")).toBe("宽度");
    expect(instance.t("settings.preset.heightLabel")).toBe("高度");
    expect(instance.t("settings.preset.frameRateNumeratorLabel")).toBe("分子");
    expect(instance.t("settings.preset.frameRateDenominatorLabel")).toBe("分母");
    expect(instance.t("settings.preset.sourceOption")).toBe("与源相同");
    expect(instance.t("settings.preset.customOption")).toBe("自定义");

    // Settings: quality kinds
    expect(instance.t("settings.quality.crf")).toBe("恒定质量（CRF）");
    expect(instance.t("settings.quality.bitrate")).toBe("比特率（kbps）");
    expect(instance.t("settings.quality.qualityScale")).toBe("质量系数");

    // Settings: encoder availability
    expect(instance.t("settings.encoder.available")).toBe("可用");
    expect(instance.t("settings.encoder.unavailable")).toBe("不可用");
    expect(instance.t("settings.encoder.unknown")).toBe("未探测");
    expect(
      instance.t("settings.encoder.optionLabelAvailable", { name: "libx264" }),
    ).toBe("libx264（可用）");
    expect(
      instance.t("settings.encoder.optionLabelUnavailable", { name: "libx264" }),
    ).toBe("libx264（不可用）");
    expect(instance.t("settings.encoder.optionLabelUnknown", { name: "libx264" })).toBe(
      "libx264（未探测）",
    );
    expect(instance.t("settings.encoder.reasonNotListed")).toBe(
      "此 FFmpeg 版本不包含该编码器。",
    );
    expect(instance.t("settings.encoder.reasonFailed")).toBe(
      "该编码器在本机测试失败。",
    );
    expect(instance.t("settings.encoder.reasonTimedOut")).toBe("编码器未及时响应。");
    expect(instance.t("settings.encoder.customLabel")).toBe("自定义编码器名称");
    expect(instance.t("settings.encoder.customHint")).toBe(
      "请使用 1 到 64 个字符。以字母或数字开头，后续只能使用字母、数字、下划线、句点或连字符。",
    );

    // Settings: field validation messages
    expect(instance.t("settings.field.required")).toBe("此字段为必填项。");
    expect(instance.t("settings.field.tooLong", { max: 120 })).toBe(
      "最多可输入 120 个字符。",
    );
    expect(instance.t("settings.field.charset")).toBe(
      "请使用 1 到 64 个字符。以字母或数字开头，后续只能使用字母、数字、下划线、句点或连字符。",
    );
    expect(instance.t("settings.field.outOfRange", { min: 0, max: 63 })).toBe(
      "请输入 0 到 63（含两端）之间的数值。",
    );
    expect(instance.t("settings.field.positive")).toBe("请输入一个大于零的整数。");
    expect(instance.t("settings.field.notInteger")).toBe("请输入一个整数。");
  });

  // The frame size is a technical identifier and keeps its plain digits. The frame rate is a
  // measured quantity and goes through Intl under the resolved locale.
  it("formats the source summary and its tooltip lines under the resolved locale", async () => {
    const instance = await createI18nInstance({
      initialPreference: "en",
      systemLanguages: [],
    });

    const enFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });
    const enRate = enFormatter.format(30000 / 1001);
    expect(
      instance.t("statusBar.source.summary", {
        width: String(1920),
        height: String(1080),
        fps: enRate,
      }),
    ).toBe("1920 × 1080 · 29.97 fps");
    expect(
      instance.t("statusBar.source.summaryNoRate", {
        width: String(1920),
        height: String(1080),
      }),
    ).toBe("1920 × 1080");
    expect(
      instance.t("statusBar.source.resolution", {
        width: String(1920),
        height: String(1080),
      }),
    ).toBe("Source resolution: 1920 × 1080");
    expect(instance.t("statusBar.source.rateAverage", { fps: enRate })).toBe(
      "Nominal frame rate: 29.97 fps (avg_frame_rate)",
    );
    expect(instance.t("statusBar.source.rateReal", { fps: enRate })).toBe(
      "Nominal frame rate: 29.97 fps (r_frame_rate)",
    );
    expect(instance.t("statusBar.source.rateUnavailable")).toBe(
      "Nominal frame rate: not reported by the source",
    );

    await instance.changeLanguage("zh-CN");
    const zhFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
    const zhRate = zhFormatter.format(30000 / 1001);

    expect(
      instance.t("statusBar.source.summary", {
        width: String(1920),
        height: String(1080),
        fps: zhRate,
      }),
    ).toBe("1920 × 1080 · 29.97 fps");
    expect(
      instance.t("statusBar.source.resolution", {
        width: String(1920),
        height: String(1080),
      }),
    ).toBe("源分辨率：1920 × 1080");
    expect(instance.t("statusBar.source.rateAverage", { fps: zhRate })).toBe(
      "标称帧率：29.97 fps（avg_frame_rate）",
    );
    expect(instance.t("statusBar.source.rateUnavailable")).toBe("标称帧率：源未报告");
  });
});

describe("mediaError and exportError message catalog parity", () => {
  // The two error vocabularies grow when the backend gains a code. A code with no message
  // renders as a raw key, so every entry of both lists is asserted here rather than only the
  // ones a presenter test happens to reach.
  it("defines non-empty strings in both catalogs for every import media error code", () => {
    for (const code of IMPORT_MEDIA_ERROR_CODES) {
      expect(en.mediaError[code].trim().length).toBeGreaterThan(0);
      expect(zhCN.mediaError[code].trim().length).toBeGreaterThan(0);
    }
  });

  it("defines non-empty strings in both catalogs for every export error code", () => {
    for (const code of EXPORT_ERROR_CODES) {
      expect(en.exportError[code].trim().length).toBeGreaterThan(0);
      expect(zhCN.exportError[code].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("settingsError message catalog parity", () => {
  it("defines non-empty strings in en.settingsError and zhCN.settingsError for every error code", () => {
    // Guards the loop itself: an empty or truncated vocabulary would otherwise pass every
    // assertion below. The count is derived from the two lists it concatenates plus the single
    // "unknown" fallback, so a new backend code cannot break this test.
    expect(SETTINGS_ERROR_CODES.length).toBe(
      BACKEND_SETTINGS_ERROR_CODES.length + FRONTEND_SETTINGS_ERROR_CODES.length + 1,
    );
    for (const code of SETTINGS_ERROR_CODES) {
      const enText = en.settingsError[code];
      const zhText = zhCN.settingsError[code];

      expect(typeof enText).toBe("string");
      expect(enText.trim().length).toBeGreaterThan(0);

      expect(typeof zhText).toBe("string");
      expect(zhText.trim().length).toBeGreaterThan(0);
    }
  });
});
