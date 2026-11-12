import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";
import { Notice } from "@/components/common/Notice";
import { ProgressBar } from "@/components/common/ProgressBar";
import { Button } from "@/components/ui/button";
import {
  ffmpegInstallStore,
  useFfmpegInstallStore,
  type FfmpegDownloadOffer,
} from "@/features/ffmpeg/install";
import type { FfmpegStatus } from "@/features/ffmpeg/types";
import { getResolvedLanguage } from "@/i18n";
import { stripVerbatimPrefix } from "@/lib/fileName";
import {
  ffmpegLicenseKey,
  presentFfmpegDownload,
  shouldLoadFfmpegOffer,
  type FfmpegDownloadView,
  type FfmpegInstallPhaseKey,
  type FfmpegLicenseKey,
} from "./ffmpegDownloadPresenter";
import { isFocusLost } from "./presetDraftGuard";
import { formatCacheSize } from "./waveformCachePresenter";

/** The keys that the presenter returns. The catalog test checks each one in both languages. */
type PresentedKey =
  | FfmpegInstallPhaseKey
  | FfmpegLicenseKey
  | Extract<FfmpegDownloadView, { kind: "failed" }>["messageKey"];

/**
 * A view of `t` for the keys that the presenter returns, which `t` cannot check from a variable
 * of a union type. The literal keys of the view go to `t` itself, so TypeScript checks them.
 */
type TranslatePresented = (
  key: PresentedKey,
  options?: Record<string, string>,
) => string;

/**
 * The download of FFmpeg in the status block of the FFmpeg tab (ADR 059): the offer and its
 * consent dialog, the progress of the install, and its result. See `presentFfmpegDownload`.
 *
 * The block asks Rust for the offer each time a check ends without an FFmpeg that works. Rust
 * applies the rule of ADR 059, so the block shows the offer only when Rust gives one.
 */
export function FfmpegDownloadBlock({
  status,
  chosenPath,
  guideShown,
  chooseDisabled,
  onChooseFile,
}: {
  status: FfmpegStatus;
  /** True when the user chose an FFmpeg path, which the download does not change. */
  chosenPath: boolean;
  /** True when the tab shows the install guide below the block. */
  guideShown: boolean;
  /** True while Choose File… of the tab is disabled. */
  chooseDisabled: boolean;
  /** Choose File… of the tab, the alternative that the consent dialog offers (ADR 059). */
  onChooseFile: () => void;
}) {
  const { t, i18n } = useTranslation();
  const translate = t as TranslatePresented;
  const locale = getResolvedLanguage(i18n);
  const offer = useFfmpegInstallStore((state) => state.offer);
  const install = useFfmpegInstallStore((state) => state.install);

  useEffect(() => {
    if (shouldLoadFfmpegOffer(status)) {
      void ffmpegInstallStore.getState().loadOffer();
    }
  }, [status]);

  const view = presentFfmpegDownload(status, offer, install, locale);
  const start = () => ffmpegInstallStore.getState().startInstall();

  // The dialog stays mounted, so it can close with its animation and return the focus after the
  // block changes. While the block shows the offer, the dialog shows that offer, which is the
  // offer that Download starts. `consentOffer` keeps it only for the close.
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentOffer, setConsentOffer] = useState<FfmpegDownloadOffer | null>(null);
  const dialogOffer = view.kind === "offer" ? view.offer : consentOffer;
  // The offer can go away while the dialog is open, for example after a check that another
  // window started. The dialog then closes, so Download never starts an offer that it did not
  // show.
  if (consentOpen && view.kind !== "offer") {
    setConsentOpen(false);
  }

  // A screen reader hears how an install ended. A failure has a notice with the alert role.
  // The region exists before its text changes, so a screen reader speaks the change.
  const [seenKind, setSeenKind] = useState(view.kind);
  const [announcement, setAnnouncement] = useState("");
  if (view.kind !== seenKind) {
    setSeenKind(view.kind);
    if (view.kind === "running") {
      // A second install that ends the same way changes the text again, so it is spoken.
      setAnnouncement("");
    } else if (seenKind === "running") {
      if (view.kind === "installed") {
        setAnnouncement(t("settings.ffmpegDownload.installed"));
      } else if (view.kind === "offer" && view.canceled) {
        setAnnouncement(t("settings.ffmpegDownload.canceled"));
      } else {
        setAnnouncement("");
      }
    }
  }

  // When the block removes the control that had the focus, the focus moves to the next control
  // of the block, unless the user moved it elsewhere. The consent dialog returns the focus
  // itself when it closes (`confirmFocus`, `fallbackFocus`).
  const downloadRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // One kind of the block shows at a time, so at most one of these refs is set.
  const focusTarget = useCallback(
    (): HTMLElement | null =>
      cancelRef.current ?? retryRef.current ?? downloadRef.current ?? resultRef.current,
    [],
  );
  const focusedKind = useRef(view.kind);
  useEffect(() => {
    const previous = focusedKind.current;
    if (previous === view.kind) {
      return;
    }
    focusedKind.current = view.kind;
    // Only a change from or to the progress removes a control of the block that can hold the
    // focus: Cancel Download, or Try Again. A check of the tab also hides and shows the offer,
    // and the tab returns the focus to its own control then (`pickFfmpegActionEndFocus`).
    if (
      (previous === "running" || view.kind === "running") &&
      isFocusLost(document.activeElement)
    ) {
      focusTarget()?.focus();
    }
  }, [view.kind, focusTarget]);

  let content: ReactNode = null;
  switch (view.kind) {
    case "none":
      break;
    case "offer":
      content = (
        <div className="space-y-2 border-t border-border pt-2 text-muted-foreground">
          {view.canceled && <p>{t("settings.ffmpegDownload.canceled")}</p>}
          <p>
            {guideShown
              ? t("settings.ffmpegDownload.offer", { version: view.offer.version })
              : t("settings.ffmpegDownload.offerAlone", {
                  version: view.offer.version,
                })}
          </p>
          <Button
            ref={downloadRef}
            variant="outline"
            size="sm"
            onClick={() => {
              setConsentOffer(view.offer);
              setConsentOpen(true);
            }}
          >
            {t("settings.ffmpegDownload.button")}
          </Button>
        </div>
      );
      break;
    case "running":
      content = (
        <div className="space-y-1.5 border-t border-border pt-2 text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              {translate(view.phaseKey, view.values)}
            </span>
            {/* Stays enabled after the click, so it keeps the focus. A second click changes
                nothing: the store sends one cancel. */}
            <Button
              ref={cancelRef}
              variant="outline"
              size="sm"
              onClick={() => {
                ffmpegInstallStore.getState().cancelInstall();
              }}
            >
              {view.cancelRequested
                ? t("settings.ffmpegDownload.canceling")
                : t("settings.ffmpegDownload.cancel")}
            </Button>
          </div>
          <ProgressBar
            value={view.percent}
            size="sm"
            aria-label={t("settings.ffmpegDownload.progress")}
          />
        </div>
      );
      break;
    case "installed":
      content = (
        <Notice ref={resultRef} tabIndex={-1} tone="success" icon={CircleCheck}>
          <p>{t("settings.ffmpegDownload.installed")}</p>
        </Notice>
      );
      break;
    case "failed":
      content = (
        <Notice
          ref={resultRef}
          tabIndex={-1}
          tone="warning"
          icon={TriangleAlert}
          role="alert"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <p>{t("settings.ffmpegDownload.failed")}</p>
            <p>{translate(view.messageKey)}</p>
            {view.detail !== null && (
              <DiagnosticDetails
                summary={t("settings.ffmpegDownload.details.show")}
                openSummary={t("settings.ffmpegDownload.details.hide")}
                text={view.detail}
              />
            )}
            {view.retry && (
              <Button ref={retryRef} variant="outline" size="sm" onClick={start}>
                {t("settings.ffmpegDownload.retry")}
              </Button>
            )}
          </div>
        </Notice>
      );
      break;
  }

  return (
    <>
      {content}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <ConfirmDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        title={t("settings.ffmpegDownload.dialog.title")}
        description={
          dialogOffer === null ? null : (
            <ConsentText offer={dialogOffer} chosenPath={chosenPath} locale={locale} />
          )
        }
        confirmLabel={t("settings.ffmpegDownload.dialog.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={start}
        alternative={{
          label: t("settings.ffmpeg.chooseFile"),
          disabled: chooseDisabled,
          onSelect: onChooseFile,
        }}
        // The progress takes the place of the Download button, so its Cancel takes the focus.
        // A start that Rust refuses at once has ended before the dialog closes, and the
        // control of its result takes the focus then.
        confirmFocus={() => cancelRef.current}
        fallbackFocus={focusTarget}
      />
    </>
  );
}

/** What the consent dialog says: the version, the host, the folder, the size and the licence. */
function ConsentText({
  offer,
  chosenPath,
  locale,
}: {
  offer: FfmpegDownloadOffer;
  chosenPath: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const translate = t as TranslatePresented;
  return (
    <div className="space-y-2">
      <p>
        {t("settings.ffmpegDownload.dialog.intro", {
          version: offer.version,
          source: offer.source,
        })}
      </p>
      <p className="font-mono break-all text-foreground select-text">
        {stripVerbatimPrefix(offer.directory)}
      </p>
      <p>
        {t("settings.ffmpegDownload.dialog.size", {
          size: formatCacheSize(offer.downloadSize, locale),
        })}
      </p>
      <p>
        {t("settings.ffmpegDownload.dialog.license", {
          license: translate(ffmpegLicenseKey(offer.license)),
        })}
      </p>
      {offer.replaces && <p>{t("settings.ffmpegDownload.dialog.replaces")}</p>}
      {chosenPath && <p>{t("settings.ffmpegDownload.dialog.chosenPath")}</p>}
      <p>{t("settings.ffmpegDownload.dialog.close")}</p>
    </div>
  );
}
