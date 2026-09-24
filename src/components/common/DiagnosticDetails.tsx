import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCopyFeedback } from "./useCopyFeedback";

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
  const textRef = useRef<HTMLPreElement>(null);
  const { feedback, hint, announcement, copy } = useCopyFeedback(text, textRef);

  return (
    <details
      className={cn("group text-xs", className)}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex w-fit list-none items-center gap-1 rounded-sm text-muted-foreground focus-ring outline-none select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
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
          className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs wrap-break-word whitespace-pre-wrap text-foreground focus-ring outline-none select-text"
        >
          {text}
        </pre>
        <div className="flex items-center justify-end gap-2">
          {/* The hint shows, because the user must act on it. The live region below
              speaks it, so this copy is hidden from assistive technology. */}
          {feedback === "selected" ? (
            <p aria-hidden="true" className="mr-auto min-w-0 text-muted-foreground">
              {hint}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="xs"
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
