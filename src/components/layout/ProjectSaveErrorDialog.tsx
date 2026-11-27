import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createConfirmFocusReturn } from "@/components/common/confirmDialogModel";
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";
import { DialogActions } from "@/components/common/DialogActions";
import {
  ENCLOSING_DIALOG_SELECTOR,
  toDeferredFocusCandidate,
  toFocusCandidate,
} from "@/components/common/focusCandidate";
import { isInOpenDialog, OPEN_DIALOG_SELECTOR } from "@/components/common/focusTarget";
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
import {
  projectSaveErrorStore,
  useProjectSaveErrorStore,
} from "@/features/project/saveErrorStore";
import type { ProjectSaveError } from "@/features/project/saveStep";
import { TITLE_BAR_FILE_MENU_SELECTOR } from "@/lib/titleBar";
import {
  PROJECT_SAVE_ERROR_TITLE_KEY,
  presentProjectSaveError,
} from "./projectSaveErrorPresenter";

/**
 * The File menu trigger of the title bar, a stable element, while no other dialog of the page is
 * open. Save from an item of that menu opens this dialog after the item is gone, so the focus
 * goes there in place of the document body. It never goes behind a dialog that is still open.
 */
const fileMenuTrigger = (): HTMLElement | null =>
  document.querySelector(OPEN_DIALOG_SELECTOR) === null
    ? document.querySelector<HTMLElement>(TITLE_BAR_FILE_MENU_SELECTOR)
    : null;

/**
 * The dialog that held `opener` at the open, while that dialog is still open, or null. Radix
 * keeps a closing dialog in the document during its exit animation, and that one does not count.
 */
function openEnclosingDialog(opener: Element | null): () => HTMLElement | null {
  const enclosing = opener?.closest<HTMLElement>(ENCLOSING_DIALOG_SELECTOR) ?? null;
  return () =>
    enclosing !== null &&
    enclosing.isConnected &&
    enclosing.matches(OPEN_DIALOG_SELECTOR)
      ? enclosing
      : null;
}

const handleOpenChange = (open: boolean) => {
  if (!open) {
    projectSaveErrorStore.getState().dismiss();
  }
};

/**
 * The dialog of a save of the project that failed (ADR 072). The Save action and the save prompt
 * of the quit and of Clear Timeline report the error, and this dialog shows it. It has one
 * button, which closes it. A diagnostic text of the system shows in its details, untranslated
 * (ADR 011). Mount it once, in the application shell.
 *
 * It is a modal dialog of the main window: the title bar knows it (`titleBarModal.ts`), and the
 * test "a dialog of the window is open" sees its `role="dialog"` (`MODAL_LAYER_SELECTOR`).
 */
export function ProjectSaveErrorDialog() {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Readonly<Record<string, string>>,
  ) => string;
  const error = useProjectSaveErrorStore((state) => state.error);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [focusReturn] = useState(createConfirmFocusReturn);

  // Keep the last error while the dialog plays its close animation, so its text does not
  // disappear before the dialog does.
  const [shownError, setShownError] = useState<ProjectSaveError | null>(error);
  if (error !== null && error !== shownError) {
    setShownError(error);
  }
  const view = shownError === null ? null : presentProjectSaveError(shownError);

  return (
    <Dialog open={error !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          // Radix dispatches this before it moves the focus, so the active element is still the
          // element that held the focus at the open. At the close the focus goes to that element
          // when it can take the focus, else to the dialog that held it while that dialog is
          // still open, else to the File menu trigger while no dialog of the page is open, as in
          // `ConfirmDialog` (`createConfirmFocusReturn`).
          const opener = document.activeElement;
          focusReturn.noteOpened(
            toFocusCandidate(opener),
            toDeferredFocusCandidate(openEnclosingDialog(opener)),
            toDeferredFocusCandidate(fileMenuTrigger),
          );
          // The one button takes the focus, and not the disclosure of the details.
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // The dialog has no Radix trigger. A dialog that opened meanwhile keeps the focus.
          event.preventDefault();
          const target = focusReturn.takeCloseTarget();
          if (!isInOpenDialog(document.activeElement)) {
            target?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(PROJECT_SAVE_ERROR_TITLE_KEY)}</DialogTitle>
          <DialogDescription>
            {view === null ? null : translate(view.message.key, view.message.values)}
          </DialogDescription>
        </DialogHeader>
        {view?.detail != null ? (
          <DiagnosticDetails
            summary={t("projectSaveError.details.show")}
            openSummary={t("projectSaveError.details.hide")}
            text={view.detail}
          />
        ) : null}
        <DialogFooter>
          <DialogActions
            cancel={
              <DialogClose asChild>
                <Button ref={closeRef} variant="outline">
                  {t("common.close")}
                </Button>
              </DialogClose>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
