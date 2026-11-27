/**
 * The count of the file dialogs of the system that the main window has open.
 *
 * A file dialog of the system is modal to the window, so the page gets no key press and no click
 * while it shows. The macOS application menu still works then, so its command items read
 * `isSystemFileDialogOpen` and do nothing while it is true. Without it, an item would queue a
 * second dialog behind the first one, or change the sequence under an open save dialog.
 *
 * Each caller that opens such a dialog runs the call of the dialog through
 * `trackSystemFileDialog`: the Open Media dialog, the save dialog of a project, the save dialog of
 * an export and the save dialog of Export Frame.
 */

let openCount = 0;

/**
 * Runs `call`, the call of a file dialog of the system, and counts the dialog as open until the
 * call settles. A call that throws or rejects counts as closed too.
 */
export async function trackSystemFileDialog<T>(call: () => Promise<T>): Promise<T> {
  openCount += 1;
  try {
    return await call();
  } finally {
    openCount -= 1;
  }
}

/** True while a file dialog of the system that `trackSystemFileDialog` counts is open. */
export function isSystemFileDialogOpen(): boolean {
  return openCount > 0;
}
