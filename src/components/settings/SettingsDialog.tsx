import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
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
import { settingsStore, useSettingsStore } from "@/features/settings/store";
import { presentSettingsError } from "./settingsErrorPresenter";
import { FfmpegPathSection } from "./FfmpegPathSection";
import { PresetLibrarySection } from "./PresetLibrarySection";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const error = useSettingsStore((state) => state.error);
  const status = useSettingsStore((state) => state.status);
  const settings = useSettingsStore((state) => state.settings);
  const errorView = presentSettingsError(error);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
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

        {/* Scrollable body keeps header, close button, and footer pinned */}
        <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-1">
          {errorView ? (
            <Notice tone="destructive" role="alert">
              {(
                t as (key: string, options?: Record<string, string | number>) => string
              )(errorView.key, errorView.values)}
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

          <FfmpegPathSection />
          <PresetLibrarySection />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
