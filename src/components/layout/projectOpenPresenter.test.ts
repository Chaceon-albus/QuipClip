import { describe, expect, it } from "vitest";
import { ImportMediaError, IMPORT_MEDIA_ERROR_CODES } from "@/features/media/types";
import type {
  OpenProjectError,
  OpenProjectState,
  OpenSourceRow,
} from "@/features/project/openStep";
import {
  PROJECT_COMMAND_ERROR_CODES,
  ProjectCommandError,
} from "@/features/project/types";
import { RECOVERY_ERROR_CODES, RecoveryCommandError } from "@/features/recovery/types";
import { createI18nInstance } from "@/i18n";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  DOCUMENT_REFUSED_MESSAGE_KEYS,
  PROJECT_LOAD_MESSAGE_KEYS,
  RECOVERY_READ_MESSAGE_KEYS,
  SEQUENCE_REFUSED_MESSAGE_KEYS,
  SOURCE_FACT_MESSAGE_KEYS,
  presentOpenError,
  presentOpenRow,
  presentProjectOpen,
} from "./projectOpenPresenter";

/** The text of `key` in `catalog`, or undefined when the catalog has no such text. */
function textOf(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

function expectInBothCatalogs(key: string): void {
  for (const catalog of [en, zhCN]) {
    const text = textOf(catalog, key);
    expect(typeof text, key).toBe("string");
    expect((text as string).trim(), key).not.toBe("");
  }
}

const MISSING: OpenSourceRow = {
  entryId: "e1",
  fileName: "a.mp4",
  documentPath: "/old/a.mp4",
  foundPath: null,
  failure: { kind: "absent" },
};

function state(
  phase: OpenProjectState["phase"],
  projectPath: string | null = null,
): OpenProjectState {
  return { phase, projectPath, mode: "open" };
}

describe("presentProjectOpen", () => {
  it("shows no dialog while the step is idle", () => {
    expect(presentProjectOpen(state({ kind: "idle" }))).toBeNull();
  });

  it("names the project file while the step reads it", () => {
    expect(presentProjectOpen(state({ kind: "loading" }, "/p/cut.qcproj"))).toEqual({
      kind: "loading",
      title: { key: "projectOpen.title" },
      message: { key: "projectOpen.loading", values: { name: "cut.qcproj" } },
    });
  });

  it("names no file in the read of a state with no path", () => {
    expect(presentProjectOpen(state({ kind: "loading" }))).toMatchObject({
      message: { key: "projectOpen.loadingNoName" },
    });
  });

  it("shows the count and the name of the file that the step checks", () => {
    expect(
      presentProjectOpen(
        state(
          {
            kind: "checking",
            stage: "sources",
            current: 2,
            total: 5,
            fileName: "b.mp4",
          },
          "/p/cut.qcproj",
        ),
      ),
    ).toEqual({
      kind: "checking",
      title: { key: "projectOpen.title" },
      message: {
        key: "projectOpen.checking",
        values: { current: 2, total: 5, name: "b.mp4" },
      },
      percent: 20,
    });
  });

  it("says that the last check reads each file again", () => {
    const view = presentProjectOpen(
      state({
        kind: "checking",
        stage: "revisions",
        current: 1,
        total: 1,
        fileName: "a.mp4",
      }),
    );
    expect(view).toMatchObject({
      message: { key: "projectOpen.checkingAgain" },
      percent: 0,
    });
  });

  it("lists the files to locate, with Open while the step allows it", () => {
    const found: OpenSourceRow = {
      entryId: "e2",
      fileName: "b.mp4",
      documentPath: "/old/b.mp4",
      foundPath: "/old/b.mp4",
      failure: null,
    };
    const view = presentProjectOpen(
      state({ kind: "locating", rows: [MISSING, found], busy: false, canOpen: false }),
    );
    expect(view).toMatchObject({
      kind: "locating",
      title: { key: "projectOpen.title" },
      message: { key: "projectOpen.locateIntro" },
      canOpen: false,
    });
    expect(
      view?.kind === "locating" ? view.rows.map((row) => row.entryId) : [],
    ).toEqual(["e1", "e2"]);
    expect(
      presentProjectOpen(
        state({ kind: "locating", rows: [found], busy: false, canOpen: true }),
      ),
    ).toMatchObject({
      canOpen: true,
      // The line above the list follows the rows.
      message: { key: "projectOpen.locateIntroAllFound" },
    });
  });

  it("makes Open and Locate unavailable while the step is busy", () => {
    const view = presentProjectOpen(
      state({ kind: "locating", rows: [MISSING], busy: true, canOpen: true }),
    );
    expect(view).toMatchObject({ canOpen: false });
    expect(view?.kind === "locating" ? view.rows[0]?.canLocate : null).toBe(false);
  });

  it("shows the error of a failed open, with its own title", () => {
    expect(
      presentProjectOpen(
        state({
          kind: "failed",
          error: { kind: "entriesDiffer", entryIds: ["e1", "e2"] },
        }),
      ),
    ).toEqual({
      kind: "failed",
      title: { key: "projectOpen.failedTitle" },
      message: { key: "projectOpen.error.entriesDiffer" },
      detail: null,
    });
  });
});

describe("presentOpenRow", () => {
  it("shows the name, the path of the document, the reason and Locate for a file that is absent", () => {
    expect(presentOpenRow(MISSING, false)).toEqual({
      entryId: "e1",
      fileName: "a.mp4",
      documentPath: {
        key: "projectOpen.row.documentPath",
        values: { path: "/old/a.mp4" },
      },
      status: {
        kind: "missing",
        reasons: [{ key: "projectOpen.reason.absent" }],
        detail: null,
      },
      showsLocate: true,
      canLocate: true,
      locateLabel: { key: "projectOpen.row.locateLabel", values: { name: "a.mp4" } },
    });
  });

  it("says that a file changed", () => {
    expect(
      presentOpenRow({ ...MISSING, failure: { kind: "changed" } }, false).status,
    ).toEqual({
      kind: "missing",
      reasons: [{ key: "projectOpen.reason.changed" }],
      detail: null,
    });
  });

  it("says that a file cannot be used, with the message of its import error and its detail", () => {
    const error = new ImportMediaError({
      code: "ffprobeProcessFailed",
      detail: "moov atom not found",
    });
    expect(
      presentOpenRow({ ...MISSING, failure: { kind: "importFailed", error } }, false)
        .status,
    ).toEqual({
      kind: "missing",
      reasons: [
        { key: "projectOpen.reason.unusable" },
        { key: "mediaError.ffprobeProcessFailed" },
      ],
      detail: "moov atom not found",
    });
  });

  it("names the fact of a file that does not read as the project says", () => {
    for (const fact of Object.keys(SOURCE_FACT_MESSAGE_KEYS) as Array<
      keyof typeof SOURCE_FACT_MESSAGE_KEYS
    >) {
      expect(
        presentOpenRow({ ...MISSING, failure: { kind: "readsOtherwise", fact } }, false)
          .status,
      ).toEqual({
        kind: "missing",
        reasons: [
          { key: "projectOpen.reason.unusable" },
          { key: SOURCE_FACT_MESSAGE_KEYS[fact] },
        ],
        detail: null,
      });
    }
  });

  it("shows a found file with no Locate, and its path only when it is another path", () => {
    const same = presentOpenRow(
      { ...MISSING, foundPath: "/old/a.mp4", failure: null },
      false,
    );
    expect(same.status).toEqual({
      kind: "found",
      message: { key: "projectOpen.row.found" },
    });
    expect(same.showsLocate).toBe(false);
    expect(same.canLocate).toBe(false);
    expect(
      presentOpenRow({ ...MISSING, foundPath: "/new/a.mp4", failure: null }, false)
        .status,
    ).toEqual({
      kind: "found",
      message: { key: "projectOpen.row.foundAt", values: { path: "/new/a.mp4" } },
    });
  });
});

describe("presentOpenError", () => {
  it("gives each code of load_project a message, and the text of the system as the detail", () => {
    for (const code of PROJECT_COMMAND_ERROR_CODES) {
      const view = presentOpenError({
        kind: "loadFailed",
        error: new ProjectCommandError({ code, detail: "os error 2" }),
      });
      expect(view.message).toEqual({ key: PROJECT_LOAD_MESSAGE_KEYS[code] });
      expect(view.detail).toBe("os error 2");
    }
  });

  it("puts the field of the document and its value in the detail, never in the sentence", () => {
    expect(
      presentOpenError({
        kind: "loadFailed",
        error: new ProjectCommandError({
          code: "unsafeProjectValue",
          field: "sources[0].size",
          value: "9007199254740993",
        }),
      }),
    ).toEqual({
      message: { key: "projectSaveError.write.unsafeProjectValue" },
      detail: "sources[0].size: 9007199254740993",
    });
    expect(
      presentOpenError({
        kind: "loadFailed",
        error: new ProjectCommandError({
          code: "invalidProject",
          field: "segments[2]",
        }),
      }).detail,
    ).toBe("segments[2]");
    expect(
      presentOpenError({
        kind: "loadFailed",
        error: new ProjectCommandError({ code: "invalidJson", detail: "  " }),
      }).detail,
    ).toBeNull();
  });

  it("gives each problem of the document and of the sequence a message", () => {
    for (const kind of Object.keys(DOCUMENT_REFUSED_MESSAGE_KEYS) as Array<
      keyof typeof DOCUMENT_REFUSED_MESSAGE_KEYS
    >) {
      const problem = { kind } as Extract<
        OpenProjectError,
        { kind: "documentRefused" }
      >["problem"];
      expect(presentOpenError({ kind: "documentRefused", problem })).toEqual({
        message: { key: DOCUMENT_REFUSED_MESSAGE_KEYS[kind] },
        detail: null,
      });
      expect(presentOpenError({ kind: "sequenceRefused", problem })).toEqual({
        message: { key: SEQUENCE_REFUSED_MESSAGE_KEYS[kind] },
        detail: null,
      });
    }
  });

  it("says that the files as they read now break the timeline, apart from the document", () => {
    expect(SEQUENCE_REFUSED_MESSAGE_KEYS.clipExtentUnknown).not.toBe(
      DOCUMENT_REFUSED_MESSAGE_KEYS.clipExtentUnknown,
    );
    expect(SEQUENCE_REFUSED_MESSAGE_KEYS.layoutFailed).not.toBe(
      DOCUMENT_REFUSED_MESSAGE_KEYS.layoutFailed,
    );
    expect(SEQUENCE_REFUSED_MESSAGE_KEYS.invalidSegment).not.toBe(
      DOCUMENT_REFUSED_MESSAGE_KEYS.invalidSegment,
    );
  });

  it("gives each code of read_recovery a message, and the text of the system as the detail", () => {
    for (const code of RECOVERY_ERROR_CODES) {
      const view = presentOpenError({
        kind: "recoveryReadFailed",
        status: "failed",
        error: new RecoveryCommandError({ code, detail: "os error 5" }),
      });
      expect(view.message).toEqual({ key: RECOVERY_READ_MESSAGE_KEYS[code] });
      expect(view.detail).toBe("os error 5");
    }
  });

  it("says that the recovery file was not found, or that it cannot be read (ADR 073)", () => {
    expect(
      presentOpenError({
        kind: "recoveryReadFailed",
        status: "failed",
        error: new RecoveryCommandError({ code: "offerNotFound" }),
      }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.notFound" },
      detail: null,
    });
    expect(
      presentOpenError({
        kind: "recoveryReadFailed",
        status: "failed",
        error: new RecoveryCommandError({ code: "readFailed", detail: "EIO" }),
      }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.readFailed" },
      detail: "EIO",
    });
  });

  it("says that the version of the recovery file is absent or not read (ADR 073)", async () => {
    expect(
      presentOpenError({
        kind: "recoveryReadFailed",
        status: "failed",
        error: new RecoveryCommandError({ code: "unsupportedRecoveryVersion" }),
      }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.unsupportedVersion" },
      detail: null,
    });
    const english = await createI18nInstance({
      initialPreference: "en",
      storage: null,
    });
    const chinese = await createI18nInstance({
      initialPreference: "zh-CN",
      storage: null,
    });
    expect(english.t("projectOpen.error.recovery.unsupportedVersion")).toBe(
      "The recovery file has no version, or it has a version that this version of QuipClip does not read.",
    );
    expect(chinese.t("projectOpen.error.recovery.unsupportedVersion")).toBe(
      "恢复文件缺少版本信息，或者其版本不受此版本的 QuipClip 支持。",
    );
  });

  it("puts the field of a document that is not valid in the detail of a recovery file", () => {
    expect(
      presentOpenError({
        kind: "recoveryReadFailed",
        status: "failed",
        error: new RecoveryCommandError({
          code: "invalidRecoveryFile",
          project: new ProjectCommandError({
            code: "invalidProject",
            field: "clips[0].sourceId",
            value: "x",
          }),
        }),
      }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.invalidFile" },
      detail: "clips[0].sourceId: x",
    });
  });

  it("gives a process that is not the owner and a session that ended a message each", () => {
    expect(
      presentOpenError({ kind: "recoveryReadFailed", status: "notOwner", error: null }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.notOwner" },
      detail: null,
    });
    expect(
      presentOpenError({
        kind: "recoveryReadFailed",
        status: "staleSession",
        error: null,
      }),
    ).toEqual({
      message: { key: "projectOpen.error.recovery.staleSession" },
      detail: null,
    });
    // A failure with no error, which the open step never gives, has the message of an unknown
    // error.
    expect(
      presentOpenError({ kind: "recoveryReadFailed", status: "failed", error: null }),
    ).toEqual({ message: { key: "projectOpen.error.load.unknown" }, detail: null });
  });
});

describe("presentProjectOpen for a restore (ADR 073)", () => {
  function restoreState(
    phase: OpenProjectState["phase"],
    projectPath: string | null = null,
  ): OpenProjectState {
    return { phase, projectPath, mode: "restore" };
  }

  it("has the title of a restore, and reads the recovery file with or without a name", () => {
    for (const path of [null, "/p/cut.qcproj"]) {
      expect(presentProjectOpen(restoreState({ kind: "loading" }, path))).toEqual({
        kind: "loading",
        title: { key: "projectOpen.restoreTitle" },
        message: { key: "projectOpen.restoreLoading" },
      });
    }
  });

  it("keeps the title of a restore while it checks and while it lists the files", () => {
    expect(
      presentProjectOpen(
        restoreState({
          kind: "checking",
          stage: "sources",
          current: 1,
          total: 2,
          fileName: "a.mp4",
        }),
      ),
    ).toMatchObject({ title: { key: "projectOpen.restoreTitle" } });
    expect(
      presentProjectOpen(
        restoreState({
          kind: "locating",
          rows: [MISSING],
          busy: false,
          canOpen: false,
        }),
      ),
    ).toMatchObject({
      title: { key: "projectOpen.restoreTitle" },
      message: { key: "projectOpen.locateIntro" },
    });
  });

  it("shows the error of a restore with its own title", () => {
    expect(
      presentProjectOpen(
        restoreState({
          kind: "failed",
          error: {
            kind: "recoveryReadFailed",
            status: "failed",
            error: new RecoveryCommandError({ code: "offerNotFound" }),
          },
        }),
      ),
    ).toEqual({
      kind: "failed",
      title: { key: "projectOpen.restoreFailedTitle" },
      message: { key: "projectOpen.error.recovery.notFound" },
      detail: null,
    });
  });
});

describe("the catalog messages of the project dialog", () => {
  it("has each key of the presenter in both catalogs", () => {
    const keys = [
      ...Object.values(PROJECT_LOAD_MESSAGE_KEYS),
      ...Object.values(DOCUMENT_REFUSED_MESSAGE_KEYS),
      ...Object.values(SEQUENCE_REFUSED_MESSAGE_KEYS),
      ...Object.values(SOURCE_FACT_MESSAGE_KEYS),
      ...Object.values(RECOVERY_READ_MESSAGE_KEYS),
      ...IMPORT_MEDIA_ERROR_CODES.map((code) => `mediaError.${code}`),
      "projectOpen.title",
      "projectOpen.failedTitle",
      "projectOpen.restoreTitle",
      "projectOpen.restoreFailedTitle",
      "projectOpen.restoreLoading",
      "projectOpen.error.recovery.notOwner",
      "projectOpen.error.recovery.staleSession",
      "projectOpen.loading",
      "projectOpen.loadingNoName",
      "projectOpen.checking",
      "projectOpen.checkingAgain",
      "projectOpen.locateIntro",
      "projectOpen.locateIntroAllFound",
      "projectOpen.locate",
      "projectOpen.open",
      "projectOpen.details.show",
      "projectOpen.details.hide",
      "projectOpen.row.documentPath",
      "projectOpen.row.found",
      "projectOpen.row.foundAt",
      "projectOpen.row.locateLabel",
      "projectOpen.reason.absent",
      "projectOpen.reason.changed",
      "projectOpen.reason.unusable",
      "projectOpen.error.entriesDiffer",
    ];
    for (const key of keys) {
      expectInBothCatalogs(key);
    }
  });

  it("renders the progress and a row in English and in Chinese", async () => {
    const english = await createI18nInstance({
      initialPreference: "en",
      storage: null,
    });
    const chinese = await createI18nInstance({
      initialPreference: "zh-CN",
      storage: null,
    });
    const values = { current: 2, total: 5, name: "b.mp4" };
    expect(english.t("projectOpen.checking", values)).toBe(
      "Checking file 2 of 5: “b.mp4”",
    );
    expect(chinese.t("projectOpen.checking", values)).toBe(
      "正在检查第 2 个文件（共 5 个）：“b.mp4”",
    );
    expect(english.t("projectOpen.title")).toBe("Open Project");
    expect(chinese.t("projectOpen.title")).toBe("打开项目");
    expect(english.t("projectOpen.locate")).toBe("Locate…");
    // The texts of a restore (ADR 073).
    expect(english.t("projectOpen.restoreTitle")).toBe("Restore Project");
    expect(chinese.t("projectOpen.restoreTitle")).toBe("恢复项目");
    expect(english.t("projectOpen.error.recovery.notFound")).toBe(
      "QuipClip did not find the recovery file.",
    );
    expect(chinese.t("projectOpen.error.recovery.notFound")).toBe("未找到恢复文件。");
  });
});
