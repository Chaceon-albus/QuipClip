import { cva, type VariantProps } from "class-variance-authority";

/**
 * Classes of one text item in the status bar: the source item, the approximate-position
 * chip, and the FFmpeg item.
 *
 * Every item is a 24px box, so it fits the 28px bar without making it taller. An icon inline
 * with the text is 14px. The item text goes in a child span with `min-w-0 truncate`, which
 * keeps it on one line. The span shows an ellipsis only when its item is narrower than the
 * text. That happens only to the FFmpeg label, which has a maximum width. The source item and
 * the approximate-position chip are `shrink-0`: they keep their full width, and below 48rem
 * the chip text collapses to its icon before the chip could be cut.
 *
 * Every item that uses these classes can take the focus, so the focus ring is in the base.
 * The ring is inset: the left group clips its overflow, and it would cut an outer ring.
 *
 * - `tone: "warning"` draws a chip. The fill comes from the base token and the text from the
 *   `-text` token, like the warning Notice, because the base token does not reach 4.5:1 as
 *   text in the light theme. A caller also adds an icon, so colour is not the only cue. The
 *   icon also takes the `-text` token: the light base token reaches only about 2.4:1 on the
 *   chip, below the 3:1 that an icon needs, and a collapsed chip shows only its icon.
 * - `interactive: true` adds the hover feedback of a control that has an action. The hover of
 *   a warning chip stays in the warning colours.
 */
export const statusBarItem = cva(
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
  {
    variants: {
      tone: {
        neutral: "text-muted-foreground",
        warning: "bg-warning/10 text-warning-text",
      },
      interactive: {
        true: "transition-colors",
        false: "cursor-default",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        interactive: true,
        className: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      },
      {
        tone: "warning",
        interactive: true,
        className: "hover:bg-warning/20",
      },
    ],
    defaultVariants: {
      tone: "neutral",
      interactive: false,
    },
  },
);

export type StatusBarItemVariants = VariantProps<typeof statusBarItem>;
