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
  /**
   * The key chip text, or the texts of several chips for an action with more than one key
   * (`ShortcutLabel.chips`), or null when the action has no key.
   */
  readonly keys?: string | readonly string[] | null;
  /** A second, muted line: what the user must do first, or null. */
  readonly reason?: string | null;
}

/**
 * The tooltip of a control: the name of its action, its key chip, and a second, muted line
 * that says what the user must do first. A disabled control shows why it is disabled there.
 * An enabled control can also show it, when its action would only report a missing step
 * (ADR 024).
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
  const chips = (typeof keys === "string" ? [keys] : (keys ?? [])).filter(
    (chip) => chip !== "",
  );
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
        {/* Two chips side by side could read as a key sequence, so a slash stands between
            two keys that each perform the action. */}
        {chips.map((chip, index) => (
          <span key={chip} className="inline-flex items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden="true" className="text-tooltip-foreground/60">
                /
              </span>
            ) : null}
            <Kbd>{chip}</Kbd>
          </span>
        ))}
      </span>
      {hasReason ? <span className="text-tooltip-foreground/70">{reason}</span> : null}
    </TooltipContent>
  );
}
