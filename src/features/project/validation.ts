/**
 * Strict validation of the answers of `load_project` and `save_project`, and normalization of
 * their rejections (ADR 010, ADR 072).
 *
 * An answer of the wrong shape throws a `TypeError`. Each function builds new objects that list
 * every field, so an unknown field of the payload never reaches the page.
 */

import { isFrameCountString, isPtsString, isTickCountString } from "@/lib/time";
import {
  isNonNegativeU32,
  isPositiveRational,
  isSignedRational,
} from "@/features/media/validation";
import { isValidSegmentName } from "@/features/timeline/segmentName";
import {
  PROJECT_SCHEMA_VERSION,
  isSourceFingerprint,
  isValidAudioStreamIndex,
  type Clip,
  type PersistedSource,
  type Project,
  type Rational,
  type SequenceSegment,
} from "@/types/project";
import {
  BACKEND_PROJECT_COMMAND_ERROR_CODES,
  PROJECT_COMMAND_ERROR_CODES,
  ProjectCommandError,
  type BackendProjectCommandErrorCode,
  type LoadProjectResult,
  type ProjectCommandErrorCode,
  type SaveProjectResult,
} from "./types";

/** Checks whether an unknown value is an error code of the Rust project commands. */
export function isBackendProjectCommandErrorCode(
  value: unknown,
): value is BackendProjectCommandErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_PROJECT_COMMAND_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Checks whether an unknown value is an error code of a project command. */
export function isProjectCommandErrorCode(
  value: unknown,
): value is ProjectCommandErrorCode {
  return (
    typeof value === "string" &&
    (PROJECT_COMMAND_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** A non-negative safe integer, as a schema version of the error payload. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Normalizes a rejection of a project command into a `ProjectCommandError`.
 *
 * The code is a known code or `unknown`. Each optional fact is kept only when it has the type of
 * the Rust payload. A local `Error`, such as the `TypeError` of a malformed answer, becomes
 * `unknown` with no detail, so no English sentence of the page reaches the interface.
 */
export function normalizeProjectCommandError(error: unknown): ProjectCommandError {
  if (error instanceof ProjectCommandError) {
    return error;
  }
  if (typeof error === "object" && error !== null && !(error instanceof Error)) {
    const candidate = error as Record<string, unknown>;
    return new ProjectCommandError({
      code: isProjectCommandErrorCode(candidate.code) ? candidate.code : "unknown",
      detail: typeof candidate.detail === "string" ? candidate.detail : undefined,
      field: typeof candidate.field === "string" ? candidate.field : undefined,
      value: typeof candidate.value === "string" ? candidate.value : undefined,
      foundSchemaVersion: isSafeNonNegativeInteger(candidate.foundSchemaVersion)
        ? candidate.foundSchemaVersion
        : undefined,
      supportedSchemaVersion: isSafeNonNegativeInteger(candidate.supportedSchemaVersion)
        ? candidate.supportedSchemaVersion
        : undefined,
    });
  }
  if (typeof error === "string" && error.length > 0) {
    return new ProjectCommandError({ code: "unknown", detail: error });
  }
  return new ProjectCommandError({ code: "unknown" });
}

/** The record of a plain object, or null for another value. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * True when `record` has each key of `required`, and no key outside `required` and `optional`,
 * as the Rust types with `deny_unknown_fields` read a document.
 */
function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => key in record) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function fail(message: string): never {
  throw new TypeError(`Invalid project command result: ${message}`);
}

function copyRational(value: Rational): Rational {
  return { n: value.n, d: value.d };
}

/**
 * True when `value` has the form of a `relPath` (ADR 072), by the rule of the Rust project module
 * on every host: parts with `/` between them, zero or more `..` parts first and then one or more
 * names. A name is not empty, not `.` and not `..`. The text has no NUL, and its first part does
 * not have the form of a drive (an ASCII letter and `:`). The backend refuses more on Windows,
 * such as a backslash, so each text that it loads passes here.
 */
export function isRelPathText(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const parts = value.split("/");
  let first = 0;
  while (first < parts.length && parts[first] === "..") {
    first += 1;
  }
  const names = parts.slice(first);
  return (
    names.length > 0 &&
    names.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/**
 * True when `value` is a path text that a document can hold for a source: a string that is not
 * empty and has no NUL, as the Rust project module reads it (ADR 072).
 */
export function isSourcePathText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

const SOURCE_REQUIRED_KEYS = [
  "id",
  "path",
  "size",
  "mtime",
  "videoStreamIndex",
  "videoTimeBase",
  "videoStartPts",
  "videoEndPts",
  "videoDurationTicks",
  "approximateDurationSeconds",
  "avgFrameRate",
  "rFrameRate",
  "reportedFrameCount",
] as const;
const SOURCE_OPTIONAL_KEYS = ["relPath", "audioStreamIndex", "fingerprint"] as const;

function validateSource(value: unknown, index: number): PersistedSource {
  const s = asRecord(value);
  if (s === null || !hasExactKeys(s, SOURCE_REQUIRED_KEYS, SOURCE_OPTIONAL_KEYS)) {
    fail(`sources[${index}] must have exactly the fields of a persisted source`);
  }
  if (typeof s.id !== "string" || !isSourcePathText(s.path)) {
    fail(
      `sources[${index}].id must be a string, and path a non-empty string with no NUL`,
    );
  }
  const { size, mtime } = s;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mtime !== "number" ||
    !Number.isSafeInteger(mtime)
  ) {
    fail(`sources[${index}].size and mtime must be safe integers`);
  }
  if (!isNonNegativeU32(s.videoStreamIndex)) {
    fail(`sources[${index}].videoStreamIndex must be a u32`);
  }
  if (!isPositiveRational(s.videoTimeBase)) {
    fail(`sources[${index}].videoTimeBase must be a positive rational`);
  }
  if (s.videoStartPts !== null && !isPtsString(s.videoStartPts)) {
    fail(`sources[${index}].videoStartPts must be a PTS or null`);
  }
  if (s.videoEndPts !== null && !isPtsString(s.videoEndPts)) {
    fail(`sources[${index}].videoEndPts must be a PTS or null`);
  }
  if (s.videoDurationTicks !== null && !isTickCountString(s.videoDurationTicks)) {
    fail(`sources[${index}].videoDurationTicks must be a tick count or null`);
  }
  const duration = s.approximateDurationSeconds;
  if (
    duration !== null &&
    (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
  ) {
    fail(
      `sources[${index}].approximateDurationSeconds must be a finite number or null`,
    );
  }
  if (s.avgFrameRate !== null && !isPositiveRational(s.avgFrameRate)) {
    fail(`sources[${index}].avgFrameRate must be a positive rational or null`);
  }
  if (s.rFrameRate !== null && !isPositiveRational(s.rFrameRate)) {
    fail(`sources[${index}].rFrameRate must be a positive rational or null`);
  }
  if (s.reportedFrameCount !== null && !isFrameCountString(s.reportedFrameCount)) {
    fail(`sources[${index}].reportedFrameCount must be a frame count or null`);
  }
  if ("relPath" in s && !isRelPathText(s.relPath)) {
    fail(`sources[${index}].relPath must be a relative path`);
  }
  if ("audioStreamIndex" in s && !isValidAudioStreamIndex(s.audioStreamIndex)) {
    fail(`sources[${index}].audioStreamIndex must be a u32`);
  }
  if ("fingerprint" in s && !isSourceFingerprint(s.fingerprint, size)) {
    fail(`sources[${index}].fingerprint must be a fingerprint of the revision`);
  }

  const source: PersistedSource = {
    id: s.id,
    path: s.path,
    size,
    mtime,
    videoStreamIndex: s.videoStreamIndex,
    videoTimeBase: copyRational(s.videoTimeBase),
    videoStartPts: s.videoStartPts,
    videoEndPts: s.videoEndPts,
    videoDurationTicks: s.videoDurationTicks,
    approximateDurationSeconds: duration,
    avgFrameRate: isSignedRational(s.avgFrameRate)
      ? copyRational(s.avgFrameRate)
      : null,
    rFrameRate: isSignedRational(s.rFrameRate) ? copyRational(s.rFrameRate) : null,
    reportedFrameCount: s.reportedFrameCount,
  };
  if (isRelPathText(s.relPath)) {
    source.relPath = s.relPath;
  }
  if (isValidAudioStreamIndex(s.audioStreamIndex)) {
    source.audioStreamIndex = s.audioStreamIndex;
  }
  if (isSourceFingerprint(s.fingerprint, size)) {
    source.fingerprint = { start: s.fingerprint.start, fnv1a64: s.fingerprint.fnv1a64 };
  }
  return source;
}

function validateClip(value: unknown, index: number): Clip {
  const c = asRecord(value);
  if (
    c === null ||
    !hasExactKeys(c, ["id", "sourceId"]) ||
    typeof c.id !== "string" ||
    typeof c.sourceId !== "string"
  ) {
    fail(`clips[${index}] must have exactly a string id and a string sourceId`);
  }
  return { id: c.id, sourceId: c.sourceId };
}

function validateSegment(value: unknown, index: number): SequenceSegment {
  const g = asRecord(value);
  if (
    g === null ||
    !hasExactKeys(g, ["id", "inClipId", "inPts", "outClipId", "outPts"], ["name"])
  ) {
    fail(`segments[${index}] must have exactly the fields of a segment`);
  }
  if (
    typeof g.id !== "string" ||
    typeof g.inClipId !== "string" ||
    typeof g.outClipId !== "string" ||
    !isPtsString(g.inPts) ||
    !isPtsString(g.outPts)
  ) {
    fail(`segments[${index}] must have string ids and PTS edit points`);
  }
  if ("name" in g && (typeof g.name !== "string" || !isValidSegmentName(g.name))) {
    fail(`segments[${index}].name must be a valid segment name`);
  }
  const segment: SequenceSegment = {
    id: g.id,
    inClipId: g.inClipId,
    inPts: g.inPts,
    outClipId: g.outClipId,
    outPts: g.outPts,
  };
  if (typeof g.name === "string") {
    segment.name = g.name;
  }
  return segment;
}

/**
 * Validates the shape of a project document of schema version 1 (ADR 010, ADR 052, ADR 072) and
 * returns a new copy of it. It checks the form of each field, not the rules of the sequence: the
 * backend validated those at load, and the page applies its own rules of the sequence later.
 */
export function validateProjectDocument(value: unknown): Project {
  const p = asRecord(value);
  if (
    p === null ||
    !hasExactKeys(p, ["schemaVersion", "sources", "clips", "segments"])
  ) {
    fail("project must have exactly schemaVersion, sources, clips and segments");
  }
  if (p.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    fail(`project.schemaVersion must be ${PROJECT_SCHEMA_VERSION}`);
  }
  if (
    !Array.isArray(p.sources) ||
    !Array.isArray(p.clips) ||
    !Array.isArray(p.segments)
  ) {
    fail("project.sources, clips and segments must be arrays");
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sources: p.sources.map((source, index) => validateSource(source, index)),
    clips: p.clips.map((clip, index) => validateClip(clip, index)),
    segments: p.segments.map((segment, index) => validateSegment(segment, index)),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates an answer of `load_project`: the canonical path, the document, and one list of
 * candidates for each source. Each list has one or two different paths, and its last path is the
 * `path` of its source: the relative candidate comes first.
 */
export function validateLoadProjectResult(value: unknown): LoadProjectResult {
  const r = asRecord(value);
  if (r === null || !hasExactKeys(r, ["path", "project", "candidates"])) {
    fail("load answer must have exactly path, project and candidates");
  }
  if (!isNonEmptyString(r.path)) {
    fail("load answer path must be a non-empty string");
  }
  const project = validateProjectDocument(r.project);
  const candidates = r.candidates;
  if (!Array.isArray(candidates) || candidates.length !== project.sources.length) {
    fail("load answer must have one list of candidates for each source");
  }
  const lists = candidates.map((list: unknown, index) => {
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > 2 ||
      !list.every(isNonEmptyString) ||
      new Set(list).size !== list.length ||
      list[list.length - 1] !== project.sources[index].path
    ) {
      fail(
        `candidates[${index}] must be one or two different paths that end with the source path`,
      );
    }
    return [...list];
  });
  return { path: r.path, project, candidates: lists };
}

/** Validates an answer of `save_project`: the canonical path of the written file. */
export function validateSaveProjectResult(value: unknown): SaveProjectResult {
  const r = asRecord(value);
  if (r === null || !hasExactKeys(r, ["path"]) || !isNonEmptyString(r.path)) {
    fail("save answer must have exactly a non-empty string path");
  }
  return { path: r.path };
}
