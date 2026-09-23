import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  presentQuitPrompt,
  presentReplacePrompt,
  type QuitGuardPromptView,
} from "./quitGuard";
import { quitGuard, type QuitGuardPrompt } from "./quitGuardController";

function presentPrompt(prompt: QuitGuardPrompt): QuitGuardPromptView {
  return prompt.kind === "quit"
    ? presentQuitPrompt(prompt.loss)
    : presentReplacePrompt(prompt);
}

const handleConfirm = () => {
  quitGuard.confirm();
};

const handleOpenChange = (open: boolean) => {
  if (!open) {
    // Radix closes the dialog after the confirm button runs `handleConfirm`, and the prompt
    // is already gone then, so this cancels only a Cancel, an Escape, or another dismissal.
    quitGuard.cancel();
  }
};

/**
 * The one dialog of the quit guard: "Quit QuipClip?" before a quit that loses work, and
 * "Replace the open video?" before another video hides the segments of the open one
 * (ADR 027). Mount it once, in the application shell.
 *
 * Cancel takes the focus when the dialog opens, so Enter never confirms by accident. The
 * dialog opens above any other dialog, such as the settings dialog with an unsaved preset
 * draft, and Cancel returns to that dialog with no change.
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
    />
  );
}
