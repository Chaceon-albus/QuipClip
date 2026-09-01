/**
 * Ref ownership helper for video media elements.
 *
 * Guarantees that ref cleanup retains the exact element owned by the callback instance,
 * passes that exact element to detach, and only clears videoRef.current if it still owns that element.
 */

import { getSourceRevisionKey } from "@/features/media";
import type { PlaybackMediaElement, PlaybackSource } from "./types";

export interface VideoRefOwnershipOptions<
  TElement extends PlaybackMediaElement = PlaybackMediaElement,
> {
  videoRef: { current: TElement | null };
  getSource: () => PlaybackSource | null;
  attach: (source: PlaybackSource, element: TElement) => void;
  detach: (sourceRevisionKey: string, element: TElement) => void;
}

/**
 * Creates a ref callback instance retaining the element it owns.
 *
 * When called with an element:
 * - Records the element and source identity as owned by this callback instance
 * - Updates videoRef.current
 * - Calls attach(source, node)
 *
 * When called with null:
 * - Only clears videoRef.current if videoRef.current still points to the owned element
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
      options.videoRef.current = node;
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
        if (options.videoRef.current === elToDetach) {
          options.videoRef.current = null;
        }
        options.detach(idToDetach, elToDetach);
      }
    }
  };
}
