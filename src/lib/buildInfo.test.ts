import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBuildInfo, validateBuildInfo } from "./buildInfo";
import { BACKEND_COMMANDS, type InvokeFn } from "./ipc";

const SOURCE = { commit: "a1b2c3d", branch: "feature/trim", modified: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateBuildInfo", () => {
  it("reads a version with a source and a version with no source", () => {
    expect(validateBuildInfo({ version: "0.1.1", source: SOURCE })).toEqual({
      version: "0.1.1",
      source: SOURCE,
    });
    expect(
      validateBuildInfo({
        version: "0.1.1",
        source: { commit: "a1b2c3d", branch: null, modified: false },
      }),
    ).toEqual({
      version: "0.1.1",
      source: { commit: "a1b2c3d", branch: null, modified: false },
    });
    expect(validateBuildInfo({ version: "0.1.1", source: null })).toEqual({
      version: "0.1.1",
      source: null,
    });
  });

  it("refuses every other shape", () => {
    for (const value of [
      null,
      undefined,
      "0.1.1",
      {},
      { version: "", source: null },
      { version: 1, source: null },
      { version: "0.1.1" },
      { version: "0.1.1", source: "a1b2c3d" },
      { version: "0.1.1", source: { ...SOURCE, commit: "" } },
      { version: "0.1.1", source: { ...SOURCE, branch: "" } },
      { version: "0.1.1", source: { ...SOURCE, branch: undefined } },
      { version: "0.1.1", source: { ...SOURCE, modified: "true" } },
    ]) {
      expect(validateBuildInfo(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("loadBuildInfo", () => {
  it("calls build_info and returns its checked result", async () => {
    const invoke = vi.fn(() => Promise.resolve({ version: "0.1.1", source: SOURCE }));

    await expect(loadBuildInfo({ invoke: invoke as InvokeFn })).resolves.toEqual({
      version: "0.1.1",
      source: SOURCE,
    });
    expect(invoke).toHaveBeenCalledWith(BACKEND_COMMANDS.BUILD_INFO);
  });

  it("resolves null and logs when the command fails or returns another shape", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      loadBuildInfo({ invoke: () => Promise.reject(new Error("denied")) }),
    ).resolves.toBeNull();
    await expect(
      loadBuildInfo({ invoke: (() => Promise.resolve({ version: 1 })) as InvokeFn }),
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
