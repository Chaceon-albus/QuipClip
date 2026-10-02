import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The `src` directory, which the `@/` alias names. */
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Resolves an import specifier of `from` to a source file, or null for a package. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(SOURCE_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(from), specifier);
  } else {
    return null;
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Every source module that `entry` reaches through its imports, type imports included, so the
 * set is larger than what runs and a test on it errs on the safe side.
 */
function reachableModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      const target = resolveImport(file, match[1]);
      if (target !== null && !seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("SettingsWindowRoot", () => {
  const reached = reachableModules(
    join(SOURCE_ROOT, "components/settings/SettingsWindowRoot.tsx"),
  );
  const relative = new Set(
    Array.from(reached, (file) => file.slice(SOURCE_ROOT.length + 1)),
  );

  it("reaches the Settings view", () => {
    // Guards the walk itself: a walk that resolved nothing would pass every test below.
    expect(relative.has("components/settings/SettingsWindow.tsx")).toBe(true);
    expect(relative.has("features/settings/store.ts")).toBe(true);
  });

  // The quit decision of ADR 027 runs in the main window alone. A quit listener in the
  // Settings window could answer a quit with `confirm_quit` and skip the question of the main
  // window. The keys of ADR 026, the menu actions and the file drop act on the editor.
  it("mounts no quit listener, no keyboard layer, no menu listener and no file drop", () => {
    for (const module of [
      "components/layout/useQuitGuard.ts",
      "components/layout/QuitGuardDialog.tsx",
      "components/layout/useKeyboardShortcuts.ts",
      "components/layout/useNativeMenuActions.ts",
      "components/layout/useFileDropOpen.ts",
      "components/layout/DropOverlay.tsx",
      "components/layout/AppShell.tsx",
    ]) {
      expect(relative.has(module), module).toBe(false);
    }
  });
});
