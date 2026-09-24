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
import { DialogActions } from "@/components/common/DialogActions";
import { isInOpenDialog, toPromptFocusTarget } from "@/components/common/focusTarget";
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
import { cn } from "@/lib/utils";
import { createDialogFocusReturn } from "./dialogFocusReturn";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  decideCloseRequest,
  decidePromptSaveOutcome,
  pickPromptCancelFocus,
  pickPromptOpenFocus,
  isInsideLeavePrompt,
  presentUnsavedDraftPrompt,
  type PresetDraftGuard,
} from "./presetDraftGuard";
import { presentSettingsError } from "./settingsErrorPresenter";
import { FfmpegPathSection } from "./FfmpegPathSection";
import { GeneralSection } from "./GeneralSection";
import { PresetLibrarySection } from "./PresetLibrarySection";

const hideSettings = () => {
  settingsPanelStore.getState().hide();
};

// The export setup step reads the last selection of the Presets tab when this dialog closes.
const reportPresetSelection = (presetId: string | null) => {
  settingsPanelStore.getState().setSelectedPresetId(presetId);
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
 * Only one unsaved-changes prompt is open at a time. While the preset library shows its own
 * prompt, for a switch to another preset or for Add, a close request goes to that prompt. While
 * the footer shows its prompt, a switch or an Add in the preset library goes to the footer.
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
  const openingPresetId = useSettingsPanelStore((state) => state.openingPresetId);
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

  // A quit drops the draft, so the quit guard reads it from the panel store (ADR 027).
  const unsavedPresetName = presetDraft.dirty ? (presetDraft.presetName ?? "") : null;
  useEffect(() => {
    settingsPanelStore.getState().setUnsavedPresetName(unsavedPresetName);
    return () => {
      settingsPanelStore.getState().setUnsavedPresetName(null);
    };
  }, [unsavedPresetName]);

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
    switch (
      decideCloseRequest(presetDraft, closePrompt !== null, presetDraft.leavePromptOpen)
    ) {
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
      case "defer":
        // The preset library already asks about the draft. The request goes to that prompt,
        // and the footer shows no second one. The prompt is on the preset tab.
        presetDraft.focusLeavePrompt();
        if (section !== PRESETS_SECTION) {
          settingsPanelStore.getState().setSection(PRESETS_SECTION);
        }
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
          // the element that opened the dialog. A caller whose control leaves the document as
          // this dialog opens names another element in the panel store.
          focusReturn.noteOpened(
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
            settingsPanelStore.getState().returnFocus,
          );
        }}
        onKeyDownCapture={() => {
          focusReturn.noteInteraction("keyboard");
        }}
        onEscapeKeyDown={(event) => {
          focusReturn.noteInteraction("keyboard");
          // Escape inside the unsaved-changes prompt of the preset library answers that
          // prompt with "Keep Editing" (`decideLeavePromptKey`). It is not a close request.
          if (
            isInsideLeavePrompt(event.target instanceof Element ? event.target : null)
          ) {
            event.preventDefault();
          }
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
          const target = focusReturn.takeCloseTarget();
          // The export dialog opens again as this dialog closes, when its setup step opened
          // this dialog, and it has the focus by now (`exportSettingsReturn.ts`). It keeps it.
          if (isInOpenDialog(document.activeElement)) {
            return;
          }
          target?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

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

          {/* Scrollable body keeps header, close button, tabs, and footer pinned. It is a flex
              column, so the preset panel can take the free height and scroll inside its own
              panes. A hidden panel is `display: none` and takes no gap. */}
          <div
            ref={bodyRef}
            className="-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-1"
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
            {/* The preset tab fills the free height of the body, so its list and its editor
                scroll inside their panes and the dialog keeps its height when the selection
                changes. The minimum keeps both panes usable when an error notice above takes
                part of the body. The body then scrolls. */}
            <SettingsPanel value="presets" className="flex min-h-72 flex-1 flex-col">
              <PresetLibrarySection
                onDraftChange={setPresetDraft}
                closePromptOpen={unsavedPrompt !== null}
                onFocusClosePrompt={() => {
                  focusPrompt(promptCancelRef.current, promptMessageRef.current);
                }}
                visible={section === PRESETS_SECTION}
                open={open}
                openingPresetId={openingPresetId}
                onSelectionChange={reportPresetSelection}
              />
            </SettingsPanel>
          </div>
        </TabsPrimitive.Root>

        <DialogFooter>
          {unsavedPrompt !== null ? (
            // "Don't Save" is a discard: at the far left on macOS, and after Save on Windows.
            // Each footer is keyed, so the buttons of the prompt never stay mounted as the
            // Close button.
            <DialogActions
              key="prompt"
              leading={
                // `tabIndex={-1}` lets the message take the focus while a save disables
                // every button, without adding a stop to the Tab order.
                <p
                  ref={promptMessageRef}
                  role="alert"
                  tabIndex={-1}
                  className="min-w-0 font-medium wrap-break-word outline-none"
                >
                  {translate(unsavedPrompt.message.key, unsavedPrompt.message.values)}
                </p>
              }
              extras={[
                {
                  key: "dontSave",
                  role: "discard",
                  node: (
                    <Button
                      variant="ghost"
                      disabled={unsavedPrompt.choicesDisabled}
                      onClick={handleDontSave}
                    >
                      {t("settings.preset.dontSave")}
                    </Button>
                  ),
                },
              ]}
              cancel={
                <Button
                  ref={promptCancelRef}
                  variant="outline"
                  disabled={unsavedPrompt.choicesDisabled}
                  onClick={cancelPrompt}
                >
                  {t("common.cancel")}
                </Button>
              }
              primary={
                <Button
                  disabled={unsavedPrompt.saveDisabled}
                  onClick={() => {
                    void handleSaveAndClose();
                  }}
                >
                  {t("common.save")}
                </Button>
              }
            />
          ) : (
            <DialogActions
              key="close"
              cancel={
                <DialogClose asChild>
                  <Button ref={footerCloseRef} variant="outline">
                    {t("common.close")}
                  </Button>
                </DialogClose>
              }
            />
          )}
        </DialogFooter>

        {/* The close button comes after the footer in the document, so it is the last stop
            of the Tab order, and the first stop is the tab list. It still draws at the top
            right corner. */}
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
            <XIcon />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </DialogClose>
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
      className="inline-flex h-full items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground/60 focus-ring transition-colors outline-none hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground"
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
  className,
  children,
}: {
  value: SettingsSection;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Content
      value={value}
      forceMount
      className={cn(
        "rounded-md focus-ring outline-none data-[state=inactive]:hidden",
        className,
      )}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
