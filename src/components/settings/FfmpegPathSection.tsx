import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  Check,
  CircleCheck,
  Copy,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Notice } from "@/components/common/Notice";
import { useCopyFeedback } from "@/components/common/useCopyFeedback";
import { Button } from "@/components/ui/button";
import { useFfmpegStore } from "@/features/ffmpeg";
import { settingsStore } from "@/features/settings/store";
import { getResolvedLanguage } from "@/i18n";
import { isMacOS, isWindows } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  presentFfmpegStatus,
  selectFfmpegState,
  type FfmpegStatusDetailEntry,
  type FfmpegStatusView,
} from "@/components/layout/ffmpegStatusPresenter";
import {
  createFfmpegPathController,
  type FfmpegPathView,
} from "./ffmpegPathController";
import {
  ffmpegStatusIcon,
  hasFfmpegControlActionEnded,
  nextFfmpegAnnouncement,
  pickFfmpegActionEndFocus,
  presentFfmpegActions,
  presentFfmpegAnnouncement,
  presentFfmpegInstallGuide,
  presentFfmpegSource,
  splitFfmpegStatusDetail,
  toFfmpegPlatform,
  type FfmpegAnnouncement,
  type FfmpegInstallGuide,
  type FfmpegSectionControl,
  type FfmpegSourceView,
  type FfmpegStatusIcon,
} from "./ffmpegSectionPresenter";
import { toPromptFocusTarget } from "@/components/common/focusTarget";

// The `-text` tokens reach 4.5:1 as text in both themes. The icon in front of the line takes
// the same colour, and its shape carries the state, so the colour is never the only cue.
const toneClasses: Record<FfmpegStatusView["tone"], string> = {
  neutral: "text-muted-foreground",
  ready: "text-success-text",
  warning: "text-warning-text",
};

const statusIcons: Record<FfmpegStatusIcon, LucideIcon> = {
  spinner: Loader2,
  check: CircleCheck,
  warning: TriangleAlert,
};

/** The tags of the install messages. `<mono>` wraps a URL that the user copies by hand. */
const INSTALL_COMPONENTS = {
  mono: <span className="font-mono text-foreground select-all" />,
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
    // Compare the settings slice rather than resubscribing to every store write. The store
    // publishes pure lifecycle transitions ("loading", "saving", "ready") that leave
    // `settings` referentially identical, and `syncFromSettings` is unguarded here, so each
    // of those would otherwise re-render this section with no change in what it displays.
    let previous = settingsStore.getState().settings;
    controller.syncFromSettings(previous);
    return settingsStore.subscribe((state) => {
      if (state.settings === previous) {
        return;
      }
      previous = state.settings;
      controller.syncFromSettings(state.settings);
    });
  }, [controller]);

  const ffmpeg = useFfmpegStore(useShallow(selectFfmpegState));
  const resolvedLanguage = getResolvedLanguage(i18n);
  const platform = useMemo(() => toFfmpegPlatform(isMacOS(), isWindows()), []);

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

  const source = presentFfmpegSource(view, ffmpeg, platform);
  const actions = presentFfmpegActions(view, ffmpeg.status);
  const iconName = ffmpegStatusIcon(ffmpeg.status, statusView.tone);
  const StatusIcon = statusIcons[iconName];
  const detail = splitFfmpegStatusDetail(statusView.detail);
  const installGuide = presentFfmpegInstallGuide(ffmpeg.status, platform);

  // `t` types its options from the key. The presenters return keys as plain strings, so this
  // view of `t` takes them without a cast at each call.
  const translate = t as (key: string, options?: Record<string, string>) => string;
  const statusLineText = translate(statusView.lineKey, statusView.lineValues);

  // The live region below speaks once when a check starts and once when it ends. The
  // visible status line is not live, so the step count that it shows is not read at each
  // step. The phase of the moment the tab opens is not announced: the line shows it.
  const announcement = presentFfmpegAnnouncement(ffmpeg.status, statusView);
  const [seenPhase, setSeenPhase] = useState(announcement.phase);
  const [announced, setAnnounced] = useState<FfmpegAnnouncement | null>(null);
  const nextAnnouncement = nextFfmpegAnnouncement(seenPhase, announcement);
  if (nextAnnouncement !== null) {
    setSeenPhase(nextAnnouncement.phase);
    setAnnounced(nextAnnouncement);
  }

  // Each control is disabled while its action runs, so the focus is lost when the action
  // ends. The control that started the action then takes the focus back. See
  // `pickFfmpegActionEndFocus`.
  const chooseFolderRef = useRef<HTMLButtonElement>(null);
  const chooseFileRef = useRef<HTMLButtonElement>(null);
  const useAutomaticRef = useRef<HTMLButtonElement>(null);
  const reprobeRef = useRef<HTMLButtonElement>(null);
  const startedControlRef = useRef<FfmpegSectionControl | null>(null);
  useEffect(() => {
    const control = startedControlRef.current;
    if (
      control === null ||
      !hasFfmpegControlActionEnded(control, view.pending, actions.reprobeDisabled)
    ) {
      return;
    }
    startedControlRef.current = null;
    const controlRefs: Record<
      FfmpegSectionControl,
      RefObject<HTMLButtonElement | null>
    > = {
      chooseFolder: chooseFolderRef,
      chooseFile: chooseFileRef,
      useAutomatic: useAutomaticRef,
      reprobe: reprobeRef,
    };
    pickFfmpegActionEndFocus(
      toPromptFocusTarget(controlRefs[control].current),
      toPromptFocusTarget(chooseFolderRef.current),
      document.activeElement,
    )?.focus();
  }, [view.pending, actions.reprobeDisabled]);

  const start = (control: FfmpegSectionControl, action: () => Promise<boolean>) => {
    startedControlRef.current = control;
    void action();
  };

  return (
    <section className="space-y-3">
      <h3 className="font-heading text-sm font-medium">
        {t("settings.ffmpeg.section")}
      </h3>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("settings.ffmpeg.pathLabel")}
        </span>
        <FfmpegSourceBox source={source} />
      </div>

      {source.kind === "fallback" && (
        <Notice tone="warning" icon={TriangleAlert}>
          <p>{t("settings.ffmpeg.fallback")}</p>
          <p className="mt-1">{t("settings.ffmpeg.chosenPath")}</p>
          <p className="font-mono break-all select-text">{source.chosenPath}</p>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* The two main actions, kept together. Choose Folder comes first, because the hint
            below prefers a folder. */}
        <div className="flex flex-wrap gap-2">
          <Button
            ref={chooseFolderRef}
            variant="outline"
            size="sm"
            disabled={actions.chooseDisabled}
            onClick={() => {
              start("chooseFolder", () => controller.choose("directory"));
            }}
          >
            {t("settings.ffmpeg.chooseFolder")}
          </Button>
          <Button
            ref={chooseFileRef}
            variant="outline"
            size="sm"
            disabled={actions.chooseDisabled}
            onClick={() => {
              start("chooseFile", () => controller.choose("file"));
            }}
          >
            {t("settings.ffmpeg.chooseFile")}
          </Button>
        </div>
        {/* A quieter action, shown only while a user path is set. Without one, automatic
            detection is already in use. */}
        {actions.useAutomatic !== null && (
          <Button
            ref={useAutomaticRef}
            variant="ghost"
            size="sm"
            disabled={actions.useAutomatic.disabled}
            onClick={() => {
              start("useAutomatic", () => controller.clear());
            }}
          >
            {t("settings.ffmpeg.useAutomatic")}
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("settings.ffmpeg.hint")}</p>

      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex min-w-0 flex-1 items-start gap-1.5 font-medium",
              toneClasses[statusView.tone],
            )}
          >
            <StatusIcon
              aria-hidden="true"
              className={cn(
                "mt-px size-3.5 shrink-0",
                iconName === "spinner" && "animate-spin motion-reduce:animate-none",
              )}
            />
            <span className="min-w-0">{statusLineText}</span>
          </div>
          {/* Sits next to the status it refreshes. Disabled while a choose, a clear, or
              another check is in flight, and also while a probe started elsewhere is still
              running: `startProbe` has nothing to add to a probe already in progress. */}
          <Button
            ref={reprobeRef}
            variant="outline"
            size="sm"
            disabled={actions.reprobeDisabled}
            onClick={() => {
              start("reprobe", () => controller.reprobe());
            }}
          >
            {t("settings.ffmpeg.reprobe")}
          </Button>
        </div>
        <FfmpegDetailList entries={detail.leading} />
        {installGuide !== null && <FfmpegInstallGuideView guide={installGuide} />}
        {detail.searched.length > 0 && (
          <div className={cn(installGuide !== null && "border-t border-border pt-2")}>
            <FfmpegDetailList entries={detail.searched} />
          </div>
        )}
      </div>
      {/* The region exists before its text changes, so a screen reader speaks the change. It
          holds no control. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announced === null ? "" : translate(announced.key, announced.values)}
      </span>
    </section>
  );
}

const sourceBoxClass =
  "space-y-0.5 rounded-md border border-input bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground";
const sourcePathClass = "font-mono break-all text-foreground select-text";

/** Where the FFmpeg in use comes from. See `presentFfmpegSource`. */
function FfmpegSourceBox({ source }: { source: FfmpegSourceView }) {
  const { t } = useTranslation();
  switch (source.kind) {
    case "locating":
      return <div className={sourceBoxClass}>{t("ffmpeg.status.locating")}</div>;
    case "notDetected":
      return (
        <div className={sourceBoxClass}>{t("settings.ffmpeg.source.notDetected")}</div>
      );
    case "unset":
      return <div className={sourceBoxClass}>{t("settings.ffmpeg.pathUnset")}</div>;
    case "unknown":
      return (
        <div className={sourceBoxClass}>
          <p>{t("settings.ffmpeg.source.unknown")}</p>
          {source.chosenPath !== null && (
            <>
              <p>{t("settings.ffmpeg.chosenPath")}</p>
              <p className={sourcePathClass}>{source.chosenPath}</p>
            </>
          )}
        </div>
      );
    case "unusable":
      // No FFmpeg is in use, so a warning takes the place of the box. Use Automatic Detection
      // stays available below it.
      return (
        <Notice tone="warning" icon={TriangleAlert}>
          <p>{t("settings.ffmpeg.unusable")}</p>
          <p className="mt-1">{t("settings.ffmpeg.chosenPath")}</p>
          <p className="font-mono break-all select-text">{source.chosenPath}</p>
        </Notice>
      );
    case "automatic":
    case "fallback":
      // A fallback is the FFmpeg that automatic detection found. The notice under the box
      // names the chosen path that QuipClip cannot use.
      return (
        <div className={sourceBoxClass}>
          <p>{t("settings.ffmpeg.source.automatic")}</p>
          <p className={sourcePathClass}>{source.path}</p>
          <p>{t(source.originKey)}</p>
        </div>
      );
    case "user":
      return (
        <div className={sourceBoxClass}>
          <p>{t("settings.ffmpeg.source.user")}</p>
          {source.path !== null && <p className={sourcePathClass}>{source.path}</p>}
          {source.programPath !== null && (
            <p className="break-all select-text">
              {t("ffmpeg.detail.program", { path: source.programPath })}
            </p>
          )}
        </div>
      );
  }
}

function FfmpegDetailList({ entries }: { entries: FfmpegStatusDetailEntry[] }) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1 text-muted-foreground">
      {entries.map((item) => (
        <p key={item.id} className={cn(item.mono && "font-mono break-all select-text")}>
          {t(item.key, {
            defaultValue: t("ffmpegError.unknown"),
            ...item.values,
          })}
        </p>
      ))}
    </div>
  );
}

/** The install instructions for a missing FFmpeg, for the current platform only. */
function FfmpegInstallGuideView({ guide }: { guide: FfmpegInstallGuide }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 border-t border-border pt-2 text-muted-foreground">
      <h4 className="font-medium text-foreground">
        {t("settings.ffmpeg.install.title")}
      </h4>
      {guide.platform === "macos" && (
        // Before the command, because the command fails without Homebrew. The web view opens
        // no link without a command, so the URL is text to copy.
        <p className="select-text">
          <Trans
            t={t}
            i18nKey={guide.prerequisiteKey}
            values={{ url: guide.url }}
            components={INSTALL_COMPONENTS}
          />
        </p>
      )}
      <p>{t(guide.introKey)}</p>
      <InstallCommand command={guide.command} />
      <p>{t(guide.afterKey)}</p>
    </div>
  );
}

/**
 * One install command in a selectable code block, with a Copy button.
 *
 * The Copy behaviour is the one of `DiagnosticDetails` (see `useCopyFeedback`): the label
 * stays "Copy" and only the icon changes, a refused write selects the command and shows the
 * copy shortcut, and a live region speaks the result.
 */
function InstallCommand({ command }: { command: string }) {
  const { t } = useTranslation();
  const codeId = useId();
  const codeRef = useRef<HTMLElement>(null);
  const { feedback, hint, announcement, copy } = useCopyFeedback(command, codeRef);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <code
          ref={codeRef}
          id={codeId}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs break-all text-foreground select-all"
        >
          {command}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-describedby={codeId}
          onClick={() => {
            void copy();
          }}
        >
          {feedback === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {t("common.diagnostic.copy")}
        </Button>
      </div>
      {/* The hint shows, because the user must act on it. The live region below speaks it,
          so this copy is hidden from assistive technology. */}
      {feedback === "selected" ? <p aria-hidden="true">{hint}</p> : null}
      {/* The region exists before its text changes, so a screen reader speaks the change. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
