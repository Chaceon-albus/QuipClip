import type * as React from "react";
import { cva } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type NoticeTone = "neutral" | "info" | "success" | "warning" | "destructive";

export interface NoticeProps extends React.ComponentProps<"div"> {
  /** Color family of the box. Default "neutral". */
  tone?: NoticeTone;
  /** Optional leading lucide icon. It is decorative and hidden from assistive technology. */
  icon?: LucideIcon;
}

// Tinted tones draw the fill and the border from the base token and the text from the
// `-text` token, because the base token does not reach 4.5:1 as text in the light theme.
const noticeVariants = cva("flex gap-2 rounded-md border p-2.5 text-xs", {
  variants: {
    tone: {
      neutral: "border-border bg-muted/40 text-muted-foreground",
      info: "border-info/30 bg-info/10 text-info-text",
      success: "border-success/30 bg-success/10 text-success-text",
      warning: "border-warning/30 bg-warning/10 text-warning-text",
      destructive: "border-destructive/30 bg-destructive/10 text-destructive-text",
    },
  },
  defaultVariants: {
    tone: "neutral",
  },
});

// An icon is not text, so it keeps the base token.
const iconVariants = cva("mt-px size-3.5 shrink-0", {
  variants: {
    tone: {
      neutral: "",
      info: "text-info",
      success: "text-success",
      warning: "text-warning",
      destructive: "text-destructive",
    },
  },
  defaultVariants: {
    tone: "neutral",
  },
});

/**
 * Small notice box for an inline message, such as an error, a warning, or a result.
 *
 * The box sets no `role`. The caller passes `role="alert"` for an error or `role="status"`
 * for a result.
 */
export function Notice({
  tone = "neutral",
  icon: Icon,
  className,
  children,
  ...props
}: NoticeProps): React.JSX.Element {
  return (
    <div
      {...props}
      data-tone={tone}
      className={cn(noticeVariants({ tone }), className)}
    >
      {Icon ? <Icon aria-hidden="true" className={iconVariants({ tone })} /> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
