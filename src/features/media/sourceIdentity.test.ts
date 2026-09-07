import { describe, expect, it } from "vitest";
import {
  generateSourceId,
  getGeneratedSourceId,
  getSourceRevisionKey,
  isSameSourceRevision,
} from "./sourceIdentity";

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

  describe("isSameSourceRevision", () => {
    const media = {
      path: "/videos/sample.mp4",
      size: 1_048_576,
      mtime: 1_724_976_000,
    };

    it("holds for two descriptors of the same revision", () => {
      expect(isSameSourceRevision(media, { ...media })).toBe(true);
    });

    it("fails when size, mtime, or path differ", () => {
      expect(isSameSourceRevision(media, { ...media, size: 2_097_152 })).toBe(false);
      expect(isSameSourceRevision(media, { ...media, mtime: 1_724_976_500 })).toBe(
        false,
      );
      expect(isSameSourceRevision(media, { ...media, path: "/videos/other.mp4" })).toBe(
        false,
      );
    });

    it("an unavailable descriptor on either side is never the same revision", () => {
      // An empty key states that nothing is known, not that the two sides agree.
      expect(isSameSourceRevision(null, null)).toBe(false);
      expect(isSameSourceRevision(media, null)).toBe(false);
      expect(isSameSourceRevision(undefined, media)).toBe(false);
    });
  });

  describe("getGeneratedSourceId", () => {
    const media = {
      path: "/videos/sample.mp4",
      size: 1_048_576,
      mtime: 1_724_976_000,
    };

    it("is stable while neither size nor mtime changes", () => {
      const first = getGeneratedSourceId(media);
      expect(first).not.toBeNull();
      expect(getGeneratedSourceId({ ...media })).toBe(first);
    });

    it("changes when size changes and when mtime changes", () => {
      // This is the invalidation the export warning rests on. Keyed by path, a re-encoded file
      // was handed the ID its stale segments carry, so the segments still matched the active
      // source and the next export cut them from frames they no longer name.
      const original = getGeneratedSourceId(media);
      const resized = getGeneratedSourceId({ ...media, size: 2_097_152 });
      const touched = getGeneratedSourceId({ ...media, mtime: 1_724_976_500 });

      expect(resized).not.toBe(original);
      expect(touched).not.toBe(original);
      expect(touched).not.toBe(resized);
    });

    it("is a map and not a one-slot memo, so A then B then A restores A", () => {
      const a = { path: "/videos/a.mp4", size: 100, mtime: 1_724_976_000 };
      const b = { path: "/videos/b.mp4", size: 200, mtime: 1_724_976_000 };

      const firstA = getGeneratedSourceId(a);
      const firstB = getGeneratedSourceId(b);
      expect(firstB).not.toBe(firstA);
      expect(getGeneratedSourceId(a)).toBe(firstA);
      expect(getGeneratedSourceId(b)).toBe(firstB);
    });

    it("answers null when no media is available", () => {
      expect(getGeneratedSourceId(null)).toBeNull();
      expect(getGeneratedSourceId(undefined)).toBeNull();
    });
  });
});
