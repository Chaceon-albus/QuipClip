import { describe, expect, it } from "vitest";
import {
  PROJECT_SCHEMA_VERSION,
  FINGERPRINT_MAX_LENGTH,
  hasValidAudioStreamIndexField,
  isSourceFingerprint,
  isValidAudioStreamIndex,
  type PersistedSource,
  type FrameCount,
  type Project,
  type Pts,
  type Rational,
  type Segment,
  type SequenceSegment,
  type Clip,
  type TickCount,
} from "@/types/project";

describe("project type definitions and schema", () => {
  it("defines schema version 1", () => {
    expect(PROJECT_SCHEMA_VERSION).toBe(1);
  });

  it("persisted source matches .qcproj document structure without proxy", () => {
    const videoTimeBase: Rational = { n: 1, d: 90000 };
    const avgFrameRate: Rational = { n: 30000, d: 1001 };
    const rFrameRate: Rational = { n: 30000, d: 1001 };
    const persisted: PersistedSource = {
      id: "s1",
      path: "/Users/x/clips/a.mp4",
      relPath: "clips/a.mp4",
      size: 12345678,
      mtime: 1787073674,
      videoStreamIndex: 0,
      videoTimeBase,
      videoStartPts: "-1800" as Pts,
      videoEndPts: "32368200" as Pts,
      videoDurationTicks: "32370000" as TickCount,
      approximateDurationSeconds: 359.666667,
      avgFrameRate,
      rFrameRate,
      reportedFrameCount: null,
    };
    const clip: Clip = { id: "c1", sourceId: "s1" };
    const segment: SequenceSegment = {
      id: "g1",
      inClipId: "c1",
      inPts: "9000" as Pts,
      outClipId: "c1",
      outPts: "27000" as Pts,
    };
    const project: Project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      sources: [persisted],
      clips: [clip],
      segments: [segment],
    };

    expect(project.schemaVersion).toBe(1);
    expect("renderSettings" in project).toBe(false);
    expect(project.sources[0].id).toBe("s1");
    expect(project.sources[0].videoStartPts).toBe("-1800");
    expect(project.sources[0].videoDurationTicks).toBe("32370000");
    expect(project.sources[0].approximateDurationSeconds).toBe(359.666667);
    expect(project.sources[0].reportedFrameCount).toBeNull();
    expect(project.segments[0].inPts).toBe("9000");
    expect(project.segments[0].outPts).toBe("27000");
    expect(project.sources[0].videoEndPts).toBe("32368200");
    expect(project.clips[0].sourceId).toBe("s1");
    expect(project.segments[0].outClipId).toBe("c1");
  });

  it("segment conforms to half-open PTS interval model", () => {
    const segment: Segment = {
      id: "seg-1",
      sourceId: "s1",
      inPts: "1000" as Pts,
      outPts: "2000" as Pts,
    };
    expect(segment.inPts).toBe("1000");
    expect(segment.outPts).toBe("2000");
  });

  describe("the fingerprint of a persisted source (ADR 072)", () => {
    const hash = "9f3c5a7714e0b2d1";

    it("accepts a canonical start below the size, at most 64 KiB in front of it", () => {
      expect(isSourceFingerprint({ start: "0", fnv1a64: hash }, 1)).toBe(true);
      expect(
        isSourceFingerprint({ start: "0", fnv1a64: hash }, FINGERPRINT_MAX_LENGTH),
      ).toBe(true);
      expect(isSourceFingerprint({ start: "1048576", fnv1a64: hash }, 1_114_112)).toBe(
        true,
      );
      expect(isSourceFingerprint({ start: "1114111", fnv1a64: hash }, 1_114_112)).toBe(
        true,
      );
      expect(isSourceFingerprint({ start: "1", fnv1a64: "0000000000000000" }, 2)).toBe(
        true,
      );
      expect(isSourceFingerprint({ start: "1", fnv1a64: "ffffffffffffffff" }, 2)).toBe(
        true,
      );
    });

    it("refuses each bound and each other form", () => {
      // The start must be smaller than the size, and at most 64 KiB in front of it.
      expect(isSourceFingerprint({ start: "0", fnv1a64: hash }, 0)).toBe(false);
      expect(isSourceFingerprint({ start: "5", fnv1a64: hash }, 5)).toBe(false);
      expect(
        isSourceFingerprint({ start: "0", fnv1a64: hash }, FINGERPRINT_MAX_LENGTH + 1),
      ).toBe(false);
      expect(isSourceFingerprint({ start: "1048575", fnv1a64: hash }, 1_114_112)).toBe(
        false,
      );
      for (const start of ["", "01", "00", "+1", "-1", " 1", "1.0", "1e3", "x"]) {
        expect(isSourceFingerprint({ start, fnv1a64: hash }, 1_000)).toBe(false);
      }
      for (const fnv1a64 of [
        "",
        "9f3c5a7714e0b2d",
        "9f3c5a7714e0b2d10",
        "9F3C5A7714E0B2D1",
        "9f3c5a7714e0b2dg",
      ]) {
        expect(isSourceFingerprint({ start: "1", fnv1a64 }, 1_000)).toBe(false);
      }
      for (const value of [
        null,
        "1:9f3c5a7714e0b2d1",
        [],
        { start: 1, fnv1a64: hash },
        { start: "1" },
        { start: "1", fnv1a64: hash, size: 2 },
      ]) {
        expect(isSourceFingerprint(value, 1_000)).toBe(false);
      }
      expect(isSourceFingerprint({ start: "1", fnv1a64: hash }, 1.5)).toBe(false);
    });
  });

  describe("the audio stream index of a persisted source (ADR 070)", () => {
    it("accepts an absent field and a whole number from 0 to the largest u32", () => {
      expect(hasValidAudioStreamIndexField({ id: "s1" })).toBe(true);
      for (const index of [0, 1, 7, 4_294_967_295]) {
        expect(isValidAudioStreamIndex(index)).toBe(true);
        expect(
          hasValidAudioStreamIndexField({ id: "s1", audioStreamIndex: index }),
        ).toBe(true);
      }
    });

    it("refuses null and every value that is not such a number", () => {
      for (const value of [
        null,
        undefined,
        -1,
        1.5,
        4_294_967_296,
        Number.NaN,
        "1",
        true,
      ]) {
        expect(isValidAudioStreamIndex(value)).toBe(false);
        expect(
          hasValidAudioStreamIndexField({ id: "s1", audioStreamIndex: value }),
        ).toBe(false);
      }
    });
  });

  it("enforces at compile-time that a source with a proxy does not assign to PersistedSource while plain persisted object does", () => {
    type PlainPersistedSource = {
      id: string;
      path: string;
      relPath: string;
      size: number;
      mtime: number;
      videoStreamIndex: number;
      videoTimeBase: Rational;
      videoStartPts: Pts | null;
      videoEndPts: Pts | null;
      videoDurationTicks: TickCount | null;
      approximateDurationSeconds: number | null;
      avgFrameRate: Rational | null;
      rFrameRate: Rational | null;
      reportedFrameCount: FrameCount | null;
    };
    // A source with machine-specific proxy state (ADR 010).
    type Source = PlainPersistedSource & { proxy: { path: string; state: string } };

    type Extends<A, B> = [A] extends [B] ? true : false;

    type SourceAssignsToPersisted = Extends<Source, PersistedSource>;
    type PlainAssignsToPersisted = Extends<PlainPersistedSource, PersistedSource>;
    type PersistedAssignsToPersisted = Extends<PersistedSource, PersistedSource>;
    type SourceAssignsToProjectSource = Extends<Source, Project["sources"][number]>;
    type PlainAssignsToProjectSource = Extends<
      PlainPersistedSource,
      Project["sources"][number]
    >;
    type ProjectSourceAssignsToPersisted = Extends<
      Project["sources"][number],
      PersistedSource
    >;
    type PersistedAssignsToProjectSource = Extends<
      PersistedSource,
      Project["sources"][number]
    >;

    const sourceAssignsToPersisted: SourceAssignsToPersisted = false;
    const plainAssignsToPersisted: PlainAssignsToPersisted = true;
    const persistedAssignsToPersisted: PersistedAssignsToPersisted = true;
    const sourceAssignsToProjectSource: SourceAssignsToProjectSource = false;
    const plainAssignsToProjectSource: PlainAssignsToProjectSource = true;
    const projectSourceAssignsToPersisted: ProjectSourceAssignsToPersisted = true;
    const persistedAssignsToProjectSource: PersistedAssignsToProjectSource = true;

    expect(sourceAssignsToPersisted).toBe(false);
    expect(plainAssignsToPersisted).toBe(true);
    expect(persistedAssignsToPersisted).toBe(true);
    expect(sourceAssignsToProjectSource).toBe(false);
    expect(plainAssignsToProjectSource).toBe(true);
    expect(projectSourceAssignsToPersisted).toBe(true);
    expect(persistedAssignsToProjectSource).toBe(true);
  });
});
