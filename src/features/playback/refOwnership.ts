/**
 * Ref ownership helper for video media elements.
 *
 * Guarantees that ref cleanup retains the exact element owned by the callback instance,
 * passes that exact element to detach, and only clears the shared ref if it still owns that element.
 *
 * The shared ref is reached through narrow accessors instead of the ref object itself, so a caller
 * never hands a ref across a function boundary.
 */

import { getSourceRevisionKey } from "@/features/media";
import type { PlaybackMediaElement, PlaybackSource } from "./types";

export interface VideoRefOwnershipOptions<
  TElement extends PlaybackMediaElement = PlaybackMediaElement,
> {
  /** Reads the element the shared ref currently holds. Called only when the ref callback runs. */
  getElement: () => TElement | null;
  /** Writes the shared ref. Called only when the ref callback runs. */
  setElement: (element: TElement | null) => void;
  getSource: () => PlaybackSource | null;
  attach: (source: PlaybackSource, element: TElement) => void;
  detach: (sourceRevisionKey: string, element: TElement) => void;
}

/**
 * Creates a ref callback instance retaining the element it owns.
 *
 * When called with an element:
 * - Records the element and source identity as owned by this callback instance
 * - Writes the element into the shared ref through setElement
 * - Calls attach(source, node)
 *
 * When called with null:
 * - Only clears the shared ref if getElement still returns the owned element
 * - Calls detach(ownedIdentity, ownedElement) with the exact owned element
 */
export function createVideoRefCallback<
  TElement extends PlaybackMediaElement = PlaybackMediaElement,
>(options: VideoRefOwnershipOptions<TElement>): (node: TElement | null) => void {
  let ownedElement: TElement | null = null;
  let ownedIdentity = "";

  return (node: TElement | null) => {
    if (node) {
      ownedElement = node;
      options.setElement(node);
      const source = options.getSource();
      if (source) {
        ownedIdentity = getSourceRevisionKey(source);
        options.attach(source, node);
      } else {
        ownedIdentity = "";
      }
    } else {
      const elToDetach = ownedElement;
      const idToDetach = ownedIdentity;
      ownedElement = null;
      ownedIdentity = "";
      if (elToDetach) {
        if (options.getElement() === elToDetach) {
          options.setElement(null);
        }
        options.detach(idToDetach, elToDetach);
      }
    }
  };
}
