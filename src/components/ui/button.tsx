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
  // The shadcn focus style, a border in the ring colour and a 3px halo at half strength, is
  // replaced by the `focus-ring` utility of globals.css, the one focus ring of every control.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap focus-ring transition-[color,background-color,border-color,box-shadow,opacity] outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
        // border and the faint fill are border-border and bg-input/30, so the button stays
        // apart from the dialog surface in both themes. The Input and the SelectTrigger
        // take the stronger border-border-strong and the bg-surface-2 well, so a field does
        // not read as a button. Hover is the accent, and press is --accent-hover.
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
        // dark: branch and keep the fills of each theme. Press is --destructive-tint-active.
        // The variant has no focus style of its own: it takes the `focus-ring` of the base.
        destructive:
          "bg-destructive-tint text-destructive hover:bg-destructive-tint-hover active:bg-destructive-tint-active",
        link: "text-primary underline-offset-4 hover:underline",
        // QuipClip: hand-edited — added. A control in the title bar, the status bar or the
        // timeline gutter. Hover and the open state use the accent of the window chrome.
        // Press mixes that accent 10% toward the chrome text colour, which is darker in the
        // light theme and lighter in the dark theme. The focus ring is inset
        // (`focus-ring-inset`): the status bar sits against the window edge, and the timeline
        // gutter is in a container that clips, so a ring outside the button would be cut.
        chrome:
          "text-muted-foreground focus-ring-inset hover:bg-chrome-accent hover:text-chrome-accent-foreground active:bg-[color-mix(in_oklab,var(--chrome-accent),var(--chrome-foreground)_10%)] aria-expanded:bg-chrome-accent aria-expanded:text-chrome-accent-foreground",
        // QuipClip: hand-edited — added. A bordered transport bar button, such as Mark In.
        // Its card fill stands over the background of the bar. Hover is --muted, and press
        // is --secondary-hover.
        tool: "border-border bg-card text-foreground hover:bg-muted hover:text-foreground active:bg-secondary-hover",
        // QuipClip: hand-edited — added. A transport bar button without a border, such as
        // Undo or a frame step. It has no fill of its own, so its hover fill lies on the
        // background of the bar, where --muted is too faint in the light theme. The
        // --tool-ghost-* tokens (globals.css) give it --secondary-hover in the light theme,
        // and the hover and press of the tool variant in the dark theme.
        "tool-ghost":
          "text-muted-foreground hover:bg-tool-ghost-hover hover:text-foreground active:bg-tool-ghost-active",
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
        // QuipClip: hand-edited — added. The three transport bar sizes. They keep the
        // pixel sizes that the transport bar had as call-site classes. A button with its
        // label under the icon, such as Undo, takes `tool-row` with call-site classes.
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
