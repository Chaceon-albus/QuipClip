import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tabs as TabsPrimitive } from "radix-ui";
import { DialogActions } from "@/components/common/DialogActions";
import { isInOpenDialog, toPromptFocusTarget } from "@/components/common/focusTarget";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  isSettingsSection,
  settingsPanelStore,
  useSettingsPanelStore,
  type SettingsSection,
} from "@/features/settings/panelStore";
import {
  closeSettingsWindow,
  startSettingsWindowRequestListener,
  type SettingsWindowRequest,
} from "@/features/settings/settingsWindowClient";
import { reportSettingsWindowDraft } from "@/features/settings/settingsWindowDraft";
import { settingsStore, useSettingsStore } from "@/features/settings/store";
import { startEventListener } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  decideCloseRequest,
  decidePromptSaveOutcome,
  pickPromptCancelFocus,
  pickPromptOpenFocus,
  presentUnsavedDraftPrompt,
  type PresetDraftGuard,
} from "./presetDraftGuard";
import { presentSettingsError } from "./settingsErrorPresenter";
import { FfmpegPathSection } from "./FfmpegPathSection";
import { GeneralSection } from "./GeneralSection";
import {
  PresetLibrarySection,
  type PresetSelectionRequest,
} from "./PresetLibrarySection";

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

/** The Tauri window of this page, or null outside the Tauri shell. */
function getNativeWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * Closes the window with no close request. The unsaved draft was settled before. Rust closes
 * it (`closeSettingsWindow`): the page holds no window destroy permission, because the window
 * commands act on any window that the caller names.
 */
function destroyWindow(): void {
  void closeSettingsWindow();
}

/**
 * The Settings window. `SettingsWindowRoot` renders it as the whole page of the window that
 * Rust builds with the label `settings`. The window has the system title bar, so this view
 * has no title, no close control, and no Close button.
 *
 * The window starts hidden, and the view shows it after its first render, so the window never
 * shows an empty web view. Each opening of the window can name a tab and a preset
 * (`openSettingsWindow`). The view takes that request when it mounts and on each navigate
 * event, switches to the tab, and selects the preset only when no draft holds an unsaved edit.
 *
 * A close request cannot drop an unsaved preset draft. The red window button, Close Window of
 * the File menu, and Alt+F4 raise the close request of the window. The view always cancels
 * it, and closes the window itself when `decideCloseRequest` allows it. With a dirty draft,
 * the footer shows the unsaved-changes prompt, and the window switches to the preset tab.
 * Escape does not close the window.
 *
 * Only one unsaved-changes prompt is open at a time. While the preset library shows its own
 * prompt, for a switch to another preset or for Add, a close request goes to that prompt. While
 * the footer shows its prompt, a switch or an Add in the preset library goes to the footer.
 *
 * The view reports the name of an unsaved draft to the main window, whose quit guard names it
 * (ADR 027, `settingsWindowDraft.ts`).
 */
export function SettingsWindow() {
  const { t, i18n } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;
  const section = useSettingsPanelStore((state) => state.section);
  const error = useSettingsStore((state) => state.error);
  const status = useSettingsStore((state) => state.status);
  const settings = useSettingsStore((state) => state.settings);
  const errorView = presentSettingsError(error);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  // The preset library reports its draft here. Its unmount reports the clean guard.
  const [presetDraft, setPresetDraft] = useState<PresetDraftGuard>(
    CLEAN_PRESET_DRAFT_GUARD,
  );
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const promptCancelRef = useRef<HTMLButtonElement>(null);
  const promptMessageRef = useRef<HTMLParagraphElement>(null);
  // Set by Cancel and read by the effect below, after the footer closes the prompt.
  const cancelledPromptRef = useRef<ClosePrompt | null>(null);
  // The newest preset that an opening of the window named. See `PresetSelectionRequest`.
  const [selectionRequest, setSelectionRequest] =
    useState<PresetSelectionRequest | null>(null);
  // Counts the requests to give the focus to the active tab, after the tab changed.
  const [tabFocusRequests, setTabFocusRequests] = useState(0);

  // A quit drops the draft, so the quit guard of the main window reads its name (ADR 027).
  const unsavedPresetName = presetDraft.dirty ? (presetDraft.presetName ?? "") : null;
  useEffect(() => {
    reportSettingsWindowDraft(unsavedPresetName);
  }, [unsavedPresetName]);
  useEffect(
    () => () => {
      reportSettingsWindowDraft(null);
    },
    [],
  );

  const unsavedPrompt =
    closePrompt === null ? null : presentUnsavedDraftPrompt(presetDraft);

  // Drop the prompt as soon as the draft is clean, derived during render the way the preset
  // library drops its switch prompt. A Save or a Cancel in the preset editor clears the draft
  // while the prompt is open, and the prompt then has nothing left to ask about.
  if (closePrompt !== null && unsavedPrompt === null) {
    setClosePrompt(null);
  }

  // The active tab trigger, which takes the focus after an opening and after a cancelled
  // prompt that has no element to give the focus back to.
  const findActiveTab = useCallback(
    (): HTMLElement | null =>
      tabListRef.current?.querySelector<HTMLElement>(
        '[role="tab"][data-state="active"]',
      ) ?? null,
    [],
  );

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
        toPromptFocusTarget(findActiveTab()),
      )?.focus();
    }
  }, [closePrompt, findActiveTab]);

  const cancelPrompt = () => {
    cancelledPromptRef.current = closePrompt;
    setClosePrompt(null);
  };

  const requestClose = () => {
    switch (
      decideCloseRequest(presetDraft, closePrompt !== null, presetDraft.leavePromptOpen)
    ) {
      case "close":
        destroyWindow();
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
      // A second close request while the prompt is open keeps the prompt. The focus goes
      // back into it.
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

  // The close listener lives as long as the window, and it runs the decision of the latest
  // render.
  const requestCloseRef = useRef(requestClose);
  useLayoutEffect(() => {
    requestCloseRef.current = requestClose;
  });

  // Every close request of the window comes here. The handler always cancels it, also after
  // the release: Tauri destroys the window after a handler that does not cancel, and React
  // StrictMode releases the effect once while its subscription is still in place. The window
  // then closes only through `destroyWindow`.
  useEffect(() => {
    const nativeWindow = getNativeWindow();
    if (nativeWindow === null) {
      return undefined;
    }
    return startEventListener(
      (handler) =>
        nativeWindow.onCloseRequested((event) => {
          event.preventDefault();
          handler(undefined);
        }),
      () => {
        requestCloseRef.current();
      },
    );
  }, []);

  const handleDontSave = () => {
    presetDraft.discard();
    destroyWindow();
  };

  // Closes only when the save succeeded and left nothing unsaved. A failed save keeps the
  // window and the prompt open, and the error notice at the top of the scrolling body reports
  // the failure. See `decidePromptSaveOutcome`.
  const handleSaveAndClose = async () => {
    // The save disables every choice while it runs, and a disabled button drops the focus to
    // the document body. The message keeps the focus inside the prompt.
    promptMessageRef.current?.focus();
    const saved = await presetDraft.save();
    // The store clears its error when a save starts, so an error here belongs to this save.
    switch (decidePromptSaveOutcome(saved, settingsStore.getState().error !== null)) {
      case "close":
        destroyWindow();
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
  // so without this the window has no way out and the user must delete the file by hand.
  // `reset_settings` is the escape hatch ADR 013 defines: it renames the damaged file to
  // settings.invalid.json and writes fresh seeds.
  const canRecover = status === "error" && settings === null;

  useEffect(() => {
    void settingsStore.getState().loadSettings();
  }, []);

  // The window title follows the language. The system draws it in the title bar, the Window
  // menu, and the task bar.
  const resolvedLanguage = i18n.resolvedLanguage;
  useEffect(() => {
    void getNativeWindow()
      ?.setTitle(t("settings.title"))
      .catch(() => {
        // The title stays as it is. Rust gave the window the English title.
      });
  }, [t, resolvedLanguage]);

  // The window starts hidden. It shows after the first render, and it takes the focus, so the
  // keyboard reaches the active tab at once.
  useEffect(() => {
    const nativeWindow = getNativeWindow();
    if (nativeWindow === null) {
      return;
    }
    void nativeWindow
      .show()
      .then(() => nativeWindow.setFocus())
      .then(() => {
        setTabFocusRequests((count) => count + 1);
      })
      .catch((error: unknown) => {
        console.error("Failed to show the Settings window:", error);
      });
  }, []);

  // Each opening of the window can name a tab and a preset. Rust brings the window forward,
  // and the active tab then takes the focus, so the keyboard starts where the opening points.
  useEffect(
    () =>
      startSettingsWindowRequestListener({
        onRequest: (request: SettingsWindowRequest) => {
          if (request.section !== null) {
            settingsPanelStore.getState().setSection(request.section);
          }
          if (request.presetId !== null) {
            setSelectionRequest({ presetId: request.presetId });
          }
          setTabFocusRequests((count) => count + 1);
        },
      }),
    [],
  );

  useEffect(() => {
    if (tabFocusRequests === 0) {
      return;
    }
    // A prompt or a confirmation that is open keeps the focus: the unsaved-changes prompt of
    // the footer or of the preset library (both alerts), and a dialog such as Delete Preset.
    const active = document.activeElement;
    const inPrompt = active !== null && active.closest('[role="alert"]') !== null;
    if (promptMessageRef.current !== null || inPrompt || isInOpenDialog(active)) {
      return;
    }
    findActiveTab()?.focus();
  }, [tabFocusRequests, findActiveTab]);

  // Each tab starts at its top. All panels share one scroll container, so without this a
  // tab would open at the offset the previous tab was scrolled to.
  useLayoutEffect(() => {
    if (bodyRef.current !== null) {
      bodyRef.current.scrollTop = 0;
    }
  }, [section]);

  return (
    <div className="flex h-screen w-screen flex-col gap-4 overflow-hidden bg-background p-4 text-sm text-foreground">
      <TabsPrimitive.Root
        value={section}
        onValueChange={handleSectionChange}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <TabsPrimitive.List
          ref={tabListRef}
          aria-label={t("settings.title")}
          className="inline-flex h-8 w-fit shrink-0 items-center rounded-lg bg-muted p-[3px] text-muted-foreground"
        >
          <SettingsTab value="general">{t("settings.tab.general")}</SettingsTab>
          <SettingsTab value="ffmpeg">{t("settings.tab.ffmpeg")}</SettingsTab>
          <SettingsTab value="presets">{t("settings.tab.presets")}</SettingsTab>
        </TabsPrimitive.List>

        {/* Scrollable body keeps the tabs and the footer pinned. It is a flex column, so the
            preset panel can take the free height and scroll inside its own panes. A hidden
            panel is `display: none` and takes no gap. */}
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
              <p className="text-muted-foreground">{t("settings.resetDamagedHint")}</p>
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
              scroll inside their panes and the window keeps its layout when the selection
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
              selectionRequest={selectionRequest}
            />
          </SettingsPanel>
        </div>
      </TabsPrimitive.Root>

      {/* The footer exists only while a close request asks about an unsaved draft. "Don't
          Save" is a discard: at the far left on macOS, and after Save on Windows. */}
      {unsavedPrompt !== null ? (
        <div className="-mx-4 -mb-4 flex shrink-0 justify-end gap-2 border-t bg-muted/50 p-4">
          <DialogActions
            leading={
              // `tabIndex={-1}` lets the message take the focus while a save disables every
              // button, without adding a stop to the Tab order.
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
        </div>
      ) : null}
    </div>
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
 * One tab panel. `forceMount` keeps every panel mounted for the life of the window, and the
 * inactive ones are only hidden. An unmounted preset panel would drop an unsaved preset draft
 * without the discard prompt, and the sections would reload their state on every switch.
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
