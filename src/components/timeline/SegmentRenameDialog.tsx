import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { DialogActions } from "@/components/common/DialogActions";
import { isInOpenDialog, toLandingFocusTarget } from "@/components/common/focusTarget";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { timelineStore } from "@/features/timeline";
import { segmentRenameDialogStore } from "./segmentRenameDialogStore";
import {
  initialSegmentRenameText,
  planSegmentRenameConfirm,
  readSegmentRenameText,
  resolveSegmentRenameKey,
  returnSegmentRenameFocus,
  SEGMENT_ID_ATTRIBUTE,
  spliceSegmentRenamePaste,
  TIMELINE_SEEK_SURFACE_SELECTOR,
  type SegmentRenameFocusTarget,
} from "./segmentRenameModel";
import { segmentTrimSession } from "./segmentTrimSession";

const handleOpenChange = (open: boolean) => {
  if (!open) {
    segmentRenameDialogStore.getState().close();
  }
};

/** The bar of the segment, then the seek surface of the timeline, as focus fallbacks. */
function timelineFocusFallbacks(
  segmentId: string,
): (SegmentRenameFocusTarget | null)[] {
  const bar = Array.from(
    document.querySelectorAll<HTMLElement>(`[${SEGMENT_ID_ATTRIBUTE}]`),
  ).find((element) => element.getAttribute(SEGMENT_ID_ATTRIBUTE) === segmentId);
  return [
    toLandingFocusTarget(bar ?? null),
    toLandingFocusTarget(
      document.querySelector<HTMLElement>(TIMELINE_SEEK_SURFACE_SELECTOR),
    ),
  ];
}

interface SegmentRenameContentProps {
  /** The id of the segment that the dialog renames, fixed from the moment it opened. */
  readonly segmentId: string;
  /** The `openCount` of the open that mounted this content. */
  readonly openCount: number;
  /** True while the dialog is open. False during the exit animation. */
  readonly isOpen: boolean;
}

/**
 * The content of one open of the dialog. It reads the name of its segment once, when it mounts,
 * so a change of the timeline while the dialog is open does not replace the text of the user.
 */
function SegmentRenameContent({
  segmentId,
  openCount,
  isOpen,
}: SegmentRenameContentProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(() =>
    initialSegmentRenameText(timelineStore.getState().sequenceSegments, segmentId),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The element that held the focus when the dialog opened, or null for the body.
  const openerRef = useRef<HTMLElement | null>(null);
  // The caret that a paste set, for the next layout of the field.
  const caretRef = useRef<number | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const textState = readSegmentRenameText(text);
  const isTooLong = textState.kind === "tooLong";

  useLayoutEffect(() => {
    const caret = caretRef.current;
    caretRef.current = null;
    if (caret !== null) {
      inputRef.current?.setSelectionRange(caret, caret);
    }
  }, [text]);

  const confirm = () => {
    // Every fact is read now, never from a closure of an earlier render: the confirm of a
    // dialog that is closing does nothing (`canRunSegmentRenameConfirm`).
    const plan = planSegmentRenameConfirm({
      text: inputRef.current?.value ?? text,
      segmentId,
      liveSegmentIds: new Set(
        timelineStore.getState().segments.map((segment) => segment.id),
      ),
      dialog: segmentRenameDialogStore.getState(),
      openCount,
      isTrimLocked: segmentTrimSession.isLocked(),
    });
    if (plan.kind === "ignore" || plan.kind === "refuse") {
      return;
    }
    if (plan.kind === "rename") {
      timelineStore.getState().renameSegment(plan.segmentId, plan.name);
    }
    segmentRenameDialogStore.getState().close();
  };

  return (
    <DialogContent
      showCloseButton={false}
      // A closing dialog takes no input, so an Enter after Escape during the exit animation
      // cannot confirm the discarded text.
      inert={!isOpen}
      onOpenAutoFocus={(event) => {
        // Radix dispatches this before it moves the focus, so the active element is still the
        // element that opened the dialog.
        const opener = document.activeElement;
        openerRef.current =
          opener instanceof HTMLElement && opener !== document.body ? opener : null;
        // Radix would focus the field with the caret at the end. The field holds the name with
        // all its text selected (ADR 065), so a key press replaces it.
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }}
      onCloseAutoFocus={(event) => {
        // A dialog that opened meanwhile keeps the focus.
        if (isInOpenDialog(document.activeElement)) {
          event.preventDefault();
          return;
        }
        // The dialog has no Radix trigger. The focus goes back to the element that held it at
        // the open, or else to the timeline, so a keyboard user keeps the place.
        event.preventDefault();
        returnSegmentRenameFocus(
          toLandingFocusTarget(openerRef.current),
          timelineFocusFallbacks(segmentId),
        );
      }}
      // Radix takes Escape in its own listener, before the field. While the input method
      // composes text, Escape belongs to it, and the dialog stays open.
      onEscapeKeyDown={(event) => {
        if (resolveSegmentRenameKey(event) !== "cancel") {
          event.preventDefault();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("timeline.renameSegment.title")}</DialogTitle>
        {/* Radix links the description to the dialog, so a screen reader reads the hint when
            the dialog opens. */}
        <DialogDescription>{t("timeline.renameSegment.hint")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">
          {t("timeline.renameSegment.field")}
        </label>
        {/* The field has no `maxLength`: that attribute counts UTF-16 code units in Chromium and
            grapheme clusters in WebKit, and the rule counts Unicode scalar values. A text that
            is too long shows the message below, and the confirm does nothing. `select-text`
            restores text selection, which the application shell turns off. */}
        <Input
          ref={inputRef}
          id={fieldId}
          type="text"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onPaste={(event) => {
            // A text field turns a line break of a paste into a space before `onChange`. The
            // dialog reads the raw text and removes the characters that a name cannot have
            // itself (`spliceSegmentRenamePaste`).
            const field = event.currentTarget;
            const pasted = event.clipboardData.getData("text/plain");
            event.preventDefault();
            const next = spliceSegmentRenamePaste(
              field.value,
              field.selectionStart ?? field.value.length,
              field.selectionEnd ?? field.value.length,
              pasted,
            );
            if (!next.changed) {
              // No render follows, so the caret goes after the paste now.
              field.setSelectionRange(next.caret, next.caret);
              return;
            }
            caretRef.current = next.caret;
            setText(next.text);
          }}
          onKeyDown={(event) => {
            const action = resolveSegmentRenameKey({
              key: event.key,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            });
            if (action === "confirm") {
              event.preventDefault();
              confirm();
            }
          }}
          aria-invalid={isTooLong}
          aria-describedby={isTooLong ? errorId : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="select-text"
        />
        {textState.kind === "tooLong" && (
          <p id={errorId} className="text-xs text-destructive-text">
            {t("timeline.renameSegment.tooLong", {
              length: textState.length,
              max: textState.max,
            })}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogActions
          cancel={
            <DialogClose asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
          }
          primary={
            <Button disabled={isTooLong} onClick={confirm}>
              {t("timeline.renameSegment.confirm")}
            </Button>
          }
        />
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The Rename Segment dialog (ADR 065). Mount it once, in the application shell.
 *
 * The action opens it for the current segment (`segmentRenameDialogStore`), and the dialog names
 * that segment by its id until it closes. The field holds the name with all its text selected.
 * Enter and the confirm button apply the text (`planSegmentRenameConfirm`), and Escape and the
 * cancel button keep the name. While the input method composes text, Enter and Escape belong to
 * it. While the dialog is open, the window keyboard layer and the command items of the macOS
 * menu do nothing, because it is a modal layer (ADR 021). At the close the focus goes back to the
 * element that held it at the open, or else to the timeline (`returnSegmentRenameFocus`).
 */
export function SegmentRenameDialog() {
  const segmentId = useStore(segmentRenameDialogStore, (state) => state.segmentId);
  const openCount = useStore(segmentRenameDialogStore, (state) => state.openCount);
  // Keep the last segment while the dialog plays its close animation, so its content stays.
  const [shownId, setShownId] = useState<string | null>(segmentId);
  if (segmentId !== null && segmentId !== shownId) {
    setShownId(segmentId);
  }
  return (
    <Dialog open={segmentId !== null} onOpenChange={handleOpenChange}>
      {shownId !== null && (
        // A new key at each open, so the field starts with the name of its segment.
        <SegmentRenameContent
          key={openCount}
          segmentId={shownId}
          openCount={openCount}
          isOpen={segmentId !== null}
        />
      )}
    </Dialog>
  );
}
