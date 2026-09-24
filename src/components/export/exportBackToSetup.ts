/**
 * Pure rules for the Back action of the failed export panel.
 *
 * Back resets the export store and runs the open step of ADR 024 again, the step that the
 * Export button runs. The dialog stays open while the step runs. Two rules keep that safe:
 *
 * 1. Back acts only on a failure while the store tracks no run. A reset drops the run that
 *    the store tracks, and a run that the backend still encodes then has no owner (ADR 025).
 *    The store says whether it still tracks a run, so the rule reads that and not the code.
 *
 *    Known gap: "the store tracks no run" does not prove "the backend runs nothing". When a
 *    slot cancel (`cancel_active_export`) rejects during `preparing`, the store drops the
 *    start that still waits for its run id. It shows `failed` with no tracked run, and it
 *    discards the later `start_export` answer, while the backend can still encode that run.
 *    Back shows in that state. The fix belongs in the store, in a later unit, and a test in
 *    `exportBackToSetup.test.ts` pins the gap until then.
 * 2. A step that answers after the dialog closed changes nothing. The source check reads the
 *    file, which on a share that stopped answering can take seconds. A step that answered
 *    late would otherwise open the closed dialog again, or report a failure into the store
 *    that the close reset.
 *
 * The module has no React and no document, so the tests need neither.
 */

import type { ExportState } from "@/features/export";

/** The fields of the export store that decide whether Back is offered. */
export type BackToSetupInput = Pick<ExportState, "status" | "tracking">;

/**
 * Answers whether the failed panel offers Back, and whether a click on it may reset the
 * store and run the open step again.
 *
 * `failed` is necessary and not sufficient: the store must also have stopped tracking the
 * run. A `failed` status says only that the interface shows a failure, not that the backend
 * has no run. The store also reports `failed` when a call from the interface rejects while
 * the run continues. `cancel_export` never answers with an error of its own, so its
 * rejection comes from the IPC layer, and the store records it as `unknown`, with the run
 * still tracked. The error code therefore cannot tell this case apart, and `tracking` can.
 *
 * An active status holds a run that a reset would drop, and `idle`, `finished`, and
 * `canceled` do not offer Back.
 */
export function canGoBackToSetup({ status, tracking }: BackToSetupInput): boolean {
  return status === "failed" && !tracking;
}

/** The two calls through which the open step changes the dialog and the store. */
export interface OpenStepEffects {
  setModalOpen: (open: boolean) => void;
  reportError: (error: unknown) => void;
}

/**
 * Hands out one generation for each open step that Back starts.
 *
 * `begin` returns a check that stays true until the next `begin` or `invalidate`. The dialog
 * calls `invalidate` when it closes.
 */
export interface OpenStepGeneration {
  begin: () => () => boolean;
  invalidate: () => void;
}

export function createOpenStepGeneration(): OpenStepGeneration {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      const mine = generation;
      return () => generation === mine;
    },
    invalidate: () => {
      generation += 1;
    },
  };
}

/**
 * Wraps the effects of an open step, so that a step for which `isCurrent` answers false
 * changes nothing.
 */
export function guardOpenStepEffects(
  isCurrent: () => boolean,
  effects: OpenStepEffects,
): OpenStepEffects {
  return {
    setModalOpen: (open) => {
      if (isCurrent()) {
        effects.setModalOpen(open);
      }
    },
    reportError: (error) => {
      if (isCurrent()) {
        effects.reportError(error);
      }
    },
  };
}
