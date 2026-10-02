import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  createThemePreferenceStore,
  readStoredThemePreference,
} from "@/features/settings/themePreference";
import type { PreferenceStorage } from "@/i18n/types";
import capability from "../../src-tauri/capabilities/default.json";
import settingsCapability from "../../src-tauri/capabilities/settings.json";
import { BACKEND_COMMANDS } from "./ipc";
import {
  DARK_COLOR_SCHEME_QUERY,
  THEME_PREFERENCES,
  applyResolvedTheme,
  createThemeController,
  isThemePreference,
  nativeWindowThemeFor,
  resolveTheme,
  startThemeSync,
  type ColorSchemeQuery,
  type NativeWindowTheme,
  type ThemePreference,
  type ThemePreferenceSource,
  type ThemeRoot,
} from "./theme";

// The default native setters read `isTauri()`, `getCurrentWindow()` and its label, and call
// `invoke`. All are replaced, so a test can run the default wiring inside and outside Tauri,
// and in each window.
const tauri = vi.hoisted(() => ({
  inside: false,
  label: "main",
  setTheme: vi.fn<(theme: "light" | "dark" | null) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.inside,
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: tauri.setTheme, label: tauri.label }),
}));

interface FakeRoot extends ThemeRoot {
  readonly classes: Set<string>;
  readonly style: { colorScheme: string };
  /** The number of writes that changed the dark class or the color scheme. */
  writes: number;
}

function fakeRoot(initialClasses: readonly string[] = []): FakeRoot {
  const classes = new Set(initialClasses);
  let colorScheme = "";
  const root: FakeRoot = {
    classes,
    writes: 0,
    classList: {
      toggle: (token: string, force?: boolean) => {
        const on = force ?? !classes.has(token);
        if (on !== classes.has(token)) {
          root.writes += 1;
        }
        if (on) {
          classes.add(token);
        } else {
          classes.delete(token);
        }
        return on;
      },
    },
    style: {
      get colorScheme() {
        return colorScheme;
      },
      set colorScheme(value: string) {
        if (value !== colorScheme) {
          root.writes += 1;
        }
        colorScheme = value;
      },
    },
  };
  return root;
}

interface FakeQuery extends ColorSchemeQuery {
  matches: boolean;
  readonly listeners: Set<() => void>;
  /** Changes the system appearance and notifies each listener. */
  change(matches: boolean): void;
}

function fakeQuery(matches: boolean): FakeQuery {
  const listeners = new Set<() => void>();
  const query: FakeQuery = {
    matches,
    listeners,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    change: (next) => {
      query.matches = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return query;
}

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function themeOf(root: FakeRoot): { dark: boolean; colorScheme: string } {
  return { dark: root.classes.has("dark"), colorScheme: root.style.colorScheme };
}

describe("resolveTheme", () => {
  it("follows the system for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the system for an explicit preference", () => {
    for (const systemPrefersDark of [true, false]) {
      expect(resolveTheme("light", systemPrefersDark)).toBe("light");
      expect(resolveTheme("dark", systemPrefersDark)).toBe("dark");
    }
  });
});

describe("isThemePreference", () => {
  it("recognises only the three preference names", () => {
    expect(THEME_PREFERENCES).toEqual(["system", "light", "dark"]);
    for (const value of THEME_PREFERENCES) {
      expect(isThemePreference(value)).toBe(true);
    }
    for (const value of ["", "auto", "Dark", null, undefined, 1, true]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });
});

describe("applyResolvedTheme", () => {
  it("sets the dark class and the color scheme together", () => {
    const root = fakeRoot(["other"]);

    applyResolvedTheme(root, "dark");
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });

    applyResolvedTheme(root, "light");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
    expect(root.classes.has("other")).toBe(true);
  });
});

describe("createThemeController", () => {
  it("follows system changes while the preference is system", () => {
    const root = fakeRoot();
    const query = fakeQuery(false);
    const controller = createThemeController(root, query);

    controller.setPreference("system");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
    expect(query.listeners.size).toBe(1);

    query.change(true);
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });

    query.change(false);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
  });

  it("stops listening for an explicit preference, and listens again for system", () => {
    const root = fakeRoot();
    const query = fakeQuery(true);
    const controller = createThemeController(root, query);

    controller.setPreference("system");
    controller.setPreference("light");
    expect(query.listeners.size).toBe(0);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });

    query.change(false);
    query.change(true);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });

    controller.setPreference("dark");
    expect(query.listeners.size).toBe(0);
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });

    query.change(false);
    controller.setPreference("system");
    expect(query.listeners.size).toBe(1);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
  });

  it("adds one listener only, however often system is set", () => {
    const query = fakeQuery(false);
    const controller = createThemeController(fakeRoot(), query);

    controller.setPreference("system");
    controller.setPreference("system");

    expect(query.listeners.size).toBe(1);
  });

  it("reads a missing query as a light system", () => {
    const root = fakeRoot(["dark"]);
    const controller = createThemeController(root, null);

    controller.setPreference("system");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });

    controller.setPreference("dark");
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });
  });

  it("removes its listener on dispose and keeps the last theme", () => {
    const root = fakeRoot();
    const query = fakeQuery(true);
    const controller = createThemeController(root, query);

    controller.setPreference("system");
    controller.dispose();
    query.change(false);

    expect(query.listeners.size).toBe(0);
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });
  });
});

describe("startThemeSync", () => {
  it("applies the stored preference at once and each later change", () => {
    const root = fakeRoot();
    const query = fakeQuery(true);
    const store = createThemePreferenceStore({
      storage: memoryStorage({ [THEME_PREFERENCE_STORAGE_KEY]: "light" }),
    });

    const stop = startThemeSync(store, { root, query });
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
    expect(query.listeners.size).toBe(0);

    store.getState().setPreference("system");
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });
    expect(query.listeners.size).toBe(1);

    store.getState().setPreference("light");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });

    stop();
    store.getState().setPreference("dark");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
    expect(query.listeners.size).toBe(0);
  });

  it("does nothing without a document root", () => {
    const query = fakeQuery(true);
    const store = createThemePreferenceStore({ storage: memoryStorage() });

    const stop = startThemeSync(store, { root: null, query });

    expect(query.listeners.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});

describe("nativeWindowThemeFor", () => {
  it("maps system to null and an explicit preference to itself", () => {
    expect(nativeWindowThemeFor("system")).toBeNull();
    expect(nativeWindowThemeFor("light")).toBe("light");
    expect(nativeWindowThemeFor("dark")).toBe("dark");
  });
});

/** A native setter whose calls settle only when the test settles them. */
function deferredSetter() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const setter = vi.fn<(theme: NativeWindowTheme) => Promise<void>>(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return {
    setter,
    calls: () => setter.mock.calls.map(([theme]) => theme),
    /** Settles the oldest open call, and lets its handlers run. */
    async settle(outcome: "resolve" | "reject" = "resolve") {
      const call = pending.shift();
      if (outcome === "resolve") {
        call?.resolve();
      } else {
        call?.reject(new Error("denied"));
      }
      await flushPromises();
    },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A source that notifies on each call to `emit`, also for an unchanged preference. */
function manualSource(initial: ThemePreference): ThemePreferenceSource & {
  emit(preference: ThemePreference): void;
} {
  let preference = initial;
  const listeners = new Set<(state: { preference: ThemePreference }) => void>();
  return {
    getState: () => ({ preference }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (next) => {
      preference = next;
      for (const listener of listeners) {
        listener({ preference });
      }
    },
  };
}

describe("startThemeSync native window theme", () => {
  afterEach(() => {
    tauri.inside = false;
    tauri.setTheme.mockClear();
  });

  it("sends the mapped theme at start, also for system", async () => {
    for (const [stored, expected] of [
      ["system", null],
      ["light", "light"],
      ["dark", "dark"],
    ] as const) {
      const native = deferredSetter();
      const source = manualSource(stored);

      const stop = startThemeSync(source, {
        root: fakeRoot(),
        query: fakeQuery(false),
        setWindowTheme: native.setter,
      });
      await native.settle();
      stop();

      expect(native.calls()).toEqual([expected]);
    }
  });

  it("sends each change of the preference, mapped to the native theme", async () => {
    const native = deferredSetter();
    const source = manualSource("system");
    const root = fakeRoot();
    startThemeSync(source, {
      root,
      query: fakeQuery(true),
      setWindowTheme: native.setter,
    });
    await native.settle();

    source.emit("light");
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
    await native.settle();
    source.emit("dark");
    await native.settle();
    source.emit("system");
    await native.settle();

    expect(native.calls()).toEqual([null, "light", "dark", null]);
  });

  it("does not send a theme that did not change", async () => {
    const native = deferredSetter();
    const source = manualSource("dark");
    startThemeSync(source, {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: native.setter,
    });
    await native.settle();

    source.emit("dark");
    await flushPromises();

    expect(native.calls()).toEqual(["dark"]);
  });

  it("keeps one call in flight and then sends only the latest theme", async () => {
    const native = deferredSetter();
    const source = manualSource("dark");
    startThemeSync(source, {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: native.setter,
    });

    source.emit("light");
    source.emit("system");
    expect(native.calls()).toEqual(["dark"]);

    await native.settle();
    expect(native.calls()).toEqual(["dark", null]);

    // A change that returns to the theme in flight sends nothing more.
    source.emit("light");
    source.emit("system");
    await native.settle();
    expect(native.calls()).toEqual(["dark", null]);
  });

  it("ignores a failed call and still sends the next change", async () => {
    const native = deferredSetter();
    const source = manualSource("dark");
    const root = fakeRoot();
    startThemeSync(source, {
      root,
      query: fakeQuery(false),
      setWindowTheme: native.setter,
    });

    await native.settle("reject");
    source.emit("light");
    await native.settle();

    expect(native.calls()).toEqual(["dark", "light"]);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
  });

  it("ignores a setter that throws at once", async () => {
    const setter = vi.fn<(theme: NativeWindowTheme) => Promise<void>>(() => {
      throw new Error("no window");
    });
    const source = manualSource("dark");
    const root = fakeRoot();

    expect(() => {
      startThemeSync(source, { root, query: fakeQuery(false), setWindowTheme: setter });
      source.emit("light");
    }).not.toThrow();
    await flushPromises();

    expect(setter.mock.calls.map(([theme]) => theme)).toEqual(["dark", "light"]);
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
  });

  it("sends nothing after stop", async () => {
    const native = deferredSetter();
    const source = manualSource("dark");
    const stop = startThemeSync(source, {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: native.setter,
    });

    source.emit("light");
    stop();
    await native.settle();
    source.emit("system");
    await flushPromises();

    expect(native.calls()).toEqual(["dark"]);
  });

  it("uses the window of Tauri by default, and nothing outside Tauri", async () => {
    const outside = startThemeSync(manualSource("dark"), {
      root: fakeRoot(),
      query: fakeQuery(false),
    });
    outside();
    expect(tauri.setTheme).not.toHaveBeenCalled();

    tauri.inside = true;
    const source = manualSource("dark");
    const inside = startThemeSync(source, {
      root: fakeRoot(),
      query: fakeQuery(false),
    });
    await flushPromises();
    source.emit("system");
    await flushPromises();
    inside();

    expect(tauri.setTheme.mock.calls.map(([theme]) => theme)).toEqual(["dark", null]);
  });

  it("sends nothing with a null setter", () => {
    const root = fakeRoot();
    startThemeSync(manualSource("dark"), {
      root,
      query: fakeQuery(false),
      setWindowTheme: null,
    });
    expect(themeOf(root)).toEqual({ dark: true, colorScheme: "dark" });
  });

  it("has the permission that setTheme needs in the main window capability", () => {
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toContain("core:window:allow-set-theme");
  });
});

describe("startThemeSync window border", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
  });

  afterEach(() => {
    tauri.inside = false;
    tauri.label = "main";
  });

  /** Starts a sync that sends only the border theme, to `border`. */
  function startBorderSync(
    source: ThemePreferenceSource,
    query: ColorSchemeQuery,
    border: ReturnType<typeof deferredSetter>,
  ): () => void {
    return startThemeSync(source, {
      root: fakeRoot(),
      query,
      setWindowTheme: null,
      setWindowBorderTheme: border.setter,
    });
  }

  it("sends the resolved theme at start, also for system", async () => {
    for (const [stored, systemPrefersDark, expected] of [
      ["system", false, "light"],
      ["system", true, "dark"],
      ["light", true, "light"],
      ["dark", false, "dark"],
    ] as const) {
      const border = deferredSetter();
      const stop = startBorderSync(
        manualSource(stored),
        fakeQuery(systemPrefersDark),
        border,
      );
      await border.settle();
      stop();

      expect(border.calls()).toEqual([expected]);
    }
  });

  it("follows the system appearance under system, and ignores it otherwise", async () => {
    const border = deferredSetter();
    const query = fakeQuery(false);
    const source = manualSource("system");
    startBorderSync(source, query, border);
    await border.settle();

    query.change(true);
    await border.settle();
    source.emit("light");
    await border.settle();
    query.change(false);
    query.change(true);
    await flushPromises();
    source.emit("dark");
    await border.settle();

    expect(border.calls()).toEqual(["light", "dark", "light", "dark"]);
  });

  it("does not send a resolved theme that did not change", async () => {
    // The preference changes, and the theme that the page shows stays dark.
    const border = deferredSetter();
    const source = manualSource("system");
    startBorderSync(source, fakeQuery(true), border);
    await border.settle();

    source.emit("dark");
    await flushPromises();

    expect(border.calls()).toEqual(["dark"]);
  });

  it("keeps one call in flight and then sends only the latest theme", async () => {
    const border = deferredSetter();
    const source = manualSource("dark");
    startBorderSync(source, fakeQuery(false), border);

    source.emit("light");
    source.emit("system");
    source.emit("light");
    expect(border.calls()).toEqual(["dark"]);

    await border.settle();
    expect(border.calls()).toEqual(["dark", "light"]);
  });

  it("sends nothing after stop", async () => {
    const border = deferredSetter();
    const query = fakeQuery(false);
    const source = manualSource("system");
    const stop = startBorderSync(source, query, border);

    stop();
    await border.settle();
    query.change(true);
    source.emit("dark");
    await flushPromises();

    expect(border.calls()).toEqual(["light"]);
  });

  it("calls the border command by default in the main window, and nowhere else", async () => {
    const outside = startThemeSync(manualSource("dark"), {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: null,
    });
    await flushPromises();
    outside();
    expect(tauri.invoke).not.toHaveBeenCalled();

    // The Settings window has the frame of the system and no grant of the command.
    tauri.inside = true;
    tauri.label = "settings";
    const settings = startThemeSync(manualSource("dark"), {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: null,
    });
    await flushPromises();
    settings();
    expect(tauri.invoke).not.toHaveBeenCalled();

    tauri.label = "main";
    const source = manualSource("dark");
    const main = startThemeSync(source, {
      root: fakeRoot(),
      query: fakeQuery(false),
      setWindowTheme: null,
    });
    await flushPromises();
    source.emit("light");
    await flushPromises();
    main();

    expect(tauri.invoke.mock.calls).toEqual([
      [BACKEND_COMMANDS.SET_WINDOW_BORDER_THEME, { theme: "dark" }],
      [BACKEND_COMMANDS.SET_WINDOW_BORDER_THEME, { theme: "light" }],
    ]);
  });

  it("has the grant of the border command in the main window capability only", () => {
    expect(capability.permissions).toContain("allow-set-window-border-theme");
    expect(settingsCapability.permissions).not.toContain(
      "allow-set-window-border-theme",
    );
  });
});

const initScriptSource = readFileSync(
  fileURLToPath(new URL("../../public/theme-init.js", import.meta.url)),
  "utf8",
);

const indexHtml = readFileSync(
  fileURLToPath(new URL("../../index.html", import.meta.url)),
  "utf8",
);

interface InitEnvironment {
  /** The stored value. Null means no stored value. */
  stored: string | null;
  /** True when reading `window.localStorage` throws. */
  storageThrows?: boolean;
  /** The system appearance. Null means the web view has no `matchMedia`. */
  systemDark: boolean | null;
  initialClasses?: readonly string[];
}

/** Runs `public/theme-init.js` against a fake document and window. */
function runInitScript(environment: InitEnvironment): FakeRoot {
  const root = fakeRoot(environment.initialClasses);
  const storage = {
    getItem: (key: string) =>
      key === THEME_PREFERENCE_STORAGE_KEY ? environment.stored : null,
  };
  const window: Record<string, unknown> = {};
  Object.defineProperty(window, "localStorage", {
    get: () => {
      if (environment.storageThrows) {
        throw new Error("denied");
      }
      return storage;
    },
  });
  if (environment.systemDark !== null) {
    const systemDark = environment.systemDark;
    window.matchMedia = (query: string) => ({
      matches: query === DARK_COLOR_SCHEME_QUERY && systemDark,
    });
  }
  runInNewContext(initScriptSource, { window, document: { documentElement: root } });
  return root;
}

describe("public/theme-init.js", () => {
  const storedValues = [null, "system", "light", "dark", "auto", ""];

  it("writes the same theme as the module for every stored value and system", () => {
    for (const stored of storedValues) {
      for (const systemDark of [true, false]) {
        const root = runInitScript({ stored, systemDark });
        const storage = memoryStorage(
          stored === null ? {} : { [THEME_PREFERENCE_STORAGE_KEY]: stored },
        );
        const expected = resolveTheme(readStoredThemePreference(storage), systemDark);

        expect(themeOf(root), `stored ${stored}, system dark ${systemDark}`).toEqual({
          dark: expected === "dark",
          colorScheme: expected,
        });
      }
    }
  });

  it("removes a dark class that the preference does not want", () => {
    const root = runInitScript({
      stored: "light",
      systemDark: true,
      initialClasses: ["dark"],
    });
    expect(themeOf(root)).toEqual({ dark: false, colorScheme: "light" });
  });

  it("follows the system when storage throws", () => {
    expect(
      themeOf(
        runInitScript({ stored: "light", storageThrows: true, systemDark: true }),
      ),
    ).toEqual({ dark: true, colorScheme: "dark" });
  });

  it("reads a web view without matchMedia as a light system", () => {
    expect(themeOf(runInitScript({ stored: null, systemDark: null }))).toEqual({
      dark: false,
      colorScheme: "light",
    });
    expect(themeOf(runInitScript({ stored: "dark", systemDark: null }))).toEqual({
      dark: true,
      colorScheme: "dark",
    });
  });

  it("does not throw without a document", () => {
    expect(() => {
      runInNewContext(initScriptSource, { window: {} });
    }).not.toThrow();
  });

  it("hands over to the module sync without a visible change", () => {
    for (const stored of storedValues) {
      for (const systemDark of [true, false]) {
        const root = runInitScript({ stored, systemDark });
        const writesBefore = root.writes;
        const snapshot = themeOf(root);
        const storage = memoryStorage(
          stored === null ? {} : { [THEME_PREFERENCE_STORAGE_KEY]: stored },
        );

        const stop = startThemeSync(createThemePreferenceStore({ storage }), {
          root,
          query: fakeQuery(systemDark),
        });
        stop();

        expect(root.writes).toBe(writesBefore);
        expect(themeOf(root)).toEqual(snapshot);
      }
    }
  });

  it("stays ES5 syntax", () => {
    const code = initScriptSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/`/);
    expect(code).not.toMatch(/\b(?:let|const|class|import|export)\b/);
  });
});

describe("index.html", () => {
  it("declares both color schemes", () => {
    expect(indexHtml).toMatch(/<meta name="color-scheme" content="light dark"\s*\/?>/);
  });

  it("loads the theme script first, as a plain blocking script in <head>", () => {
    const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
    const firstScript = /<script\b[^>]*>/.exec(indexHtml);

    expect(firstScript?.[0]).toBe('<script src="/theme-init.js">');
    expect(firstScript!.index).toBeLessThan(head.length);
    expect(head.indexOf("<link")).toBe(-1);
    expect(head.indexOf("<style")).toBe(-1);
  });
});
