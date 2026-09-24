import { describe, expect, it, vi } from "vitest";
import { presentFfmpegStatus } from "@/components/layout/ffmpegStatusPresenter";
import {
  CapabilityProbeError,
  type FfmpegState,
  type FfmpegStatus,
} from "@/features/ffmpeg/types";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import type { FfmpegPathView } from "./ffmpegPathController";
import {
  automaticOriginKey,
  ffmpegStatusIcon,
  hasFfmpegControlActionEnded,
  HOMEBREW_INSTALL_COMMAND,
  HOMEBREW_URL,
  isFfmpegStatusBusy,
  nextFfmpegAnnouncement,
  pickFfmpegActionEndFocus,
  presentFfmpegActions,
  presentFfmpegAnnouncement,
  presentFfmpegInstallGuide,
  presentFfmpegSource,
  splitFfmpegStatusDetail,
  toFfmpegPlatform,
  WINGET_INSTALL_COMMAND,
  type FfmpegPlatform,
  type FfmpegSectionControl,
  type FfmpegSourceState,
} from "./ffmpegSectionPresenter";
import type { PromptFocusTarget } from "@/components/common/focusTarget";
import type { FocusHolderProbe } from "./presetDraftGuard";

/** Walks a dotted key through a nested catalog, the way i18next does. */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function expectMessageInBothCatalogs(key: string): void {
  expect(typeof resolveCatalogKey(en, key), `en: ${key}`).toBe("string");
  expect(typeof resolveCatalogKey(zhCN, key), `zh-CN: ${key}`).toBe("string");
}

const ALL_STATUSES: FfmpegStatus[] = [
  "idle",
  "locating",
  "probing",
  "ready",
  "missing",
  "failed",
];

const FORMAT = {
  list: new Intl.ListFormat("en", { style: "long", type: "unit" }),
  number: new Intl.NumberFormat("en"),
};

function pathView(overrides: Partial<FfmpegPathView> = {}): FfmpegPathView {
  return { path: null, pending: false, ready: true, ...overrides };
}

function sourceState(overrides: Partial<FfmpegSourceState> = {}): FfmpegSourceState {
  return { status: "ready", paths: null, origin: null, ...overrides };
}

function ffmpegState(overrides: Partial<FfmpegState> = {}): FfmpegState {
  return {
    status: "ready",
    runId: "run-1",
    paths: TOOLS_PAIR,
    origin: "path",
    version: "8.0",
    license: { gpl: true, nonfree: false, version3: false },
    hwaccels: [],
    results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
    done: 1,
    total: 1,
    source: "probe",
    error: null,
    inspected: null,
    ...overrides,
  };
}

const HOMEBREW_PAIR = {
  ffmpeg: "/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffmpeg",
  ffprobe: "/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffprobe",
};

const APP_DATA_PAIR = {
  ffmpeg: "/Users/me/Library/Application Support/app.quipclip/bin/ffmpeg",
  ffprobe: "/Users/me/Library/Application Support/app.quipclip/bin/ffprobe",
};

const TOOLS_PAIR = {
  ffmpeg: "/tools/ffmpeg/bin/ffmpeg",
  ffprobe: "/tools/ffmpeg/bin/ffprobe",
};

// What `std::fs::canonicalize` returns on Windows.
const WINDOWS_PAIR = {
  ffmpeg: "\\\\?\\D:\\Portable\\FFmpeg\\bin\\ffmpeg.exe",
  ffprobe: "\\\\?\\D:\\Portable\\FFmpeg\\bin\\ffprobe.exe",
};

const WINGET_LINK_PAIR = {
  ffmpeg: "\\\\?\\C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
  ffprobe:
    "\\\\?\\C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe",
};

describe("toFfmpegPlatform", () => {
  it("maps macOS, Windows and every other platform", () => {
    expect(toFfmpegPlatform(true, false)).toBe("macos");
    expect(toFfmpegPlatform(false, true)).toBe("windows");
    expect(toFfmpegPlatform(false, false)).toBe("other");
  });
});

describe("automaticOriginKey", () => {
  it("names the Homebrew folders with PATH on macOS only, because ADR 012 gives them the path origin", () => {
    expect(automaticOriginKey("path", "macos")).toBe("settings.ffmpeg.origin.pathMac");
    expect(automaticOriginKey("path", "windows")).toBe("settings.ffmpeg.origin.path");
    expect(automaticOriginKey("path", "other")).toBe("settings.ffmpeg.origin.path");
  });

  it.each<FfmpegPlatform>(["macos", "windows", "other"])(
    "names the application data folder on %s",
    (platform) => {
      expect(automaticOriginKey("appData", platform)).toBe(
        "settings.ffmpeg.origin.appData",
      );
    },
  );

  it("gives keys that both catalogs hold", () => {
    for (const platform of ["macos", "windows"] as const) {
      expectMessageInBothCatalogs(automaticOriginKey("path", platform));
    }
    expectMessageInBothCatalogs(automaticOriginKey("appData", "windows"));
  });
});

describe("presentFfmpegSource", () => {
  describe("with no user path", () => {
    it.each<FfmpegStatus>(["idle", "locating"])(
      "shows the locating state while the store is %s",
      (status) => {
        expect(
          presentFfmpegSource(pathView(), sourceState({ status }), "macos"),
        ).toEqual({ kind: "locating" });
      },
    );

    it("shows the automatic detection and its source while the probe runs", () => {
      const view = presentFfmpegSource(
        pathView(),
        sourceState({ status: "probing", paths: HOMEBREW_PAIR, origin: "path" }),
        "macos",
      );

      expect(view).toEqual({
        kind: "automatic",
        path: HOMEBREW_PAIR.ffmpeg,
        originKey: "settings.ffmpeg.origin.pathMac",
      });
    });

    it("shows a program in the application data folder", () => {
      const view = presentFfmpegSource(
        pathView(),
        sourceState({ status: "ready", paths: APP_DATA_PAIR, origin: "appData" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "automatic",
        path: APP_DATA_PAIR.ffmpeg,
        originKey: "settings.ffmpeg.origin.appData",
      });
    });

    it("shows a Windows program without the verbatim prefix", () => {
      const view = presentFfmpegSource(
        pathView(),
        sourceState({ status: "ready", paths: WINGET_LINK_PAIR, origin: "path" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "automatic",
        path: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
        originKey: "settings.ffmpeg.origin.path",
      });
    });

    it("keeps the automatic detection when the probe failed after discovery", () => {
      const view = presentFfmpegSource(
        pathView(),
        sourceState({ status: "failed", paths: TOOLS_PAIR, origin: "path" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "automatic",
        path: TOOLS_PAIR.ffmpeg,
        originKey: "settings.ffmpeg.origin.path",
      });
    });

    it("says that nothing was detected when the pair is missing", () => {
      expect(
        presentFfmpegSource(pathView(), sourceState({ status: "missing" }), "macos"),
      ).toEqual({ kind: "notDetected" });
    });

    it("claims no detection when the check stopped before discovery reported", () => {
      // For example `appDataUnavailable`: discovery never ran, so "did not detect" would
      // claim a search that did not happen.
      expect(
        presentFfmpegSource(pathView(), sourceState({ status: "failed" }), "windows"),
      ).toEqual({ kind: "unknown", chosenPath: null });
    });

    it("does not call a result from a user path automatic when the settings no longer hold that path", () => {
      const state = sourceState({
        status: "ready",
        paths: TOOLS_PAIR,
        origin: "configured",
      });

      expect(presentFfmpegSource(pathView(), state, "macos")).toEqual({
        kind: "unset",
      });
      // A choose or a check in flight keeps this state until its probe starts, so the tab
      // does not say "Locating FFmpeg..." while the file picker is open.
      expect(presentFfmpegSource(pathView({ pending: true }), state, "macos")).toEqual({
        kind: "unset",
      });
      expect(
        presentFfmpegSource(
          pathView({ pending: true }),
          { ...state, status: "locating" },
          "macos",
        ),
      ).toEqual({ kind: "locating" });
    });
  });

  describe("before the settings load", () => {
    const notReady = pathView({ ready: false });

    it("shows a program from a user path as the program, not as the chosen path", () => {
      // The store holds the program that the chosen path resolved to. The chosen path can be
      // a folder, so the program must not show as the path that the user chose.
      const view = presentFfmpegSource(
        notReady,
        sourceState({ status: "ready", paths: WINDOWS_PAIR, origin: "configured" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "user",
        path: null,
        programPath: "D:\\Portable\\FFmpeg\\bin\\ffmpeg.exe",
      });
    });

    it("reports an automatic detection", () => {
      const view = presentFfmpegSource(
        notReady,
        sourceState({ status: "ready", paths: HOMEBREW_PAIR, origin: "path" }),
        "macos",
      );

      expect(view.kind).toBe("automatic");
    });

    it("never claims that no user path is set", () => {
      for (const status of ALL_STATUSES) {
        for (const state of [
          sourceState({ status }),
          sourceState({ status, paths: TOOLS_PAIR, origin: "configured" }),
        ]) {
          for (const pending of [false, true]) {
            const view = presentFfmpegSource(
              pathView({ ready: false, pending }),
              state,
              "macos",
            );
            expect(view.kind).not.toBe("unset");
          }
        }
      }
    });
  });

  describe("with a user path", () => {
    it("shows the chosen path, and no resolved program when it is the same path", () => {
      const view = presentFfmpegSource(
        pathView({ path: TOOLS_PAIR.ffmpeg }),
        sourceState({ status: "ready", paths: TOOLS_PAIR, origin: "configured" }),
        "macos",
      );

      expect(view).toEqual({
        kind: "user",
        path: TOOLS_PAIR.ffmpeg,
        programPath: null,
      });
    });

    it("shows no resolved program for a chosen Windows file that differs only in the verbatim prefix and letter case", () => {
      const view = presentFfmpegSource(
        pathView({ path: "d:\\portable\\ffmpeg\\bin\\FFMPEG.EXE" }),
        sourceState({ status: "ready", paths: WINDOWS_PAIR, origin: "configured" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "user",
        path: "d:\\portable\\ffmpeg\\bin\\FFMPEG.EXE",
        programPath: null,
      });
      // Forward slashes are the same path on Windows.
      expect(
        presentFfmpegSource(
          pathView({ path: "D:/Portable/FFmpeg/bin/ffmpeg.exe" }),
          sourceState({ status: "ready", paths: WINDOWS_PAIR, origin: "configured" }),
          "windows",
        ),
      ).toMatchObject({ kind: "user", programPath: null });
    });

    it("keeps letter case on macOS, where a symbolic link can resolve to another case", () => {
      const view = presentFfmpegSource(
        pathView({ path: "/Tools/ffmpeg/bin/ffmpeg" }),
        sourceState({ status: "ready", paths: TOOLS_PAIR, origin: "configured" }),
        "macos",
      );

      expect(view).toEqual({
        kind: "user",
        path: "/Tools/ffmpeg/bin/ffmpeg",
        programPath: TOOLS_PAIR.ffmpeg,
      });
    });

    it("shows the program that a chosen folder resolved to", () => {
      const view = presentFfmpegSource(
        pathView({ path: "/opt/homebrew/bin" }),
        sourceState({ status: "probing", paths: HOMEBREW_PAIR, origin: "configured" }),
        "macos",
      );

      expect(view).toEqual({
        kind: "user",
        path: "/opt/homebrew/bin",
        programPath: HOMEBREW_PAIR.ffmpeg,
      });
    });

    it("shows the program of a chosen Windows folder without the verbatim prefix", () => {
      const view = presentFfmpegSource(
        pathView({ path: "D:\\Portable\\FFmpeg\\bin" }),
        sourceState({ status: "ready", paths: WINDOWS_PAIR, origin: "configured" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "user",
        path: "D:\\Portable\\FFmpeg\\bin",
        programPath: "D:\\Portable\\FFmpeg\\bin\\ffmpeg.exe",
      });
    });

    it("reports the fallback when discovery moved past an unusable chosen path", () => {
      const state = sourceState({
        status: "ready",
        paths: HOMEBREW_PAIR,
        origin: "path",
      });

      expect(presentFfmpegSource(pathView({ path: "/empty" }), state, "macos")).toEqual(
        {
          kind: "fallback",
          chosenPath: "/empty",
          path: HOMEBREW_PAIR.ffmpeg,
          originKey: "settings.ffmpeg.origin.pathMac",
        },
      );
      expect(
        presentFfmpegSource(
          pathView({ path: "C:\\empty" }),
          sourceState({ status: "ready", paths: WINGET_LINK_PAIR, origin: "path" }),
          "windows",
        ),
      ).toEqual({
        kind: "fallback",
        chosenPath: "C:\\empty",
        path: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
        originKey: "settings.ffmpeg.origin.path",
      });
    });

    it("reports a fallback to the application data folder", () => {
      const view = presentFfmpegSource(
        pathView({ path: "/empty" }),
        sourceState({ status: "ready", paths: APP_DATA_PAIR, origin: "appData" }),
        "windows",
      );

      expect(view).toEqual({
        kind: "fallback",
        chosenPath: "/empty",
        path: APP_DATA_PAIR.ffmpeg,
        originKey: "settings.ffmpeg.origin.appData",
      });
    });

    it("says that the chosen path is unusable when discovery accepted no candidate", () => {
      // locate.rs: `missing` means that no candidate passed, the configured one included,
      // so no FFmpeg is in use and nothing may be shown under "FFmpeg in Use".
      const view = presentFfmpegSource(
        pathView({ path: "/tools" }),
        sourceState({ status: "missing" }),
        "macos",
      );

      expect(view).toEqual({ kind: "unusable", chosenPath: "/tools" });
    });

    it("keeps Use Automatic Detection available while the chosen path is unusable", () => {
      expect(presentFfmpegActions(pathView({ path: "/tools" }), "missing")).toEqual({
        chooseDisabled: false,
        useAutomatic: { disabled: false },
        reprobeDisabled: false,
      });
    });

    it.each<FfmpegStatus>(["idle", "locating"])(
      "claims no program while the store is %s, because discovery has not finished",
      (status) => {
        for (const state of [
          sourceState({ status }),
          sourceState({ status, paths: TOOLS_PAIR, origin: "configured" }),
        ]) {
          expect(
            presentFfmpegSource(pathView({ path: "/tools" }), state, "macos"),
          ).toEqual({ kind: "locating" });
        }
      },
    );

    it("claims no program when the check stopped before discovery reported", () => {
      const view = presentFfmpegSource(
        pathView({ path: "/tools" }),
        sourceState({ status: "failed" }),
        "macos",
      );

      expect(view).toEqual({ kind: "unknown", chosenPath: "/tools" });
    });

    it("shows the chosen program when the probe failed after discovery accepted it", () => {
      // The program is the one QuipClip uses. The status block says why the probe failed.
      const view = presentFfmpegSource(
        pathView({ path: TOOLS_PAIR.ffmpeg }),
        sourceState({ status: "failed", paths: TOOLS_PAIR, origin: "configured" }),
        "macos",
      );

      expect(view).toEqual({
        kind: "user",
        path: TOOLS_PAIR.ffmpeg,
        programPath: null,
      });
    });

    it("keeps the result for the path in the settings while the file picker is open", () => {
      // A choose is pending while the picker is open. The store still holds the result for
      // the path that the settings hold, so that result stays true.
      const pending = pathView({ path: "/empty", pending: true });

      expect(
        presentFfmpegSource(pending, sourceState({ status: "missing" }), "macos"),
      ).toEqual({ kind: "unusable", chosenPath: "/empty" });
      expect(
        presentFfmpegSource(
          pending,
          sourceState({ status: "ready", paths: HOMEBREW_PAIR, origin: "path" }),
          "macos",
        ),
      ).toMatchObject({ kind: "fallback", chosenPath: "/empty" });
    });

    it("shows the locating state once the probe of a new path starts", () => {
      const view = presentFfmpegSource(
        pathView({ path: "/new/ffmpeg", pending: true }),
        sourceState({ status: "locating" }),
        "macos",
      );

      expect(view).toEqual({ kind: "locating" });
    });

    it("claims a program as in use in no state before discovery accepted one", () => {
      // Every state/label pair: only `user`, `automatic` and `fallback` name a program as the
      // one in use, and each needs a program that discovery reported.
      for (const status of ALL_STATUSES) {
        for (const pending of [false, true]) {
          for (const path of [
            pathView({ pending }),
            pathView({ path: "/tools", pending }),
          ]) {
            const view = presentFfmpegSource(path, sourceState({ status }), "macos");
            expect(["user", "automatic", "fallback"]).not.toContain(view.kind);
          }
        }
      }
    });
  });

  it("uses source keys that both catalogs hold", () => {
    for (const key of [
      "settings.ffmpeg.pathLabel",
      "settings.ffmpeg.source.user",
      "settings.ffmpeg.source.automatic",
      "settings.ffmpeg.source.notDetected",
      "settings.ffmpeg.source.unknown",
      "settings.ffmpeg.pathUnset",
      "settings.ffmpeg.fallback",
      "settings.ffmpeg.unusable",
      "settings.ffmpeg.chosenPath",
      "ffmpeg.status.locating",
      "ffmpeg.detail.program",
    ]) {
      expectMessageInBothCatalogs(key);
    }
    expect(en.settings.ffmpeg.pathLabel).toBe("FFmpeg in Use");
    expect(zhCN.settings.ffmpeg.pathLabel).toBe("当前使用的 FFmpeg");
    expect(en.settings.ffmpeg.unusable).toBe(
      "QuipClip cannot use the path that you chose, and it did not detect FFmpeg in another location.",
    );
    expect(zhCN.settings.ffmpeg.unusable).toBe(
      "QuipClip 无法使用您选择的路径，也没有在其他位置检测到 FFmpeg。",
    );
    expect(en.settings.ffmpeg.source.unknown).toBe(
      "QuipClip could not identify which FFmpeg to use. The status below gives the reason.",
    );
  });
});

describe("presentFfmpegActions", () => {
  it("disables every control and hides Use Automatic Detection before the settings load", () => {
    expect(presentFfmpegActions(pathView({ ready: false }), "ready")).toEqual({
      chooseDisabled: true,
      useAutomatic: null,
      reprobeDisabled: true,
    });
  });

  it("hides Use Automatic Detection while automatic detection is in use", () => {
    expect(presentFfmpegActions(pathView(), "ready")).toEqual({
      chooseDisabled: false,
      useAutomatic: null,
      reprobeDisabled: false,
    });
  });

  it("shows Use Automatic Detection while a user path is set", () => {
    expect(presentFfmpegActions(pathView({ path: "/tools" }), "ready")).toEqual({
      chooseDisabled: false,
      useAutomatic: { disabled: false },
      reprobeDisabled: false,
    });
  });

  it("disables every control while a choose, a clear or a check is in flight", () => {
    expect(
      presentFfmpegActions(pathView({ path: "/tools", pending: true }), "ready"),
    ).toEqual({
      chooseDisabled: true,
      useAutomatic: { disabled: true },
      reprobeDisabled: true,
    });
  });

  it.each<FfmpegStatus>(["locating", "probing"])(
    "disables only Check Again while the store is %s",
    (status) => {
      expect(presentFfmpegActions(pathView({ path: "/tools" }), status)).toEqual({
        chooseDisabled: false,
        useAutomatic: { disabled: false },
        reprobeDisabled: true,
      });
    },
  );

  it.each<FfmpegStatus>(["idle", "ready", "missing", "failed"])(
    "enables Check Again while the store is %s",
    (status) => {
      expect(presentFfmpegActions(pathView(), status).reprobeDisabled).toBe(false);
    },
  );

  it("uses labels that both catalogs hold", () => {
    for (const key of [
      "settings.ffmpeg.chooseFolder",
      "settings.ffmpeg.chooseFile",
      "settings.ffmpeg.useAutomatic",
      "settings.ffmpeg.reprobe",
    ]) {
      expectMessageInBothCatalogs(key);
    }
    expect(en.settings.ffmpeg.useAutomatic).toBe("Use Automatic Detection");
    expect(zhCN.settings.ffmpeg.useAutomatic).toBe("改用自动检测");
  });
});

describe("hasFfmpegControlActionEnded", () => {
  it.each<FfmpegSectionControl>([
    "chooseFolder",
    "chooseFile",
    "useAutomatic",
    "reprobe",
  ])("keeps the %s action running while the controller is pending", (control) => {
    expect(hasFfmpegControlActionEnded(control, true, false)).toBe(false);
    expect(hasFfmpegControlActionEnded(control, true, true)).toBe(false);
  });

  it.each<FfmpegSectionControl>(["chooseFolder", "chooseFile", "useAutomatic"])(
    "ends the %s action when the controller is no longer pending, while the probe still runs",
    (control) => {
      expect(hasFfmpegControlActionEnded(control, false, true)).toBe(true);
      expect(hasFfmpegControlActionEnded(control, false, false)).toBe(true);
    },
  );

  it("ends Check Again only when the probe that it started ends", () => {
    expect(hasFfmpegControlActionEnded("reprobe", false, true)).toBe(false);
    expect(hasFfmpegControlActionEnded("reprobe", false, false)).toBe(true);
  });
});

describe("pickFfmpegActionEndFocus", () => {
  type FakeTarget = PromptFocusTarget & { name: string };

  function target(
    name: string,
    overrides: Partial<PromptFocusTarget> = {},
  ): FakeTarget {
    return {
      name,
      isConnected: true,
      isRendered: true,
      isDisabled: false,
      focus: vi.fn(),
      ...overrides,
    };
  }

  function holder(tagName: string, role: string | null = null): FocusHolderProbe {
    return {
      tagName,
      getAttribute: (name: string) => (name === "role" ? role : null),
    };
  }

  const BODY = holder("BODY");
  // Radix moves the focus to the dialog element when the focused element leaves the
  // document or becomes disabled.
  const DIALOG = holder("DIV", "dialog");
  const OTHER_BUTTON = holder("BUTTON");

  it.each([
    ["no element", null],
    ["the document body", BODY],
    ["the dialog element", DIALOG],
  ])(
    "gives the focus back to the control that started the action when %s holds it",
    (_case, active) => {
      const started = target("Check Again");
      const fallback = target("Choose Folder");

      expect(pickFfmpegActionEndFocus(started, fallback, active)).toBe(started);
    },
  );

  it("gives the focus to Choose Folder after a clear that removed Use Automatic Detection", () => {
    const fallback = target("Choose Folder");

    expect(pickFfmpegActionEndFocus(null, fallback, DIALOG)).toBe(fallback);
    expect(
      pickFfmpegActionEndFocus(
        target("Use Automatic Detection", { isConnected: false }),
        fallback,
        BODY,
      ),
    ).toBe(fallback);
  });

  it("gives the focus back to Use Automatic Detection after a clear that failed and kept the path", () => {
    const started = target("Use Automatic Detection");

    expect(pickFfmpegActionEndFocus(started, target("Choose Folder"), DIALOG)).toBe(
      started,
    );
  });

  it("leaves the focus where the user moved it during the action", () => {
    expect(
      pickFfmpegActionEndFocus(
        target("Check Again"),
        target("Choose Folder"),
        OTHER_BUTTON,
      ),
    ).toBeNull();
  });

  it("moves the focus nowhere when no control can take it", () => {
    expect(
      pickFfmpegActionEndFocus(
        target("Check Again", { isDisabled: true }),
        target("Choose Folder", { isRendered: false }),
        BODY,
      ),
    ).toBeNull();
  });
});

describe("isFfmpegStatusBusy and ffmpegStatusIcon", () => {
  it.each<[FfmpegStatus, boolean]>([
    ["idle", true],
    ["locating", true],
    ["probing", true],
    ["ready", false],
    ["missing", false],
    ["failed", false],
  ])("reports %s as busy: %s", (status, busy) => {
    expect(isFfmpegStatusBusy(status)).toBe(busy);
  });

  it.each<FfmpegStatus>(["idle", "locating", "probing"])(
    "shows the spinner while the store is %s",
    (status) => {
      expect(ffmpegStatusIcon(status, "neutral")).toBe("spinner");
    },
  );

  it("follows the tone of the presented status once the probe ends", () => {
    const iconFor = (state: FfmpegState) =>
      ffmpegStatusIcon(state.status, presentFfmpegStatus(state, FORMAT).tone);

    expect(iconFor(ffmpegState())).toBe("check");
    // A ready FFmpeg with no working encoder cannot export, so it takes the warning.
    expect(
      iconFor(
        ffmpegState({
          results: [{ name: "libx264", kind: "video", listed: true, status: "failed" }],
        }),
      ),
    ).toBe("warning");
    expect(iconFor(ffmpegState({ status: "missing", paths: null, origin: null }))).toBe(
      "warning",
    );
    expect(iconFor(ffmpegState({ status: "failed" }))).toBe("warning");
  });
});

describe("presentFfmpegAnnouncement and nextFfmpegAnnouncement", () => {
  const announce = (state: FfmpegState) =>
    presentFfmpegAnnouncement(state.status, presentFfmpegStatus(state, FORMAT));

  it.each<FfmpegStatus>(["idle", "locating", "probing"])(
    "says one constant message while the store is %s",
    (status) => {
      expect(announce(ffmpegState({ status, done: 3, total: 12 }))).toEqual({
        phase: "checking",
        key: "settings.ffmpeg.checking",
        values: {},
      });
    },
  );

  it("says the complete status line when the check ends", () => {
    expect(announce(ffmpegState())).toEqual({
      phase: "ready",
      key: "ffmpeg.status.ready",
      values: { version: "8.0", working: "1", tested: "1" },
    });
    expect(
      announce(ffmpegState({ status: "missing", paths: null, origin: null })),
    ).toEqual({ phase: "missing", key: "ffmpeg.status.missing", values: {} });
    expect(announce(ffmpegState({ status: "failed" }))).toEqual({
      phase: "failed",
      key: "ffmpeg.status.failed",
      values: {},
    });
  });

  it("announces only a change of phase, so each step of the probe is not read", () => {
    const steps: FfmpegState[] = [
      ffmpegState({ status: "locating" }),
      ffmpegState({ status: "probing", done: 0, total: 12 }),
      ffmpegState({ status: "probing", done: 1, total: 12 }),
      ffmpegState({ status: "probing", done: 2, total: 12 }),
      ffmpegState({ status: "ready", done: 12, total: 12 }),
      ffmpegState({ status: "ready", done: 12, total: 12 }),
      ffmpegState({ status: "locating" }),
      ffmpegState({ status: "missing", paths: null, origin: null }),
    ];

    // The tab opened while the previous check was ready, so that phase is not announced.
    let seen = announce(ffmpegState()).phase;
    const spoken: string[] = [];
    for (const state of steps) {
      const next = nextFfmpegAnnouncement(seen, announce(state));
      if (next !== null) {
        seen = next.phase;
        spoken.push(next.key);
      }
    }

    expect(spoken).toEqual([
      "settings.ffmpeg.checking",
      "ffmpeg.status.ready",
      "settings.ffmpeg.checking",
      "ffmpeg.status.missing",
    ]);
  });

  it("announces nothing when the tab opens", () => {
    const current = announce(ffmpegState({ status: "probing", done: 4, total: 12 }));

    expect(nextFfmpegAnnouncement(current.phase, current)).toBeNull();
  });

  it("uses a message that both catalogs hold", () => {
    expectMessageInBothCatalogs("settings.ffmpeg.checking");
  });
});

describe("splitFfmpegStatusDetail", () => {
  it("puts the reason first and every searched location, in search order, second", () => {
    const inspected = [
      {
        ffmpeg: "/configured/ffmpeg",
        ffprobe: "/configured/ffprobe",
        origin: "configured",
      },
      { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe", origin: "path" },
      {
        ffmpeg: "/opt/homebrew/bin/ffmpeg",
        ffprobe: "/opt/homebrew/bin/ffprobe",
        origin: "path",
      },
      { ffmpeg: "/app/bin/ffmpeg", ffprobe: "/app/bin/ffprobe", origin: "appData" },
    ] as const;
    const state = ffmpegState({
      status: "missing",
      runId: null,
      paths: null,
      origin: null,
      version: null,
      license: null,
      results: [],
      done: 0,
      total: 0,
      source: null,
      error: new CapabilityProbeError({
        code: "ffmpegPairMissing",
        detail: "no complete ffmpeg pair in 4 locations",
        inspected: [...inspected],
      }),
      inspected: [...inspected],
    });

    const { leading, searched } = splitFfmpegStatusDetail(
      presentFfmpegStatus(state, FORMAT).detail,
    );

    expect(leading.map((entry) => entry.key)).toEqual([
      "ffmpegError.ffmpegPairMissing",
      "ffmpeg.detail.raw",
    ]);
    expect(searched.map((entry) => entry.key)).toEqual([
      "ffmpeg.detail.searchedPair.configured",
      "ffmpeg.detail.searchedPair.path",
      "ffmpeg.detail.searchedPair.path",
      "ffmpeg.detail.searchedPair.appData",
    ]);
    expect(searched.map((entry) => entry.values?.path)).toEqual(
      inspected.map((candidate) => candidate.ffmpeg),
    );
  });

  it("keeps every entry of a state that searched nothing in the leading part", () => {
    const detail = [
      { key: "ffmpeg.detail.version", id: "a", mono: false },
      { key: "ffmpeg.detail.hardwareNone", id: "b", mono: false },
    ];

    expect(splitFfmpegStatusDetail(detail)).toEqual({ leading: detail, searched: [] });
  });
});

describe("presentFfmpegInstallGuide", () => {
  it("gives the Homebrew prerequisite, the command and Check Again on macOS, in display order", () => {
    const guide = presentFfmpegInstallGuide("missing", "macos");

    expect(guide).toEqual({
      platform: "macos",
      prerequisiteKey: "settings.ffmpeg.install.macPrerequisite",
      url: "https://brew.sh",
      introKey: "settings.ffmpeg.install.macIntro",
      command: "brew install ffmpeg",
      afterKey: "settings.ffmpeg.install.macAfter",
    });
    // The prerequisite comes before the command.
    expect(Object.keys(guide ?? {})).toEqual([
      "platform",
      "prerequisiteKey",
      "url",
      "introKey",
      "command",
      "afterKey",
    ]);
    expect(HOMEBREW_INSTALL_COMMAND).toBe("brew install ffmpeg");
    expect(HOMEBREW_URL).toBe("https://brew.sh");
  });

  it("gives the exact winget command from the winget source and a restart on Windows", () => {
    expect(presentFfmpegInstallGuide("missing", "windows")).toEqual({
      platform: "windows",
      introKey: "settings.ffmpeg.install.windowsIntro",
      command: "winget install -e --id Gyan.FFmpeg --source winget",
      afterKey: "settings.ffmpeg.install.windowsAfter",
    });
    expect(WINGET_INSTALL_COMMAND).toBe(
      "winget install -e --id Gyan.FFmpeg --source winget",
    );
  });

  it("gives nothing on a platform without instructions", () => {
    expect(presentFfmpegInstallGuide("missing", "other")).toBeNull();
  });

  it.each<FfmpegStatus>(["idle", "locating", "probing", "ready", "failed"])(
    "gives nothing while the store is %s",
    (status) => {
      expect(presentFfmpegInstallGuide(status, "macos")).toBeNull();
      expect(presentFfmpegInstallGuide(status, "windows")).toBeNull();
    },
  );

  it("uses messages that both catalogs hold", () => {
    expectMessageInBothCatalogs("settings.ffmpeg.install.title");
    for (const platform of ["macos", "windows"] as const) {
      const guide = presentFfmpegInstallGuide("missing", platform);
      expect(guide).not.toBeNull();
      if (guide === null) {
        return;
      }
      expectMessageInBothCatalogs(guide.introKey);
      expectMessageInBothCatalogs(guide.afterKey);
      if (guide.platform === "macos") {
        expectMessageInBothCatalogs(guide.prerequisiteKey);
      }
    }
  });

  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ] as const)(
    "names Check Again on macOS with the exact label of the button in %s, in one complete message",
    (_language, catalog) => {
      const { macAfter, windowsAfter } = catalog.settings.ffmpeg.install;

      // ADR 011: the message holds the label itself. No placeholder takes a translated
      // fragment.
      expect(macAfter).toContain(catalog.settings.ffmpeg.reprobe);
      expect(macAfter).not.toContain("{{");
      // Check Again does not help on Windows, because the running process keeps its PATH.
      expect(windowsAfter).not.toContain(catalog.settings.ffmpeg.reprobe);
      expect(windowsAfter).not.toContain("{{");
    },
  );

  it("names the Start menu on Windows and shows the Homebrew URL as mono text", () => {
    expect(en.settings.ffmpeg.install.windowsAfter).toContain("Start menu");
    expect(zhCN.settings.ffmpeg.install.windowsAfter).toContain("“开始”菜单");
    expect(en.settings.ffmpeg.install.macPrerequisite).toContain(
      "<mono>{{url}}</mono>",
    );
    expect(zhCN.settings.ffmpeg.install.macPrerequisite).toContain(
      "<mono>{{url}}</mono>",
    );
  });

  it("keeps no Copy messages of its own, because Copy uses the shared diagnostic messages", () => {
    const install: Record<string, unknown> = en.settings.ffmpeg.install;
    expect(install.copy).toBeUndefined();
    expect(install.copied).toBeUndefined();
    expectMessageInBothCatalogs("common.diagnostic.copy");
    expectMessageInBothCatalogs("common.diagnostic.copied");
  });
});
