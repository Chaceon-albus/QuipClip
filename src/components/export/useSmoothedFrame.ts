import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createFrameSmoother, type FrameSmoother } from "./exportProgressSmoothing";

/**
 * How the smoothed frame behaves.
 *
 * - `live`: the position moves on each animation frame between the reports.
 * - `frozen`: the position stays where it is, for content that must not change, such as a
 *   dialog that fades out.
 * - `off`: the reported frame shows unchanged.
 */
export type FrameSmoothingMode = "live" | "frozen" | "off";

export interface SmoothedFrame {
  /** The frame to show: the whole part of the smoothed position, or the reported frame. */
  frame: number | null;
  /**
   * The smoothed position at `now`, or null when no frame was reported. It is stable across
   * renders. Call it from a callback or an effect only, because it reads the model of the run.
   */
  positionAt: (now: number) => number | null;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The reduced-motion query, or null in a web view with no media queries. */
function reducedMotionQuery(): MediaQueryList | null {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia(REDUCED_MOTION_QUERY);
    }
  } catch {
    // A web view with no media queries reads as no preference.
  }
  return null;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  if (query === null) {
    return () => {};
  }
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/** True when the system asks for reduced motion. It follows a change of the setting. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

/**
 * Turns the reported frame count into a continuous position (`exportProgressSmoothing`).
 *
 * The hook keeps one model per run in a ref. A layout effect pushes each new `frame` with the
 * time of the commit, so the effects of the child components already see it. A frame of null
 * ends the run, and the next frame starts a new model.
 *
 * A change of `frame` comes from a report that just arrived, so the commit time is its arrival
 * time. The frame that is already there at mount is different: the dialog can open during a
 * run, long after that report. The hook pushes that frame with no time, so it measures no rate
 * (`FrameSampleOptions`). At the start of a run, the panel is already open with no frame, so the
 * first frame of the run has its time.
 *
 * In the `live` mode, a loop of animation frames reads the position while it still moves. It
 * renders only when the whole frame changes, so a slow encode does not render on each animation
 * frame. The loop stops when the position holds, and the next report starts it again. When the
 * system asks for reduced motion, the `live` mode acts as `off`. In the `frozen` mode, the last
 * smoothed frame stays, so the display does not step back to the reported frame.
 *
 * `positionAt` reads the model in every mode, so a clock can sample the position even when the
 * display shows the reported frame.
 */
export function useSmoothedFrame(
  frame: number | null,
  expectedFrames: number | null,
  mode: FrameSmoothingMode,
): SmoothedFrame {
  const reducedMotion = usePrefersReducedMotion();
  const effectiveMode = mode === "live" && reducedMotion ? "off" : mode;
  const smootherRef = useRef<FrameSmoother>(null);
  const mountedRef = useRef(false);
  const previousModeRef = useRef(effectiveMode);
  const expectedFramesRef = useRef(expectedFrames);
  const [smoothed, setSmoothed] = useState<number | null>(null);

  // A position of an earlier run, or of a time with the smoothing off, must not show. The
  // state clears during the render, so the reported frame shows in this render.
  //
  // With the smoothing on and no position yet, the state starts at the reported frame during
  // the render. That is the first position of a new model, because the first report shows at
  // once. The state then changes only from the animation frames. Without this start, a report
  // that comes before the first animation frame would show for one frame and then step back
  // to the position of the model.
  const showReported = frame === null || effectiveMode === "off";
  if (showReported) {
    if (smoothed !== null) {
      setSmoothed(null);
    }
  } else if (smoothed === null) {
    setSmoothed(frame);
  }

  useLayoutEffect(() => {
    expectedFramesRef.current = expectedFrames;
  }, [expectedFrames]);

  useLayoutEffect(() => {
    // Only a frame that changed after the mount has a known arrival time.
    const timed = mountedRef.current;
    mountedRef.current = true;
    if (frame === null) {
      smootherRef.current = null;
      return;
    }
    smootherRef.current ??= createFrameSmoother();
    smootherRef.current.push(frame, performance.now(), { timed });
  }, [frame]);

  // In the `off` mode the display shows the reported frame, and the render that turns the
  // smoothing on starts its state at that frame. Just after a report the position of the model
  // can lie a few frames below it, so the model holds the frame, and the first animation frame
  // does not step back. The rule runs after the push above, so the model already has the frame.
  useLayoutEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = effectiveMode;
    if (previous === "off" && effectiveMode !== "off" && frame !== null) {
      smootherRef.current?.hold(frame);
    }
  }, [effectiveMode, frame]);

  useEffect(() => {
    const smoother = smootherRef.current;
    if (effectiveMode !== "live" || smoother === null) {
      return;
    }
    let handle = 0;
    let shownWhole: number | null = null;
    const step = (now: number) => {
      const position = smoother.frameAt(now, expectedFramesRef.current);
      if (position !== null) {
        const whole = Math.floor(position);
        if (whole !== shownWhole) {
          shownWhole = whole;
          setSmoothed(whole);
        }
      }
      if (smoother.isMoving(now, expectedFramesRef.current)) {
        handle = window.requestAnimationFrame(step);
      }
    };
    handle = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(handle);
    };
    // A new frame can replace the model, and it starts a new segment, so it restarts the loop.
  }, [effectiveMode, frame, expectedFrames]);

  const positionAt = useCallback(
    (now: number) =>
      smootherRef.current?.frameAt(now, expectedFramesRef.current) ?? null,
    [],
  );

  return { frame: showReported ? frame : (smoothed ?? frame), positionAt };
}
