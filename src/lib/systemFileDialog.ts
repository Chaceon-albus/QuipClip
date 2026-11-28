/**
 * The count of the file dialogs of the system that the main window has open.
 *
 * A file dialog of the system is modal to the window, so the page gets no key press and no click
 * while it shows. The macOS application menu still works then, so its command items read
 * `isSystemFileDialogOpen` and do nothing while it is true. Without it, an item would queue a
 * second dialog behind the first one, or change the sequence under an open save dialog.
 *
 * Each caller that opens such a dialog runs the call of the dialog through
 * `trackSystemFileDialog`: the dialog of the Open action, the dialog of "Locate…" of the project
 * dialog, the save dialog of a project, the save dialog of an export and the save dialog of Export
 * Frame.
 */

let openCount = 0;

/** The listeners of `subscribeSystemFileDialog`. */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Runs `call`, the call of a file dialog of the system, and counts the dialog as open until the
 * call settles. A call that throws or rejects counts as closed too.
 */
export async function trackSystemFileDialog<T>(call: () => Promise<T>): Promise<T> {
  openCount += 1;
  notify();
  try {
    return await call();
  } finally {
    openCount -= 1;
    notify();
  }
}

/**
 * Calls `listener` after each change of the count: a dialog that opens, and a dialog that closes.
 * The recovery prompt (ADR 073) waits for the close. Answers the function that removes the
 * listener.
 */
export function subscribeSystemFileDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while a file dialog of the system that `trackSystemFileDialog` counts is open. */
export function isSystemFileDialogOpen(): boolean {
  return openCount > 0;
}
