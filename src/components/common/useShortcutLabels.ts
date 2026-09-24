import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  getShortcutPlatform,
  type ShortcutAction,
} from "@/components/layout/shortcutBindings";
import {
  ariaKeyShortcutsFor,
  chipShortcutsFor,
  formatShortcut,
  resolveShortcutKeyNames,
  shortcutFor,
} from "@/components/layout/shortcutLabels";

/** What a control shows and declares for the key of its action. */
export interface ShortcutLabel {
  /**
   * The text of the chip of the first binding, formatted for the platform, such as `⇧⌘Z`. A
   * menu item shows it as its shortcut.
   */
  readonly keys: string;
  /**
   * The text of every chip that a tooltip shows (`chipShortcutsFor`), first binding first.
   * One chip for every action except Fit, which also shows Shift+Z.
   */
  readonly chips: readonly string[];
  /** The `aria-keyshortcuts` value, such as `Meta+Shift+Z`. */
  readonly aria: string;
}

/** Returns the key of the action, or null when the action has no binding on the platform. */
export type ShortcutLabelLookup = (action: ShortcutAction) => ShortcutLabel | null;

/**
 * Returns a lookup from an action to its key chip and its `aria-keyshortcuts` value, read from
 * the binding table (ADR 026). The lookup changes only with the interface language, because
 * the words of the chip come from the catalog.
 */
export function useShortcutLabels(): ShortcutLabelLookup {
  const { t } = useTranslation();
  return useMemo(() => {
    // The platform is fixed for the life of the process.
    const platform = getShortcutPlatform();
    const keyNames = resolveShortcutKeyNames((key) => t(key));
    return (action) => {
      const binding = shortcutFor(action, platform);
      if (binding === null) {
        return null;
      }
      return {
        keys: formatShortcut(binding, platform, keyNames),
        chips: chipShortcutsFor(action, platform).map((chip) =>
          formatShortcut(chip, platform, keyNames),
        ),
        aria: ariaKeyShortcutsFor(action, platform) ?? "",
      };
    };
  }, [t]);
}
