import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  isSettingsSection,
  settingsPanelStore,
  useSettingsPanelStore,
  type SettingsSection,
} from "@/features/settings/panelStore";
import { settingsStore, useSettingsStore } from "@/features/settings/store";
import { createDialogFocusReturn } from "./dialogFocusReturn";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  decideCloseRequest,
  decidePromptSaveOutcome,
  isElementRendered,
  pickPromptCancelFocus,
  pickPromptOpenFocus,
  presentUnsavedDraftPrompt,
  type PresetDraftGuard,
  type PromptFocusTarget,
} from "./presetDraftGuard";
import { presentSettingsError } from "./settingsErrorPresenter";
import { FfmpegPathSection } from "./FfmpegPathSection";
import { GeneralSection } from "./GeneralSection";
import { PresetLibrarySection } from "./PresetLibrarySection";

const hideSettings = () => {
  settingsPanelStore.getState().hide();
};

const handleSectionChange = (value: string) => {
  if (isSettingsSection(value)) {
    settingsPanelStore.getState().setSection(value);
  }
};

/** The unsaved-changes prompt that a close request raised. */
type ClosePrompt = {
  /** The element that held the focus when the prompt opened. Cancel gives it back. */
  returnFocus: HTMLElement | null;
};

/** The section that holds the preset editor, which the unsaved-changes prompt is about. */
const PRESETS_SECTION: SettingsSection = "presets";

function toPromptFocusTarget(element: HTMLElement | null): PromptFocusTarget | null {
  if (element === null) {
    return null;
  }
  // Getters, because the rules read the element when the focus moves, not when it is wrapped.
  return {
    get isConnected() {
      return element.isConnected;
    },
    get isRendered() {
      return isElementRendered(element);
    },
    get isDisabled() {
      return element.matches(":disabled");
    },
    focus: () => {
      element.focus();
    },
  };
}

/** Gives the focus to Cancel, or to the prompt message while Cancel is disabled. */
function focusPrompt(cancel: HTMLElement | null, message: HTMLElement | null): void {
  pickPromptOpenFocus(
    toPromptFocusTarget(cancel),
    toPromptFocusTarget(message),
  )?.focus();
}

/**
 * The settings dialog. `AppShell` mounts it once, and the settings panel store opens it and
 * selects its tab, so any component can open it on a given section. A `show` while the
 * dialog is open only changes the tab.
 *
 * A close request cannot drop an unsaved preset draft. Escape, the close button in the
 * header, and the Close button in the footer all reach `onOpenChange(false)`. The dialog is
 * controlled by the panel store, so it stays open when `requestClose` does not call `hide`.
 * With a dirty draft, the footer shows the unsaved-changes prompt instead of the Close
 * button, and the dialog switches to the preset tab. A second close request dismisses the
 * prompt. See `decideCloseRequest`. A press outside the dialog never closes it, because the
 * dialog is a form.
 *
 * The panel store's `hide` stays an unconditional close. The dialog calls it only after the
 * guard allows the close or the user answered the prompt.
 */
export function SettingsDialog() {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;
  const open = useSettingsPanelStore((state) => state.open);
  const section = useSettingsPanelStore((state) => state.section);
  const error = useSettingsStore((state) => state.error);
  const status = useSettingsStore((state) => state.status);
  const settings = useSettingsStore((state) => state.settings);
  const errorView = presentSettingsError(error);
  const focusReturn = useMemo(() => createDialogFocusReturn(), []);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The preset library reports its draft here. Its unmount reports the clean guard.
  const [presetDraft, setPresetDraft] = useState<PresetDraftGuard>(
    CLEAN_PRESET_DRAFT_GUARD,
  );
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const promptCancelRef = useRef<HTMLButtonElement>(null);
  const promptMessageRef = useRef<HTMLParagraphElement>(null);
  const footerCloseRef = useRef<HTMLButtonElement>(null);
  // Set by Cancel and read by the effect below, after the footer shows the Close button again.
  const cancelledPromptRef = useRef<ClosePrompt | null>(null);

  const unsavedPrompt =
    closePrompt === null ? null : presentUnsavedDraftPrompt(presetDraft);

  // Drop the prompt as soon as the draft is clean, derived during render the way the preset
  // library drops its switch prompt. A Save or a Cancel in the preset editor clears the draft
  // while the prompt is open, and the prompt then has nothing left to ask about.
  if (closePrompt !== null && unsavedPrompt === null) {
    setClosePrompt(null);
  }

  useEffect(() => {
    if (closePrompt !== null) {
      // This also takes a keyboard user from the field that raised the prompt to the prompt.
      focusPrompt(promptCancelRef.current, promptMessageRef.current);
      return;
    }
    const cancelled = cancelledPromptRef.current;
    cancelledPromptRef.current = null;
    if (cancelled !== null) {
      pickPromptCancelFocus(
        toPromptFocusTarget(cancelled.returnFocus),
        toPromptFocusTarget(footerCloseRef.current),
      )?.focus();
    }
  }, [closePrompt]);

  const cancelPrompt = () => {
    cancelledPromptRef.current = closePrompt;
    setClosePrompt(null);
  };

  const requestClose = () => {
    switch (decideCloseRequest(presetDraft, closePrompt !== null)) {
      case "close":
        hideSettings();
        return;
      case "raise": {
        const active = document.activeElement;
        setClosePrompt({
          returnFocus:
            active instanceof HTMLElement && active !== document.body ? active : null,
        });
        // Show the draft the prompt is about. The tab switch also scrolls the body to the
        // top, where the preset list marks the unsaved preset.
        if (section !== PRESETS_SECTION) {
          settingsPanelStore.getState().setSection(PRESETS_SECTION);
        }
        return;
      }
      case "cancel":
        cancelPrompt();
        return;
      case "hold":
        focusPrompt(promptCancelRef.current, promptMessageRef.current);
        return;
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      settingsPanelStore.getState().show();
    } else {
      requestClose();
    }
  };

  const handleDontSave = () => {
    presetDraft.discard();
    hideSettings();
  };

  // Closes only when the save succeeded and left nothing unsaved. A failed save keeps the
  // dialog and the prompt open, and the error notice at the top of the scrolling body reports
  // the failure. See `decidePromptSaveOutcome`.
  const handleSaveAndClose = async () => {
    // The save disables every choice while it runs, and a disabled button drops the focus to
    // the document body. The message keeps the focus inside the prompt.
    promptMessageRef.current?.focus();
    const saved = await presetDraft.save();
    // The store clears its error when a save starts, so an error here belongs to this save.
    switch (decidePromptSaveOutcome(saved, settingsStore.getState().error !== null)) {
      case "close":
        hideSettings();
        return;
      case "revealError":
        if (bodyRef.current !== null) {
          bodyRef.current.scrollTop = 0;
        }
        return;
      case "stay":
        return;
    }
  };

  // The load failed and no document survived it. Every control below then disables itself,
  // so without this the dialog has no way out and the user must delete the file by hand.
  // `reset_settings` is the escape hatch ADR 013 defines: it renames the damaged file to
  // settings.invalid.json and writes fresh seeds.
  const canRecover = status === "error" && settings === null;

  useEffect(() => {
    if (open) {
      void settingsStore.getState().loadSettings();
    }
  }, [open]);

  // Each tab starts at its top. All panels share one scroll container, so without this a
  // tab would open at the offset the previous tab was scrolled to.
  useLayoutEffect(() => {
    if (bodyRef.current !== null) {
      bodyRef.current.scrollTop = 0;
    }
  }, [section]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // A fixed height, not only a maximum, so the dialog keeps its size when the user
        // switches between a short tab and a long one. The body below scrolls instead.
        className="flex h-[min(85vh,48rem)] flex-col overflow-hidden sm:max-w-2xl"
        onOpenAutoFocus={() => {
          // Radix dispatches this before it moves the focus, so the active element is still
          // the element that opened the dialog.
          focusReturn.noteOpened(
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
          );
        }}
        onKeyDownCapture={() => {
          focusReturn.noteInteraction("keyboard");
        }}
        onEscapeKeyDown={() => {
          focusReturn.noteInteraction("keyboard");
        }}
        onPointerDownCapture={() => {
          focusReturn.noteInteraction("pointer");
        }}
        onInteractOutside={(event) => {
          // The dialog is a form. A stray press outside it must not close it, with or
          // without an unsaved draft. The dialog closes from Escape, the close button in
          // the header, and the footer.
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // Radix would focus its trigger, and this dialog has none. See dialogFocusReturn.ts
          // for why a pointer close leaves the focus on the body.
          event.preventDefault();
          focusReturn.takeCloseTarget()?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
            <XIcon />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </DialogClose>

        <TabsPrimitive.Root
          value={section}
          onValueChange={handleSectionChange}
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          <TabsPrimitive.List
            aria-label={t("settings.title")}
            className="inline-flex h-8 w-fit shrink-0 items-center rounded-lg bg-muted p-[3px] text-muted-foreground"
          >
            <SettingsTab value="general">{t("settings.tab.general")}</SettingsTab>
            <SettingsTab value="ffmpeg">{t("settings.tab.ffmpeg")}</SettingsTab>
            <SettingsTab value="presets">{t("settings.tab.presets")}</SettingsTab>
          </TabsPrimitive.List>

          {/* Scrollable body keeps header, close button, tabs, and footer pinned */}
          <div
            ref={bodyRef}
            className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-1"
          >
            {errorView ? (
              <Notice tone="destructive" role="alert">
                {translate(errorView.key, errorView.values)}
              </Notice>
            ) : null}

            {canRecover ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
                <p className="text-muted-foreground">
                  {t("settings.resetDamagedHint")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void settingsStore.getState().resetSettings();
                  }}
                >
                  {t("settings.resetDamaged")}
                </Button>
              </div>
            ) : null}

            <SettingsPanel value="general">
              <GeneralSection />
            </SettingsPanel>
            <SettingsPanel value="ffmpeg">
              <FfmpegPathSection />
            </SettingsPanel>
            <SettingsPanel value="presets">
              <PresetLibrarySection onDraftChange={setPresetDraft} />
            </SettingsPanel>
          </div>
        </TabsPrimitive.Root>

        <DialogFooter>
          {unsavedPrompt !== null ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {/* `tabIndex={-1}` lets the message take the focus while a save disables
                  every button, without adding a stop to the Tab order. */}
              <p
                ref={promptMessageRef}
                role="alert"
                tabIndex={-1}
                className="mr-auto min-w-0 font-medium wrap-break-word outline-none"
              >
                {translate(unsavedPrompt.message.key, unsavedPrompt.message.values)}
              </p>
              <Button
                variant="ghost"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={handleDontSave}
              >
                {t("settings.preset.dontSave")}
              </Button>
              <Button
                ref={promptCancelRef}
                variant="outline"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={cancelPrompt}
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={unsavedPrompt.saveDisabled}
                onClick={() => {
                  void handleSaveAndClose();
                }}
              >
                {t("common.save")}
              </Button>
            </div>
          ) : (
            <DialogClose asChild>
              <Button ref={footerCloseRef} variant="outline">
                {t("common.close")}
              </Button>
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsTab({
  value,
  children,
}: {
  value: SettingsSection;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="inline-flex h-full items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

/**
 * One tab panel. `forceMount` keeps every panel mounted while the dialog is open, and the
 * inactive ones are only hidden. An unmounted preset panel would drop an unsaved preset
 * draft without the discard prompt, and the sections would reload their state on every
 * switch. Before the tabs existed, both sections were mounted for as long as the dialog was
 * open, and this keeps that lifetime.
 */
function SettingsPanel({
  value,
  children,
}: {
  value: SettingsSection;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Content
      value={value}
      forceMount
      className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=inactive]:hidden"
    >
      {children}
    </TabsPrimitive.Content>
  );
}
