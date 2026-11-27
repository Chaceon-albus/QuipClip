import { describe, expect, it } from "vitest";
import { ProjectCommandError } from "@/features/project/types";
import type { Project } from "@/types/project";
import { RecoveryCommandError } from "./types";
import {
  isRecoveryOfferId,
  normalizeRecoveryCommandError,
  validateRecoveryChangeResult,
  validateRecoveryDiscardResult,
  validateRecoveryListResult,
  validateRecoveryReadResult,
  validateRecoveryStartResult,
} from "./validation";

function source(path: string, id = "s1") {
  return {
    id,
    path,
    size: 100,
    mtime: 1_700_000_000,
    videoStreamIndex: 0,
    videoTimeBase: { n: 1, d: 90_000 },
    videoStartPts: "0",
    videoEndPts: "900000",
    videoDurationTicks: "900000",
    approximateDurationSeconds: 10,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    reportedFrameCount: "300",
  };
}

function document(sources = [source("/clips/a.mp4")]) {
  return {
    schemaVersion: 1,
    sources,
    clips: [{ id: "c1", sourceId: "s1" }],
    segments: [
      { id: "g1", inClipId: "c1", inPts: "10", outClipId: "c1", outPts: "20" },
    ],
  };
}

describe("recovery answer validation", () => {
  it("knows the form of an offer id", () => {
    expect(isRecoveryOfferId("0123456789abcdef")).toBe(true);
    for (const id of ["0123456789ABCDEF", "0123456789abcde", "../x", 5, null]) {
      expect(isRecoveryOfferId(id)).toBe(false);
    }
  });

  it("validates the token of start_recovery", () => {
    expect(validateRecoveryStartResult({ token: "12" })).toEqual({ token: "12" });
    for (const value of [
      { token: 12 },
      { token: "" },
      { token: "a1" },
      {},
      null,
      "12",
    ]) {
      expect(() => validateRecoveryStartResult(value)).toThrow(TypeError);
    }
    expect(() => validateRecoveryStartResult({ token: "1", extra: 1 })).toThrow(
      TypeError,
    );
  });

  it("validates each consistent change answer", () => {
    const cases = [
      { owner: true, status: "done", current: "written" },
      { owner: true, status: "done", current: "nothing" },
      { owner: false, status: "notOwner", current: "notKnown" },
      { owner: true, status: "staleSession", current: "notKnown" },
      { owner: false, status: "staleSession", current: "notKnown" },
      {
        owner: true,
        status: "failed",
        current: "notKnown",
        error: { code: "writeFailed", detail: "Permission denied (os error 13)" },
      },
      {
        owner: true,
        status: "failed",
        current: "written",
        error: { code: "removeFailed" },
      },
      {
        owner: false,
        status: "failed",
        current: "notKnown",
        error: { code: "commandExecutionFailed" },
      },
      {
        owner: false,
        status: "failed",
        current: "notKnown",
        error: { code: "missingRestoreState" },
      },
    ];
    for (const value of cases) {
      const result = validateRecoveryChangeResult(value);
      expect(result.owner).toBe(value.owner);
      expect(result.status).toBe(value.status);
      expect(result.current).toBe(value.current);
      expect(result.error === undefined).toBe(value.error === undefined);
    }
    const failed = validateRecoveryChangeResult(cases[5]);
    expect(failed.error).toBeInstanceOf(RecoveryCommandError);
    expect(failed.error).toMatchObject({
      code: "writeFailed",
      detail: "Permission denied (os error 13)",
    });
  });

  it("validates a refused document with its project error", () => {
    const result = validateRecoveryChangeResult({
      owner: true,
      status: "refused",
      current: "nothing",
      error: {
        code: "documentRefused",
        project: { code: "invalidProject", field: "segments[0]" },
      },
    });
    expect(result.status).toBe("refused");
    expect(result.error?.code).toBe("documentRefused");
    expect(result.error?.project).toBeInstanceOf(ProjectCommandError);
    expect(result.error?.project).toMatchObject({
      code: "invalidProject",
      field: "segments[0]",
    });

    // A refused document whose removal failed answers notKnown.
    expect(
      validateRecoveryChangeResult({
        owner: true,
        status: "refused",
        current: "notKnown",
        error: {
          code: "documentRefused",
          project: {
            code: "futureSchemaVersion",
            foundSchemaVersion: 2,
            supportedSchemaVersion: 1,
          },
        },
      }).error?.project?.foundSchemaVersion,
    ).toBe(2);
  });

  it("refuses a change answer that is not consistent or not of its shape", () => {
    const invalid: unknown[] = [
      null,
      {},
      { owner: "yes", status: "done", current: "written" },
      { owner: true, status: "finished", current: "written" },
      { owner: true, status: "done", current: "maybe" },
      { owner: true, status: "done", current: "written", extra: 1 },
      // notOwner with the owner bit, or with a known file.
      { owner: true, status: "notOwner", current: "notKnown" },
      { owner: false, status: "notOwner", current: "nothing" },
      // A command that changed nothing cannot know the file.
      { owner: true, status: "staleSession", current: "written" },
      // done knows the file, and has the owner.
      { owner: true, status: "done", current: "notKnown" },
      { owner: false, status: "done", current: "nothing" },
      // An error comes exactly with refused and failed.
      { owner: true, status: "failed", current: "notKnown" },
      {
        owner: true,
        status: "done",
        current: "written",
        error: { code: "writeFailed" },
      },
      // refused needs documentRefused with a project error, and does not answer written.
      {
        owner: true,
        status: "refused",
        current: "nothing",
        error: { code: "writeFailed" },
      },
      {
        owner: true,
        status: "refused",
        current: "nothing",
        error: { code: "documentRefused" },
      },
      {
        owner: true,
        status: "refused",
        current: "written",
        error: { code: "documentRefused", project: { code: "tooLarge" } },
      },
      // Unknown codes and error fields.
      { owner: true, status: "failed", current: "notKnown", error: { code: "boom" } },
      {
        owner: true,
        status: "failed",
        current: "notKnown",
        error: { code: "writeFailed", message: "x" },
      },
      {
        owner: true,
        status: "failed",
        current: "notKnown",
        error: { code: "writeFailed", project: { code: "invalidProject" } },
      },
      {
        owner: true,
        status: "refused",
        current: "nothing",
        error: { code: "documentRefused", project: { code: "nope" } },
      },
    ];
    for (const value of invalid) {
      expect(() => validateRecoveryChangeResult(value), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });

  it("validates a list answer", () => {
    const result = validateRecoveryListResult({
      owner: true,
      status: "done",
      complete: true,
      offers: [
        { id: "00000000000000b2", writtenAtMs: 3_000_000, projectPath: null },
        { id: "00000000000000a1", writtenAtMs: 1_000_000, projectPath: "/old.qcproj" },
      ],
    });
    expect(result).toEqual({
      owner: true,
      status: "done",
      complete: true,
      offers: [
        { id: "00000000000000b2", writtenAtMs: 3_000_000, projectPath: null },
        { id: "00000000000000a1", writtenAtMs: 1_000_000, projectPath: "/old.qcproj" },
      ],
    });

    const partial = validateRecoveryListResult({
      owner: true,
      status: "failed",
      complete: false,
      offers: [{ id: "00000000000000a1", writtenAtMs: 1, projectPath: null }],
      error: { code: "readFailed" },
    });
    expect(partial.offers).toHaveLength(1);
    expect(partial.error?.code).toBe("readFailed");

    expect(
      validateRecoveryListResult({
        owner: false,
        status: "notOwner",
        complete: false,
        offers: [],
      }).complete,
    ).toBe(false);
  });

  it("refuses a list answer that is not consistent or not of its shape", () => {
    const offer = { id: "00000000000000a1", writtenAtMs: 1, projectPath: null };
    const invalid: unknown[] = [
      { owner: true, status: "done", complete: false, offers: [] },
      {
        owner: true,
        status: "failed",
        complete: true,
        offers: [],
        error: { code: "readFailed" },
      },
      { owner: true, status: "refused", complete: false, offers: [] },
      { owner: false, status: "notOwner", complete: false, offers: [offer] },
      { owner: true, status: "done", complete: true, offers: [offer, offer] },
      { owner: true, status: "done", complete: true, offers: [{ ...offer, id: "x" }] },
      {
        owner: true,
        status: "done",
        complete: true,
        offers: [{ ...offer, writtenAtMs: -1 }],
      },
      {
        owner: true,
        status: "done",
        complete: true,
        offers: [{ ...offer, writtenAtMs: 1.5 }],
      },
      {
        owner: true,
        status: "done",
        complete: true,
        offers: [{ ...offer, projectPath: 3 }],
      },
      { owner: true, status: "done", complete: true, offers: [{ ...offer, extra: 1 }] },
      { owner: true, status: "done", complete: true, offers: {} },
    ];
    for (const value of invalid) {
      expect(() => validateRecoveryListResult(value), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });

  it("validates a read answer with one candidate for each source", () => {
    const project = document([source("/clips/a.mp4"), source("/clips/b.mp4", "s2")]);
    const result = validateRecoveryReadResult({
      owner: true,
      status: "done",
      offer: {
        projectPath: "/Cuts/Stream.qcproj",
        project,
        candidates: [["/clips/a.mp4"], ["/clips/b.mp4"]],
      },
    });
    expect(result.offer?.projectPath).toBe("/Cuts/Stream.qcproj");
    expect(result.offer?.project).toEqual(project as unknown as Project);
    expect(result.offer?.candidates).toEqual([["/clips/a.mp4"], ["/clips/b.mp4"]]);

    const failed = validateRecoveryReadResult({
      owner: true,
      status: "failed",
      error: {
        code: "invalidRecoveryFile",
        project: { code: "invalidProject", field: "segments[0]" },
      },
    });
    expect(failed.offer).toBeUndefined();
    expect(failed.error?.project?.field).toBe("segments[0]");
  });

  it("refuses a read answer that is not consistent or not of its shape", () => {
    const offer = {
      projectPath: null,
      project: document(),
      candidates: [["/clips/a.mp4"]],
    };
    const invalid: unknown[] = [
      { owner: true, status: "done" },
      { owner: true, status: "failed", offer, error: { code: "readFailed" } },
      { owner: true, status: "done", offer: { ...offer, candidates: [] } },
      {
        owner: true,
        status: "done",
        offer: { ...offer, candidates: [["/other.mp4"]] },
      },
      {
        owner: true,
        status: "done",
        offer: { ...offer, candidates: [["/x/a.mp4", "/clips/a.mp4"]] },
      },
      { owner: true, status: "done", offer: { ...offer, projectPath: 1 } },
      {
        owner: true,
        status: "done",
        offer: {
          ...offer,
          project: document([{ ...source("/clips/a.mp4"), relPath: "a.mp4" } as never]),
        },
      },
      {
        owner: true,
        status: "done",
        offer: { ...offer, project: { schemaVersion: 1 } },
      },
      {
        owner: true,
        status: "refused",
        error: { code: "documentRefused", project: { code: "tooLarge" } },
      },
    ];
    for (const value of invalid) {
      expect(() => validateRecoveryReadResult(value), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });

  it("validates a discard answer", () => {
    expect(validateRecoveryDiscardResult({ owner: true, status: "done" })).toEqual({
      owner: true,
      status: "done",
    });
    expect(
      validateRecoveryDiscardResult({
        owner: true,
        status: "failed",
        error: { code: "invalidOfferId" },
      }).error?.code,
    ).toBe("invalidOfferId");
    for (const value of [
      { owner: true, status: "failed" },
      { owner: true, status: "notOwner" },
      { owner: false, status: "done" },
      { owner: true, status: "done", extra: true },
    ]) {
      expect(() => validateRecoveryDiscardResult(value)).toThrow(TypeError);
    }
  });

  it("normalizes a rejection with no English sentence of the page", () => {
    expect(normalizeRecoveryCommandError("invalid args `token`")).toMatchObject({
      code: "unknown",
      detail: "invalid args `token`",
    });
    expect(
      normalizeRecoveryCommandError({ code: "readFailed", detail: "x" }),
    ).toMatchObject({
      code: "readFailed",
      detail: "x",
    });
    expect(normalizeRecoveryCommandError({ code: "nope" }).code).toBe("unknown");
    const local = normalizeRecoveryCommandError(new TypeError("Invalid shape"));
    expect(local.code).toBe("unknown");
    expect(local.detail).toBeUndefined();
    const known = new RecoveryCommandError({ code: "offerNotFound" });
    expect(normalizeRecoveryCommandError(known)).toBe(known);
  });
});
