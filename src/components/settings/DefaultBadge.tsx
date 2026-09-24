import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The Default badge of the default preset (ADR 024). A row of the preset list and an item of the
 * preset select in the export setup step show it, so the default preset reads the same in
 * Settings and in the export dialog. The text does not wrap, so a narrow row never makes the
 * badge two lines high.
 *
 * The text takes `accent-foreground`, not `primary`. Measured with the WCAG 2 formula against
 * the palette in `globals.css`, over the /10 primary fill, on a preset list row:
 * | Row              | Light  | Dark    |
 * | ---------------- | ------ | ------- |
 * | Not selected     | 9.95:1 | 13.44:1 |
 * | Pointer over it  | 9.37:1 | 12.95:1 |
 * | Selected         | 7.93:1 | 10.12:1 |
 * The `primary` text gave 4.40:1 on a row that is not selected and 3.51:1 on the selected row
 * in the light theme. An item of the preset select is on the same two surfaces: the popover
 * and the accent of the highlighted item.
 */
export function DefaultBadge({ id, className }: { id?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      id={id}
      className={cn(
        "shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-2xs leading-none font-semibold whitespace-nowrap text-accent-foreground",
        className,
      )}
    >
      {t("settings.preset.defaultBadge")}
    </span>
  );
}
