import { describe, expect, it } from "vitest";
import { formatCacheSize } from "./waveformCachePresenter";

describe("formatCacheSize", () => {
  it("shows kilobytes below one megabyte and megabytes above", () => {
    expect(formatCacheSize(0, "en")).toBe("0 kB");
    expect(formatCacheSize(720 * 1024, "en")).toBe("720 kB");
    expect(formatCacheSize(1024 * 1024, "en")).toBe("1 MB");
    expect(formatCacheSize(256 * 1024 * 1024, "en")).toBe("256 MB");
    expect(formatCacheSize(1.25 * 1024 * 1024, "en")).toBe("1.3 MB");
  });

  it("treats a value that is not a size as nothing", () => {
    expect(formatCacheSize(Number.NaN, "en")).toBe("0 kB");
    expect(formatCacheSize(-5, "en")).toBe("0 kB");
  });
});
