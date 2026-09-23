import type * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { resolveProgressBarModel } from "./progressBarModel";

export interface ProgressBarProps extends Omit<
  React.ComponentProps<"div">,
  "children" | "role"
> {
  /** 0 to 100. Null or undefined draws the indeterminate bar. */
  value?: number | null;
  /** Tone variant of the bar: "default", "success", or "destructive". Default "default". */
  tone?: "default" | "success" | "destructive";
  /** Height variant: "xs" (h-1), "sm" (h-1.5), or "md" (h-2). Default "md". */
  size?: "xs" | "sm" | "md";
  /** Moves the gradient along the filled part. Default true. */
  flowing?: boolean;
}

const trackVariants = cva(
  "relative w-full overflow-hidden rounded-full bg-progress-track",
  {
    variants: {
      size: {
        xs: "h-1",
        sm: "h-1.5",
        md: "h-2",
      },
      tone: {
        default: "",
        success:
          "bg-progress-track-success [--progress-from:var(--success)] [--progress-to:var(--progress-to-success)]",
        destructive:
          "bg-progress-track-destructive [--progress-from:var(--destructive)] [--progress-to:var(--progress-to-destructive)]",
      },
    },
    defaultVariants: {
      size: "md",
      tone: "default",
    },
  },
);

/**
 * Reusable progress bar supporting determinate and indeterminate modes,
 * three tone variants, three heights, and an animated gradient fill.
 * The caller must give the bar an accessible name with `aria-label` or `aria-labelledby`.
 */
export function ProgressBar({
  value,
  tone = "default",
  size = "md",
  flowing = true,
  className,
  ...props
}: ProgressBarProps): React.JSX.Element {
  const model = resolveProgressBarModel(value);

  return (
    <div
      {...props}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={model.ariaValueNow}
      data-state={model.mode}
      data-tone={tone}
      className={cn(trackVariants({ size, tone }), className)}
    >
      {model.mode === "determinate" ? (
        <div
          className={cn(
            "h-full rounded-full progress-fill transition-[width] duration-300 ease-out motion-reduce:transition-none",
            flowing && "animate-progress-flow motion-reduce:animate-none",
          )}
          style={{ width: `${model.fillPercent}%` }}
        />
      ) : (
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-1/3 rounded-full progress-fill motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50",
            flowing ? "animate-progress-bounce-flow" : "animate-progress-bounce",
          )}
        />
      )}
    </div>
  );
}
