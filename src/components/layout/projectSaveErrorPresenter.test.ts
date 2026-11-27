import { describe, expect, it } from "vitest";
import type { ProjectSaveError } from "@/features/project/saveStep";
import {
  PROJECT_COMMAND_ERROR_CODES,
  ProjectCommandError,
} from "@/features/project/types";
import { createI18nInstance } from "@/i18n";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  PROJECT_SAVE_ERROR_TITLE_KEY,
  PROJECT_SAVE_WRITE_MESSAGE_KEYS,
  presentProjectSaveError,
} from "./projectSaveErrorPresenter";

/** Walks a dotted key through a catalog, the way i18next resolves it. */
function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

/** One error of each kind, and one of each problem that has its own message. */
const ERRORS: readonly ProjectSaveError[] = [
  { kind: "noClip" },
  { kind: "dialogFailed", error: new Error("plugin") },
  { kind: "invalidName", path: "/p/cut.txt" },
  { kind: "missingSource", sourceId: "a" },
  {
    kind: "documentRefused",
    problem: { kind: "clipExtentUnknown", clipId: "c1", sourceId: "a" },
    fileName: "clip.webm",
  },
  {
    kind: "documentRefused",
    problem: { kind: "layoutFailed" },
    fileName: null,
  },
  ...PROJECT_COMMAND_ERROR_CODES.map((code): ProjectSaveError => ({
    kind: "writeFailed",
    error: new ProjectCommandError({ code }),
  })),
];

describe("presentProjectSaveError", () => {
  it("gives each kind and each code of the write a message of both catalogs", () => {
    for (const error of ERRORS) {
      const { message } = presentProjectSaveError(error);
      for (const catalog of [en, zhCN]) {
        const text = lookup(catalog, message.key);
        expect(typeof text, message.key).toBe("string");
        expect(text).not.toBe("");
      }
    }
    for (const catalog of [en, zhCN]) {
      expect(typeof lookup(catalog, PROJECT_SAVE_ERROR_TITLE_KEY)).toBe("string");
      // One message for each code, and no other.
      expect(Object.keys(catalog.projectSaveError.write).sort()).toEqual(
        [...PROJECT_COMMAND_ERROR_CODES].sort(),
      );
    }
    expect(Object.keys(PROJECT_SAVE_WRITE_MESSAGE_KEYS).sort()).toEqual(
      [...PROJECT_COMMAND_ERROR_CODES].sort(),
    );
  });

  it("names the file of a clip with no length (ADR 072, Save step 2)", () => {
    expect(
      presentProjectSaveError({
        kind: "documentRefused",
        problem: { kind: "clipExtentUnknown", clipId: "c1", sourceId: "a" },
        fileName: "clip.webm",
      }),
    ).toEqual({
      message: {
        key: "projectSaveError.clipExtentUnknown",
        values: { fileName: "clip.webm" },
      },
      detail: null,
    });
    // Another problem of the document has the general message.
    expect(
      presentProjectSaveError({
        kind: "documentRefused",
        problem: { kind: "duplicateClip", clipId: "c1" },
        fileName: null,
      }).message,
    ).toEqual({ key: "projectSaveError.documentRefused" });
  });

  it("says that the name must end in .qcproj", () => {
    expect(
      presentProjectSaveError({ kind: "invalidName", path: "/p/cut.txt" }),
    ).toEqual({ message: { key: "projectSaveError.invalidName" }, detail: null });
  });

  it("puts the text of the system in the details, and not in the sentence", () => {
    const view = presentProjectSaveError({
      kind: "writeFailed",
      error: new ProjectCommandError({
        code: "permissionDenied",
        detail: "Permission denied (os error 13)",
      }),
    });
    expect(view).toEqual({
      message: { key: "projectSaveError.write.permissionDenied" },
      detail: "Permission denied (os error 13)",
    });
    // An error with no text, or with blank text, has no details.
    expect(
      presentProjectSaveError({
        kind: "writeFailed",
        error: new ProjectCommandError({ code: "writeFailed", detail: "  " }),
      }).detail,
    ).toBeNull();
    // The text of the dialog plugin shows too: a string, or the message of an Error.
    expect(
      presentProjectSaveError({
        kind: "dialogFailed",
        error: new Error("plugin failed"),
      }),
    ).toEqual({
      message: { key: "projectSaveError.dialogFailed" },
      detail: "plugin failed",
    });
    expect(
      presentProjectSaveError({ kind: "dialogFailed", error: "window not found" })
        .detail,
    ).toBe("window not found");
    for (const error of [undefined, null, 7, { code: 1 }, "", new Error("")]) {
      expect(
        presentProjectSaveError({ kind: "dialogFailed", error }).detail,
      ).toBeNull();
    }
  });

  it("renders the messages in English and in Simplified Chinese", async () => {
    const expected = {
      en: {
        title: "QuipClip could not save the project",
        invalidName: "The name of a project file must end in .qcproj.",
        clip: "QuipClip could not read the length of “clip.webm” from the file. A project file can hold such a video only when it is alone on the timeline, so QuipClip did not save the project.",
        noClip: "The timeline has no video, so there is nothing to save.",
        documentRefused:
          "A project file cannot hold the timeline in its current form, so QuipClip did not save the project.",
        filter: "QuipClip Projects",
      },
      "zh-CN": {
        title: "无法保存项目",
        invalidName: "项目文件的名称必须以 .qcproj 结尾。",
        clip: "无法从文件中读取“clip.webm”的时长。只有当时间轴上仅有这一段视频时，项目文件才能记录它，因此未保存项目。",
        noClip: "时间轴上没有视频，因此没有可保存的内容。",
        documentRefused: "项目文件无法记录当前形式的时间轴，因此未保存项目。",
        filter: "QuipClip 项目",
      },
    } as const;
    for (const language of ["en", "zh-CN"] as const) {
      const instance = await createI18nInstance({
        initialPreference: language,
        storage: null,
      });
      const t = instance.t as unknown as (
        key: string,
        values?: Readonly<Record<string, string>>,
      ) => string;
      expect(t(PROJECT_SAVE_ERROR_TITLE_KEY)).toBe(expected[language].title);
      expect(t("projectSaveError.invalidName")).toBe(expected[language].invalidName);
      expect(t("projectSaveError.clipExtentUnknown", { fileName: "clip.webm" })).toBe(
        expected[language].clip,
      );
      expect(t("dialog.projectFilter")).toBe(expected[language].filter);
      expect(t("projectSaveError.noClip")).toBe(expected[language].noClip);
      expect(t("projectSaveError.documentRefused")).toBe(
        expected[language].documentRefused,
      );
    }
  });
});
