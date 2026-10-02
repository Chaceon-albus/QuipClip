/**
 * The title bar of the main window while a modal dialog of that window is open.
 *
 * The scrim of a modal dialog starts below the title bar (`--title-bar-height` in
 * `globals.css`), so the user can still move the window while the dialog is open. Radix sets
 * `pointer-events: none` on `<body>` while a modal layer is open, and the bar inherits it, so a
 * press on the bar would reach no element of it. While a dialog is open:
 *
 * - The bar takes the pointer again. A press reaches the drag region of ADR 020, and on Windows
 *   the three window buttons. The close button keeps the quit path of ADR 027, the path of
 *   `Alt+F4`: the quit prompt opens above the export dialog, takes the place of the replace
 *   prompt, and does not open a second time while it shows.
 * - The controls of the application, the File menu and Export, take no pointer. A press on one
 *   falls through to the bar and moves the window. The dialog keeps the Tab key inside it, and
 *   Radix hides everything outside the dialog from assistive technology, so the controls are
 *   out of reach. They are not `inert`: an element that turns inert loses the focus before the
 *   dialog records its opener, so the dialog could not give the focus back to that control.
 * - A mouse press on the bar keeps the focus in the dialog (`keepsFocusOnPress`). A press on a
 *   window button would otherwise focus that button, and the focus trap of the dialog would pull
 *   the focus back and select the text of a field. A second press of a double click on macOS
 *   would move the focus to the document body.
 *
 * Only the main window draws this bar. The Settings window has the title bar of the system
 * (ADR 038).
 */

import { isInTitleBar } from "@/lib/titleBar";

/** The modal dialogs of the main window. A new modal dialog of that window joins this list. */
export interface TitleBarModalInput {
  /** The export dialog is open (`useExportPanelStore`). */
  readonly exportDialogOpen: boolean;
  /** The quit prompt or the replace prompt is open (`QuitGuardDialog`, ADR 027). */
  readonly quitPromptOpen: boolean;
}

/** What the title bar changes while a modal dialog is open. */
export interface TitleBarModalView {
  /** True while a modal dialog of the main window is open. */
  readonly modalOpen: boolean;
  /** The pointer class of the bar. Empty while no dialog is open. */
  readonly barClass: string;
  /** The pointer class of each control of the application. Empty while no dialog is open. */
  readonly appControlClass: string;
}

/** The title bar for the dialogs that are open. Each class is a complete class literal. */
export function presentTitleBarModal({
  exportDialogOpen,
  quitPromptOpen,
}: TitleBarModalInput): TitleBarModalView {
  if (exportDialogOpen || quitPromptOpen) {
    return {
      modalOpen: true,
      barClass: "pointer-events-auto",
      appControlClass: "pointer-events-none",
    };
  }
  return { modalOpen: false, barClass: "", appControlClass: "" };
}

/**
 * True when a mouse press must not move the focus: a modal dialog is open and the press is in
 * the bar.
 *
 * React passes the presses of the export dialog up to the bar, because the dialog is a React
 * child of the bar, although its portal is under `<body>`. The test follows the document, so a
 * press in the dialog still moves the focus as usual.
 *
 * @param view The view of `presentTitleBarModal`.
 * @param target The `target` of the mouse press.
 */
export function keepsFocusOnPress(view: TitleBarModalView, target: unknown): boolean {
  return view.modalOpen && isInTitleBar(target);
}
