import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  ANNOUNCE_GAP_MS,
  copyFeedbackDurationMs,
  copyFeedbackOf,
  selectedHintKey,
  type CopyFeedback,
} from "./diagnosticDetailsModel";

export interface DiagnosticDetailsProps {
  /** The label of the disclosure while it is closed. */
  summary: string;
  /** The label of the disclosure while it is open. Defaults to `summary`. */
  openSummary?: string;
  /** The diagnostic text. It shows unchanged (ADR 011). */
  text: string;
  className?: string;
}

/**
 * Diagnostic text behind a disclosure that starts closed, with a Copy button.
 *
 * The text comes from `ffmpeg`, from the operating system, or from Rust. ADR 011 shows it
 * unchanged beside a translated message, for a bug report. It can be long, so it starts
 * hidden. The caller places it outside a tinted message box: the text is in the foreground
 * colour, so it is at full contrast, and it is selectable.
 *
 * Copy writes the text to the clipboard, and its icon changes to a check mark for a short
 * time. Its label stays "Copy", so its accessible name always holds its visible label
 * (WCAG 2.5.3). When the clipboard refuses the write, Copy selects the text instead, and a
 * hint names the keyboard shortcut that copies it. A live region speaks "Copied" or the
 * hint.
 */
export function DiagnosticDetails({
  summary,
  openSummary,
  text,
  className,
}: DiagnosticDetailsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The result of the last Copy click, or null. It sets the icon and the visible hint. Each
  // click stores a new object, so the timer below starts again, and the check mark stays
  // for its full time after the last click.
  const [feedback, setFeedback] = useState<{ kind: CopyFeedback } | null>(null);
  // The result that the live region speaks, or null. It is apart from `feedback`, so the
  // gap before an announcement never changes what shows. See `handleCopy`.
  const [announced, setAnnounced] = useState<CopyFeedback | null>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const announceTimerRef = useRef<number | null>(null);
  // False after the unmount. The copy answers after an await, and a timer must not start
  // for a component that is gone.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (feedback === null) {
      return;
    }
    const durationMs = copyFeedbackDurationMs(feedback.kind);
    if (durationMs === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFeedback(null);
      setAnnounced(null);
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [feedback]);

  // A screen reader speaks a live region only when its text changes. A result that repeats
  // the last one, such as a second copy within the confirmation time or a second refused
  // copy, would otherwise pass in silence. So the click empties the region, and the result
  // goes into it `ANNOUNCE_GAP_MS` later, after the empty region reached the screen reader.
  const handleCopy = async () => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
      announceTimerRef.current = null;
    }
    setAnnounced(null);
    const kind = copyFeedbackOf(await copyText(text));
    if (!mountedRef.current) {
      return;
    }
    if (kind === "selected") {
      const element = textRef.current;
      const selection = window.getSelection();
      if (element !== null && selection !== null) {
        selection.selectAllChildren(element);
      }
    }
    setFeedback({ kind });
    announceTimerRef.current = window.setTimeout(() => {
      announceTimerRef.current = null;
      setAnnounced(kind);
    }, ANNOUNCE_GAP_MS);
  };

  const hint = t(selectedHintKey(isMacOS()));
  let announcement: string | null = null;
  if (announced === "copied") {
    announcement = t("common.diagnostic.copied");
  } else if (announced === "selected") {
    announcement = hint;
  }

  return (
    <details
      className={cn("group text-xs", className)}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex w-fit list-none items-center gap-1 rounded-sm text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {open ? (openSummary ?? summary) : summary}
      </summary>
      <div className="mt-2 space-y-1.5">
        {/* `tabIndex` lets a keyboard user scroll a long diagnostic. */}
        <pre
          ref={textRef}
          tabIndex={0}
          className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs wrap-break-word whitespace-pre-wrap text-foreground outline-none select-text focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {text}
        </pre>
        <div className="flex items-center justify-end gap-2">
          {/* The hint shows, because the user must act on it. The live region below
              speaks it, so this copy is hidden from assistive technology. */}
          {feedback?.kind === "selected" ? (
            <p aria-hidden="true" className="mr-auto min-w-0 text-muted-foreground">
              {hint}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              void handleCopy();
            }}
          >
            {feedback?.kind === "copied" ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {t("common.diagnostic.copy")}
          </Button>
          {/* The region exists before its text changes, so a screen reader speaks the
              change. */}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </span>
        </div>
      </div>
    </details>
  );
}
