/**
 * Catalog Parity and Plural Validation for QuipClip.
 *
 * Implements ADR 011:
 * - Evidence-based plural family detection: established ONLY by valid named {{count}} on recognized suffixed forms or typed declared metadata. Sibling count/shape is not evidence.
 * - Typed declared metadata supporting cardinal, ordinal, or both per base key.
 * - Composite internal identity (baseKey, pluralType) preventing cardinal and ordinal collision.
 * - Enforces required CLDR plural categories per locale using Intl.PluralRules.
 * - Enforces declared families even when no candidate suffix exists.
 * - Permits exact-count `_zero` override only for cardinal keys; rejects invalid ordinal zero.
 * - Enforces exact placeholder parity per semantic form (including `{{count}}`).
 * - Rejects positional placeholders, single-brace placeholders, and malformed mustache syntax while allowing literal single braces like `{ key: value }`.
 */

export type PluralType = "cardinal" | "ordinal";

export type DeclaredPluralType =
  "cardinal" | "ordinal" | "both" | readonly PluralType[];

export type DeclaredPlurals =
  | Record<string, DeclaredPluralType>
  | Map<string, DeclaredPluralType>
  | ReadonlyMap<string, DeclaredPluralType>;

export interface ParsedKey {
  baseKey: string;
  pluralType: PluralType | null;
  category: string | null;
  rawPath: string;
}

export interface CatalogParityValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ValidateCatalogParityOptions {
  sourceLocale?: string;
  declaredPlurals?: DeclaredPlurals;
  declaredPluralKeys?: DeclaredPlurals | readonly string[] | Set<string>;
}

const ORDINAL_SUFFIX_REGEX = /^(.*)_ordinal_(zero|one|two|few|many|other)$/;
const CARDINAL_SUFFIX_REGEX = /^(.*)_(zero|one|two|few|many|other)$/;

/**
 * Parses a candidate leaf key path into candidate syntactic components.
 */
export function parseCatalogKey(path: string): ParsedKey {
  const ordinalMatch = path.match(ORDINAL_SUFFIX_REGEX);
  if (ordinalMatch) {
    return {
      baseKey: ordinalMatch[1],
      pluralType: "ordinal",
      category: ordinalMatch[2],
      rawPath: path,
    };
  }

  const cardinalMatch = path.match(CARDINAL_SUFFIX_REGEX);
  if (cardinalMatch) {
    return {
      baseKey: cardinalMatch[1],
      pluralType: "cardinal",
      category: cardinalMatch[2],
      rawPath: path,
    };
  }

  return {
    baseKey: path,
    pluralType: null,
    category: null,
    rawPath: path,
  };
}

/**
 * Extracts leaf key-value pairs from a nested catalog object.
 */
export function extractLeafEntries(
  obj: unknown,
  prefix = "",
): Array<{ path: string; value: unknown }> {
  const entries: Array<{ path: string; value: unknown }> = [];
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        entries.push(...extractLeafEntries(value, currentPath));
      } else {
        entries.push({ path: currentPath, value });
      }
    }
  }
  return entries;
}

/**
 * Extracts valid named mustache-style placeholders from a string.
 */
export function extractPlaceholders(text: string): string[] {
  const matches = text.matchAll(/(?<!\{)\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}(?!\})/g);
  const placeholders = new Set<string>();
  for (const match of matches) {
    if (match[1]) {
      placeholders.add(match[1]);
    }
  }
  return Array.from(placeholders).sort();
}

/**
 * Validates placeholder syntax in a translation string.
 *
 * Rejects:
 * - Positional placeholders like {0}, {1}
 * - Printf format specifiers like %s, %d, %1$s, %@
 * - Single-brace named placeholders like {name}, {count}
 * - Empty mustache {{}}
 * - Malformed / unclosed mustache syntax
 *
 * Allows:
 * - Literal single braces such as `{ key: value }` or `Set { a, b }`
 */
export function validatePlaceholderSyntax(
  text: string,
  path: string,
  locale: string,
): string[] {
  const errors: string[] = [];

  // Check for printf-style format specifiers (e.g. %s, %d, %1$s, %@)
  const printfMatches = text.match(/(?<!%)%(?:\d+\$)?[a-zA-Z@]/g);
  if (printfMatches) {
    for (const match of printfMatches) {
      errors.push(
        `Locale '${locale}' contains forbidden positional format specifier '${match}' in '${path}' (only named {{name}} placeholders are allowed)`,
      );
    }
  }

  // Check for positional single-brace numbers (e.g. {0}, {1})
  const positionalBraceMatches = text.match(/(?<!\{)\{\s*\d+\s*\}(?!\})/g);
  if (positionalBraceMatches) {
    for (const match of positionalBraceMatches) {
      errors.push(
        `Locale '${locale}' contains forbidden positional placeholder '${match}' in '${path}' (only named {{name}} placeholders are allowed)`,
      );
    }
  }

  // Check for single-brace named placeholders (e.g. {name})
  const singleBraceMatches = text.match(
    /(?<!\{)\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}(?!\})/g,
  );
  if (singleBraceMatches) {
    for (const match of singleBraceMatches) {
      errors.push(
        `Locale '${locale}' contains invalid single-brace placeholder '${match}' in '${path}' (must use double braces '{{name}}')`,
      );
    }
  }

  // Check for empty mustache placeholders {{}}
  if (/\{\{\s*\}\}/.test(text)) {
    errors.push(
      `Locale '${locale}' contains empty mustache placeholder '{{}}' in '${path}'`,
    );
  }

  // Check for malformed, unclosed, or triple mustache syntax
  const stripped = text.replace(
    /(?<!\{)\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}(?!\})/g,
    "",
  );
  if (/\{\{|\}\}/.test(stripped)) {
    if (!/\{\{\s*\}\}/.test(text)) {
      errors.push(
        `Locale '${locale}' contains malformed or unclosed mustache syntax in '${path}' (text: "${text}")`,
      );
    }
  }

  return errors;
}

/**
 * Parses and normalizes declared plural metadata from options.
 */
function parseDeclaredPlurals(
  options?: ValidateCatalogParityOptions,
): Map<string, Set<PluralType>> {
  const map = new Map<string, Set<PluralType>>();

  const addDeclaration = (baseKey: unknown, declType: unknown): void => {
    if (typeof baseKey !== "string" || baseKey.trim().length === 0) {
      return;
    }
    const types: PluralType[] = [];
    if (declType === "cardinal") {
      types.push("cardinal");
    } else if (declType === "ordinal") {
      types.push("ordinal");
    } else if (declType === "both") {
      types.push("cardinal", "ordinal");
    } else if (Array.isArray(declType)) {
      for (const t of declType as unknown[]) {
        if (t === "cardinal" || t === "ordinal") {
          types.push(t);
        }
      }
    } else if (declType === undefined || declType === true) {
      types.push("cardinal");
    }

    if (types.length > 0) {
      let set = map.get(baseKey);
      if (!set) {
        set = new Set<PluralType>();
        map.set(baseKey, set);
      }
      for (const t of types) {
        set.add(t);
      }
    }
  };

  const rawDeclared = options?.declaredPlurals ?? options?.declaredPluralKeys;
  if (rawDeclared) {
    if (rawDeclared instanceof Map) {
      for (const [key, value] of rawDeclared.entries()) {
        addDeclaration(key, value);
      }
    } else if (rawDeclared instanceof Set || Array.isArray(rawDeclared)) {
      for (const item of rawDeclared as Iterable<unknown>) {
        if (Array.isArray(item) && item.length === 2) {
          addDeclaration(item[0], item[1]);
        } else if (typeof item === "string") {
          addDeclaration(item, "cardinal");
        }
      }
    } else if (typeof rawDeclared === "object") {
      for (const [key, value] of Object.entries(rawDeclared)) {
        addDeclaration(key, value);
      }
    }
  }

  return map;
}

/**
 * Validates message-key parity, plural category completeness, and placeholder integrity
 * across multiple language catalogs according to ADR 011 and re-review rules.
 */
export function validateCatalogParity(
  catalogs: Record<string, unknown>,
  options?: ValidateCatalogParityOptions,
): CatalogParityValidationResult {
  const errors: string[] = [];
  const locales = Object.keys(catalogs);
  if (locales.length === 0) {
    return { isValid: true, errors: [] };
  }

  const sourceLocale =
    options?.sourceLocale && locales.includes(options.sourceLocale)
      ? options.sourceLocale
      : locales[0];

  const declaredFamiliesMap = parseDeclaredPlurals(options);

  interface RawLeaf {
    locale: string;
    path: string;
    value: string;
    parsed: ParsedKey;
    placeholders: string[];
  }

  const rawLeavesByLocale = new Map<string, RawLeaf[]>();

  // 1. Extract leaves and check basic validity + placeholder syntax
  for (const locale of locales) {
    const leaves: RawLeaf[] = [];
    const rawEntries = extractLeafEntries(catalogs[locale]);

    for (const { path, value } of rawEntries) {
      if (typeof value !== "string" || value.trim().length === 0) {
        errors.push(
          `Locale '${locale}' has invalid or empty string at leaf path '${path}'`,
        );
        continue;
      }

      const syntaxErrors = validatePlaceholderSyntax(value, path, locale);
      errors.push(...syntaxErrors);

      const parsed = parseCatalogKey(path);
      const placeholders = extractPlaceholders(value);

      leaves.push({
        locale,
        path,
        value,
        parsed,
        placeholders,
      });
    }

    rawLeavesByLocale.set(locale, leaves);
  }

  // 2. Evidence-based Plural Family Detection using composite (baseKey, pluralType)
  // A plural family is established ONLY by:
  // - valid named {{count}} placeholder on a recognized suffixed form
  // - explicit typed declared metadata
  // Sibling count/shape is NOT plural evidence.
  interface EstablishedFamily {
    baseKey: string;
    pluralType: PluralType;
    familyId: string;
  }

  const establishedFamilies = new Map<string, EstablishedFamily>();

  // A. Add explicit declared families
  for (const [baseKey, types] of declaredFamiliesMap.entries()) {
    for (const pluralType of types) {
      const familyId = `${pluralType}:${baseKey}`;
      establishedFamilies.set(familyId, {
        baseKey,
        pluralType,
        familyId,
      });
    }
  }

  // B. Detect candidate plural families containing {{count}} on recognized suffixed forms
  for (const leaves of rawLeavesByLocale.values()) {
    for (const leaf of leaves) {
      if (
        leaf.parsed.pluralType !== null &&
        leaf.parsed.category !== null &&
        leaf.placeholders.includes("count")
      ) {
        const familyId = `${leaf.parsed.pluralType}:${leaf.parsed.baseKey}`;
        if (!establishedFamilies.has(familyId)) {
          establishedFamilies.set(familyId, {
            baseKey: leaf.parsed.baseKey,
            pluralType: leaf.parsed.pluralType,
            familyId,
          });
        }
      }
    }
  }

  // 3. Classify leaves per locale into established plural family forms and regular semantic keys
  interface FormInfo {
    path: string;
    value: string;
    category: string | null;
    placeholders: string[];
  }

  interface LocaleCatalogData {
    familyForms: Map<string, Map<string, FormInfo>>; // familyId -> (category -> FormInfo)
    regularKeys: Map<string, FormInfo>; // rawPath -> FormInfo
  }

  const localeData = new Map<string, LocaleCatalogData>();

  for (const locale of locales) {
    const data: LocaleCatalogData = {
      familyForms: new Map(),
      regularKeys: new Map(),
    };
    localeData.set(locale, data);

    const leaves = rawLeavesByLocale.get(locale) ?? [];

    for (const leaf of leaves) {
      let isPluralMember = false;

      if (leaf.parsed.pluralType !== null && leaf.parsed.category !== null) {
        const candidateFamilyId = `${leaf.parsed.pluralType}:${leaf.parsed.baseKey}`;
        if (establishedFamilies.has(candidateFamilyId)) {
          isPluralMember = true;
          let catMap = data.familyForms.get(candidateFamilyId);
          if (!catMap) {
            catMap = new Map();
            data.familyForms.set(candidateFamilyId, catMap);
          }

          if (catMap.has(leaf.parsed.category)) {
            errors.push(
              `Locale '${locale}' defines duplicate category '${leaf.parsed.category}' for base key '${leaf.parsed.baseKey}'`,
            );
          } else {
            catMap.set(leaf.parsed.category, {
              path: leaf.path,
              value: leaf.value,
              category: leaf.parsed.category,
              placeholders: leaf.placeholders,
            });
          }
        }
      }

      if (!isPluralMember) {
        if (data.regularKeys.has(leaf.path)) {
          errors.push(`Locale '${locale}' defines duplicate key '${leaf.path}'`);
        } else {
          data.regularKeys.set(leaf.path, {
            path: leaf.path,
            value: leaf.value,
            category: null,
            placeholders: leaf.placeholders,
          });
        }
      }
    }
  }

  // 4. Parity and completeness checks for all established plural families
  const sortedFamilyIds = Array.from(establishedFamilies.keys()).sort();

  for (const familyId of sortedFamilyIds) {
    const { baseKey, pluralType } = establishedFamilies.get(familyId)!;
    const sourceFamilyForms = localeData.get(sourceLocale)?.familyForms.get(familyId);

    for (const locale of locales) {
      const targetLocaleData = localeData.get(locale)!;
      const targetFamilyForms = targetLocaleData.familyForms.get(familyId);

      let requiredCategories: readonly string[];
      try {
        const pr = new Intl.PluralRules(locale, { type: pluralType });
        requiredCategories = pr.resolvedOptions().pluralCategories;
      } catch {
        errors.push(
          `Failed to resolve Intl.PluralRules for locale '${locale}' and type '${pluralType}'`,
        );
        continue;
      }

      const allowedCategories = new Set<string>(requiredCategories);
      if (pluralType === "cardinal") {
        // exact-count _zero is an optional override only for cardinal keys (ADR 011)
        allowedCategories.add("zero");
      }

      if (!targetFamilyForms || targetFamilyForms.size === 0) {
        // Check if this locale has a regular unsuffixed key matching baseKey
        if (targetLocaleData.regularKeys.has(baseKey)) {
          errors.push(
            `Locale '${locale}' has plural type mismatch for base key '${baseKey}': expected '${pluralType}', found 'regular'`,
          );
        }

        // Missing all required categories
        for (const reqCat of requiredCategories) {
          const expectedSuffix =
            pluralType === "ordinal" ? `_ordinal_${reqCat}` : `_${reqCat}`;
          errors.push(
            `Locale '${locale}' is missing required ${pluralType} plural category '${reqCat}' for base key '${baseKey}' (expected key '${baseKey}${expectedSuffix}')`,
          );
        }
        continue;
      }

      // Check required categories
      for (const reqCat of requiredCategories) {
        if (!targetFamilyForms.has(reqCat)) {
          const expectedSuffix =
            pluralType === "ordinal" ? `_ordinal_${reqCat}` : `_${reqCat}`;
          errors.push(
            `Locale '${locale}' is missing required ${pluralType} plural category '${reqCat}' for base key '${baseKey}' (expected key '${baseKey}${expectedSuffix}')`,
          );
        }
      }

      // Check unexpected categories (e.g. invalid _ordinal_zero)
      for (const [formCategory] of targetFamilyForms) {
        if (!allowedCategories.has(formCategory)) {
          errors.push(
            `Locale '${locale}' contains unexpected ${pluralType} plural category '${formCategory}' for base key '${baseKey}'`,
          );
        }
      }

      // Enforce exact placeholder parity per appropriate semantic form
      if (sourceFamilyForms && sourceFamilyForms.size > 0) {
        for (const [targetCategory, targetForm] of targetFamilyForms) {
          let sourceForm: FormInfo | undefined;

          if (pluralType === "cardinal" && targetCategory === "zero") {
            sourceForm =
              sourceFamilyForms.get("zero") ?? sourceFamilyForms.get("other");
          } else {
            sourceForm =
              sourceFamilyForms.get(targetCategory) ?? sourceFamilyForms.get("other");
          }

          if (sourceForm) {
            if (
              JSON.stringify(sourceForm.placeholders) !==
              JSON.stringify(targetForm.placeholders)
            ) {
              errors.push(
                `Locale '${locale}' has placeholder mismatch in '${targetForm.path}' for base key '${baseKey}': expected [${sourceForm.placeholders.join(", ")}], found [${targetForm.placeholders.join(", ")}]`,
              );
            }
          }
        }
      }
    }
  }

  // 5. Parity and completeness checks for all regular (non-plural) keys
  const allRegularKeys = new Set<string>();
  for (const data of localeData.values()) {
    for (const key of data.regularKeys.keys()) {
      allRegularKeys.add(key);
    }
  }

  const sortedRegularKeys = Array.from(allRegularKeys).sort();

  for (const rawKey of sortedRegularKeys) {
    const sourceForm = localeData.get(sourceLocale)?.regularKeys.get(rawKey);

    for (const locale of locales) {
      const data = localeData.get(locale)!;
      const form = data.regularKeys.get(rawKey);

      if (!form) {
        // Check if rawKey is present as a plural family in this locale
        const activeFamily = Array.from(establishedFamilies.values()).find(
          (f) =>
            f.baseKey === rawKey && (data.familyForms.get(f.familyId)?.size ?? 0) > 0,
        );

        if (activeFamily) {
          errors.push(
            `Locale '${locale}' has plural type mismatch for base key '${rawKey}': expected 'regular', found '${activeFamily.pluralType}'`,
          );
        } else {
          errors.push(`Locale '${locale}' is missing base key '${rawKey}'`);
        }
        continue;
      }

      if (sourceForm) {
        if (
          JSON.stringify(sourceForm.placeholders) !== JSON.stringify(form.placeholders)
        ) {
          errors.push(
            `Named placeholder mismatch for key '${rawKey}' in locale '${locale}': expected [${sourceForm.placeholders.join(", ")}], found [${form.placeholders.join(", ")}]`,
          );
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
