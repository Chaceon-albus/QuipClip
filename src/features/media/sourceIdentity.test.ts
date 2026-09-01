import { describe, expect, it } from "vitest";
import { generateSourceId, getSourceRevisionKey } from "./sourceIdentity";

describe("Media Source Identity and Revision Helpers", () => {
  describe("generateSourceId", () => {
    it("generates collision-resistant UUID-based IDs", () => {
      const ids = new Set(Array.from({ length: 1_000 }, () => generateSourceId()));
      expect(ids.size).toBe(1_000);
      for (const id of ids) {
        expect(id).toMatch(
          /^s[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      }
    });

    it("generates IDs with custom prefix", () => {
      const customId = generateSourceId("src_");
      expect(customId).toMatch(/^src_[0-9a-f-]{36}$/i);
    });

    it("survives project serialization and reload unchanged", () => {
      const id = generateSourceId();
      const reloaded = JSON.parse(JSON.stringify({ sourceId: id })) as {
        sourceId: string;
      };
      expect(reloaded.sourceId).toBe(id);
    });
  });

  describe("getSourceRevisionKey", () => {
    it("returns empty string for null or undefined media", () => {
      expect(getSourceRevisionKey(null)).toBe("");
      expect(getSourceRevisionKey(undefined)).toBe("");
    });

    it("returns empty string when media path is not a string", () => {
      expect(
        getSourceRevisionKey({
          path: null as unknown as string,
          size: 100,
          mtime: 100,
        }),
      ).toBe("");
    });

    it("generates deterministic revision key from path, size, and mtime", () => {
      const media = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      expect(getSourceRevisionKey(media)).toBe("/videos/sample.mp4:1048576:1724976000");
    });

    it("produces distinct revision key when mtime changes", () => {
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
      expect(getSourceRevisionKey(original)).not.toBe(getSourceRevisionKey(modified));
    });

    it("produces distinct revision key when size changes", () => {
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
      expect(getSourceRevisionKey(original)).not.toBe(getSourceRevisionKey(modified));
    });

    it("produces distinct revision key when path changes", () => {
      const original = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      const renamed = {
        path: "/videos/renamed.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      expect(getSourceRevisionKey(original)).not.toBe(getSourceRevisionKey(renamed));
    });
  });
});
