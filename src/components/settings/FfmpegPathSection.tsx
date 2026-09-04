import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFfmpegStore } from "@/features/ffmpeg";
import { settingsStore } from "@/features/settings/store";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  presentFfmpegStatus,
  type FfmpegStatusView,
} from "@/components/layout/ffmpegStatusPresenter";
import {
  createFfmpegPathController,
  type FfmpegPathView,
} from "./ffmpegPathController";

const toneClasses: Record<FfmpegStatusView["tone"], string> = {
  neutral: "text-muted-foreground",
  ready: "text-muted-foreground",
  warning: "text-warning",
};

export function FfmpegPathSection() {
  const { t, i18n } = useTranslation();

  // `pendingView` starts `null` and needs nothing from `controller`, so it carries no forward
  // reference. `controller` is built once, after `setView` exists, exactly like the pre-fix
  // code did -- the only change is that no second, throwaway controller is built anywhere.
  // Until the controller's first `onChange` lands (see the activate/syncFromSettings effects
  // below), `view` reads live off that same single instance via `getView()`.
  const [pendingView, setView] = useState<FfmpegPathView | null>(null);

  const controller = useMemo(
    () =>
      createFfmpegPathController({
        onChange: setView,
      }),
    [],
  );

  const view = pendingView ?? controller.getView();

  useEffect(() => {
    controller.activate();
    return () => {
      controller.deactivate();
    };
  }, [controller]);

  useEffect(() => {
    controller.syncFromSettings(settingsStore.getState().settings);
    return settingsStore.subscribe((state) => {
      controller.syncFromSettings(state.settings);
    });
  }, [controller]);

  const ffmpeg = useFfmpegStore();
  const resolvedLanguage = getResolvedLanguage(i18n);

  const listFormatter = useMemo(
    () =>
      new Intl.ListFormat(resolvedLanguage, {
        style: "long",
        type: "unit",
      }),
    [resolvedLanguage],
  );

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        maximumFractionDigits: 3,
      }),
    [resolvedLanguage],
  );

  const statusView = useMemo(
    () =>
      presentFfmpegStatus(ffmpeg, {
        list: listFormatter,
        number: numberFormatter,
      }),
    [ffmpeg, listFormatter, numberFormatter],
  );

  const statusLineText = (
    t as (key: string, options?: Record<string, string>) => string
  )(statusView.lineKey, statusView.lineValues);

  return (
    <section className="space-y-3">
      <h3 className="font-heading text-sm font-medium">
        {t("settings.ffmpeg.section")}
      </h3>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("settings.ffmpeg.pathLabel")}
        </span>
        <div className="rounded-md border border-input bg-muted/40 px-3 py-1.5 font-mono text-xs break-all text-foreground select-text">
          {view.ready
            ? view.path
              ? view.path
              : t("settings.ffmpeg.pathUnset")
            : t("common.loading")}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={view.ready ? view.pending : true}
          onClick={() => {
            void controller.choose("directory");
          }}
        >
          {t("settings.ffmpeg.chooseFolder")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={view.ready ? view.pending : true}
          onClick={() => {
            void controller.choose("file");
          }}
        >
          {t("settings.ffmpeg.chooseFile")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={view.ready ? view.pending : true}
          onClick={() => {
            void controller.clear();
          }}
        >
          {t("settings.ffmpeg.clear")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t("settings.ffmpeg.hint")}</p>

      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
        <div className={cn("font-medium", toneClasses[statusView.tone])}>
          {statusLineText}
        </div>
        <div className="space-y-1 text-muted-foreground">
          {statusView.detail.map((item) => (
            <p
              key={item.id}
              className={cn(item.mono && "font-mono break-all select-text")}
            >
              {t(item.key, {
                defaultValue: t("ffmpegError.unknown"),
                ...item.values,
              })}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
