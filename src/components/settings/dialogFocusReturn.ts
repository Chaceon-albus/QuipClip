/**
 * Decides where the focus goes when the settings dialog closes.
 *
 * The dialog has no Radix `DialogTrigger`, because any component can open it through the
 * settings panel store. Radix therefore has no trigger to focus on close, and the focus would
 * fall to the body for every user.
 *
 * WAI-ARIA returns the focus to the element that opened a dialog, and a keyboard user needs
 * that. A pointer user does not, and there it does harm: the status bar gear has a tooltip,
 * and a Radix tooltip opens on every focus that no pointer press on its trigger started. A
 * focus call after a click on Close would show the "Settings" tooltip while the pointer is
 * somewhere else. So the focus returns to the opener only when the last interaction with the
 * dialog came from the keyboard.
 *
 * The rule has no DOM and no React, so the tests need no document.
 */

/** How the user last acted on the open dialog. */
export type DialogInteraction = "keyboard" | "pointer";

/** The narrow view of an element that the rule reads, so a test can pass a fake. */
export interface FocusReturnTarget {
  /** False after the element left the document. A detached element cannot take the focus. */
  readonly isConnected: boolean;
  focus: () => void;
}

export interface DialogFocusReturn {
  /**
   * Records the element that held the focus when the dialog opened. Call it from
   * `onOpenAutoFocus`: Radix dispatches that event before it moves the focus into the dialog.
   */
  noteOpened: (opener: FocusReturnTarget | null) => void;
  /** Records the kind of the latest interaction with the open dialog. */
  noteInteraction: (interaction: DialogInteraction) => void;
  /**
   * Returns the element that must take the focus now that the dialog closed, or null when the
   * focus must stay where the closing dialog leaves it. It also forgets the opener, so a stale
   * element never takes the focus after a later open.
   */
  takeCloseTarget: () => FocusReturnTarget | null;
}

export function createDialogFocusReturn(): DialogFocusReturn {
  let opener: FocusReturnTarget | null = null;
  // Every close comes after an interaction that sets this value: Escape, a press on a close
  // button, or a press outside the dialog. The keyboard default applies only to a close that
  // no interaction caused, and for that close the WAI-ARIA default is the safe one.
  let interaction: DialogInteraction = "keyboard";

  return {
    noteOpened: (next) => {
      opener = next;
      interaction = "keyboard";
    },
    noteInteraction: (next) => {
      interaction = next;
    },
    takeCloseTarget: () => {
      const target = opener;
      opener = null;
      if (interaction !== "keyboard" || target === null || !target.isConnected) {
        return null;
      }
      return target;
    },
  };
}
