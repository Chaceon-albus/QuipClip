import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // QuipClip: hand-edited — no disabled:cursor-not-allowed. A disabled control keeps
        // the default cursor, the same as a disabled Button. The border is
        // border-border-strong and the fill is bg-surface-2 in both themes, not a dark:
        // branch, the same as a SelectTrigger: a field is a well with a clear edge
        // (globals.css). The shadcn focus style, a border in the ring colour and a 3px halo
        // at half strength, is replaced by `focus-ring`, the one focus ring of every control.
        "h-8 w-full min-w-0 rounded-lg border border-border-strong bg-surface-2 px-2.5 py-1 text-base focus-ring transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
