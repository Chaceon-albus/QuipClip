import { describe, expect, it, vi } from "vitest";
import {
  calculateHoverLineOffset,
  createTimelineHoverLine,
  hideHoverLine,
  hideSnapIndicator,
  HOVER_LABEL_GAP_PX,
  resolveHoverLabelSide,
  showSnapIndicator,
  snapToDevicePixel,
  writeHoverLine,
  type HoverPointer,
  type HoverScheduler,
} from "./timelineHover";

describe("resolveHoverLabelSide", () => {
  // A visible lane from x 100 to x 1000, and a label 80 px wide.
  it("puts the label to the right of the line when it fits there", () => {
    expect(resolveHoverLabelSide(500, 80, 100, 1000)).toBe("right");
    expect(resolveHoverLabelSide(1000 - 80 - HOVER_LABEL_GAP_PX, 80, 100, 1000)).toBe(
      "right",
    );
  });

  it("moves the label to the left near the right edge", () => {
    expect(
      resolveHoverLabelSide(1000 - 80 - HOVER_LABEL_GAP_PX + 1, 80, 100, 1000),
    ).toBe("left");
    expect(resolveHoverLabelSide(995, 80, 100, 1000)).toBe("left");
  });

  it("takes the side with more room when the label fits on neither side", () => {
    expect(resolveHoverLabelSide(150, 200, 100, 300)).toBe("right");
    expect(resolveHoverLabelSide(260, 200, 100, 300)).toBe("left");
  });

  it("falls back to the right for an input that is not finite", () => {
    expect(resolveHoverLabelSide(NaN, 80, 100, 1000)).toBe("right");
    expect(resolveHoverLabelSide(995, NaN, 100, 1000)).toBe("right");
  });
});

describe("snapToDevicePixel", () => {
  it("rounds to the device pixel grid", () => {
    expect(snapToDevicePixel(10.3, 1)).toBe(10);
    expect(snapToDevicePixel(10.3, 2)).toBe(10.5);
    expect(snapToDevicePixel(10.2, 2)).toBe(10);
    expect(snapToDevicePixel(10.5, 1.25)).toBe(10.4);
  });

  it("uses a ratio of 1 for a ratio that is not usable, and 0 for an offset that is not finite", () => {
    expect(snapToDevicePixel(10.3, 0)).toBe(10);
    expect(snapToDevicePixel(10.3, NaN)).toBe(10);
    expect(snapToDevicePixel(NaN, 2)).toBe(0);
  });
});

describe("calculateHoverLineOffset", () => {
  it("puts the line on the device pixel grid when the lane edge lies between two pixels", () => {
    for (const ratio of [1, 1.25, 1.5, 1.75, 2]) {
      for (const laneLeft of [96, 95.6, 96.3, -1204.4]) {
        for (const clientX of [300, 300.3, 300.5, 301.9]) {
          const offset = calculateHoverLineOffset(clientX, laneLeft, ratio);
          const devicePixels = (laneLeft + offset) * ratio;
          expect(Math.abs(devicePixels - Math.round(devicePixels))).toBeLessThan(1e-9);
          // Less than one device pixel from the pointer.
          expect(Math.abs(laneLeft + offset - clientX)).toBeLessThanOrEqual(
            0.5 / ratio + 1e-9,
          );
        }
      }
    }
  });

  it("gives 0 for an input that is not finite", () => {
    expect(calculateHoverLineOffset(NaN, 96, 2)).toBe(0);
    expect(calculateHoverLineOffset(300, Infinity, 2)).toBe(0);
  });
});

interface FakeFrames extends HoverScheduler {
  run: () => void;
  pending: () => number;
}

function createFakeFrames(): FakeFrames {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  return {
    request(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
    run() {
      const entries = [...callbacks.values()];
      callbacks.clear();
      entries.forEach((callback) => callback());
    },
    pending: () => callbacks.size,
  };
}

const mouse = (clientX: number, buttons = 0): HoverPointer => ({
  clientX,
  pointerType: "mouse",
  buttons,
});

function createHover(options: { suppressed?: boolean; drawResult?: boolean } = {}) {
  let suppressed = options.suppressed ?? false;
  const frames = createFakeFrames();
  const draw = vi.fn((_clientX: number) => options.drawResult ?? true);
  const hide = vi.fn();
  const hover = createTimelineHoverLine({
    isSuppressed: () => suppressed,
    draw,
    hide,
    scheduler: frames,
  });
  return {
    hover,
    frames,
    draw,
    hide,
    setSuppressed: (value: boolean) => {
      suppressed = value;
    },
  };
}

describe("createTimelineHoverLine", () => {
  it("draws once per frame at the latest pointer position", () => {
    const { hover, frames, draw } = createHover();
    hover.move(mouse(100));
    hover.move(mouse(120));
    hover.move(mouse(140));
    expect(draw).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(140);
  });

  it("hides on leave in the next frame, and does not draw a move that the leave followed", () => {
    const { hover, frames, draw, hide } = createHover();
    hover.move(mouse(100));
    frames.run();
    hover.move(mouse(120));
    hover.leave();
    // Not at once: a move in the same frame can still cancel the hide.
    expect(hide).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("does not flicker when the pointer moves from one lane to the other in one frame", () => {
    const { hover, frames, draw, hide } = createHover();
    hover.move(mouse(100));
    frames.run();
    // The pointer leaves the ruler lane and moves over the track lane before the next frame.
    hover.leave();
    hover.move(mouse(101));
    expect(frames.pending()).toBe(1);
    frames.run();
    expect(hide).not.toHaveBeenCalled();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenLastCalledWith(101);
  });

  it("cancels a scheduled first draw on leave, with nothing to hide", () => {
    const { hover, frames, draw, hide } = createHover();
    hover.move(mouse(100));
    hover.leave();
    expect(frames.pending()).toBe(0);
    frames.run();
    expect(draw).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });

  it("does not hide again while the line is already hidden", () => {
    const { hover, hide } = createHover();
    hover.leave();
    hover.hide();
    expect(hide).not.toHaveBeenCalled();
  });

  it("hides and does not draw while a drag runs", () => {
    const { hover, frames, draw, hide, setSuppressed } = createHover();
    hover.move(mouse(100));
    frames.run();
    setSuppressed(true);
    hover.move(mouse(120));
    expect(hide).toHaveBeenCalledTimes(1);
    frames.run();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("hides in the frame when a drag started after the move", () => {
    const { hover, frames, draw, hide, setSuppressed } = createHover();
    hover.move(mouse(100));
    frames.run();
    hover.move(mouse(120));
    setSuppressed(true);
    frames.run();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("hides for a pointer with a button held and for a touch pointer", () => {
    const { hover, frames, draw, hide } = createHover();
    hover.move(mouse(100));
    frames.run();
    hover.move(mouse(120, 1));
    expect(hide).toHaveBeenCalledTimes(1);
    hover.move({ clientX: 130, pointerType: "touch", buttons: 0 });
    frames.run();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("hides when it cannot draw", () => {
    const { hover, frames, hide } = createHover({ drawResult: false });
    hover.move(mouse(100));
    frames.run();
    // The line was not shown, so there is nothing to hide.
    expect(hide).not.toHaveBeenCalled();
    hover.refresh();
    // The pointer is forgotten, so a refresh draws nothing.
    expect(frames.pending()).toBe(0);
  });

  it("hides a shown line when a later draw fails", () => {
    let result = true;
    const frames = createFakeFrames();
    const hide = vi.fn();
    const hover = createTimelineHoverLine({
      isSuppressed: () => false,
      draw: () => result,
      hide,
      scheduler: frames,
    });
    hover.move(mouse(100));
    frames.run();
    result = false;
    hover.move(mouse(120));
    frames.run();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("draws again on refresh at the last pointer position", () => {
    const { hover, frames, draw } = createHover();
    hover.refresh();
    expect(frames.pending()).toBe(0);
    hover.move(mouse(100));
    frames.run();
    hover.refresh();
    frames.run();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenLastCalledWith(100);
  });

  it("hide forgets the pointer, so a refresh does not show the line again", () => {
    const { hover, frames, draw } = createHover();
    hover.move(mouse(100));
    frames.run();
    hover.hide();
    hover.refresh();
    frames.run();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a scheduled frame", () => {
    const { hover, frames, draw } = createHover();
    hover.move(mouse(100));
    hover.dispose();
    expect(frames.pending()).toBe(0);
    frames.run();
    expect(draw).not.toHaveBeenCalled();
  });
});

/** A stand-in for an HTMLElement with only the fields that the writers use. */
function fakeElement(offsetWidth = 0) {
  return {
    hidden: true,
    style: { transform: "", left: "" },
    textContent: "",
    dataset: {} as Record<string, string>,
    offsetWidth,
  } as unknown as HTMLElement;
}

describe("writeHoverLine and hideHoverLine", () => {
  it("moves both lines by one transform, writes the label and shows the lines", () => {
    const ruler = fakeElement();
    const track = fakeElement();
    const label = fakeElement(80);
    const resolveSide = vi.fn(() => "left" as const);
    writeHoverLine(
      { ruler, label, track },
      { offsetPx: 42.5, text: "≈ 00:00:01:02", resolveSide },
    );
    expect(ruler.style.transform).toBe("translateX(42.5px)");
    expect(track.style.transform).toBe("translateX(42.5px)");
    expect(ruler.hidden).toBe(false);
    expect(track.hidden).toBe(false);
    expect(label.textContent).toBe("≈ 00:00:01:02");
    expect(resolveSide).toHaveBeenCalledWith(80);
    expect(label.dataset.side).toBe("left");

    hideHoverLine({ ruler, label, track });
    expect(ruler.hidden).toBe(true);
    expect(track.hidden).toBe(true);
  });

  it("measures the label again only when the length of its text changes", () => {
    const label = fakeElement(80);
    const resolveSide = vi.fn(() => "right" as const);
    const elements = { ruler: fakeElement(), label, track: fakeElement() };
    writeHoverLine(elements, { offsetPx: 1, text: "≈ 00:00:01:02", resolveSide });
    Object.assign(label, { offsetWidth: 999 });
    writeHoverLine(elements, { offsetPx: 2, text: "≈ 00:00:01:03", resolveSide });
    expect(resolveSide).toHaveBeenLastCalledWith(80);
    writeHoverLine(elements, { offsetPx: 3, text: "≈ 01:00:00:00:00", resolveSide });
    expect(resolveSide).toHaveBeenLastCalledWith(999);
  });

  it("does not keep a width of 0, which a label that is not rendered reports", () => {
    const label = fakeElement(0);
    const resolveSide = vi.fn(() => "right" as const);
    const elements = { ruler: fakeElement(), label, track: fakeElement() };
    writeHoverLine(elements, { offsetPx: 1, text: "≈ 00:00:01:02", resolveSide });
    expect(resolveSide).toHaveBeenLastCalledWith(0);
    Object.assign(label, { offsetWidth: 80 });
    writeHoverLine(elements, { offsetPx: 2, text: "≈ 00:00:01:03", resolveSide });
    expect(resolveSide).toHaveBeenLastCalledWith(80);
  });

  it("skips an element that is not mounted", () => {
    expect(() => {
      writeHoverLine(
        { ruler: null, label: null, track: null },
        { offsetPx: 1, text: "x", resolveSide: () => "right" },
      );
      hideHoverLine({ ruler: null, label: null, track: null });
    }).not.toThrow();
  });
});

describe("showSnapIndicator and hideSnapIndicator", () => {
  it("places the 1px line centred on the boundary with left, and shows it", () => {
    const ruler = fakeElement();
    const track = fakeElement();
    showSnapIndicator({ ruler, track }, 0.25);
    expect(ruler.style.left).toBe("calc(25% - 0.5px)");
    expect(track.style.left).toBe("calc(25% - 0.5px)");
    expect(ruler.hidden).toBe(false);
    expect(track.hidden).toBe(false);

    hideSnapIndicator({ ruler, track });
    expect(ruler.hidden).toBe(true);
    expect(track.hidden).toBe(true);
  });

  it("skips an element that is not mounted", () => {
    const ruler = fakeElement();
    showSnapIndicator({ ruler, track: null }, 1);
    expect(ruler.style.left).toBe("calc(100% - 0.5px)");
    expect(() => hideSnapIndicator({ ruler: null, track: null })).not.toThrow();
  });
});
