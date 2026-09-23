/**
 * Localization types, interfaces, and constants for QuipClip.
 *
 * See ADR 011 (Localized interface with i18next).
 */

import "i18next";
import type { en } from "./locales/en";

/**
 * Persisted user language preference setting.
 * - 'system': resolve active language dynamically from system/browser locale (default).
 * - 'en': explicitly force English interface.
 * - 'zh-CN': explicitly force Simplified Chinese interface.
 */
export type LanguagePreference = "system" | "en" | "zh-CN";

/**
 * Supported resolved interface languages with bundled catalogs.
 */
export type SupportedLanguage = "en" | "zh-CN";

/**
 * Available language preference options.
 */
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = [
  "system",
  "en",
  "zh-CN",
] as const;

/**
 * Available bundled catalog languages.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  "en",
  "zh-CN",
] as const;

/**
 * Default language preference on fresh install (ADR 011).
 */
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "system";

/**
 * Source and fallback language for QuipClip (ADR 011).
 */
export const FALLBACK_LANGUAGE: SupportedLanguage = "en";

/**
 * Stable localStorage key for persisting language preference outside project documents (ADR 011).
 */
export const LANGUAGE_STORAGE_KEY = "quipclip.language_preference";

/**
 * Minimal storage abstraction to allow dependency injection for persistence testing.
 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * The element that carries the document language in its `lang` attribute.
 * `document.documentElement` satisfies it. Tests inject a plain object instead of a DOM.
 */
export interface DocumentLanguageTarget {
  lang: string;
}

/**
 * A key name that ends in a CLDR plural category other than `other`, such as
 * `saveBlocked_one`.
 *
 * A message with such a key name is optional in a target catalog. Each language needs only
 * the categories that `Intl.PluralRules` returns for it: English needs `_one` and `_other`,
 * and Simplified Chinese needs `_other` alone. The parity check in `validator.ts` refuses a
 * category that the language does not use, so an exact copy of the English key set would make
 * a Chinese plural fail it.
 *
 * Only a message (a string value) can be a plural form. A nested group whose key name ends in
 * such a suffix stays required and keeps its object type.
 *
 * The type does not decide which categories a locale needs. The parity test on the production
 * catalogs does (ADR 011). It still requires every category that each locale uses, and it
 * still requires an ordinary message whose key name only happens to end in such a suffix.
 */
type OptionalPluralCategoryKey = `${string}_${"zero" | "one" | "two" | "few" | "many"}`;

/**
 * Recursive schema type for translation catalogs ensuring complete key parity.
 *
 * Every key is required except a plural form: a string-valued key that
 * `OptionalPluralCategoryKey` matches. A target catalog cannot add a key that the source
 * catalog does not have. `types.test.ts` checks these rules at compile time.
 */
export type DeepStringSchema<T> = {
  readonly [
    K in keyof T as K extends OptionalPluralCategoryKey
      ? T[K] extends string
        ? never
        : K
      : K
  ]: T[K] extends string
    ? string
    : T[K] extends object
      ? DeepStringSchema<T[K]>
      : never;
} & {
  readonly [
    K in keyof T as K extends OptionalPluralCategoryKey
      ? T[K] extends string
        ? K
        : never
      : never
  ]?: string;
};

/**
 * Translation catalog type based on the source English dictionary.
 */
export type TranslationCatalog = DeepStringSchema<typeof en>;

/**
 * Options for configuring and creating an i18n runtime instance.
 */
export interface I18nRuntimeOptions {
  storage?: PreferenceStorage | null;
  systemLanguages?: readonly string[] | null;
  initialPreference?: LanguagePreference;
}

/**
 * Options for setting language preference.
 */
export interface SetPreferenceOptions {
  storage?: PreferenceStorage | null;
  systemLanguages?: readonly string[] | null;
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}
