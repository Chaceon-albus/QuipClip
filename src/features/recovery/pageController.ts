/**
 * The recovery controller of the page (ADR 073), with the production clients and stores.
 *
 * The application shell starts it one time (`startPageRecovery`). The quit guard reads its token
 * and its line for `confirm_quit`, and the restore reads an offer and puts `finish_restore` in its
 * line. The recovery prompt reads its offers to show.
 */

import { createRecoveryController, type RecoveryController } from "./controller";

/** The one recovery controller of the page. Nothing sends a command before its start. */
export const recoveryController: RecoveryController = createRecoveryController();

/**
 * Starts the recovery session of the page. A second call starts no second session: the start of
 * the controller runs one time, so the effect that React StrictMode runs two times in development
 * calls `start_recovery` one time. The shell never closes the controller: the page keeps one
 * session for its life, and only a confirmed quit ends it.
 *
 * @param controller The controller to start. The controller of the page by default.
 */
export function startPageRecovery(
  controller: Pick<RecoveryController, "start"> = recoveryController,
): void {
  void controller.start();
}
