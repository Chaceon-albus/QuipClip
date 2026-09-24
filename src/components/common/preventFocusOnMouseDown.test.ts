import type { MouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { preventFocusOnMouseDown } from "./preventFocusOnMouseDown";

describe("preventFocusOnMouseDown", () => {
  it("cancels the mouse down and does not stop its propagation", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent<HTMLElement>;

    preventFocusOnMouseDown(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
