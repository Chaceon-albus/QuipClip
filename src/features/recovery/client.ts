/**
 * Typed IPC clients of the recovery commands (ADR 073).
 *
 * Each command but `start_recovery` answers each failure in its answer, with the facts that the
 * page needs. So these clients do not throw: a rejection of the command, or an answer of the
 * wrong shape, gives a `failed` answer with no owner, `notKnown` for the file, and the error
 * code `unknown`. `startRecovery` throws a `RecoveryCommandError`, because it has no such
 * answer.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";
import type { PersistedSource, Project } from "@/types/project";
import type {
  RecoveryChangeResult,
  RecoveryDiscardResult,
  RecoveryListResult,
  RecoveryReadResult,
  RecoveryStartResult,
  RecoveryWork,
} from "./types";
import {
  normalizeRecoveryCommandError,
  validateRecoveryChangeResult,
  validateRecoveryDiscardResult,
  validateRecoveryListResult,
  validateRecoveryReadResult,
  validateRecoveryStartResult,
} from "./validation";

/** Options of the recovery clients. */
export interface RecoveryClientOptions {
  /** Optional custom invoke function, for dependency injection in tests. */
  invoke?: InvokeFn;
}

/** A copy of `project` whose sources have no `relPath`: a recovery file has none (ADR 073). */
function withoutRelPaths(project: Project): Project {
  return {
    ...project,
    sources: project.sources.map((source): PersistedSource => {
      const { relPath: _relPath, ...rest } = source;
      return rest;
    }),
  };
}

/** The answer of a change command that did not come back in its shape. */
function failedChange(error: unknown): RecoveryChangeResult {
  return {
    owner: false,
    status: "failed",
    current: "notKnown",
    error: normalizeRecoveryCommandError(error),
  };
}

/**
 * Invokes `start_recovery` with no argument. It reads no file.
 *
 * @returns The token of the recovery session of the page.
 * @throws RecoveryCommandError if the backend rejects or returns data of the wrong shape.
 */
export async function startRecovery(
  options: RecoveryClientOptions = {},
): Promise<RecoveryStartResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.START_RECOVERY);
    return validateRecoveryStartResult(rawResult);
  } catch (error) {
    throw normalizeRecoveryCommandError(error);
  }
}

/**
 * Invokes `list_recovery_offers` with arguments `{ token }`. The backend removes the temporary
 * files of a write and the offers that are not valid, and lists the valid offers.
 */
export async function listRecoveryOffers(
  token: string,
  options: RecoveryClientOptions = {},
): Promise<RecoveryListResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.LIST_RECOVERY_OFFERS, {
      token,
    });
    return validateRecoveryListResult(rawResult);
  } catch (error) {
    return {
      owner: false,
      status: "failed",
      complete: false,
      offers: [],
      error: normalizeRecoveryCommandError(error),
    };
  }
}

/**
 * Invokes `write_recovery` with arguments `{ token, projectPath, project }`. The document has
 * no `relPath`: the payload has no such field.
 */
export async function writeRecovery(
  token: string,
  work: RecoveryWork,
  options: RecoveryClientOptions = {},
): Promise<RecoveryChangeResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.WRITE_RECOVERY, {
      token,
      projectPath: work.projectPath,
      project: withoutRelPaths(work.project),
    });
    return validateRecoveryChangeResult(rawResult);
  } catch (error) {
    return failedChange(error);
  }
}

/**
 * Invokes `clear_recovery` with arguments `{ token }`. The backend removes `current.json` when a
 * command with the token wrote it.
 */
export async function clearRecovery(
  token: string,
  options: RecoveryClientOptions = {},
): Promise<RecoveryChangeResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.CLEAR_RECOVERY, { token });
    return validateRecoveryChangeResult(rawResult);
  } catch (error) {
    return failedChange(error);
  }
}

/**
 * Invokes `read_recovery` with arguments `{ token, id }`. The answer has the path of the offer,
 * its document, and one candidate path for each source.
 */
export async function readRecovery(
  token: string,
  id: string,
  options: RecoveryClientOptions = {},
): Promise<RecoveryReadResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.READ_RECOVERY, {
      token,
      id,
    });
    return validateRecoveryReadResult(rawResult);
  } catch (error) {
    return {
      owner: false,
      status: "failed",
      error: normalizeRecoveryCommandError(error),
    };
  }
}

/** Invokes `discard_recovery` with arguments `{ token, id }`. The backend removes the offer. */
export async function discardRecovery(
  token: string,
  id: string,
  options: RecoveryClientOptions = {},
): Promise<RecoveryDiscardResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.DISCARD_RECOVERY, {
      token,
      id,
    });
    return validateRecoveryDiscardResult(rawResult);
  } catch (error) {
    return {
      owner: false,
      status: "failed",
      error: normalizeRecoveryCommandError(error),
    };
  }
}

/**
 * Invokes `finish_restore` with arguments `{ token, id, state }`. `state` is the work to write,
 * or null for a session with no changes to save. The payload always has the key `state`: the
 * backend answers `missingRestoreState` for a call with no such key, and changes no file. The
 * backend writes or removes `current.json`, and then removes the offer.
 */
export async function finishRestore(
  token: string,
  id: string,
  state: RecoveryWork | null,
  options: RecoveryClientOptions = {},
): Promise<RecoveryChangeResult> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const rawResult = await invoke<unknown>(BACKEND_COMMANDS.FINISH_RESTORE, {
      token,
      id,
      state:
        state === null
          ? null
          : { projectPath: state.projectPath, project: withoutRelPaths(state.project) },
    });
    return validateRecoveryChangeResult(rawResult);
  } catch (error) {
    return failedChange(error);
  }
}
