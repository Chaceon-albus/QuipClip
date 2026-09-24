/**
 * Pure rules for `ConfirmDialog`: the style of a destructive confirm button, and where the
 * focus goes when the dialog closes.
 *
 * The rules have no DOM and no React, so the tests need no document.
 */

/**
 * Classes that turn the default button into a solid destructive button.
 *
 * The text takes the color of the dialog surface (`popover`), not `destructive-foreground`.
 * Measured with the WCAG 2 formula against the palette in `globals.css`:
 *
 * | Theme | State | This style | `destructive-foreground` text | Tinted variant, `-text` token |
 * | ----- | ----- | ---------- | ----------------------------- | ----------------------------- |
 * | Light | Rest  | 4.67:1     | 4.46:1                        | 4.88:1                        |
 * | Light | Hover | 5.34:1     | 3.97:1 (`/90`)                | 4.21:1 (`/20`)                |
 * | Light | Press | 6.12:1     | —                             | —                             |
 * | Dark  | Rest  | 5.02:1     | 3.28:1                        | 3.94:1 (`/20`)                |
 * | Dark  | Hover | 5.69:1     | 3.87:1 (`/90`)                | 3.39:1 (`/30`)                |
 * | Dark  | Press | 6.41:1     | —                             | —                             |
 *
 * The button text is 14 px at weight 500, so it needs 4.5:1. Only this style reaches it in
 * both themes and in every state. The two other styles fail at rest or on hover, so the
 * table gives no press figure for them. The light theme gets light text on a dark red fill,
 * and the dark theme gets dark text on a light red fill, which is how the primary button of
 * each theme already works.
 *
 * The hover color mixes the fill 10% toward `foreground`, which moves it away from the text
 * in both themes: darker in the light theme and lighter in the dark theme. The press color
 * mixes 20%, so it moves further in the same direction. The mix is in OKLab so that the hue
 * does not turn toward orange on the way. The fill keeps at least 4.38:1 against the dialog
 * footer, above the 3:1 that WCAG 1.4.11 asks of a control boundary.
 *
 * The press class must be in this list, because the default button has its own press fill
 * (`active:bg-primary-active`), and this class replaces it.
 */
export const DESTRUCTIVE_CONFIRM_CLASS =
  "bg-destructive text-popover hover:bg-[color-mix(in_oklab,var(--destructive),var(--foreground)_10%)] active:bg-[color-mix(in_oklab,var(--destructive),var(--foreground)_20%)]";

/** The narrow view of an element that the focus rule reads, so a test can pass a fake. */
export interface FocusCandidate {
  /** False after the element left the document. A detached element cannot take the focus. */
  readonly isConnected: boolean;
  /** True while the element cannot take the focus, such as a disabled button. */
  readonly isDisabled: boolean;
  /**
   * True for the document body. The focus rests on the body when no control holds it, so a
   * dialog that opens then has no opener to return to. Absent means false.
   */
  readonly isDocumentBody?: boolean;
  focus: () => void;
}

export interface ConfirmFocusReturn {
  /**
   * Records the element that opened the dialog, and the fallbacks, in order, for a close that
   * leaves the opener unable to take the focus. Call it from `onOpenAutoFocus`: Radix
   * dispatches that event before it moves the focus into the dialog, so the active element is
   * the opener. The document body counts as no opener, so the fallbacks apply.
   */
  noteOpened: (
    opener: FocusCandidate | null,
    ...fallbacks: readonly (FocusCandidate | null)[]
  ) => void;
  /**
   * Records that the user confirmed, and the element that takes the focus after the confirm in
   * place of the opener. Pass null to keep the opener first. Call it from the confirm button,
   * before the dialog closes.
   */
  noteConfirmed: (target: FocusCandidate | null) => void;
  /**
   * Returns the element that must take the focus now that the dialog closed, or null when no
   * recorded element can take it. After a confirm, the target of `noteConfirmed` comes first.
   * It also forgets every element, so a stale element never takes the focus after a later
   * open.
   */
  takeCloseTarget: () => FocusCandidate | null;
}

/**
 * Creates the focus rule of one confirm dialog.
 *
 * WAI-ARIA returns the focus to the element that opened a dialog. `ConfirmDialog` has no
 * Radix trigger, so Radix has no element to focus on close, and the focus would fall to the
 * body. A keyboard user would then lose their place in the dialog underneath, such as the
 * settings dialog.
 *
 * The opener is a poor target after a confirm. The confirmed action usually starts a write,
 * and the preset library disables its buttons while a write is in flight. A delete also
 * removes the list row that opened the dialog. Two rules cover this:
 * - The caller can name the element that takes the focus after a confirm, whatever the
 *   opener, such as the row that takes the selection after a delete (`noteConfirmed`).
 * - When the opener cannot take the focus, the first fallback that can takes it. The caller
 *   can name one, and the last fallback is the enclosing dialog, which takes the focus and
 *   keeps it inside that dialog's focus trap.
 *
 * Unlike the settings dialog (see `dialogFocusReturn.ts`), this rule returns the focus after a
 * pointer close as well. That exception exists for an opener whose tooltip opens on every
 * focus. The toolbar buttons of the preset list have a tooltip, but it opens on a focus only
 * while the focus ring shows, so a focus return after a pointer close does not open it.
 */
export function createConfirmFocusReturn(): ConfirmFocusReturn {
  let candidates: readonly (FocusCandidate | null)[] = [];
  let confirmed = false;
  let confirmTarget: FocusCandidate | null = null;

  const canTakeFocus = (
    candidate: FocusCandidate | null,
  ): candidate is FocusCandidate =>
    candidate !== null && candidate.isConnected && !candidate.isDisabled;

  return {
    noteOpened: (opener, ...fallbacks) => {
      candidates = [opener?.isDocumentBody === true ? null : opener, ...fallbacks];
      confirmed = false;
      confirmTarget = null;
    },
    noteConfirmed: (target) => {
      confirmed = true;
      confirmTarget = target;
    },
    takeCloseTarget: () => {
      const recorded = confirmed ? [confirmTarget, ...candidates] : candidates;
      candidates = [];
      confirmed = false;
      confirmTarget = null;
      return recorded.find(canTakeFocus) ?? null;
    },
  };
}
