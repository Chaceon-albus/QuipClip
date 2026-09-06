import { describe, expect, it, vi } from "vitest";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { BACKEND_EVENTS, type ListenFn, type UnlistenFn } from "@/lib/ipc";
import { subscribeExportProgress } from "./events";
import type { ExportProgressEvent } from "./types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("Media Export Events", () => {
  it("subscribes to BACKEND_EVENTS.EXPORT_PROGRESS ('export:progress')", async () => {
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

    const handler = vi.fn<(event: ExportProgressEvent) => void>();
    const unlisten = await subscribeExportProgress(handler, {
      listen: mockListen,
    });

    expect(listenCalledTimes).toBe(1);
    expect(lastListenEvent).toBe(BACKEND_EVENTS.EXPORT_PROGRESS);
    expect(BACKEND_EVENTS.EXPORT_PROGRESS).toBe("export:progress");

    // Test unlisten
    unlisten();
    expect(mockUnlisten).toHaveBeenCalledTimes(1);

    // Test firing an event
    const validEvent: ExportProgressEvent = {
      event: "started",
      runId: "run-1",
      outputPath: "/media/out.mp4",
      segmentCount: 1,
      totalDurationUs: 2_000_000,
      expectedFrames: 60,
    };

    capturedCallback!(validEvent);
    expect(handler).toHaveBeenCalledWith(validEvent);
  });

  it("delegates to default Tauri listen when no custom listen is passed", async () => {
    const mockedTauriListen = vi.mocked(tauriListen);
    const mockUnlisten = vi.fn();
    mockedTauriListen.mockResolvedValueOnce(mockUnlisten);

    const handler = vi.fn();
    const unlisten = await subscribeExportProgress(handler);

    expect(mockedTauriListen).toHaveBeenCalledWith(
      "export:progress",
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

    const handler = vi.fn<(event: ExportProgressEvent) => void>();
    await subscribeExportProgress(handler, { listen: mockListen });

    // Send malformed payloads
    capturedCallback!(null);
    capturedCallback!("invalid-string");
    capturedCallback!({ event: "unknownEvent", runId: "123" });
    capturedCallback!({
      event: "started",
      runId: "123",
      // missing outputPath, segmentCount, totalDurationUs
    });
    capturedCallback!({
      event: "progress",
      runId: "123",
      frame: -1, // invalid negative frame
    });
    capturedCallback!({
      event: "finished",
      runId: "123",
      // missing frames
    });
    capturedCallback!({
      event: "failed",
      runId: "123",
      code: "invalidErrorCodeNotInList",
    });

    expect(handler).not.toHaveBeenCalled();

    // Verify listener is still alive and processes subsequent valid event
    const validEvent: ExportProgressEvent = {
      event: "publishing",
      runId: "run-1",
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

    const handler = vi.fn<(event: ExportProgressEvent) => void>();
    await subscribeExportProgress(handler, { listen: mockListen });

    const events: ExportProgressEvent[] = [
      {
        event: "started",
        runId: "run-1",
        outputPath: "/media/out.mp4",
        segmentCount: 2,
        totalDurationUs: 5_000_000,
        expectedFrames: 150,
      },
      {
        event: "progress",
        runId: "run-1",
        frame: 45,
        expectedFrames: 150,
        fps: { n: 30, d: 1 },
        speed: { n: 15, d: 10 },
        totalSize: 1024000,
      },
      {
        event: "publishing",
        runId: "run-1",
      },
      {
        event: "finished",
        runId: "run-1",
        outputPath: "/media/out.mp4",
        frames: 150,
      },
      {
        event: "failed",
        runId: "run-1",
        code: "encoderUnavailable",
        detail: "Encoder nvenc unavailable",
        exitCode: 1,
        encoder: "h264_nvenc",
      },
      {
        event: "failed",
        runId: "run-1",
        code: "canceled",
      },
    ];

    for (const evt of events) {
      capturedCallback!(evt);
    }

    expect(handler).toHaveBeenCalledTimes(6);
    expect(handler).toHaveBeenNthCalledWith(1, events[0]);
    expect(handler).toHaveBeenNthCalledWith(2, events[1]);
    expect(handler).toHaveBeenNthCalledWith(3, events[2]);
    expect(handler).toHaveBeenNthCalledWith(4, events[3]);
    expect(handler).toHaveBeenNthCalledWith(5, events[4]);
    expect(handler).toHaveBeenNthCalledWith(6, events[5]);
  });
});
