/**
 * The mark of the title bar that the page draws, and the test for an element inside it.
 *
 * The main window draws its own title bar (`TitleBar.tsx`, ADR 020). The overlay of a modal
 * dialog leaves that bar free, so the user can still move the window while a dialog is open
 * (`--title-bar-height` in `globals.css`). A press on the bar is then not a press outside the
 * dialog: the dialog reads `isInTitleBar` and does not close.
 */

/** The props that mark an element as the title bar. `TitleBar.tsx` spreads them on the bar. */
export const TITLE_BAR_MARKER = { "data-title-bar": "" } as const;

/** The selector of the element that carries `TITLE_BAR_MARKER`. */
export const TITLE_BAR_SELECTOR = "[data-title-bar]";

/** The member of an event target that `isInTitleBar` reads. `Element` satisfies it. */
export interface TitleBarAncestorProbe {
  closest(selector: string): unknown;
}

function isTitleBarAncestorProbe(value: unknown): value is TitleBarAncestorProbe {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TitleBarAncestorProbe>).closest === "function"
  );
}

/**
 * True when `target` is the title bar or an element inside it.
 *
 * The test follows the document, not the React tree. The export dialog is a React child of
 * the title bar, but its portal puts it under `<body>`, so an element of the dialog is not in
 * the bar.
 *
 * @param target The `target` of an event. A value that is not an element, such as the
 *   document, the window or null, gives false.
 */
export function isInTitleBar(target: unknown): boolean {
  return isTitleBarAncestorProbe(target) && target.closest(TITLE_BAR_SELECTOR) !== null;
}
