import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pathTextCases from "./pathTextCases.json";
import {
  BACKEND_PROJECT_COMMAND_ERROR_CODES,
  PROJECT_COMMAND_ERROR_CODES,
  ProjectCommandError,
} from "./types";
import {
  isBackendProjectCommandErrorCode,
  isProjectCommandErrorCode,
  isRelPathText,
  isSourcePathText,
  normalizeProjectCommandError,
  validateLoadProjectResult,
  validateProjectDocument,
  validateSaveProjectResult,
} from "./validation";

/**
 * Reads the wire strings of every `ProjectCommandErrorCode` out of the Rust source. The enum
 * carries `#[serde(rename_all = "camelCase")]`, so the wire string of a variant is its name with
 * the first letter lowered.
 */
const PROJECT_ERROR_ENUM_PATTERN =
  /#\[serde\(rename_all = "camelCase"\)\]\npub enum ProjectCommandErrorCode \{\n([\s\S]*?)\n\}\n/;

function readRustProjectCommandErrorCodes(): string[] {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../src-tauri/src/commands/project.rs", import.meta.url),
    ),
    "utf8",
  );
  const declaration = PROJECT_ERROR_ENUM_PATTERN.exec(source);
  expect(declaration).not.toBeNull();
  const variants = declaration![1].matchAll(/^ {4}([A-Z][A-Za-z0-9]*),$/gm);
  return Array.from(variants, (match) => match[1][0].toLowerCase() + match[1].slice(1));
}

/** A document as the backend answers it: a source with each optional field, and one without. */
function createDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "s1",
        path: "/Users/x/live.flv",
        relPath: "../live.flv",
        size: 1_114_112,
        mtime: 1_700_000_000,
        videoStreamIndex: 0,
        videoTimeBase: { n: 1, d: 1000 },
        videoStartPts: "0",
        videoEndPts: "60000",
        videoDurationTicks: "60000",
        approximateDurationSeconds: 60,
        avgFrameRate: { n: 30, d: 1 },
        rFrameRate: { n: 30, d: 1 },
        reportedFrameCount: null,
        audioStreamIndex: 1,
        fingerprint: { start: "1048576", fnv1a64: "9f3c5a7714e0b2d1" },
      },
      {
        id: "s2",
        path: "D:\\clips\\b.mkv",
        size: 99,
        mtime: -1,
        videoStreamIndex: 2,
        videoTimeBase: { n: 1, d: 90000 },
        videoStartPts: null,
        videoEndPts: null,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
        avgFrameRate: null,
        rFrameRate: null,
        reportedFrameCount: "10",
      },
    ],
    clips: [
      { id: "c1", sourceId: "s1" },
      { id: "c2", sourceId: "s2" },
    ],
    segments: [
      { id: "g1", inClipId: "c1", inPts: "0", outClipId: "c1", outPts: "1000" },
      {
        id: "g2",
        inClipId: "c1",
        inPts: "-5",
        outClipId: "c2",
        outPts: "9223372036854775807",
        name: "Intro 😀",
      },
    ],
  };
}

function createLoadAnswer(): Record<string, unknown> {
  return {
    path: "/Users/x/cut/cut.qcproj",
    project: createDocument(),
    candidates: [["/Users/x/live.flv"], ["D:\\clips\\b.mkv"]],
  };
}

/** The document with one change at `path`, a list of keys and indexes. */
function withChange(
  path: readonly (string | number)[],
  change: (parent: Record<string | number, unknown>, key: string | number) => void,
): Record<string, unknown> {
  const document = createDocument();
  let parent: Record<string | number, unknown> = document;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string | number, unknown>;
  }
  change(parent, path[path.length - 1]);
  return document;
}

function set(
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  return withChange(path, (parent, key) => {
    parent[key] = value;
  });
}

function remove(path: readonly (string | number)[]): Record<string, unknown> {
  return withChange(path, (parent, key) => {
    delete parent[key];
  });
}

describe("project command errors", () => {
  it("names exactly the codes of the Rust ProjectCommandErrorCode", () => {
    const rustCodes = readRustProjectCommandErrorCodes();
    expect(rustCodes.length).toBeGreaterThan(8);
    expect([...BACKEND_PROJECT_COMMAND_ERROR_CODES].sort()).toEqual(
      [...rustCodes].sort(),
    );
    expect(PROJECT_COMMAND_ERROR_CODES).toContain("unknown");
  });

  it("recognizes the codes", () => {
    for (const code of BACKEND_PROJECT_COMMAND_ERROR_CODES) {
      expect(isBackendProjectCommandErrorCode(code)).toBe(true);
      expect(isProjectCommandErrorCode(code)).toBe(true);
    }
    expect(isBackendProjectCommandErrorCode("unknown")).toBe(false);
    expect(isProjectCommandErrorCode("unknown")).toBe(true);
    expect(isProjectCommandErrorCode("revisionMismatch")).toBe(false);
    expect(isProjectCommandErrorCode(3)).toBe(false);
  });

  it("keeps the facts of a backend rejection that have the right type", () => {
    const error = normalizeProjectCommandError({
      code: "futureSchemaVersion",
      foundSchemaVersion: 2,
      supportedSchemaVersion: 1,
    });
    expect(error).toBeInstanceOf(ProjectCommandError);
    expect(error.code).toBe("futureSchemaVersion");
    expect(error.foundSchemaVersion).toBe(2);
    expect(error.supportedSchemaVersion).toBe(1);

    const field = normalizeProjectCommandError({
      code: "invalidProject",
      field: "sources[0].fingerprint",
    });
    expect(field.field).toBe("sources[0].fingerprint");
    expect(field.value).toBeUndefined();

    const unsafe = normalizeProjectCommandError({
      code: "unsafeProjectValue",
      field: "sources[0].size",
      value: "9007199254740992",
      detail: "raw",
    });
    expect(unsafe.value).toBe("9007199254740992");
    expect(unsafe.detail).toBe("raw");

    const wrong = normalizeProjectCommandError({
      code: "nope",
      field: 3,
      foundSchemaVersion: -1,
      supportedSchemaVersion: 1.5,
    });
    expect(wrong.code).toBe("unknown");
    expect(wrong.field).toBeUndefined();
    expect(wrong.foundSchemaVersion).toBeUndefined();
    expect(wrong.supportedSchemaVersion).toBeUndefined();
  });

  it("gives a local error, a string and nothing the code unknown", () => {
    const same = new ProjectCommandError({ code: "readFailed" });
    expect(normalizeProjectCommandError(same)).toBe(same);
    const local = normalizeProjectCommandError(new TypeError("an English sentence"));
    expect(local.code).toBe("unknown");
    expect(local.detail).toBeUndefined();
    expect(normalizeProjectCommandError("raw text")).toMatchObject({
      code: "unknown",
      detail: "raw text",
    });
    expect(normalizeProjectCommandError(undefined).code).toBe("unknown");
  });
});

describe("validateProjectDocument", () => {
  it("accepts a document of the backend and returns a copy of it", () => {
    const document = createDocument();
    const project = validateProjectDocument(document);
    expect(project).toEqual(document);
    expect(project).not.toBe(document);
    expect(project.sources[0]).not.toBe((document.sources as unknown[])[0]);
    expect(project.sources[0].fingerprint).not.toBe(
      ((document.sources as Record<string, unknown>[])[0] as { fingerprint: unknown })
        .fingerprint,
    );
    expect("relPath" in project.sources[1]).toBe(false);
    expect("fingerprint" in project.sources[1]).toBe(false);
    expect("name" in project.segments[0]).toBe(false);
  });

  it("refuses a document with renderSettings or another unknown field", () => {
    const withRender = createDocument();
    withRender.renderSettings = {
      frameRate: { n: 30, d: 1 },
      resolution: { w: 1920, h: 1080 },
    };
    expect(() => validateProjectDocument(withRender)).toThrow(TypeError);
    expect(() => validateProjectDocument(set(["sources", 0, "proxy"], {}))).toThrow(
      TypeError,
    );
    expect(() => validateProjectDocument(set(["clips", 0, "start"], 0))).toThrow(
      TypeError,
    );
    expect(() =>
      validateProjectDocument(set(["segments", 0, "sourceId"], "s1")),
    ).toThrow(TypeError);
  });

  it("refuses a present null for each optional field", () => {
    for (const path of [
      ["sources", 0, "relPath"],
      ["sources", 0, "fingerprint"],
      ["sources", 0, "audioStreamIndex"],
      ["segments", 1, "name"],
    ] as const) {
      expect(() => validateProjectDocument(set(path, null)), path.join(".")).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a missing required field", () => {
    for (const path of [
      ["schemaVersion"],
      ["sources"],
      ["sources", 1, "videoEndPts"],
      ["sources", 1, "reportedFrameCount"],
      ["clips", 0, "sourceId"],
      ["segments", 0, "outPts"],
    ] as const) {
      expect(() => validateProjectDocument(remove(path)), path.join(".")).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a field of the wrong form", () => {
    for (const [path, value] of [
      [["schemaVersion"], 2],
      [["sources"], {}],
      [["sources", 0, "id"], 1],
      [["sources", 0, "size"], -1],
      [["sources", 0, "size"], 1.5],
      [["sources", 0, "mtime"], 9_007_199_254_740_992],
      [["sources", 0, "videoStreamIndex"], -1],
      [["sources", 0, "videoTimeBase"], { n: 0, d: 1 }],
      [["sources", 0, "videoStartPts"], "01"],
      [["sources", 0, "videoDurationTicks"], "-1"],
      [["sources", 0, "approximateDurationSeconds"], -1],
      [["sources", 0, "avgFrameRate"], { n: 30, d: 0 }],
      [["sources", 0, "reportedFrameCount"], 10],
      [["sources", 0, "relPath"], ""],
      [["sources", 0, "relPath"], "a//b.mp4"],
      [["sources", 0, "relPath"], "./a.mp4"],
      [["sources", 0, "relPath"], "/a.mp4"],
      [["sources", 0, "audioStreamIndex"], 1.5],
      [["sources", 0, "fingerprint"], { start: "0", fnv1a64: "9f3c5a7714e0b2d1" }],
      [
        ["sources", 0, "fingerprint"],
        { start: "1048576", fnv1a64: "9F3C5A7714E0B2D1" },
      ],
      [["clips", 0, "id"], null],
      [["segments", 0, "inPts"], 0],
      [["segments", 1, "name"], " Intro"],
      [["segments", 1, "name"], ""],
    ] as const) {
      expect(() => validateProjectDocument(set(path, value)), path.join(".")).toThrow(
        TypeError,
      );
    }
    expect(() => validateProjectDocument(null)).toThrow(TypeError);
    expect(() => validateProjectDocument([])).toThrow(TypeError);
  });
});

describe("the path text of a source (ADR 072)", () => {
  // The Rust test `path_texts_agree_with_the_shared_cases_of_the_frontend` reads the same cases,
  // so Rust never answers load_project with a path text that the page refuses.
  it("agrees with the shared cases for relPath", () => {
    expect(pathTextCases.relPath.length).toBeGreaterThanOrEqual(20);
    for (const { text, valid } of pathTextCases.relPath) {
      expect(isRelPathText(text), JSON.stringify(text)).toBe(valid);
      const document = set(["sources", 0, "relPath"], text);
      if (valid) {
        expect(validateProjectDocument(document).sources[0].relPath).toBe(text);
      } else {
        expect(() => validateProjectDocument(document), JSON.stringify(text)).toThrow(
          TypeError,
        );
      }
    }
  });

  it("agrees with the shared cases for path", () => {
    expect(pathTextCases.path.length).toBeGreaterThanOrEqual(4);
    for (const { text, valid } of pathTextCases.path) {
      expect(isSourcePathText(text), JSON.stringify(text)).toBe(valid);
      const answer = createLoadAnswer();
      (answer.project as { sources: Record<string, unknown>[] }).sources[0].path = text;
      answer.candidates = [[text], ["D:\\clips\\b.mkv"]];
      if (valid) {
        expect(validateLoadProjectResult(answer).project.sources[0].path).toBe(text);
      } else {
        expect(() => validateLoadProjectResult(answer), JSON.stringify(text)).toThrow(
          TypeError,
        );
      }
    }
  });
});

describe("validateLoadProjectResult", () => {
  it("accepts the answer of the backend", () => {
    const answer = createLoadAnswer();
    const result = validateLoadProjectResult(answer);
    expect(result).toEqual(answer);
    expect(result.candidates).not.toBe(answer.candidates);
  });

  it("accepts a relative candidate before the path", () => {
    const answer = createLoadAnswer();
    answer.candidates = [
      ["/Users/x/cut/../live.flv", "/Users/x/live.flv"],
      ["D:\\clips\\b.mkv"],
    ];
    expect(validateLoadProjectResult(answer).candidates[0]).toEqual([
      "/Users/x/cut/../live.flv",
      "/Users/x/live.flv",
    ]);
  });

  it("refuses an answer of the wrong shape", () => {
    const cases: Record<string, unknown>[] = [];
    const extra = createLoadAnswer();
    extra.extra = 1;
    cases.push(extra);
    const noPath = createLoadAnswer();
    delete noPath.path;
    cases.push(noPath);
    for (const path of ["", 3]) {
      cases.push({ ...createLoadAnswer(), path });
    }
    for (const candidates of [
      // One list for each source.
      [["/Users/x/live.flv"]],
      // Each list holds the path of its source, as its last path.
      [["/elsewhere/live.flv"], ["D:\\clips\\b.mkv"]],
      [["/Users/x/live.flv", "/Users/x/cut/../live.flv"], ["D:\\clips\\b.mkv"]],
      // No empty list, no repeated path, no empty path, at most two paths.
      [[], ["D:\\clips\\b.mkv"]],
      [["/Users/x/live.flv", "/Users/x/live.flv"], ["D:\\clips\\b.mkv"]],
      [["", "/Users/x/live.flv"], ["D:\\clips\\b.mkv"]],
      [["/a", "/b", "/Users/x/live.flv"], ["D:\\clips\\b.mkv"]],
      [[1], ["D:\\clips\\b.mkv"]],
      null,
    ]) {
      cases.push({ ...createLoadAnswer(), candidates });
    }
    cases.push({
      ...createLoadAnswer(),
      project: { ...createDocument(), schemaVersion: 2 },
    });
    for (const answer of cases) {
      expect(() => validateLoadProjectResult(answer)).toThrow(TypeError);
    }
    expect(() => validateLoadProjectResult(null)).toThrow(TypeError);
  });
});

describe("validateSaveProjectResult", () => {
  it("accepts exactly a non-empty path", () => {
    expect(validateSaveProjectResult({ path: "/Users/x/cut.qcproj" })).toEqual({
      path: "/Users/x/cut.qcproj",
    });
    for (const answer of [
      null,
      {},
      { path: "" },
      { path: 1 },
      { path: "/a", extra: 1 },
    ]) {
      expect(() => validateSaveProjectResult(answer)).toThrow(TypeError);
    }
  });
});
