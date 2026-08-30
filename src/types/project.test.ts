import { describe, expect, it } from "vitest";
import {
  PROJECT_SCHEMA_VERSION,
  type PersistedSource,
  type Project,
  type Rational,
  type Segment,
  type Source,
  type SourceProxy,
} from "@/types/project";

describe("project type definitions and schema", () => {
  it("defines schema version 1", () => {
    expect(PROJECT_SCHEMA_VERSION).toBe(1);
  });

  it("persisted source matches .qcproj document structure without proxy", () => {
    const timebase: Rational = { n: 30000, d: 1001 };
    const persisted: PersistedSource = {
      id: "s1",
      path: "/media/clip.mp4",
      relPath: "clip.mp4",
      size: 1048576,
      mtime: 1787073674,
      timebase,
      frameCount: 1000,
    };
    const project: Project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      timebase,
      resolution: { w: 1920, h: 1080 },
      sources: [persisted],
      segments: [],
      activeSourceId: "s1",
    };
    expect(project.sources[0].id).toBe("s1");
    expect(project.schemaVersion).toBe(1);
  });

  it("runtime source permits proxy object", () => {
    const timebase: Rational = { n: 30000, d: 1001 };
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
      timebase,
      frameCount: 1000,
      proxy,
    };
    expect(runtime.proxy?.state).toBe("ready");
  });

  it("segment conforms to single-track source time model", () => {
    const segment: Segment = {
      id: "seg-1",
      sourceId: "s1",
      inFrame: 100,
      outFrame: 200,
    };
    expect(segment.outFrame - segment.inFrame).toBe(100);
  });

  it("enforces at compile-time that Source does not assign to PersistedSource while plain persisted object does", () => {
    type PlainPersistedSource = {
      id: string;
      path: string;
      relPath: string;
      size: number;
      mtime: number;
      timebase: Rational;
      frameCount: number;
    };

    type Extends<A, B> = [A] extends [B] ? true : false;

    // Compile-time checks enforced by TypeScript compiler:
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
