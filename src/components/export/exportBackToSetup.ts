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
 *    A failed Stop request keeps the tracking: a `cancel_export` that rejects keeps the run,
 *    and the store tracks the run to its end. So `failed` with no tracked run comes only from
 *    a run that ended, a start that the backend refused, or a failure of the open step.
 * 2. A step that answers after the dialog closed changes nothing. The source check reads the
 *    file, which on a share that stopped answering can take seconds. A step that answered
 *    late would otherwise open the closed dialog again, or report a failure into the store
 *    that the close reset.
 *
 * The module has no React and no document, so the tests need neither.
 */

import {
  ExportError,
  scopeOfBack,
  type BackTarget,
  type ExportScope,
  type ExportScopeStore,
  type ExportScopeTarget,
  type ExportState,
} from "@/features/export";

/** The fields of the export store that decide whether Back is offered. */
export type BackToSetupInput = Pick<ExportState, "status" | "tracking">;

/**
 * Answers whether the failed panel offers Back, and whether a click on it may reset the
 * store and run the open step again.
 *
 * `failed` is necessary and not sufficient: the store must also have stopped tracking the
 * run. A `failed` status says only that the interface shows a failure, not that the backend
 * has no run. The store also reports `failed` when a Stop request rejects while the run
 * continues. `cancel_export` never answers with an error of its own, so a rejection comes
 * from the IPC layer, and the store records it as `unknown`, with the run still tracked. The
 * error code therefore cannot tell this case apart, and `tracking` can.
 *
 * An active status holds a run that a reset would drop, and `idle`, `finished`, and
 * `canceled` do not offer Back.
 */
export function canGoBackToSetup({ status, tracking }: BackToSetupInput): boolean {
  return status === "failed" && !tracking;
}

/**
 * The scope of the open step that Back runs (ADR 067). Back calls it at the press, before it
 * resets the result or the failure of `target`, which keeps the scope.
 *
 * The scope is the scope that the result or the failure kept (`scopeOfBack`), and the setup step
 * takes it from the moment of the press. After the error of an open step, which keeps no scope,
 * it is the scope of the setup step, which that open step set and which stays.
 *
 * `scopeTarget` is the flow target whose result or failure Back leaves: the store that the dialog
 * shows. Back reads and writes only the setup scope of that target.
 */
export function takeBackScope(
  target: BackTarget,
  scopeStore: ExportScopeStore,
  scopeTarget: ExportScopeTarget,
): ExportScope {
  const scopes = scopeStore.getState();
  const scope = scopeOfBack(target, scopes) ?? scopes.setup[scopeTarget];
  scopes.publishSetup(scopeTarget, scope);
  return scope;
}

/** What Back needs from the dialog (`goBackToSetup`). */
export interface BackToSetupSteps {
  /** The result or the failure that Back leaves, read at the press. */
  readonly target: BackTarget;
  readonly scopeStore: ExportScopeStore;
  /** The flow target whose result or failure Back leaves: the store that the dialog shows. */
  readonly scopeTarget: ExportScopeTarget;
  /** True when `scope` is valid now, with the timeline as it is (`isExportScopeValidNow`). */
  readonly isScopeValid: (scope: ExportScope) => boolean;
  /** Resets the store that the dialog shows: the export store, or the compose store. */
  readonly reset: () => void;
  /** Reports to the store that the dialog shows. */
  readonly reportError: (error: unknown) => void;
  /** Runs the open step again with the scope (`runOpenStepAgain`). */
  readonly openStep: (scope: ExportScope) => void;
}

/**
 * Back from a result or a failure (ADR 024, ADR 067).
 *
 * It takes the scope that the result or the failure kept (`takeBackScope`), and resets the store
 * that the dialog shows. It then tests the scope itself, apart from the open step and from the
 * guard that lets one open step run at a time for a file (`runExportFlow`): that guard can return
 * before an open step tests anything. A list that is no longer valid reports
 * `selectedSegmentsChanged` to the store that the dialog shows, so the setup step does not show,
 * and no open step starts. Otherwise the open step runs with the scope, and tests it again when it
 * shows.
 *
 * @returns The scope of the setup step from the press on.
 */
export function goBackToSetup(steps: BackToSetupSteps): ExportScope {
  const scope = takeBackScope(steps.target, steps.scopeStore, steps.scopeTarget);
  steps.reset();
  if (!steps.isScopeValid(scope)) {
    steps.reportError(new ExportError({ code: "selectedSegmentsChanged" }));
    return scope;
  }
  steps.openStep(scope);
  return scope;
}

/**
 * The scope of the open step that "Export anyway" runs (ADR 024, ADR 067): the scope of the setup
 * step of `scopeTarget`, the target whose confirmation the user answers, which stays. The step
 * closes the confirmation and opens the setup step again for the same export.
 */
export function exportAnywayScope(
  scopeStore: ExportScopeStore,
  scopeTarget: ExportScopeTarget,
): ExportScope {
  return scopeStore.getState().setup[scopeTarget];
}

/** The calls through which the open step changes the dialog and the stores. */
export interface OpenStepEffects {
  setModalOpen: (open: boolean) => void;
  reportError: (error: unknown) => void;
  /**
   * Sets the scope of the setup step (ADR 067), when the step shows the setup step or the error
   * of its checks. Absent means the default of the export flow controller.
   */
  publishScope?: (scope: ExportScope) => void;
}

/**
 * Hands out one generation for each open step that Back starts.
 *
 * `begin` returns a check that stays true until the next `begin` or `invalidate`. The dialog
 * calls `invalidate` when it closes or hides.
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
  const guarded: OpenStepEffects = {
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
  const { publishScope } = effects;
  if (publishScope !== undefined) {
    guarded.publishScope = (scope) => {
      if (isCurrent()) {
        publishScope(scope);
      }
    };
  }
  return guarded;
}

/** What `runOpenStepAgain` needs from the dialog. */
export interface OpenStepAgain {
  /** The generation of the dialog. The step begins a new one, and a close invalidates it. */
  readonly generation: OpenStepGeneration;
  /** The effects of the step. They apply only while the step is current. */
  readonly effects: OpenStepEffects;
  /** Sets the flag that disables Export while the step runs. */
  readonly setPending: (pending: boolean) => void;
  /** Runs the open step with the guarded effects, through `runExportFlow`. */
  readonly run: (effects: OpenStepEffects) => Promise<boolean>;
}

/**
 * Runs the open step of ADR 024 again while the dialog shows the setup step, after Back.
 *
 * Export stays disabled until the step answers, so no export starts before the source check
 * ends, and a check that fails shows its own panel. A step that another step or a close made
 * stale changes nothing, and it does not enable Export: the step that replaced it owns the
 * flag. Resolves as the step does.
 */
export function runOpenStepAgain({
  generation,
  effects,
  setPending,
  run,
}: OpenStepAgain): Promise<boolean> {
  const isCurrent = generation.begin();
  setPending(true);
  return run(guardOpenStepEffects(isCurrent, effects)).finally(() => {
    if (isCurrent()) {
      setPending(false);
    }
  });
}
