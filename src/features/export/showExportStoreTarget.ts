/**
 * The change of the export dialog to the export store by a caller that is no open step and no
 * Back (ADR 049, ADR 067): the status-bar indicator, and the confirm of an export of the compose
 * state that the queue took.
 *
 * The module has no React dependency.
 */

import { exportComposeStore, type ExportComposeStore } from "./composeStore";
import { WHOLE_EXPORT_SCOPE } from "./scope";
import { exportScopeStore, type ExportScopeStore } from "./scopeStore";
import { exportStore, type ExportStore } from "./store";

/** The facts of the dialog at the call. */
export interface ShowExportStoreTargetInput {
  /** True while the export dialog is open, read at the call (`exportPanelStore`). */
  readonly dialogOpen: boolean;
}

/** The stores that `showExportStoreTarget` reads and writes. Each defaults to its production store. */
export interface ShowExportStoreTargetDependencies {
  readonly composeStore?: ExportComposeStore;
  readonly exportStore?: ExportStore;
  readonly scopeStore?: ExportScopeStore;
}

/**
 * Ends the compose state, so the dialog shows the export store. It does not open the dialog.
 *
 * A setup step that no step opened has the whole export (ADR 067). When the call makes the
 * dialog show the export store, because the dialog was closed or was open in the compose state,
 * and the export store is `idle`, the dialog shows the setup step of the export store with no
 * open step. The scope of that setup step then becomes the whole export, and not the scope that an
 * earlier step left.
 *
 * It publishes nothing in each other case. While the dialog is open and not composing, it shows
 * the export store already, so the call changes nothing on the screen. A live run, a result and a
 * failure are no setup step: the error of an open step keeps the scope that its step published,
 * and Back reads the kept scope.
 */
export function showExportStoreTarget(
  { dialogOpen }: ShowExportStoreTargetInput,
  dependencies: ShowExportStoreTargetDependencies = {},
): void {
  const composeStore = dependencies.composeStore ?? exportComposeStore;
  const store = dependencies.exportStore ?? exportStore;
  const scopeStore = dependencies.scopeStore ?? exportScopeStore;
  // Read before the exit below changes it.
  const alreadyShown = dialogOpen && !composeStore.getState().composing;
  composeStore.getState().exit();
  if (!alreadyShown && store.getState().status === "idle") {
    scopeStore.getState().publishSetup("export", WHOLE_EXPORT_SCOPE);
  }
}
