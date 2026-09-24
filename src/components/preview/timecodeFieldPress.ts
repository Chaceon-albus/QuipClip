/**
 * The pointer rule of the open timecode field (ADR 028).
 *
 * A press anywhere outside the field closes it and keeps the position, as Escape does. A blur
 * cannot carry this rule alone: the buttons of the transport bar, the frame step buttons and the
 * zoom buttons do not take the focus from a press (`preventFocusOnMouseDown`, ADR 021), so a press
 * on Play or Mark In does its action and leaves the focus in the field. The field would then stay
 * open, and Space would type a space in it instead of starting playback. The preview listens for
 * a press on the whole document in the capture phase while the field is open, so the rule runs
 * before the handler of the control that the user pressed, and that control still acts.
 */

/** The part of a DOM node that the rule reads, so a test can pass a fake. */
export interface PressContainer<TNode> {
  /** Answers `Node.contains(other)` for the element that holds the field and its error. */
  readonly contains: (other: TNode | null) => boolean;
}

/**
 * True when a press closes the open field: its target is outside the element that holds the
 * field and its error. A press with no target node counts as outside. With no field there is
 * nothing to close.
 *
 * @param field The element that holds the open field and its error, or null.
 * @param target The node that the press landed on, or null.
 */
export function closesFieldOnPress<TNode>(
  field: PressContainer<TNode> | null,
  target: TNode | null,
): boolean {
  if (field === null) {
    return false;
  }
  return target === null || !field.contains(target);
}
