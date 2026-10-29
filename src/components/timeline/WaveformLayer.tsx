/**
 * The audio envelope of each clip whose source shows it (ADR 056).
 *
 * One canvas covers the visible part of the lane and a margin on each side. It is above the
 * segments and below the clip labels, it takes no pointer events, and the accessibility tree
 * does not show it. It starts below the clip label and the two lines of a segment label, so the
 * envelope never covers their text. A track too short for that gets the envelope over its whole
 * height. The lane can be 100,000 px wide, so the canvas never spans it: it moves
 * with the scroll and draws again in the next animation frame. The margin hides the edge that a
 * scroll shows before that frame.
 *
 * The envelope data lives outside React (`waveformData`), so a new piece of a job draws the
 * canvas again and renders nothing. With no source that shows an envelope, the layer renders
 * no canvas at all.
 *
 * The growth of the envelope while its job reads is data, not an animation, so the motion rule
 * of ADR 007 does not apply to it.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { RefObject } from "react";
import { mediaStore } from "@/features/media";
import { timelineStore } from "@/features/timeline";
import {
  drawEnvelope,
  planWaveformColumns,
  waveformData,
  type WaveformSourceView,
} from "@/features/waveform";
import { subscribeDevicePixelRatio } from "@/components/layout/windowGlyphStroke";
import { calculateClipBarLayouts } from "./clipBarLayout";

/** The margin of the canvas on each side of the visible lane, in CSS pixels. */
const OVERSCAN_PX = 512;
/** The opacity of the peak and of the RMS over it. */
const PEAK_ALPHA = 0.25;
const RMS_ALPHA = 0.5;
/** The top of the canvas in the track box: below the clip label and a segment label. */
const BELOW_LABELS_PX = 44;
/** The top of the canvas in a short track: the top of the segments. */
const SHORT_TRACK_TOP_PX = 8;
/** The lowest track box that keeps the labels clear and still shows a useful envelope. */
const LABELS_CLEAR_MIN_HEIGHT_PX = 100;
/** The colour when the canvas cannot read the token of the palette. */
const FALLBACK_RGB: readonly [number, number, number] = [32, 96, 104];

interface WaveformLayerProps {
  readonly totalDurationSeconds: number | null;
  readonly laneWidthPx: number;
  readonly viewportWidthPx: number;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}

const subscribeData = (listener: () => void) => waveformData.subscribe(listener);
// A string, so the snapshot stays equal while the set of sources does not change.
const shownSources = () => waveformData.sourceIds().sort().join("\n");

export function WaveformLayer(props: WaveformLayerProps) {
  const shown = useSyncExternalStore(subscribeData, shownSources, shownSources);
  if (shown === "" || props.totalDurationSeconds === null) {
    return null;
  }
  return <WaveformCanvas {...props} />;
}

interface EnvelopeColors {
  readonly peak: string;
  readonly rms: string;
}

/**
 * The colours of the envelope from the token `--timeline-waveform`. The canvas resolves the
 * token through a pixel, so a colour space that the context cannot take falls back to a fixed
 * colour instead of black.
 */
function resolveColors(element: HTMLElement): EnvelopeColors {
  const token = getComputedStyle(element)
    .getPropertyValue("--timeline-waveform")
    .trim();
  let rgb: readonly [number, number, number] = FALLBACK_RGB;
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (context !== null && token !== "") {
    const sentinel = "#010203";
    context.fillStyle = sentinel;
    context.fillStyle = token;
    if (context.fillStyle !== sentinel) {
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      rgb = [r, g, b];
    }
  }
  const [r, g, b] = rgb;
  return {
    peak: `rgba(${r}, ${g}, ${b}, ${PEAK_ALPHA})`,
    rms: `rgba(${r}, ${g}, ${b}, ${RMS_ALPHA})`,
  };
}

function WaveformCanvas({
  totalDurationSeconds,
  laneWidthPx,
  viewportWidthPx,
  scrollRef,
}: WaveformLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef({ totalDurationSeconds, laneWidthPx, viewportWidthPx });
  const frameRef = useRef<number | null>(null);
  const colorsRef = useRef<EnvelopeColors | null>(null);

  const draw = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    const { totalDurationSeconds, laneWidthPx, viewportWidthPx } = geometryRef.current;
    if (canvas === null || scroll === null || totalDurationSeconds === null) {
      return;
    }
    const virtual = timelineStore.getState().virtual;
    const layouts = calculateClipBarLayouts(virtual, totalDurationSeconds);
    const media = mediaStore.getState().sources;
    const sources = new Map<string, WaveformSourceView>();
    for (const sourceId of waveformData.sourceIds()) {
      const probe = media[sourceId]?.probe;
      const buffer = waveformData.get(sourceId);
      if (probe?.videoStartPts == null || buffer === undefined) {
        continue;
      }
      sources.set(sourceId, {
        originPts: probe.videoStartPts,
        timeBase: probe.videoTimeBase,
        length: buffer.length,
      });
    }
    const dpr = window.devicePixelRatio || 1;
    const plan = planWaveformColumns({
      layouts: layouts ?? [],
      clips: virtual?.clips ?? [],
      sources,
      laneWidthPx,
      totalDurationSeconds,
      scrollLeftPx: scroll.scrollLeft,
      viewportWidthPx,
      overscanPx: OVERSCAN_PX,
      dpr,
    });
    const boxHeight = canvas.parentElement?.clientHeight ?? 0;
    const top =
      boxHeight >= LABELS_CLEAR_MIN_HEIGHT_PX ? BELOW_LABELS_PX : SHORT_TRACK_TOP_PX;
    canvas.style.top = `${top}px`;
    const heightPx = Math.max(0, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== plan.widthDevicePx) {
      canvas.width = plan.widthDevicePx;
    }
    if (canvas.height !== heightPx) {
      canvas.height = heightPx;
    }
    canvas.style.width = `${plan.widthDevicePx / dpr}px`;
    canvas.style.transform = `translateX(${plan.canvasLeftPx}px)`;
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    colorsRef.current ??= resolveColors(canvas);
    drawEnvelope(context, plan, (sourceId) => waveformData.get(sourceId), {
      heightPx,
      peakColor: colorsRef.current.peak,
      rmsColor: colorsRef.current.rms,
      alpha: 1,
    });
  }, [scrollRef]);

  const schedule = useCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(draw);
    }
  }, [draw]);

  useLayoutEffect(() => {
    geometryRef.current = { totalDurationSeconds, laneWidthPx, viewportWidthPx };
    schedule();
  }, [totalDurationSeconds, laneWidthPx, viewportWidthPx, schedule]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    scroll?.addEventListener("scroll", schedule, { passive: true });
    const stopData = waveformData.subscribe(schedule);
    const stopTimeline = timelineStore.subscribe((state, previous) => {
      if (state.virtual !== previous.virtual) {
        schedule();
      }
    });
    const stopMedia = mediaStore.subscribe((state, previous) => {
      if (state.sources !== previous.sources) {
        schedule();
      }
    });
    // The height of the track row and the theme change the canvas without a render of it.
    const resize = new ResizeObserver(schedule);
    if (canvas !== null) {
      resize.observe(canvas);
    }
    const theme = new MutationObserver(() => {
      colorsRef.current = null;
      schedule();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // A move to a display of another scale keeps the CSS size, so no resize reports it.
    const stopScale = subscribeDevicePixelRatio(schedule);
    return () => {
      scroll?.removeEventListener("scroll", schedule);
      stopData();
      stopTimeline();
      stopMedia();
      resize.disconnect();
      theme.disconnect();
      stopScale();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scrollRef, schedule]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute top-2 bottom-3 left-0 z-15"
    />
  );
}
