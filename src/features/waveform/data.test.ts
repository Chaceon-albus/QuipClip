import { describe, expect, it, vi } from "vitest";
import { createWaveformDataRegistry } from "./data";

describe("createWaveformDataRegistry", () => {
  it("holds one buffer for each source and announces each change", () => {
    const registry = createWaveformDataRegistry();
    const listener = vi.fn();
    const stop = registry.subscribe(listener);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.write("a", 0, new Uint8Array([1, 2]))).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    registry.reset("a");
    expect(registry.write("a", 0, new Uint8Array([1, 2]))).toBe(true);
    expect(registry.get("a")?.length).toBe(1);
    expect(registry.sourceIds()).toEqual(["a"]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.version()).toBe(2);

    // A refused write changes nothing.
    expect(registry.write("a", 0, new Uint8Array([1]))).toBe(false);
    expect(registry.version()).toBe(2);

    registry.drop("a");
    expect(registry.get("a")).toBeUndefined();
    expect(registry.version()).toBe(3);
    registry.drop("a");
    expect(registry.version()).toBe(3);

    stop();
    registry.reset("b");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("gives a source a new empty buffer on reset", () => {
    const registry = createWaveformDataRegistry();
    registry.reset("a");
    registry.write("a", 5, new Uint8Array([9, 9]));
    const fresh = registry.reset("a");
    expect(fresh.length).toBe(0);
    expect(registry.get("a")).toBe(fresh);
  });
});
