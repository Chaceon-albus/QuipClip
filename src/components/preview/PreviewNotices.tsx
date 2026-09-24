import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, X } from "lucide-react";
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";
import { useOpenMediaAction } from "@/components/common/useOpenMediaAction";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import type { ImportMediaError } from "@/features/media";
import type { PlaybackErrorCode } from "@/features/playback";
import { settingsPanelStore } from "@/features/settings/panelStore";
import { cn } from "@/lib/utils";
import {
  importErrorActions,
  importErrorHintKey,
  resolveNoticeTimer,
  type ImportErrorAction,
  type PreviewNoticeKind,
  type PreviewNoticePhase,
} from "./previewNoticeRules";

/** Opens the Settings dialog on its FFmpeg tab. */
function openFfmpegSettings(): void {
  settingsPanelStore.getState().show("ffmpeg");
}

/**
 * The buttons of an import error, in the order of `importErrorActions`. The first one is the
 * primary action and takes the filled style.
 */
function ImportErrorActionButtons({
  actions,
  size,
}: {
  actions: readonly ImportErrorAction[];
  size: "default" | "xs";
}) {
  const { t } = useTranslation();
  const openMedia = useOpenMediaAction();
  // Choose Another File performs the Open Media action, so it declares the same key (ADR 026).
  const shortcutOf = useShortcutLabels();
  const openMediaShortcut = shortcutOf("openMedia");

  return actions.map((action, index) => {
    const variant = index === 0 ? "default" : "outline";
    return action === "openSettings" ? (
      <Button key={action} variant={variant} size={size} onClick={openFfmpegSettings}>
        {t("preview.importError.openSettings")}
      </Button>
    ) : (
      <Button
        key={action}
        variant={variant}
        size={size}
        onClick={openMedia}
        aria-keyshortcuts={openMediaShortcut?.aria}
      >
        {t("preview.importError.chooseAnother")}
      </Button>
    );
  });
}

/**
 * The diagnostic text of an import error behind the shared disclosure, with its Copy button.
 * The labels match the Details section of the export dialog.
 */
function ImportErrorDetails({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <DiagnosticDetails
      summary={t("preview.importError.details.show")}
      openSummary={t("preview.importError.details.hide")}
      text={text}
      className="w-full text-left"
    />
  );
}

/**
 * One notice of the preview's notification area: a destructive icon and the message, the
 * controls of the notice under the message, and a close button.
 *
 * Only the icon and the message are in the `alert`, so a screen reader announces the message
 * and not the names of the controls.
 *
 * A playback notice leaves by itself (`resolveNoticeTimer`). The pointer over it, or the focus
 * in it, pauses it, and a pause stops an exit that has started. An import notice stays until
 * the user dismisses it or the store clears it.
 */
function NoticeBanner({
  kind,
  message,
  onDismiss,
  onReturnFocus,
  children,
}: {
  kind: PreviewNoticeKind;
  message: ReactNode;
  onDismiss: () => void;
  /**
   * Moves the focus out of the notice. The notice calls it when it leaves while it holds the
   * focus, because the removed notice would otherwise drop the focus to the document body.
   */
  onReturnFocus: () => void;
  /** The controls of the notice, such as its actions and its diagnostic text. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<PreviewNoticePhase>("shown");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // True while the focus is in the notice. The focus handlers keep it current, so the unmount
  // cleanup does not depend on `document.activeElement`, which can already be the body then.
  const holdsFocusRef = useRef(false);

  // The timer and the unmount cleanup call the callbacks of the latest render.
  const onDismissRef = useRef(onDismiss);
  const onReturnFocusRef = useRef(onReturnFocus);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
    onReturnFocusRef.current = onReturnFocus;
  });

  // A notice that leaves while it holds the focus gives the focus back, whatever removed it:
  // the close button, a new import, or a decode failure that hides a playback error. A layout
  // cleanup runs before React removes the node, so the focus moves before the browser drops
  // it to the body.
  useLayoutEffect(
    () => () => {
      if (holdsFocusRef.current) {
        holdsFocusRef.current = false;
        onReturnFocusRef.current();
      }
    },
    [],
  );

  useEffect(() => {
    const step = resolveNoticeTimer(kind, phase, paused);
    if (step === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (step.action === "leave") {
        setPhase("leaving");
      } else {
        onDismissRef.current();
      }
    }, step.delayMs);
    return () => window.clearTimeout(timer);
  }, [kind, phase, paused]);

  const handleFocus = () => {
    holdsFocusRef.current = true;
    setFocused(true);
    setPhase("shown");
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    // A move of the focus between two controls of the notice keeps the pause.
    if (!event.currentTarget.contains(event.relatedTarget)) {
      holdsFocusRef.current = false;
      setFocused(false);
    }
  };

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border border-destructive/50 bg-preview-background/95 px-3 py-2 text-xs text-preview-foreground shadow-floating",
        phase === "leaving"
          ? "animate-out fade-out-0 fill-mode-forwards"
          : "animate-in fade-in-0 slide-in-from-top-1",
      )}
      onPointerEnter={() => {
        setHovered(true);
        setPhase("shown");
      }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div role="alert" className="flex items-start gap-2">
          <AlertCircle
            aria-hidden="true"
            className="mt-px size-4 shrink-0 text-destructive"
          />
          <p className="min-w-0 flex-1 pt-px font-medium wrap-break-word">{message}</p>
        </div>
        {/* The controls line up with the message, past the 16px icon and its 8px gap. */}
        {children !== undefined && (
          <div className="flex flex-col gap-1.5 pl-6">{children}</div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 -mr-1.5 text-preview-muted"
        aria-label={t("preview.notice.dismiss")}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * An import error over an open video. It stays until the user dismisses it or starts another
 * import. An error that the FFmpeg settings can correct also offers Open Settings.
 */
export function ImportErrorBanner({
  error,
  onDismiss,
  onReturnFocus,
}: {
  error: ImportMediaError;
  /** Receives the error that the banner shows, so the store can refuse a stale dismiss. */
  onDismiss: (error: ImportMediaError) => void;
  onReturnFocus: () => void;
}) {
  const { t } = useTranslation();
  const actions = importErrorActions(error.code, "banner");
  const hasControls = actions.length > 0 || Boolean(error.detail);
  return (
    <NoticeBanner
      kind="import"
      message={t(`mediaError.${error.code}`, { defaultValue: t("mediaError.unknown") })}
      onDismiss={() => onDismiss(error)}
      onReturnFocus={onReturnFocus}
    >
      {hasControls ? (
        <>
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <ImportErrorActionButtons actions={actions} size="xs" />
            </div>
          )}
          {error.detail && <ImportErrorDetails text={error.detail} />}
        </>
      ) : undefined}
    </NoticeBanner>
  );
}

/**
 * A playback or seek error over an open video. It leaves by itself after a few seconds.
 *
 * The caller keys it on the error code, so a new code starts a new notice with a full timer.
 */
export function PlaybackErrorBanner({
  code,
  onDismiss,
  onReturnFocus,
}: {
  code: PlaybackErrorCode;
  /** Receives the code that the banner shows, so the store can refuse a stale dismiss. */
  onDismiss: (code: PlaybackErrorCode) => void;
  onReturnFocus: () => void;
}) {
  const { t } = useTranslation();
  return (
    <NoticeBanner
      kind="playback"
      message={t(`playbackError.${code}`, {
        defaultValue: t("playbackError.playbackFailed"),
      })}
      onDismiss={() => onDismiss(code)}
      onReturnFocus={onReturnFocus}
    />
  );
}

/**
 * An import error with no video open. It takes the place of the empty state, in the same
 * layout: what failed, what to do, the actions, and the diagnostic text in a closed section.
 */
export function ImportErrorEmptyState({ error }: { error: ImportMediaError }) {
  const { t } = useTranslation();
  const actions = importErrorActions(error.code, "empty");
  const hintKey = importErrorHintKey(error.code);
  return (
    <div className="flex max-h-full w-full max-w-md flex-col items-center gap-3 overflow-y-auto p-4 text-center">
      <div role="alert" className="flex flex-col items-center gap-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl border border-preview-border bg-preview-background">
          <AlertCircle aria-hidden="true" className="size-6 text-destructive" />
        </div>
        <div className="flex flex-col items-center gap-1">
          <h2 className="text-sm font-medium text-preview-foreground">
            {t("preview.importError.title")}
          </h2>
          <p className="text-xs text-preview-foreground">
            {t(`mediaError.${error.code}`, { defaultValue: t("mediaError.unknown") })}
          </p>
          {hintKey !== null && (
            <p className="text-xs text-preview-muted">{t(hintKey)}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <ImportErrorActionButtons actions={actions} size="default" />
      </div>
      {error.detail && <ImportErrorDetails text={error.detail} />}
    </div>
  );
}
