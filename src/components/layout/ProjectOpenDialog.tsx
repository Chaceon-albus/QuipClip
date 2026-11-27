import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { createConfirmFocusReturn } from "@/components/common/confirmDialogModel";
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";
import {
  toDeferredFocusCandidate,
  toFocusCandidate,
} from "@/components/common/focusCandidate";
import { isInOpenDialog } from "@/components/common/focusTarget";
import { DialogActions } from "@/components/common/DialogActions";
import { ProgressBar } from "@/components/common/ProgressBar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OpenProjectState } from "@/features/project/openStep";
import { fileMenuTrigger, openEnclosingDialog } from "./dialogFocusReturn";
import {
  presentProjectOpen,
  type ProjectOpenMessage,
  type ProjectOpenRowView,
} from "./projectOpenPresenter";
import { quitGuard } from "./quitGuardController";

const openStep = quitGuard.openStep;

// Cancel, Escape and the close of the error view all stop the open step (ADR 072). `cancel()`
// also stops each open request that waits for its turn. The open of a project is a flow of the
// quit guard until it ends, so no second open can wait behind the one that this dialog shows,
// and the dialog needs no other cancel.
const handleOpenChange = (open: boolean) => {
  if (!open) {
    openStep.cancel();
  }
};

const handleCancel = () => {
  openStep.cancel();
};

const handleConfirm = () => {
  openStep.confirm();
};

/** Prevents the close of the dialog by a press outside it. */
const keepOpen = (event: Event) => {
  event.preventDefault();
};

type Translate = (
  key: string,
  options?: Readonly<Record<string, string | number>>,
) => string;

function OpenRow({
  row,
  translate,
}: {
  row: ProjectOpenRowView;
  translate: Translate;
}) {
  const { t } = useTranslation();
  const text = (message: ProjectOpenMessage) => translate(message.key, message.values);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium wrap-break-word text-foreground">{row.fileName}</p>
          <p className="text-xs wrap-break-word text-muted-foreground">
            {text(row.documentPath)}
          </p>
        </div>
        {row.showsLocate && (
          <Button
            variant="outline"
            size="xs"
            disabled={!row.canLocate}
            aria-label={text(row.locateLabel)}
            onClick={() => {
              void openStep.locate(row.entryId);
            }}
          >
            {t("projectOpen.locate")}
          </Button>
        )}
      </div>
      {row.status.kind === "found" ? (
        <p className="text-xs wrap-break-word text-success">
          {text(row.status.message)}
        </p>
      ) : (
        <>
          {row.status.reasons.map((reason) => (
            <p
              key={reason.key}
              className="text-xs wrap-break-word text-destructive-text"
            >
              {text(reason)}
            </p>
          ))}
          {row.status.detail !== null && (
            <DiagnosticDetails
              summary={t("projectOpen.details.show")}
              openSummary={t("projectOpen.details.hide")}
              text={row.status.detail}
            />
          )}
        </>
      )}
    </li>
  );
}

/**
 * The project dialog (ADR 072, "The open of a project"). It shows the store of the open step of
 * the page: the read of the project file, the check of each file with a progress, the list of
 * the files to locate with Open and Cancel, and the error of an open that failed with one button
 * that closes it. Mount it once, in the application shell.
 *
 * It is a modal dialog of the main window: the title bar knows it (`titleBarModal.ts`), and the
 * test "a dialog of the window is open" sees its `role="dialog"` (`MODAL_LAYER_SELECTOR`). A
 * press outside it does not close it. Escape is Cancel. The text comes from the pure presenter
 * `presentProjectOpen`.
 *
 * The dialog has no Radix trigger, so it owns the focus return, as `ProjectSaveErrorDialog` does:
 * at the close the focus goes to the element that held it at the open when that element can take
 * the focus, else to the dialog that held it while that dialog is still open, else to the File
 * menu trigger while no other dialog of the page is open. A dialog that opened meanwhile, such as
 * the quit prompt, keeps the focus.
 */
export function ProjectOpenDialog() {
  const { t } = useTranslation();
  const translate = t as Translate;
  const state = useStore(openStep.store);

  // Keep the last state while the dialog plays its close animation, so its text does not
  // disappear before the dialog does.
  const [shownState, setShownState] = useState<OpenProjectState>(state);
  if (state.phase.kind !== "idle" && state !== shownState) {
    setShownState(state);
  }
  const view = presentProjectOpen(shownState);
  const open = state.phase.kind !== "idle";
  const text = (message: ProjectOpenMessage) => translate(message.key, message.values);
  const [focusReturn] = useState(createConfirmFocusReturn);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg"
        onPointerDownOutside={keepOpen}
        onInteractOutside={keepOpen}
        onOpenAutoFocus={() => {
          // Radix dispatches this before it moves the focus, so the active element is still the
          // element that held the focus at the open. Radix then focuses the first control.
          const opener = document.activeElement;
          focusReturn.noteOpened(
            toFocusCandidate(opener),
            toDeferredFocusCandidate(openEnclosingDialog(opener)),
            toDeferredFocusCandidate(fileMenuTrigger),
          );
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = focusReturn.takeCloseTarget();
          if (!isInOpenDialog(document.activeElement)) {
            target?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{view === null ? null : text(view.title)}</DialogTitle>
          <DialogDescription>
            {view === null ? null : text(view.message)}
          </DialogDescription>
        </DialogHeader>
        {view?.kind === "loading" && (
          <ProgressBar value={null} size="sm" aria-label={text(view.message)} />
        )}
        {view?.kind === "checking" && (
          <ProgressBar value={view.percent} size="sm" aria-label={text(view.message)} />
        )}
        {view?.kind === "locating" && (
          // The up and down arrows scroll the list while it overflows (`SCROLL_KEYS_ATTRIBUTE`).
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" data-scroll-keys>
            {view.rows.map((row) => (
              <OpenRow key={row.entryId} row={row} translate={translate} />
            ))}
          </ul>
        )}
        {view?.kind === "failed" && view.detail !== null && (
          <DiagnosticDetails
            summary={t("projectOpen.details.show")}
            openSummary={t("projectOpen.details.hide")}
            text={view.detail}
          />
        )}
        <DialogFooter>
          {view?.kind === "failed" ? (
            <DialogActions
              cancel={
                <Button variant="outline" onClick={handleCancel}>
                  {t("common.close")}
                </Button>
              }
            />
          ) : (
            <DialogActions
              cancel={
                <Button variant="outline" onClick={handleCancel}>
                  {t("common.cancel")}
                </Button>
              }
              primary={
                view?.kind === "locating" ? (
                  <Button disabled={!view.canOpen} onClick={handleConfirm}>
                    {t("projectOpen.open")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
