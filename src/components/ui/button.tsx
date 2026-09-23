import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // QuipClip: hand-edited — the transition lists only the paint properties, so a layout
  // change never animates. Opacity stays in the list, because the transport edit buttons
  // delay their disabled fade. The duration and the curve come from the default transition
  // tokens (globals.css). The shadcn 1px press offset is removed: a desktop control shows
  // its press with a colour, not with a movement. Thus each variant that has a hover fill
  // also has an active: fill. The default variant presses to the palette's
  // --primary-active, which is darker than the rest fill in both themes. Each other
  // variant presses one step past its hover fill, away from the surface under the button:
  // darker in the light theme and lighter in the dark theme. The link variant has no fill.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // QuipClip: hand-edited — hover and press use the palette tokens. The shadcn
        // hover:bg-primary/80 made the fill lighter in the light theme and darker in the
        // dark theme, which is the opposite of --primary-hover. --primary-active is darker
        // than the rest fill in both themes.
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        // QuipClip: hand-edited — no dark: branch. The tokens already differ per theme,
        // and a dark: class (`:is(.dark *)`) is more specific than a call-site hover:
        // class, so it made the call-site overrides work in the light theme only. The
        // border and the faint fill are border-border and bg-input/30, the same as the
        // Input and the SelectTrigger, so the button stays apart from the dialog surface in
        // both themes. Hover is the accent, and press is --accent-hover.
        outline:
          "border-border bg-input/30 hover:bg-accent hover:text-accent-foreground active:bg-accent-hover aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        // QuipClip: hand-edited — the hover fill is the --secondary-hover token. Press mixes
        // that fill 5% toward --foreground: darker in the light theme and lighter in the
        // dark theme.
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-[color-mix(in_oklab,var(--secondary-hover),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // QuipClip: hand-edited — the accent tokens, and no dark: branch, for the reason
        // given at the outline variant. Press is --accent-hover.
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-accent-hover aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        // QuipClip: hand-edited — the --destructive-tint tokens (globals.css) replace the
        // dark: branch and keep the fills and the ring of each theme. Press is
        // --destructive-tint-active.
        destructive:
          "bg-destructive-tint text-destructive hover:bg-destructive-tint-hover focus-visible:border-destructive/40 focus-visible:ring-destructive-ring active:bg-destructive-tint-active",
        link: "text-primary underline-offset-4 hover:underline",
        // QuipClip: hand-edited — added. A control in the title bar or the status bar.
        // Hover and the open state use the sidebar accent of the window chrome. Press
        // mixes that accent 10% toward the chrome text colour, which is darker in the light
        // theme and lighter in the dark theme.
        chrome:
          "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_10%)] aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground",
        // QuipClip: hand-edited — added. A bordered transport bar button on the card
        // surface, such as Mark In. Hover is --muted, and press is --secondary-hover.
        tool: "border-border bg-card text-foreground hover:bg-muted hover:text-foreground active:bg-secondary-hover",
        // QuipClip: hand-edited — added. A transport bar button without a border, such as
        // Undo or a frame step. The same hover and press as the tool variant.
        "tool-ghost":
          "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-secondary-hover",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
        // QuipClip: hand-edited — added. The four transport bar sizes. They keep the
        // pixel sizes that the transport bar had as call-site classes.
        // `tool`: an icon over a label, such as Undo.
        tool: "size-12 flex-col gap-0.5 p-1",
        // `tool-row`: an icon beside a label, such as Mark In.
        "tool-row": "h-10 gap-2 px-3",
        // `tool-icon`: an icon only, such as a frame step.
        "tool-icon": "size-10",
        // `tool-icon-lg`: the Play and Pause button.
        "tool-icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
