import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { fileMenuTrigger } from "./dialogFocusReturn";
import {
  presentClearPrompt,
  presentOpenPrompt,
  presentQuitPrompt,
  type QuitGuardPromptView,
} from "./quitGuard";
import { quitGuard, type QuitGuardPrompt } from "./quitGuardController";

function presentPrompt(prompt: QuitGuardPrompt): QuitGuardPromptView {
  switch (prompt.kind) {
    case "quit":
      return presentQuitPrompt(prompt.loss);
    case "clear":
      return presentClearPrompt(prompt.change);
    case "open":
      return presentOpenPrompt(prompt.project);
  }
}

const handleConfirm = () => {
  quitGuard.confirm();
};

const handleDiscard = () => {
  quitGuard.discard();
};

/**
 * The one dialog of the quit guard: "Quit QuipClip?" before a quit that loses work (ADR 027),
 * the dialog before Clear Timeline (ADR 052), the save prompt of both, and the save prompt of the
 * open of a project (ADR 072), with Save, Don't Save and Cancel. Mount it once, in the
 * application shell.
 *
 * Cancel takes the focus when the dialog opens, so Enter never confirms by accident. The
 * dialog opens above any other dialog, such as the export dialog, and Cancel returns to that
 * dialog with no change. An unsaved preset draft is in the Settings window, which stays as it
 * is.
 */
export function QuitGuardDialog() {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Readonly<Record<string, string | number>>,
  ) => string;
  const prompt = useStore(quitGuard.store, (state) => state.prompt);

  // Keep the last prompt while the dialog plays its close animation, so its text does not
  // disappear before the dialog does.
  const [shownPrompt, setShownPrompt] = useState<QuitGuardPrompt | null>(prompt);
  if (prompt !== null && prompt !== shownPrompt) {
    setShownPrompt(prompt);
  }
  const view = shownPrompt === null ? null : presentPrompt(shownPrompt);

  const handleOpenChange = (open: boolean) => {
    if (!open && prompt !== null) {
      // Radix closes the dialog after a button runs its handler. The prompt of this render is
      // gone then, or a new prompt took its place, so this cancels only a Cancel, an Escape, or
      // another dismissal of the prompt that this render shows.
      quitGuard.cancel(prompt);
    }
  };

  const discard = view?.discard ?? null;

  return (
    <ConfirmDialog
      open={prompt !== null}
      onOpenChange={handleOpenChange}
      title={view === null ? null : translate(view.title.key, view.title.values)}
      description={
        view === null ? null : (
          <ul className="list-disc space-y-1 pl-5">
            {view.lines.map((line) => (
              <li key={line.key}>{translate(line.key, line.values)}</li>
            ))}
          </ul>
        )
      }
      confirmLabel={view === null ? null : translate(view.confirm.key)}
      cancelLabel={t("common.cancel")}
      destructive={view?.destructive ?? false}
      onConfirm={handleConfirm}
      discard={
        discard === null
          ? undefined
          : { label: translate(discard.key), onSelect: handleDiscard }
      }
      // A new prompt in the open dialog gives the focus to Cancel again.
      questionKey={shownPrompt}
      // A quit prompt can take the place of the project dialog, which then held the focus and is
      // gone at the close. The focus goes to the File menu trigger of the title bar then, as after
      // the project dialogs, and not to the document body.
      fallbackFocus={fileMenuTrigger}
    />
  );
}
