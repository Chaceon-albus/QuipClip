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
  /**
   * Tone variant of the bar: "default", "success", "destructive", or "neutral". Default
   * "default". A change of tone fades the colours, so a bar that stays mounted from a run
   * into its result does not jump to the colour of the result.
   */
  tone?: "default" | "success" | "destructive" | "neutral";
  /** Height variant: "xs" (h-1), "sm" (h-1.5), or "md" (h-2). Default "md". */
  size?: "xs" | "sm" | "md";
  /**
   * Moves the gradient along the filled part. Default true. On a determinate bar, false
   * pauses the gradient where it is, so a bar that stops flowing does not jump.
   */
  flowing?: boolean;
}

// The tone sets the two ends of the fill gradient on the track, and the fill inherits them.
// `globals.css` registers both as colours, so the transition on the track fades them. The
// colour change is not motion, so it stays when the system asks for reduced motion.
const trackVariants = cva(
  "relative w-full overflow-hidden rounded-full bg-progress-track transition-[background-color,--progress-from,--progress-to] duration-(--motion-slow) ease-standard",
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
        neutral:
          "bg-progress-track-neutral [--progress-from:var(--muted-foreground)] [--progress-to:var(--progress-to-neutral)]",
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
 * four tone variants, three heights, and an animated gradient fill.
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
            "h-full animate-progress-flow rounded-full progress-fill transition-[width] duration-300 ease-out motion-reduce:animate-none motion-reduce:transition-none",
            !flowing && "[animation-play-state:paused]",
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
