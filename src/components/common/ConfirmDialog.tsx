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
  /**
   * Names the element that takes the focus when the dialog closes after a confirm, in place of
   * the element that opened it, such as the list row that takes the selection after a delete.
   * The dialog calls it when it closes, not when it opens. When it is absent or returns an
   * element that cannot take the focus, the rules of a cancel apply.
   */
  confirmFocus?: () => HTMLElement | null;
  /**
   * Names the element that takes the focus when the dialog closes and the element that opened
   * it cannot, or when nothing held the focus when it opened. The dialog calls it when it
   * closes. When it is absent or returns an element that cannot take the focus, the enclosing
   * dialog takes the focus.
   */
  fallbackFocus?: () => HTMLElement | null;
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
    get isDocumentBody() {
      return element === element.ownerDocument.body;
    },
    focus: () => {
      element.focus();
    },
  };
}

/**
 * Wraps a function that names an element, so that the focus rule reads the element when the
 * dialog closes. The element can change while the dialog is open.
 */
function toDeferredFocusCandidate(resolve: () => HTMLElement | null): FocusCandidate {
  return {
    get isConnected() {
      return toFocusCandidate(resolve())?.isConnected ?? false;
    },
    get isDisabled() {
      return toFocusCandidate(resolve())?.isDisabled ?? true;
    },
    focus: () => {
      resolve()?.focus();
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
  confirmFocus,
  fallbackFocus,
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
              fallbackFocus === undefined
                ? null
                : toDeferredFocusCandidate(fallbackFocus),
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
                onClick={() => {
                  focusReturn.noteConfirmed(
                    confirmFocus === undefined
                      ? null
                      : toDeferredFocusCandidate(confirmFocus),
                  );
                  onConfirm();
                }}
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
