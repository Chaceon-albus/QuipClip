import { describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { BACKEND_COMMANDS } from "@/lib/ipc";
import { startCapabilityProbe } from "./client";
import {
  BACKEND_CAPABILITY_PROBE_ERROR_CODES,
  CapabilityProbeError,
  type BackendCapabilityProbeErrorCode,
  type CapabilityProbeStart,
  type InspectedCandidate,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createValidStartResult(
  overrides: Partial<CapabilityProbeStart> = {},
): CapabilityProbeStart {
  return {
    runId: "test-run-123",
    ffmpeg: "/opt/homebrew/bin/ffmpeg",
    ffprobe: "/opt/homebrew/bin/ffprobe",
    origin: "path",
    ...overrides,
  };
}

describe("FFmpeg Capability Probe Client", () => {
  it("invokes the backend command with force=false by default", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(createValidStartResult());

    const result = await startCapabilityProbe(false, {
      invoke: mockInvoke,
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.START_CAPABILITY_PROBE, {
      force: false,
    });
    expect(BACKEND_COMMANDS.START_CAPABILITY_PROBE).toBe("start_capability_probe");
    expect(result).toEqual(createValidStartResult());
  });

  it("invokes the backend command with force=true when requested", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(createValidStartResult());

    const result = await startCapabilityProbe(true, {
      invoke: mockInvoke,
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(BACKEND_COMMANDS.START_CAPABILITY_PROBE, {
      force: true,
    });
    expect(result.runId).toBe("test-run-123");
  });

  it("delegates to default Tauri invoke when no custom invoke is provided", async () => {
    const mockedTauriInvoke = vi.mocked(tauriInvoke);
    mockedTauriInvoke.mockResolvedValueOnce(createValidStartResult());

    const result = await startCapabilityProbe();

    expect(mockedTauriInvoke).toHaveBeenCalledWith("start_capability_probe", {
      force: false,
    });
    expect(result.runId).toBe("test-run-123");
  });

  describe.each(BACKEND_CAPABILITY_PROBE_ERROR_CODES)(
    "accepts backend error code: %s",
    (code: BackendCapabilityProbeErrorCode) => {
      it(`normalizes rejected error with code ${code}`, async () => {
        const inspected: InspectedCandidate[] = [
          {
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          },
        ];
        const mockInvoke = vi.fn().mockRejectedValue({
          code,
          detail: `Diagnostic info for ${code}`,
          exitCode: 1,
          inspected,
        });

        await expect(
          startCapabilityProbe(false, { invoke: mockInvoke }),
        ).rejects.toMatchObject({
          code,
          detail: `Diagnostic info for ${code}`,
          exitCode: 1,
          inspected,
        });

        try {
          await startCapabilityProbe(false, { invoke: mockInvoke });
        } catch (error) {
          expect(error).toBeInstanceOf(CapabilityProbeError);
        }
      });
    },
  );

  it("normalizes malformed success responses to an error with code 'unknown'", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({
      runId: "123",
      // missing ffmpeg, ffprobe, origin
    });

    const promise = startCapabilityProbe(false, { invoke: mockInvoke });
    await expect(promise).rejects.toBeInstanceOf(CapabilityProbeError);
    await expect(promise).rejects.toMatchObject({
      code: "unknown",
      detail: undefined,
      exitCode: undefined,
    });
  });

  it("normalizes Error object rejections with detail undefined to prevent leaking local messages", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("Local IPC failed"));

    const promise = startCapabilityProbe(false, { invoke: mockInvoke });
    await expect(promise).rejects.toBeInstanceOf(CapabilityProbeError);
    await expect(promise).rejects.toMatchObject({
      code: "unknown",
      detail: undefined,
      exitCode: undefined,
    });
  });
});
