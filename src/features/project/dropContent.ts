/**
 * The question before an action drops the content of the project (ADR 072, "Before the content is
 * dropped"). The open of a project uses it; the quit and Clear Timeline will use it too.
 *
 * The caller shows the save prompt through `ask`. This module decides when to ask and what each
 * answer does. It shows nothing itself, and it gives the error of a failed save to the caller.
 */

import { audioOverrideStore } from "@/features/media/audioOverrideStore";
import { liveSegments, timelineStore } from "@/features/timeline/store";
import { projectContentOf } from "./document";
import type { ProjectSaveError, ProjectSaveStep } from "./saveStep";
import { hasChangesToSave, projectStore } from "./store";

/** The answer of the save prompt: its Save, Don't Save and Cancel buttons (ADR 031). */
export type DropContentAnswer = "save" | "dontSave" | "cancel";

/** What the action that drops the content does next. */
export type DropContentResult =
  | { readonly kind: "continue" }
  /**
   * The action stops. `saveError` is the error of the save that the prompt ran, for the caller to
   * show, or null after Cancel and after a save dialog that the user canceled.
   */
  | { readonly kind: "stop"; readonly saveError: ProjectSaveError | null };

/** The dependencies of `confirmDropContent`. */
export interface DropContentDependencies {
  /** Shows the save prompt and answers the button of the user. */
  readonly ask: () => Promise<DropContentAnswer>;
  /** The save step of the page. */
  readonly saveStep: Pick<ProjectSaveStep, "save" | "whenIdle">;
  /** True when the project has changes to save now (`hasChangesToSaveNow`). */
  readonly hasChangesToSave: () => boolean;
  /**
   * True when the action that asks was canceled meanwhile, as an open that the quit canceled. A
   * canceled action takes each answer of the prompt as a stop, and it starts no save. A save that
   * started before the cancel finishes as it is. Absent means never canceled.
   */
  readonly isCanceled?: () => boolean;
}

/**
 * Asks before the content is dropped, when it has to:
 *
 * 1. It waits for a save step that runs.
 * 2. With no changes to save, the action continues.
 * 3. Otherwise it asks. Don't Save continues, and Cancel stops.
 * A canceled action (`isCanceled`) stops before it asks, and after each answer, before it acts on
 * that answer.
 *
 * 4. Save runs a save step with no test of the conditions of the Save action. A failed save, or a
 *    save dialog that the user canceled, stops. After a save that succeeded, it tests again from
 *    step 2, so it asks again while changes are left: an edit or an import that ended during the
 *    write changed the content.
 */
export async function confirmDropContent(
  dependencies: DropContentDependencies,
): Promise<DropContentResult> {
  const isCanceled = dependencies.isCanceled ?? (() => false);
  for (;;) {
    await dependencies.saveStep.whenIdle();
    if (isCanceled()) {
      return { kind: "stop", saveError: null };
    }
    if (!dependencies.hasChangesToSave()) {
      return { kind: "continue" };
    }
    const answer = await dependencies.ask();
    // The action can have been canceled while the prompt showed.
    if (isCanceled()) {
      return { kind: "stop", saveError: null };
    }
    if (answer === "dontSave") {
      return { kind: "continue" };
    }
    if (answer === "cancel") {
      return { kind: "stop", saveError: null };
    }
    const saved = await dependencies.saveStep.save("save");
    if (saved.status === "canceled") {
      return { kind: "stop", saveError: null };
    }
    if (saved.status === "failed") {
      return { kind: "stop", saveError: saved.error };
    }
    // `saved`, or `busy` when another step started meanwhile: the loop waits for it and tests
    // again.
  }
}

/** The stores that `hasChangesToSaveNow` reads. */
export interface ChangesToSaveStores {
  readonly timeline?: typeof timelineStore;
  readonly audioOverrides?: typeof audioOverrideStore;
  readonly project?: typeof projectStore;
}

/**
 * True when the project has changes to save now (ADR 072): `hasChangesToSave` with the content of
 * the session and the number of the live segments of the sequence.
 */
export function hasChangesToSaveNow(stores: ChangesToSaveStores = {}): boolean {
  const timeline = (stores.timeline ?? timelineStore).getState();
  const overrides = (stores.audioOverrides ?? audioOverrideStore).getState().overrides;
  return hasChangesToSave(
    (stores.project ?? projectStore).getState(),
    projectContentOf(timeline, overrides),
    liveSegments(timeline).length,
  );
}
