"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // QuipClip: hand-edited — the shadcn focus style, a border in the ring colour and a
        // 3px halo at half strength, and its reset inside a field label, are replaced by
        // `focus-ring` (globals.css), the one focus ring of every control. No
        // data-disabled:cursor-not-allowed: a disabled control keeps the default cursor, the
        // same as a disabled Button. The unchecked track is bg-muted-foreground/75 in both
        // themes, not bg-input with a dark: branch. The bg-input track and the thumb on it
        // were near 1.3:1 against the surface in the light theme, so the off state did not
        // read at a glance. Measured with the WCAG 2 formula against the palette, on the
        // bg-muted/20 summary box over the popover of the export dialog:
        // | Part                         | Light  | Dark   |
        // | ---------------------------- | ------ | ------ |
        // | Checked track, surface       | 4.89:1 | 7.69:1 |
        // | Checked thumb, track         | 4.74:1 | 7.98:1 |
        // | Unchecked track, surface     | 3.35:1 | 4.13:1 |
        // | Unchecked thumb, track       | 3.25:1 | 3.58:1 |
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent focus-ring transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-muted-foreground/75 data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
