import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A key chip, such as `⇧⌘Z` or `Ctrl+Shift+Z`, beside the label of a control.
 *
 * The chip takes its colours from `currentColor`, so it reads on the dark tooltip of the light
 * theme and on the grey tooltip of the dark theme without a colour of its own. The tooltip
 * content styles `data-slot="kbd"` and shortens its own right padding when it holds a chip.
 *
 * The chip is a separate element and is never part of a translated sentence (ADR 011).
 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm border border-current/25 bg-current/10 px-1 font-sans text-2xs leading-none font-medium whitespace-nowrap select-none",
        className,
      )}
      {...props}
    />
  );
}
