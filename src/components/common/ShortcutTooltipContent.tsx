import type { ComponentProps } from "react";
import { TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

/** The gap between a control and its tooltip, in pixels. */
const TOOLTIP_OFFSET = 6;

interface ShortcutTooltipContentProps extends Omit<
  ComponentProps<typeof TooltipContent>,
  "children"
> {
  /** The name of the action. */
  readonly label: string;
  /** The key chip text, or null when the action has no key. */
  readonly keys?: string | null;
  /** Why the control is disabled, or null when there is nothing to say. */
  readonly reason?: string | null;
}

/**
 * The tooltip of a control: the name of its action, its key chip, and, while the control is
 * disabled, a second, muted line that says why.
 *
 * The name, the chip and the reason are three elements. None of them is assembled into a
 * translated sentence (ADR 011).
 */
export function ShortcutTooltipContent({
  label,
  keys,
  reason,
  className,
  sideOffset = TOOLTIP_OFFSET,
  ...props
}: ShortcutTooltipContentProps) {
  const hasReason = reason !== undefined && reason !== null && reason !== "";
  return (
    <TooltipContent
      sideOffset={sideOffset}
      className={cn(
        // Two lines stack. The tooltip shortens its right padding for a key chip at the end of
        // one line, and the reason line needs the full padding back.
        hasReason && "flex-col items-start gap-0.5 has-data-[slot=kbd]:pr-3",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-center gap-1.5">
        <span>{label}</span>
        {keys ? <Kbd>{keys}</Kbd> : null}
      </span>
      {hasReason ? <span className="text-tooltip-foreground/70">{reason}</span> : null}
    </TooltipContent>
  );
}
