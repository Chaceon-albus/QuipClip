import { describe, expect, it, vi } from "vitest";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { BACKEND_EVENTS, type ListenFn, type UnlistenFn } from "@/lib/ipc";
import { subscribeCapabilityProbe } from "./events";
import type { CapabilityProbeEvent } from "./types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("FFmpeg Capability Probe Events", () => {
  it("subscribes to BACKEND_EVENTS.CAPABILITY_PROBE ('ffmpeg:capability-probe')", async () => {
    let capturedCallback: ((payload: unknown) => void) | undefined;
    let listenCalledTimes = 0;
    let lastListenEvent = "";
    const mockUnlisten: UnlistenFn = vi.fn();
    const mockListen: ListenFn = <T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      listenCalledTimes++;
      lastListenEvent = event;
      capturedCallback = (payload: unknown) => {
        handler({ payload: payload as T });
      };
      return Promise.resolve(mockUnlisten);
    };

    const handler = vi.fn<(event: CapabilityProbeEvent) => void>();
    const unlisten = await subscribeCapabilityProbe(handler, {
      listen: mockListen,
    });

    expect(listenCalledTimes).toBe(1);
    expect(lastListenEvent).toBe(BACKEND_EVENTS.CAPABILITY_PROBE);
    expect(BACKEND_EVENTS.CAPABILITY_PROBE).toBe("ffmpeg:capability-probe");

    // Test unlisten
    unlisten();
    expect(mockUnlisten).toHaveBeenCalledTimes(1);

    // Test firing an event
    const validEvent: CapabilityProbeEvent = {
      event: "located",
      runId: "run-1",
      ffmpeg: "/usr/bin/ffmpeg",
      ffprobe: "/usr/bin/ffprobe",
      origin: "path",
      version: "7.1",
      license: { gpl: true, nonfree: false, version3: true },
    };

    capturedCallback!(validEvent);
    expect(handler).toHaveBeenCalledWith(validEvent);
  });

  it("delegates to default Tauri listen when no custom listen is passed", async () => {
    const mockedTauriListen = vi.mocked(tauriListen);
    const mockUnlisten = vi.fn();
    mockedTauriListen.mockResolvedValueOnce(mockUnlisten);

    const handler = vi.fn();
    const unlisten = await subscribeCapabilityProbe(handler);

    expect(mockedTauriListen).toHaveBeenCalledWith(
      "ffmpeg:capability-probe",
      expect.any(Function),
    );
    unlisten();
    expect(mockUnlisten).toHaveBeenCalledTimes(1);
  });

  it("safely drops malformed event payloads without throwing or killing the listener", async () => {
    let capturedCallback: ((payload: unknown) => void) | undefined;
    const mockListen: ListenFn = <T>(
      _event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      capturedCallback = (payload: unknown) => {
        handler({ payload: payload as T });
      };
      return Promise.resolve(() => {});
    };

    const handler = vi.fn<(event: CapabilityProbeEvent) => void>();
    await subscribeCapabilityProbe(handler, { listen: mockListen });

    // Send malformed payloads
    capturedCallback!(null);
    capturedCallback!("invalid-payload");
    capturedCallback!({ event: "unknownVariant", runId: "123" });
    capturedCallback!({
      event: "located",
      runId: "123",
      // missing ffmpeg, ffprobe, etc.
    });

    expect(handler).not.toHaveBeenCalled();

    // Verify listener is still alive and processes subsequent valid event
    const validEvent: CapabilityProbeEvent = {
      event: "failed",
      runId: "run-1",
      code: "ffmpegPairMissing",
    };
    capturedCallback!(validEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(validEvent);
  });

  it("forwards all valid event variants to the handler", async () => {
    let capturedCallback: ((payload: unknown) => void) | undefined;
    const mockListen: ListenFn = <T>(
      _event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      capturedCallback = (payload: unknown) => {
        handler({ payload: payload as T });
      };
      return Promise.resolve(() => {});
    };

    const handler = vi.fn<(event: CapabilityProbeEvent) => void>();
    await subscribeCapabilityProbe(handler, { listen: mockListen });

    const events: CapabilityProbeEvent[] = [
      {
        event: "located",
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "configured",
        version: "7.1",
        license: { gpl: true, nonfree: false, version3: true },
      },
      {
        event: "result",
        runId: "run-1",
        result: {
          name: "libx264",
          kind: "video",
          listed: true,
          status: "works",
        },
        done: 1,
        total: 12,
      },
      {
        event: "finished",
        runId: "run-1",
        report: {
          version: "7.1",
          license: { gpl: true, nonfree: false, version3: true },
          hwaccels: [],
          encoders: [],
          probedAt: 1724976000,
        },
        source: "probe",
      },
      {
        event: "failed",
        runId: "run-1",
        code: "cacheUnavailable",
      },
    ];

    for (const evt of events) {
      capturedCallback!(evt);
    }

    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenNthCalledWith(1, events[0]);
    expect(handler).toHaveBeenNthCalledWith(2, events[1]);
    expect(handler).toHaveBeenNthCalledWith(3, events[2]);
    expect(handler).toHaveBeenNthCalledWith(4, events[3]);
  });
});
