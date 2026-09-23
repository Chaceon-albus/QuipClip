import { describe, expect, it, vi } from "vitest";
import { createMediaStore, type ImportMediaResult } from "@/features/media";
import type { FrameCount, Pts, TickCount } from "@/types/project";
import baseConfig from "../../../src-tauri/tauri.conf.json";
import macosConfig from "../../../src-tauri/tauri.macos.conf.json";
import windowsConfig from "../../../src-tauri/tauri.windows.conf.json";
import { APP_TITLE, resolveWindowTitle, startWindowTitleSync } from "./windowTitleSync";

function createMedia(fileName: string): ImportMediaResult {
  return {
    path: `/media/${fileName}`,
    fileName,
    size: 1048576,
    mtime: 1724976000,
    probe: {
      formatNames: ["mov", "mp4"],
      formatLongName: "QuickTime / MOV",
      formatStartTime: null,
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      bitDepth: 8,
      width: 1920,
      height: 1080,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 90000 },
      videoStartPts: "0" as Pts,
      videoDurationTicks: "900000" as TickCount,
      approximateDurationSeconds: 10.0,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300" as FrameCount,
      audio: null,
    },
  };
}

function createSpy() {
  return vi.fn<(title: string) => Promise<void>>(() => Promise.resolve());
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function callsOf(spy: ReturnType<typeof createSpy>): string[] {
  return spy.mock.calls.map(([title]) => title);
}

describe("resolveWindowTitle", () => {
  it("names only the application when no file is open", () => {
    expect(resolveWindowTitle(null)).toBe("QuipClip");
    expect(resolveWindowTitle(undefined)).toBe("QuipClip");
    expect(resolveWindowTitle("")).toBe("QuipClip");
  });

  it("puts the whole file name before the application name", () => {
    expect(resolveWindowTitle("holiday.final.mp4")).toBe(
      "holiday.final.mp4 — QuipClip",
    );
  });

  // A platform file replaces the whole `windows` array of the base file (ADR 020), so each
  // file carries its own title.
  const configuredTitles: [string, string | undefined][] = [
    ["tauri.conf.json", baseConfig.app.windows[0]?.title],
    ["tauri.macos.conf.json", macosConfig.app.windows[0]?.title],
    ["tauri.windows.conf.json", windowsConfig.app.windows[0]?.title],
  ];

  it.each(configuredTitles)("matches the window title in %s", (_file, title) => {
    expect(title).toBe(APP_TITLE);
  });
});

describe("startWindowTitleSync", () => {
  function setup(media: ImportMediaResult | null = null) {
    const store = createMediaStore({}, { status: media ? "ready" : "idle", media });
    const setTitle = createSpy();
    const stop = startWindowTitleSync({ store, setTitle, enabled: true });
    return { store, setTitle, stop };
  }

  it("sends the application name once at start when no file is open", async () => {
    const { store, setTitle, stop } = setup();
    expect(callsOf(setTitle)).toEqual(["QuipClip"]);
    await flushPromises();
    store.setState({ status: "loading" });
    store.setState({ status: "error" });
    await flushPromises();
    expect(setTitle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("sends the open file at start", () => {
    const { setTitle, stop } = setup(createMedia("clip.mp4"));
    expect(callsOf(setTitle)).toEqual(["clip.mp4 — QuipClip"]);
    stop();
  });

  it("follows the media as it opens, changes, and closes", async () => {
    const { store, setTitle, stop } = setup();
    const steps: Partial<ReturnType<typeof store.getState>>[] = [
      { status: "loading" },
      { status: "ready", media: createMedia("a.mp4") },
      // A failed replacement keeps the open file, so the title does not change.
      { status: "error", media: createMedia("a.mp4") },
      { status: "ready", media: createMedia("b.mov") },
      { status: "idle", media: null },
    ];
    for (const step of steps) {
      await flushPromises();
      store.setState(step);
    }
    await flushPromises();
    expect(callsOf(setTitle)).toEqual([
      "QuipClip",
      "a.mp4 — QuipClip",
      "b.mov — QuipClip",
      "QuipClip",
    ]);
    stop();
  });

  it("keeps one call in flight and sends only the latest title after it settles", async () => {
    const store = createMediaStore();
    let release: () => void = () => {};
    const setTitle = vi.fn<(title: string) => Promise<void>>();
    setTitle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    setTitle.mockImplementation(() => Promise.resolve());
    const stop = startWindowTitleSync({ store, setTitle, enabled: true });

    store.setState({ status: "ready", media: createMedia("a.mp4") });
    store.setState({ status: "ready", media: createMedia("b.mp4") });
    await flushPromises();
    expect(setTitle).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
    expect(callsOf(setTitle)).toEqual(["QuipClip", "b.mp4 — QuipClip"]);
    stop();
  });

  it("sends nothing more when the latest title matches the settled call", async () => {
    const store = createMediaStore();
    let release: () => void = () => {};
    const setTitle = vi.fn<(title: string) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startWindowTitleSync({ store, setTitle, enabled: true });
    store.setState({ status: "ready", media: createMedia("a.mp4") });
    store.setState({ status: "idle", media: null });
    release();
    await flushPromises();
    expect(setTitle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("swallows a rejection of the setter and sends the latest title", async () => {
    const store = createMediaStore();
    const setTitle = vi.fn<(title: string) => Promise<void>>(() =>
      Promise.reject(new Error("permission denied")),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stop = startWindowTitleSync({ store, setTitle, enabled: true });
      store.setState({ status: "ready", media: createMedia("a.mp4") });
      await flushPromises();
      expect(callsOf(setTitle)).toEqual(["QuipClip", "a.mp4 — QuipClip"]);
      expect(unhandled).not.toHaveBeenCalled();
      stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("catches a synchronous throw of the setter and treats it as settled", () => {
    const store = createMediaStore();
    const setTitle = vi.fn<(title: string) => Promise<void>>(() => {
      throw new Error("no window");
    });
    const stop = startWindowTitleSync({ store, setTitle, enabled: true });
    store.setState({ status: "ready", media: createMedia("a.mp4") });
    expect(callsOf(setTitle)).toEqual(["QuipClip", "a.mp4 — QuipClip"]);
    stop();
  });

  it("sends nothing after stop", async () => {
    const { store, setTitle, stop } = setup();
    stop();
    store.setState({ status: "ready", media: createMedia("a.mp4") });
    await flushPromises();
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the application shell", async () => {
    const store = createMediaStore(
      {},
      { status: "ready", media: createMedia("a.mp4") },
    );
    const setTitle = createSpy();
    const stop = startWindowTitleSync({ store, setTitle, enabled: false });
    store.setState({ status: "ready", media: createMedia("b.mp4") });
    await flushPromises();
    expect(setTitle).not.toHaveBeenCalled();
    stop();
  });

  it("reads the environment when no flag is given, and a test run is not the shell", () => {
    const store = createMediaStore();
    const setTitle = createSpy();
    const stop = startWindowTitleSync({ store, setTitle });
    expect(setTitle).not.toHaveBeenCalled();
    stop();
  });
});
