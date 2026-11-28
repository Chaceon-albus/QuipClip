import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { RecoveryOfferSummary } from "@/features/recovery/types";
import { getResolvedLanguage } from "@/i18n";
import { fileMenuTrigger } from "./dialogFocusReturn";
import { recoveryPrompt } from "./recoveryPromptController";
import { presentRecoveryPrompt } from "./recoveryPromptPresenter";

const handleRestore = () => {
  void recoveryPrompt.restore();
};

const handleDiscard = () => {
  void recoveryPrompt.discard();
};

/**
 * The recovery prompt (ADR 073): "Restore the work that was not saved?", with Restore as the
 * primary button, Discard as the discard button, and Not Now as the cancel button, which has the
 * default focus. Mount it once, in the application shell.
 *
 * It is a modal dialog of the main window: the title bar knows it (`titleBarModal.ts`), and the
 * test "a dialog of the window is open" sees its `role="alertdialog"` (`MODAL_LAYER_SELECTOR`).
 * The controller `recoveryPrompt` decides when it shows, and the presenter
 * `presentRecoveryPrompt` gives its text.
 */
export function RecoveryPromptDialog() {
  const { t, i18n } = useTranslation();
  const translate = t as (
    key: string,
    options?: Readonly<Record<string, string | number>>,
  ) => string;
  const offer = useStore(recoveryPrompt.store, (state) => state.offer);

  // Keep the last offer while the dialog plays its close animation, so its text does not
  // disappear before the dialog does.
  const [shownOffer, setShownOffer] = useState<RecoveryOfferSummary | null>(offer);
  if (offer !== null && offer !== shownOffer) {
    setShownOffer(offer);
  }
  const view =
    shownOffer === null
      ? null
      : presentRecoveryPrompt(shownOffer, getResolvedLanguage(i18n));

  const handleOpenChange = (open: boolean) => {
    if (!open && offer !== null) {
      // Radix closes the dialog after a button runs its handler. The offer of this render is gone
      // then, so this acts only for Not Now, Escape, or another dismissal of the offer that this
      // render shows.
      recoveryPrompt.cancel(offer);
    }
  };

  return (
    <ConfirmDialog
      open={offer !== null}
      onOpenChange={handleOpenChange}
      title={view === null ? null : translate(view.title.key)}
      description={
        view === null ? null : (
          <div className="space-y-1">
            {view.lines.map((line) => (
              <p key={line.key}>{translate(line.key, line.values)}</p>
            ))}
          </div>
        )
      }
      confirmLabel={view === null ? null : translate(view.restore.key)}
      cancelLabel={view === null ? null : translate(view.notNow.key)}
      onConfirm={handleRestore}
      discard={
        view === null
          ? undefined
          : { label: translate(view.discard.key), onSelect: handleDiscard }
      }
      // A prompt for the next offer in the open dialog gives the focus to Not Now again.
      questionKey={shownOffer}
      // Nothing held the focus at the start of the page, so the focus goes to the File menu
      // trigger of the title bar at the close, and not to the document body.
      fallbackFocus={fileMenuTrigger}
    />
  );
}
