/**
 * Strict validation of the answers of the recovery commands, and normalization of their
 * rejections (ADR 073).
 *
 * An answer of the wrong shape throws a `TypeError`. Each function builds new objects that list
 * every field, so an unknown field of the payload never reaches the page. Each answer must also
 * be consistent: an error comes exactly with `refused` and `failed`, and a command that changed
 * nothing says `notKnown`.
 */

import { ProjectCommandError } from "@/features/project/types";
import {
  isBackendProjectCommandErrorCode,
  validateProjectDocument,
} from "@/features/project/validation";
import {
  BACKEND_RECOVERY_ERROR_CODES,
  RECOVERY_ERROR_CODES,
  RECOVERY_FILE_STATES,
  RECOVERY_STATUSES,
  RecoveryCommandError,
  type BackendRecoveryErrorCode,
  type RecoveredOffer,
  type RecoveryChangeResult,
  type RecoveryDiscardResult,
  type RecoveryErrorCode,
  type RecoveryFileState,
  type RecoveryListResult,
  type RecoveryOfferSummary,
  type RecoveryReadResult,
  type RecoveryStartResult,
  type RecoveryStatus,
  type RecoveryStatusWithoutDocument,
} from "./types";

/** Checks whether an unknown value is an error code of the Rust recovery commands. */
export function isBackendRecoveryErrorCode(
  value: unknown,
): value is BackendRecoveryErrorCode {
  return (
    typeof value === "string" &&
    (BACKEND_RECOVERY_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Checks whether an unknown value is an error code of a recovery command. */
export function isRecoveryErrorCode(value: unknown): value is RecoveryErrorCode {
  return (
    typeof value === "string" &&
    (RECOVERY_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** True when `value` has the form of the identifier of an offer: 16 lowercase hexadecimal digits. */
export function isRecoveryOfferId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/**
 * Normalizes a rejection of a recovery command, or a local error, into a
 * `RecoveryCommandError`. The recovery commands answer each failure in their answer, so a
 * rejection comes from the IPC layer, such as an argument that the backend could not read. The
 * code is then `unknown`. A local `Error`, such as the `TypeError` of a malformed answer, has no
 * detail, so no English sentence of the page reaches the interface.
 */
export function normalizeRecoveryCommandError(error: unknown): RecoveryCommandError {
  if (error instanceof RecoveryCommandError) {
    return error;
  }
  if (typeof error === "object" && error !== null && !(error instanceof Error)) {
    const candidate = error as Record<string, unknown>;
    return new RecoveryCommandError({
      code: isRecoveryErrorCode(candidate.code) ? candidate.code : "unknown",
      detail: typeof candidate.detail === "string" ? candidate.detail : undefined,
    });
  }
  if (typeof error === "string" && error.length > 0) {
    return new RecoveryCommandError({ code: "unknown", detail: error });
  }
  return new RecoveryCommandError({ code: "unknown" });
}

function fail(message: string): never {
  throw new TypeError(`Invalid recovery command result: ${message}`);
}

/** The record of a plain object, or null for another value. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True when `record` has each key of `required`, and no key outside `required` and `optional`. */
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || typeof record[key] === "string";
}

/** Validates the error of a document, which has the shape of a project command error. */
function validateProjectError(value: unknown): ProjectCommandError {
  const e = asRecord(value);
  if (
    e === null ||
    !hasExactKeys(
      e,
      ["code"],
      ["detail", "field", "value", "foundSchemaVersion", "supportedSchemaVersion"],
    ) ||
    !isBackendProjectCommandErrorCode(e.code) ||
    !isOptionalString(e, "detail") ||
    !isOptionalString(e, "field") ||
    !isOptionalString(e, "value") ||
    ("foundSchemaVersion" in e && !isSafeNonNegativeInteger(e.foundSchemaVersion)) ||
    ("supportedSchemaVersion" in e &&
      !isSafeNonNegativeInteger(e.supportedSchemaVersion))
  ) {
    fail("error.project must be a project command error");
  }
  return new ProjectCommandError({
    code: e.code,
    detail: typeof e.detail === "string" ? e.detail : undefined,
    field: typeof e.field === "string" ? e.field : undefined,
    value: typeof e.value === "string" ? e.value : undefined,
    foundSchemaVersion: isSafeNonNegativeInteger(e.foundSchemaVersion)
      ? e.foundSchemaVersion
      : undefined,
    supportedSchemaVersion: isSafeNonNegativeInteger(e.supportedSchemaVersion)
      ? e.supportedSchemaVersion
      : undefined,
  });
}

function validateError(value: unknown): RecoveryCommandError {
  const e = asRecord(value);
  if (
    e === null ||
    !hasExactKeys(e, ["code"], ["detail", "project"]) ||
    !isBackendRecoveryErrorCode(e.code) ||
    !isOptionalString(e, "detail")
  ) {
    fail(
      "error must have a known code, an optional detail and an optional project error",
    );
  }
  const project = "project" in e ? validateProjectError(e.project) : undefined;
  if (
    project !== undefined &&
    e.code !== "documentRefused" &&
    e.code !== "invalidRecoveryFile"
  ) {
    fail("only a refused document or an invalid recovery file has a project error");
  }
  if (e.code === "documentRefused" && project === undefined) {
    fail("a refused document has a project error");
  }
  return new RecoveryCommandError({
    code: e.code,
    detail: typeof e.detail === "string" ? e.detail : undefined,
    project,
  });
}

function isStatus(value: unknown): value is RecoveryStatus {
  return (
    typeof value === "string" &&
    (RECOVERY_STATUSES as readonly string[]).includes(value)
  );
}

function isStatusWithoutDocument(
  value: unknown,
): value is RecoveryStatusWithoutDocument {
  return isStatus(value) && value !== "refused";
}

function isFileState(value: unknown): value is RecoveryFileState {
  return (
    typeof value === "string" &&
    (RECOVERY_FILE_STATES as readonly string[]).includes(value)
  );
}

/**
 * The status, the owner bit and the error of an answer, with the rules that each answer has:
 * `notOwner` comes with no owner, `done` and `refused` with the owner, and an error exactly with
 * `refused` and `failed`.
 */
function checkCommon(
  owner: boolean,
  status: RecoveryStatus,
  error: RecoveryCommandError | undefined,
): void {
  if (status === "notOwner" && owner) {
    fail("notOwner must come with owner false");
  }
  if ((status === "done" || status === "refused") && !owner) {
    fail(`${status} must come with owner true`);
  }
  const hasError = status === "refused" || status === "failed";
  if (hasError !== (error !== undefined)) {
    fail("error must be present exactly for refused and failed");
  }
  if (status === "refused" && error?.code !== "documentRefused") {
    fail("refused must come with documentRefused");
  }
}

/** Validates an answer of `start_recovery`: the token as a decimal string. */
export function validateRecoveryStartResult(value: unknown): RecoveryStartResult {
  const r = asRecord(value);
  if (
    r === null ||
    !hasExactKeys(r, ["token"]) ||
    typeof r.token !== "string" ||
    !/^[0-9]+$/.test(r.token)
  ) {
    fail("start answer must have exactly a decimal string token");
  }
  return { token: r.token };
}

/** Validates an answer of `write_recovery`, `clear_recovery` or `finish_restore`. */
export function validateRecoveryChangeResult(value: unknown): RecoveryChangeResult {
  const r = asRecord(value);
  if (
    r === null ||
    !hasExactKeys(r, ["owner", "status", "current"], ["error"]) ||
    typeof r.owner !== "boolean" ||
    !isStatus(r.status) ||
    !isFileState(r.current)
  ) {
    fail(
      "change answer must have a boolean owner, a status, a file state and an optional error",
    );
  }
  const error = "error" in r ? validateError(r.error) : undefined;
  checkCommon(r.owner, r.status, error);
  if (!r.owner && r.current !== "notKnown") {
    fail("a process that is not the owner answers notKnown");
  }
  if (r.status === "staleSession" && r.current !== "notKnown") {
    fail("staleSession answers notKnown");
  }
  if (r.status === "done" && r.current === "notKnown") {
    fail("done answers written or nothing");
  }
  if (r.status === "refused" && r.current === "written") {
    fail("refused answers nothing or notKnown");
  }
  const result: RecoveryChangeResult = {
    owner: r.owner,
    status: r.status,
    current: r.current,
  };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

function validateOfferSummary(value: unknown, index: number): RecoveryOfferSummary {
  const o = asRecord(value);
  if (
    o === null ||
    !hasExactKeys(o, ["id", "writtenAtMs", "projectPath"]) ||
    !isRecoveryOfferId(o.id) ||
    !isSafeNonNegativeInteger(o.writtenAtMs) ||
    (o.projectPath !== null && typeof o.projectPath !== "string")
  ) {
    fail(`offers[${index}] must have an id, a time in milliseconds and a path or null`);
  }
  return { id: o.id, writtenAtMs: o.writtenAtMs, projectPath: o.projectPath };
}

/** Validates an answer of `list_recovery_offers`. */
export function validateRecoveryListResult(value: unknown): RecoveryListResult {
  const r = asRecord(value);
  if (
    r === null ||
    !hasExactKeys(r, ["owner", "status", "complete", "offers"], ["error"]) ||
    typeof r.owner !== "boolean" ||
    !isStatusWithoutDocument(r.status) ||
    typeof r.complete !== "boolean" ||
    !Array.isArray(r.offers)
  ) {
    fail(
      "list answer must have a boolean owner, a status, a boolean complete and offers",
    );
  }
  const error = "error" in r ? validateError(r.error) : undefined;
  checkCommon(r.owner, r.status, error);
  if (r.complete !== (r.status === "done")) {
    fail("the list is complete exactly for done");
  }
  const offers = r.offers.map((offer, index) => validateOfferSummary(offer, index));
  if (!r.owner && offers.length > 0) {
    fail("a process that is not the owner lists no offer");
  }
  if (new Set(offers.map((offer) => offer.id)).size !== offers.length) {
    fail("each offer appears once");
  }
  const result: RecoveryListResult = {
    owner: r.owner,
    status: r.status,
    complete: r.complete,
    offers,
  };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

function validateRecoveredOffer(value: unknown): RecoveredOffer {
  const o = asRecord(value);
  if (o === null || !hasExactKeys(o, ["projectPath", "project", "candidates"])) {
    fail("offer must have exactly projectPath, project and candidates");
  }
  if (o.projectPath !== null && typeof o.projectPath !== "string") {
    fail("offer.projectPath must be a string or null");
  }
  const project = validateProjectDocument(o.project);
  if (project.sources.some((source) => source.relPath !== undefined)) {
    fail("a recovered document has no relPath");
  }
  const candidates = o.candidates;
  if (!Array.isArray(candidates) || candidates.length !== project.sources.length) {
    fail("offer must have one list of candidates for each source");
  }
  const lists = candidates.map((list: unknown, index) => {
    if (
      !Array.isArray(list) ||
      list.length !== 1 ||
      list[0] !== project.sources[index].path
    ) {
      fail(`candidates[${index}] must be the one path of its source`);
    }
    return [project.sources[index].path];
  });
  return { projectPath: o.projectPath, project, candidates: lists };
}

/** Validates an answer of `read_recovery`. */
export function validateRecoveryReadResult(value: unknown): RecoveryReadResult {
  const r = asRecord(value);
  if (
    r === null ||
    !hasExactKeys(r, ["owner", "status"], ["offer", "error"]) ||
    typeof r.owner !== "boolean" ||
    !isStatusWithoutDocument(r.status)
  ) {
    fail(
      "read answer must have a boolean owner, a status, an optional offer and error",
    );
  }
  const error = "error" in r ? validateError(r.error) : undefined;
  checkCommon(r.owner, r.status, error);
  if ((r.status === "done") !== "offer" in r) {
    fail("the offer must be present exactly for done");
  }
  const result: RecoveryReadResult = { owner: r.owner, status: r.status };
  if ("offer" in r) {
    result.offer = validateRecoveredOffer(r.offer);
  }
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

/** Validates an answer of `discard_recovery`. */
export function validateRecoveryDiscardResult(value: unknown): RecoveryDiscardResult {
  const r = asRecord(value);
  if (
    r === null ||
    !hasExactKeys(r, ["owner", "status"], ["error"]) ||
    typeof r.owner !== "boolean" ||
    !isStatusWithoutDocument(r.status)
  ) {
    fail("discard answer must have a boolean owner, a status and an optional error");
  }
  const error = "error" in r ? validateError(r.error) : undefined;
  checkCommon(r.owner, r.status, error);
  const result: RecoveryDiscardResult = { owner: r.owner, status: r.status };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}
