import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  getDialogPlatform,
  orderDialogActions,
  type DialogActionRole,
  type DialogPlatform,
} from "./dialogActionsModel";

/** An action of a footer other than the primary action and Cancel. */
export interface DialogExtraAction {
  /** Unique among the extra actions of one footer. */
  key: string;
  /** `discard` for a destructive action that throws away work, else `alternative`. */
  role: Extract<DialogActionRole, "discard" | "alternative">;
  /** The button. Null or false renders nothing, as for a button that does not apply. */
  node: ReactNode;
}

export interface DialogActionsProps {
  /**
   * The action that the dialog proposes, usually the default button. Null, false, or absent
   * when the footer has none.
   */
  primary?: ReactNode;
  /**
   * The button that goes back, or closes the dialog when nothing is left to do, and changes
   * nothing, such as Cancel, Close, or Done. It can be the default button. Null, false, or
   * absent when the footer has none.
   */
  cancel?: ReactNode;
  /** Every other action, in the order that the actions of one role take among themselves. */
  extras?: readonly DialogExtraAction[];
  /**
   * Content before the buttons, at the start of the row, such as a prompt message or a note.
   * It becomes narrower when the row is full, and its text wraps, so the buttons stay on one
   * line and the footer keeps its height when a short note appears.
   */
  leading?: ReactNode;
  /** The platform whose order applies. Defaults to the platform of the web view. */
  platform?: DialogPlatform;
  className?: string;
}

interface OrderedAction {
  role: DialogActionRole;
  key: string;
  node: ReactNode;
}

function isRendered(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== "boolean";
}

/**
 * The buttons of a dialog footer, in the order of the platform (`orderDialogActions`).
 *
 * - macOS: the primary action rightmost, with Cancel at its left, and a discard at the far
 *   left with a wider gap after it.
 * - Windows: the primary action first, with Cancel last, and a discard directly after the
 *   primary action.
 *
 * The buttons are right-aligned on both platforms. The document order is the visual order,
 * so Tab moves through the buttons in the order that the user sees. The row is one flex
 * item, so a footer that reverses its own direction does not reverse the buttons.
 *
 * The component only places the buttons. The caller keeps each button, with its style, its
 * handlers, its refs, and a Radix `Cancel` or `Action` wrapper. The default focus is the
 * caller's rule too: a dialog that confirms a destructive or lossy action gives the focus to
 * Cancel, so Enter changes nothing.
 */
export function DialogActions({
  primary,
  cancel,
  extras = [],
  leading,
  platform,
  className,
}: DialogActionsProps) {
  const actions: OrderedAction[] = [];
  if (isRendered(primary)) {
    actions.push({ role: "primary", key: "primary", node: primary });
  }
  if (isRendered(cancel)) {
    actions.push({ role: "cancel", key: "cancel", node: cancel });
  }
  for (const extra of extras) {
    if (isRendered(extra.node)) {
      actions.push({ role: extra.role, key: `extra:${extra.key}`, node: extra.node });
    }
  }

  const placed = orderDialogActions(platform ?? getDialogPlatform(), actions);
  const apart = placed.filter((placement) => placement.apart);
  const grouped = placed.filter((placement) => !placement.apart);

  // The group takes the free width in front of it (`ms-auto`), so it stays at the right
  // edge, and the leading content and an action that stands apart stay at the left. The
  // margin after an action that stands apart keeps it clear of the group in a full row. Only
  // the leading content can become narrower (`min-w-0`), because the buttons do not shrink.
  return (
    <div className={cn("flex w-full items-center gap-2", className)}>
      {isRendered(leading) ? <div className="min-w-0">{leading}</div> : null}
      {apart.length > 0 ? (
        <div className="me-4 flex shrink-0 items-center gap-2">
          {apart.map(({ action }) => (
            <Fragment key={action.key}>{action.node}</Fragment>
          ))}
        </div>
      ) : null}
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {grouped.map(({ action }) => (
          <Fragment key={action.key}>{action.node}</Fragment>
        ))}
      </div>
    </div>
  );
}
