import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { glyphStrokeWidth, useDevicePixelRatio } from "./windowGlyphStroke";

/**
 * The glyphs of the Windows window buttons.
 *
 * They copy the Windows 11 caption glyphs of Segoe Fluent Icons (ChromeMinimize E921,
 * ChromeMaximize E922, ChromeRestore E923, ChromeClose E8BB): a 10 pixel box and a 1 pixel
 * stroke for every glyph. Lucide icons have a 2 unit stroke and a different box per icon, so
 * the three buttons did not match.
 *
 * The coordinates sit on half pixels, so a 1 pixel stroke fills whole pixels at 100 % when
 * the box starts on a whole pixel. The caller must place the box on a whole pixel. The title
 * bar pads each button for that. The straight glyphs use `crispEdges`. The close glyph uses
 * `geometricPrecision`, because its diagonals need anti-aliasing. `vector-effect` is not
 * inherited, so each shape carries it.
 *
 * At a fractional scale factor, the stroke of a `crispEdges` glyph is a whole number of
 * device pixels, so every edge has the same width (`glyphStrokeWidth`). Such a stroke can be
 * wider than 1 CSS pixel, so the frame does not clip the outer edges. The close glyph keeps
 * 1 CSS pixel: anti-aliasing spreads a diagonal over partial pixels at any width, and a
 * thinner stroke made one diagonal fainter than the other at 125 %.
 */

interface GlyphProps {
  readonly className?: string;
}

interface GlyphFrameProps extends GlyphProps {
  readonly shapeRendering: "crispEdges" | "geometricPrecision";
  readonly children: ReactNode;
}

function GlyphFrame({ className, shapeRendering, children }: GlyphFrameProps) {
  const devicePixelRatio = useDevicePixelRatio();
  const strokeWidth =
    shapeRendering === "crispEdges" ? glyphStrokeWidth(devicePixelRatio) : 1;
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      shapeRendering={shapeRendering}
      overflow="visible"
      aria-hidden="true"
      focusable="false"
      className={cn("pointer-events-none shrink-0", className)}
    >
      {children}
    </svg>
  );
}

/** A horizontal line across the vertical centre. */
export function MinimizeGlyph({ className }: GlyphProps) {
  return (
    <GlyphFrame className={className} shapeRendering="crispEdges">
      <path d="M0 5.5H10" vectorEffect="non-scaling-stroke" />
    </GlyphFrame>
  );
}

/** One square that fills the box. */
export function MaximizeGlyph({ className }: GlyphProps) {
  return (
    <GlyphFrame className={className} shapeRendering="crispEdges">
      <rect x="0.5" y="0.5" width="9" height="9" vectorEffect="non-scaling-stroke" />
    </GlyphFrame>
  );
}

/**
 * Two overlapped squares: a front square at the bottom left, and the visible top and right
 * edges of a back square that is 2 pixels up and to the right.
 */
export function RestoreGlyph({ className }: GlyphProps) {
  return (
    <GlyphFrame className={className} shapeRendering="crispEdges">
      <rect x="0.5" y="2.5" width="7" height="7" vectorEffect="non-scaling-stroke" />
      <path d="M2.5 2.5V0.5H9.5V7.5H7.5" vectorEffect="non-scaling-stroke" />
    </GlyphFrame>
  );
}

/** Two diagonals from corner to corner. */
export function CloseGlyph({ className }: GlyphProps) {
  return (
    <GlyphFrame className={className} shapeRendering="geometricPrecision">
      <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" vectorEffect="non-scaling-stroke" />
    </GlyphFrame>
  );
}
