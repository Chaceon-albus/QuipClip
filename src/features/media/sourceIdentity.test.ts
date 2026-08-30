import { describe, expect, it } from "vitest";
import { getMediaSourceIdentity } from "./sourceIdentity";

describe("Media Source Identity Helper", () => {
  it("returns empty string for null or undefined media", () => {
    expect(getMediaSourceIdentity(null)).toBe("");
    expect(getMediaSourceIdentity(undefined)).toBe("");
  });

  it("returns empty string when media path is not a string", () => {
    expect(
      getMediaSourceIdentity({
        path: null as unknown as string,
        size: 100,
        mtime: 100,
      }),
    ).toBe("");
  });

  it("generates deterministic identity token from canonical path, size, and mtime", () => {
    const media = {
      path: "/videos/sample.mp4",
      size: 1048576,
      mtime: 1724976000,
    };
    expect(getMediaSourceIdentity(media)).toBe("/videos/sample.mp4:1048576:1724976000");
  });

  it("produces distinct identity when file is modified at the same path (mtime changed)", () => {
    const original = {
      path: "/videos/sample.mp4",
      size: 1048576,
      mtime: 1724976000,
    };
    const modified = {
      path: "/videos/sample.mp4",
      size: 1048576,
      mtime: 1724976500,
    };
    expect(getMediaSourceIdentity(original)).not.toBe(getMediaSourceIdentity(modified));
  });

  it("produces distinct identity when file size changes at the same path", () => {
    const original = {
      path: "/videos/sample.mp4",
      size: 1048576,
      mtime: 1724976000,
    };
    const modified = {
      path: "/videos/sample.mp4",
      size: 2097152,
      mtime: 1724976000,
    };
    expect(getMediaSourceIdentity(original)).not.toBe(getMediaSourceIdentity(modified));
  });
});
