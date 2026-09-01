import { describe, expect, it } from "vitest";
import {
  PROJECT_SCHEMA_VERSION,
  toPersistedSource,
  type PersistedSource,
  type Project,
  type Pts,
  type Rational,
  type Segment,
  type Source,
  type SourceProxy,
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
      videoDurationTicks: "32370000" as TickCount,
      approximateDurationSeconds: 359.666667,
      avgFrameRate,
      rFrameRate,
      reportedFrameCount: null,
    };
    const segment: Segment = {
      id: "g1",
      sourceId: "s1",
      inPts: "9000" as Pts,
      outPts: "27000" as Pts,
    };
    const project: Project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      renderSettings: {
        frameRate: avgFrameRate,
        resolution: { w: 1920, h: 1080 },
      },
      sources: [persisted],
      segments: [segment],
      activeSourceId: "s1",
    };

    expect(project.schemaVersion).toBe(1);
    expect(project.renderSettings.resolution).toEqual({ w: 1920, h: 1080 });
    expect(project.sources[0].id).toBe("s1");
    expect(project.sources[0].videoStartPts).toBe("-1800");
    expect(project.sources[0].videoDurationTicks).toBe("32370000");
    expect(project.sources[0].approximateDurationSeconds).toBe(359.666667);
    expect(project.sources[0].reportedFrameCount).toBeNull();
    expect(project.segments[0].inPts).toBe("9000");
    expect(project.segments[0].outPts).toBe("27000");
    expect(project.activeSourceId).toBe("s1");
  });

  it("runtime source permits proxy object", () => {
    const videoTimeBase: Rational = { n: 1, d: 90000 };
    const proxy: SourceProxy = {
      path: "/cache/s1.mp4",
      state: "ready",
    };
    const runtime: Source = {
      id: "s1",
      path: "/media/clip.mp4",
      relPath: "clip.mp4",
      size: 1048576,
      mtime: 1787073674,
      videoStreamIndex: 0,
      videoTimeBase,
      videoStartPts: "0" as Pts,
      videoDurationTicks: "90000" as TickCount,
      approximateDurationSeconds: 1.0,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "30" as TickCount,
      proxy,
    };
    expect(runtime.proxy?.state).toBe("ready");
    expect(runtime.proxy?.path).toBe("/cache/s1.mp4");
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

  describe("toPersistedSource projection", () => {
    it("creates a clean new PersistedSource object and strips runtime proxy state", () => {
      const runtime: Source = {
        id: "s1",
        path: "/media/clip.mp4",
        relPath: "clip.mp4",
        size: 1048576,
        mtime: 1787073674,
        videoStreamIndex: 0,
        videoTimeBase: { n: 1, d: 90000 },
        videoStartPts: "-1800" as Pts,
        videoDurationTicks: "32370000" as TickCount,
        approximateDurationSeconds: 359.666667,
        avgFrameRate: { n: 30000, d: 1001 },
        rFrameRate: { n: 30000, d: 1001 },
        reportedFrameCount: "10790" as TickCount,
        proxy: {
          path: "/cache/s1.mp4",
          state: "ready",
        },
      };

      const persisted = toPersistedSource(runtime);

      expect(persisted).toEqual({
        id: "s1",
        path: "/media/clip.mp4",
        relPath: "clip.mp4",
        size: 1048576,
        mtime: 1787073674,
        videoStreamIndex: 0,
        videoTimeBase: { n: 1, d: 90000 },
        videoStartPts: "-1800",
        videoDurationTicks: "32370000",
        approximateDurationSeconds: 359.666667,
        avgFrameRate: { n: 30000, d: 1001 },
        rFrameRate: { n: 30000, d: 1001 },
        reportedFrameCount: "10790",
      });

      expect("proxy" in persisted).toBe(false);
      expect(Object.keys(persisted).sort()).toEqual(
        [
          "id",
          "path",
          "relPath",
          "size",
          "mtime",
          "videoStreamIndex",
          "videoTimeBase",
          "videoStartPts",
          "videoDurationTicks",
          "approximateDurationSeconds",
          "avgFrameRate",
          "rFrameRate",
          "reportedFrameCount",
        ].sort(),
      );
    });

    it("preserves null values for optional metadata fields", () => {
      const runtime: Source = {
        id: "s2",
        path: "/media/live.ts",
        relPath: "live.ts",
        size: 2048576,
        mtime: 1787073680,
        videoStreamIndex: 1,
        videoTimeBase: { n: 1, d: 90000 },
        videoStartPts: null,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
        avgFrameRate: null,
        rFrameRate: null,
        reportedFrameCount: null,
      };

      const persisted = toPersistedSource(runtime);

      expect(persisted.videoStartPts).toBeNull();
      expect(persisted.videoDurationTicks).toBeNull();
      expect(persisted.approximateDurationSeconds).toBeNull();
      expect(persisted.avgFrameRate).toBeNull();
      expect(persisted.rFrameRate).toBeNull();
      expect(persisted.reportedFrameCount).toBeNull();
      expect("proxy" in persisted).toBe(false);
    });
  });

  it("enforces at compile-time that Source does not assign to PersistedSource while plain persisted object does", () => {
    type PlainPersistedSource = {
      id: string;
      path: string;
      relPath: string;
      size: number;
      mtime: number;
      videoStreamIndex: number;
      videoTimeBase: Rational;
      videoStartPts: Pts | null;
      videoDurationTicks: TickCount | null;
      approximateDurationSeconds: number | null;
      avgFrameRate: Rational | null;
      rFrameRate: Rational | null;
      reportedFrameCount: TickCount | null;
    };

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
