import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
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
  const errorView = presentSettingsError(error);

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
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
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

        {errorView ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {(t as (key: string, options?: Record<string, string | number>) => string)(
              errorView.key,
              errorView.values,
            )}
          </div>
        ) : null}

        <FfmpegPathSection />
        <PresetLibrarySection />

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
