/**
 * Localization runtime and preference manager for QuipClip.
 *
 * Implements i18next + react-i18next integration with dynamic system language resolution,
 * persisted preference overrides, and immediate in-memory language updates without restart.
 *
 * See ADR 011 (Localized interface with i18next).
 */

import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  FALLBACK_LANGUAGE,
  LANGUAGE_PREFERENCES,
  LANGUAGE_STORAGE_KEY,
  type LanguagePreference,
  type PreferenceStorage,
  type SetPreferenceOptions,
  type SupportedLanguage,
  type I18nRuntimeOptions,
} from "./types";

export * from "./types";
export * from "./validator";
export { en } from "./locales/en";
export { zhCN } from "./locales/zh-CN";

/**
 * Bundled translation resource bundle for i18next.
 */
export const resources = {
  en: {
    translation: en,
  },
  "zh-CN": {
    translation: zhCN,
  },
} as const;

/**
 * Safely accesses navigator.languages without throwing if navigator is undefined.
 *
 * ADR 011 names `navigator.languages` as the only source, and requires `en` when no entry
 * matches a supported language. An absent or empty list holds no matching entry, so it
 * resolves to `en`. It does NOT fall back to `navigator.language`, which would resolve a
 * different language than the record states.
 */
function getSystemLanguagesFromEnvironment(): readonly string[] {
  if (typeof navigator !== "undefined" && Array.isArray(navigator.languages)) {
    return navigator.languages.map((l) => String(l));
  }
  return [];
}

/**
 * Safely accesses window.localStorage without throwing in sandboxed environments.
 */
function getDefaultStorage(): PreferenceStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access may throw in restricted iframes or sandboxes
  }
  return null;
}

/**
 * Resolves the active supported language from a prioritized list of language tags.
 *
 * Rules (ADR 011):
 * - Examines entries in order.
 * - Chooses 'zh-CN' for the first entry whose primary language subtag is 'zh' (e.g. zh, zh-CN, zh-TW, zh-HK, zh-Hant).
 * - Chooses 'en' for the first entry whose primary language subtag is 'en' (e.g. en, en-US, en-GB).
 * - Falls back to 'en' (FALLBACK_LANGUAGE) if no supported subtag is encountered.
 * - Explicit null systemLanguages means an empty list and English fallback; only undefined reads navigator.
 *
 * Pure function: accepts optional language list for dependency injection without browser globals.
 */
export function resolveSystemLanguage(
  languages?: readonly string[] | null,
): SupportedLanguage {
  const candidateLanguages =
    languages === undefined ? getSystemLanguagesFromEnvironment() : (languages ?? []);

  for (const tag of candidateLanguages) {
    if (!tag || typeof tag !== "string") {
      continue;
    }

    const trimmed = tag.trim();
    if (!trimmed) {
      continue;
    }

    const primarySubtag = trimmed.split(/[-_]/)[0]?.toLowerCase();
    if (primarySubtag === "zh") {
      return "zh-CN";
    }
    if (primarySubtag === "en") {
      return "en";
    }
  }

  return FALLBACK_LANGUAGE;
}

/**
 * Resolves the effective supported language given a user preference and optional system locales.
 *
 * - 'en' -> 'en'
 * - 'zh-CN' -> 'zh-CN'
 * - 'system' -> dynamically resolved via resolveSystemLanguage(systemLanguages)
 */
export function resolveLanguage(
  preference: LanguagePreference,
  systemLanguages?: readonly string[] | null,
): SupportedLanguage {
  switch (preference) {
    case "en":
      return "en";
    case "zh-CN":
      return "zh-CN";
    case "system":
    default:
      return resolveSystemLanguage(systemLanguages);
  }
}

/**
 * Retrieves the persisted language preference setting from storage.
 * Returns 'system' if missing, invalid, or storage access fails.
 */
export function getStoredPreference(
  storage?: PreferenceStorage | null,
): LanguagePreference {
  const targetStorage = storage !== undefined ? storage : getDefaultStorage();

  if (!targetStorage) {
    return DEFAULT_LANGUAGE_PREFERENCE;
  }

  try {
    const raw = targetStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (raw && (LANGUAGE_PREFERENCES as readonly string[]).includes(raw)) {
      return raw as LanguagePreference;
    }
  } catch {
    // Return default on storage access error
  }

  return DEFAULT_LANGUAGE_PREFERENCE;
}

/**
 * Persists the user language preference setting outside the project document.
 */
export function setStoredPreference(
  preference: LanguagePreference,
  storage?: PreferenceStorage | null,
): void {
  const targetStorage = storage !== undefined ? storage : getDefaultStorage();

  if (!targetStorage) {
    return;
  }

  try {
    targetStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Gracefully ignore write failures in sandboxed environments
  }
}

/**
 * Creates and asynchronously initializes a standalone i18next runtime instance.
 * Useful for isolated test suites or independent rendering contexts.
 *
 * It does NOT call `.use(initReactI18next)`. That plugin calls react-i18next's
 * `setI18n`, which replaces the process-wide default instance, so every mounted
 * `useTranslation()` would switch to this instance and the running application would change
 * language. A React caller must wrap its tree in `<I18nextProvider i18n={instance}>`
 * instead, which is what makes the instance isolated in the react-i18next sense too.
 */
export async function createI18nInstance(
  options?: I18nRuntimeOptions,
): Promise<I18nInstance> {
  const preference =
    options?.initialPreference ?? getStoredPreference(options?.storage);
  const resolvedLanguage = resolveLanguage(preference, options?.systemLanguages);

  const instance = i18next.createInstance();
  await instance.init({
    lng: resolvedLanguage,
    fallbackLng: FALLBACK_LANGUAGE,
    resources,
    interpolation: {
      escapeValue: false,
    },
  });

  return instance;
}

/**
 * Global singleton i18n instance.
 */
const defaultI18n: I18nInstance = i18next;
let initQueue: Promise<unknown> = Promise.resolve();

/**
 * Initializes the default i18next runtime instance with react-i18next.
 * Guarantees that concurrent calls are serialized strictly in invocation order so the latest call wins.
 * Guarantees that a failed initialization does not permanently poison future retry attempts.
 */
export function initI18n(options?: I18nRuntimeOptions): Promise<I18nInstance> {
  const preference =
    options?.initialPreference ?? getStoredPreference(options?.storage);
  const resolvedLanguage = resolveLanguage(preference, options?.systemLanguages);

  const execute = async (): Promise<I18nInstance> => {
    if (!defaultI18n.isInitialized) {
      await defaultI18n.use(initReactI18next).init({
        lng: resolvedLanguage,
        fallbackLng: FALLBACK_LANGUAGE,
        resources,
        interpolation: {
          escapeValue: false,
        },
      });
    } else {
      const currentLanguage = defaultI18n.resolvedLanguage ?? defaultI18n.language;
      if (currentLanguage !== resolvedLanguage) {
        await defaultI18n.changeLanguage(resolvedLanguage);
      }
    }
    return defaultI18n;
  };

  const nextPromise = initQueue.then(
    () => execute(),
    () => execute(),
  );

  initQueue = nextPromise.catch(() => {});

  return nextPromise;
}

/**
 * Gets the current persisted language preference.
 */
export function getLanguagePreference(
  storage?: PreferenceStorage | null,
): LanguagePreference {
  return getStoredPreference(storage);
}

/**
 * Updates the user language preference setting, persists it to storage,
 * and immediately updates the active i18next language without requiring an application restart.
 */
export async function setLanguagePreference(
  preference: LanguagePreference,
  options?: SetPreferenceOptions & { instance?: I18nInstance },
): Promise<SupportedLanguage> {
  setStoredPreference(preference, options?.storage);
  const resolved = resolveLanguage(preference, options?.systemLanguages);
  const targetInstance = options?.instance ?? defaultI18n;
  await targetInstance.changeLanguage(resolved);
  return resolved;
}

/**
 * Returns the currently active resolved language ('en' | 'zh-CN').
 */
export function getResolvedLanguage(instance?: I18nInstance): SupportedLanguage {
  const targetInstance = instance ?? defaultI18n;
  const current = targetInstance.resolvedLanguage ?? targetInstance.language;
  if (current === "zh-CN" || current === "en") {
    return current;
  }
  return FALLBACK_LANGUAGE;
}

export { defaultI18n as i18n };
export default defaultI18n;
