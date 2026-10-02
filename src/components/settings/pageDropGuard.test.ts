import { describe, expect, it, vi } from "vitest";
import {
  isEditableDropTarget,
  refuseDragOver,
  refuseDrop,
  startPageDropGuard,
  type PageDragEvent,
  type PageDropTarget,
} from "./pageDropGuard";

const TEXT_FIELD = { tagName: "INPUT", type: "text" };
const PAGE = { tagName: "DIV" };

function dragEvent(target: unknown, types: string[] | null) {
  const preventDefault = vi.fn<() => void>();
  const event: PageDragEvent = {
    target,
    dataTransfer: types === null ? null : { types, dropEffect: "copy" },
    preventDefault,
  };
  return Object.assign(event, { preventDefault });
}

describe("isEditableDropTarget", () => {
  it("is true for a text input, a text area and an editable element", () => {
    expect(isEditableDropTarget(TEXT_FIELD)).toBe(true);
    expect(isEditableDropTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isEditableDropTarget({ tagName: "INPUT", type: "" })).toBe(true);
    expect(isEditableDropTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableDropTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("is false for every other element and for a field that cannot be edited", () => {
    expect(isEditableDropTarget(PAGE)).toBe(false);
    expect(isEditableDropTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableDropTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditableDropTarget({ tagName: "INPUT", type: "file" })).toBe(false);
    expect(isEditableDropTarget({ ...TEXT_FIELD, readOnly: true })).toBe(false);
    expect(isEditableDropTarget({ ...TEXT_FIELD, disabled: true })).toBe(false);
    expect(isEditableDropTarget(null)).toBe(false);
    expect(isEditableDropTarget("INPUT")).toBe(false);
  });
});

describe("refuseDragOver", () => {
  it("refuses a drag of files, a link and an image over the page", () => {
    for (const types of [
      ["Files"],
      ["text/uri-list", "text/plain"],
      ["text/html"],
      null,
    ]) {
      const event = dragEvent(PAGE, types);
      refuseDragOver(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      if (event.dataTransfer !== null) {
        expect(event.dataTransfer.dropEffect).toBe("none");
      }
    }
  });

  it("leaves a drag of text over a text field to its default action", () => {
    const event = dragEvent(TEXT_FIELD, ["text/plain"]);
    refuseDragOver(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.dataTransfer?.dropEffect).toBe("copy");
  });

  it("refuses a drag of files over a text field too", () => {
    const event = dragEvent(TEXT_FIELD, ["Files"]);
    refuseDragOver(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.dataTransfer?.dropEffect).toBe("none");
  });
});

describe("refuseDrop", () => {
  it("cancels a drop on the page, which would open what was dropped", () => {
    for (const types of [["text/uri-list"], ["Files"], ["text/plain"]]) {
      const event = dragEvent(PAGE, types);
      refuseDrop(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves a drop of text into a text field to its default action", () => {
    const event = dragEvent(TEXT_FIELD, ["text/plain"]);
    refuseDrop(event);
    expect(event.preventDefault).not.toHaveBeenCalled();

    const files = dragEvent(TEXT_FIELD, ["Files"]);
    refuseDrop(files);
    expect(files.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("startPageDropGuard", () => {
  it("listens for dragover and drop until the stop", () => {
    const listeners = new Map<string, unknown>();
    const target: PageDropTarget = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) {
          listeners.delete(type);
        }
      },
    };
    const stop = startPageDropGuard(target);
    expect(listeners.get("dragover")).toBe(refuseDragOver);
    expect(listeners.get("drop")).toBe(refuseDrop);
    stop();
    expect(listeners.size).toBe(0);
  });
});
