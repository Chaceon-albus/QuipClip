import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
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
import { presentSettingsError } from "./settingsErrorPresenter";
import { FfmpegPathSection } from "./FfmpegPathSection";
import { GeneralSection } from "./GeneralSection";
import { PresetLibrarySection } from "./PresetLibrarySection";

const handleOpenChange = (open: boolean) => {
  if (open) {
    settingsPanelStore.getState().show();
  } else {
    settingsPanelStore.getState().hide();
  }
};

const handleSectionChange = (value: string) => {
  if (isSettingsSection(value)) {
    settingsPanelStore.getState().setSection(value);
  }
};

/**
 * The settings dialog. `AppShell` mounts it once, and the settings panel store opens it and
 * selects its tab, so any component can open it on a given section.
 */
export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useSettingsPanelStore((state) => state.open);
  const section = useSettingsPanelStore((state) => state.section);
  const error = useSettingsStore((state) => state.error);
  const status = useSettingsStore((state) => state.status);
  const settings = useSettingsStore((state) => state.settings);
  const errorView = presentSettingsError(error);
  const focusReturn = useMemo(() => createDialogFocusReturn(), []);
  const bodyRef = useRef<HTMLDivElement>(null);

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
        onPointerDownOutside={() => {
          focusReturn.noteInteraction("pointer");
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
                {(
                  t as (
                    key: string,
                    options?: Record<string, string | number>,
                  ) => string
                )(errorView.key, errorView.values)}
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
              <PresetLibrarySection />
            </SettingsPanel>
          </div>
        </TabsPrimitive.Root>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogClose>
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
