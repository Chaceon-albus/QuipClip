/**
 * Typed IPC clients of the project file commands (ADR 010, ADR 072).
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { PersistedSource, Project } from "@/types/project";
import type { LoadProjectResult, SaveProjectResult } from "./types";
import {
  normalizeProjectCommandError,
  validateLoadProjectResult,
  validateSaveProjectResult,
} from "./validation";

/** Options of the project clients. */
export interface ProjectClientOptions {
  /** Optional custom invoke function, for dependency injection in tests. */
  invoke?: InvokeFn;
}

/**
 * Invokes the backend `load_project` command with arguments `{ path }`.
 *
 * @param path The path of the project file.
 * @param options Optional client configuration containing custom invoke.
 * @returns The canonical path of the file, the document, and the candidate paths of each source.
 * @throws ProjectCommandError if the backend rejects or returns data of the wrong shape.
 */
export async function loadProject(
  path: string,
  options: ProjectClientOptions = {},
): Promise<LoadProjectResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.LOAD_PROJECT, { path });
    return validateLoadProjectResult(rawResult);
  } catch (error) {
    throw normalizeProjectCommandError(error);
  }
}

/** A copy of `source` with no `relPath`: the backend writes that field (ADR 072). */
function withoutRelPath(source: PersistedSource): PersistedSource {
  const { relPath: _relPath, ...rest } = source;
  return rest;
}

/**
 * Invokes the backend `save_project` command with arguments `{ path, project }`.
 *
 * The backend validates the document, writes the `relPath` of each source itself, and replaces
 * the file as one step. The page does not send `relPath`: the payload has no such field. The name of the file must end in `.qcproj`, or the backend answers
 * `invalidPath`.
 *
 * @param path The path of the project file to write.
 * @param project The document to write.
 * @param options Optional client configuration containing custom invoke.
 * @returns The canonical path of the written file.
 * @throws ProjectCommandError if the backend rejects or returns data of the wrong shape.
 */
export async function saveProject(
  path: string,
  project: Project,
  options: ProjectClientOptions = {},
): Promise<SaveProjectResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.SAVE_PROJECT, {
      path,
      project: { ...project, sources: project.sources.map(withoutRelPath) },
    });
    return validateSaveProjectResult(rawResult);
  } catch (error) {
    throw normalizeProjectCommandError(error);
  }
}
