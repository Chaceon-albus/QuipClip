import { useState, type ReactNode } from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
  DESTRUCTIVE_CONFIRM_CLASS,
  createConfirmFocusReturn,
  type FocusCandidate,
} from "./confirmDialogModel";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Rendered in a `div`, so it can hold several paragraphs. */
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** Draws the confirm button as a solid destructive button. Default false. */
  destructive?: boolean;
  /** Disables the confirm button, for example while a write that it would race is running. */
  confirmDisabled?: boolean;
  /** Runs on the confirm button, before the dialog closes. */
  onConfirm: () => void;
}

// The modal layers that can hold an opener. The fallback focus target is the one around it.
const ENCLOSING_DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';

function toFocusCandidate(element: Element | null): FocusCandidate | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  // Getters, because the rule reads both values when the dialog closes, not when it opens.
  return {
    get isConnected() {
      return element.isConnected;
    },
    get isDisabled() {
      return element.matches(":disabled");
    },
    focus: () => {
      element.focus();
    },
  };
}

/**
 * A modal confirmation built on the Radix alert dialog, drawn like `DialogContent`.
 *
 * Radix gives the Cancel button the focus when the dialog opens, so Enter never confirms a
 * destructive action by accident. Escape closes only this dialog when it opens on top of
 * another one, because Radix dismisses only the highest layer. The footer order is Cancel and
 * then the confirm button, with the confirm button rightmost.
 *
 * The dialog has no trigger, so it owns the focus return. See `createConfirmFocusReturn`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [focusReturn] = useState(createConfirmFocusReturn);

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        {/* The overlay and content classes repeat `DialogOverlay` and `DialogContent` in
            `components/ui/dialog.tsx`, so the two kinds of dialog look the same. */}
        <AlertDialogPrimitive.Overlay className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialogPrimitive.Content
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onOpenAutoFocus={() => {
            // Radix dispatches this before it moves the focus to Cancel, so the active
            // element is still the element that opened the dialog.
            const opener = document.activeElement;
            focusReturn.noteOpened(
              toFocusCandidate(opener),
              toFocusCandidate(opener?.closest(ENCLOSING_DIALOG_SELECTOR) ?? null),
            );
          }}
          onCloseAutoFocus={(event) => {
            // Radix would focus its trigger, and this dialog has none.
            event.preventDefault();
            focusReturn.takeCloseTarget()?.focus();
          }}
        >
          <DialogHeader>
            <AlertDialogPrimitive.Title className="font-heading text-base leading-none font-medium">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild>
              <div className="text-sm text-muted-foreground">{description}</div>
            </AlertDialogPrimitive.Description>
          </DialogHeader>
          <DialogFooter>
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button
                className={destructive ? DESTRUCTIVE_CONFIRM_CLASS : undefined}
                disabled={confirmDisabled}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </DialogFooter>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
