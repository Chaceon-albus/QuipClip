import { describe, expect, it, vi } from "vitest";
import {
  refuseFileDragOver,
  refuseFileDrop,
  startPageDropGuard,
  type PageDragEvent,
  type PageDropTarget,
} from "./pageDropGuard";

function dragEvent(types: string[] | null) {
  const preventDefault = vi.fn<() => void>();
  const event: PageDragEvent = {
    dataTransfer: types === null ? null : { types, dropEffect: "copy" },
    preventDefault,
  };
  return Object.assign(event, { preventDefault });
}

describe("refuseFileDragOver", () => {
  it("cancels a drag of files and shows the pointer that refuses it", () => {
    const event = dragEvent(["Files"]);
    refuseFileDragOver(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.dataTransfer?.dropEffect).toBe("none");
  });

  it("leaves a drag of text to its default action", () => {
    const event = dragEvent(["text/plain"]);
    refuseFileDragOver(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.dataTransfer?.dropEffect).toBe("copy");

    const empty = dragEvent(null);
    refuseFileDragOver(empty);
    expect(empty.preventDefault).not.toHaveBeenCalled();
  });
});

describe("refuseFileDrop", () => {
  it("cancels a drop of files, which would replace the page", () => {
    const event = dragEvent(["text/uri-list", "Files"]);
    refuseFileDrop(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves a drop of text to its default action", () => {
    const event = dragEvent(["text/plain"]);
    refuseFileDrop(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
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
    expect(listeners.get("dragover")).toBe(refuseFileDragOver);
    expect(listeners.get("drop")).toBe(refuseFileDrop);
    stop();
    expect(listeners.size).toBe(0);
  });
});
