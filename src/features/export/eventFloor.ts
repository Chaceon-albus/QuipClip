/**
 * The sequence floor of the export events: the number of the last event that a restored copy
 * of the export journal already holds.
 *
 * A page that loaded again restores the export store and the queue store from the answer of
 * `export_queue_snapshot` (`recovery.ts`). Each event with a number that is not larger than the
 * `seq` of that answer is already in the restored state. Both stores consult one floor before
 * they apply an event, so neither store applies such an event a second time.
 *
 * The floor only goes up. An event without a number always passes, so that an event that a
 * test builds needs no number.
 */

import type { ExportProgressEvent } from "./types";

export interface ExportEventFloor {
  /** The number of the last event that the restored state holds. Zero before a restore. */
  readonly value: () => number;
  /** Moves the floor up to `seq`. A lower value changes nothing. */
  readonly raise: (seq: number) => void;
  /** True when a store must apply `event`: it has no number, or a number above the floor. */
  readonly admits: (event: ExportProgressEvent) => boolean;
}

export function createExportEventFloor(): ExportEventFloor {
  let floor = 0;
  return {
    value: () => floor,
    raise: (seq) => {
      if (seq > floor) {
        floor = seq;
      }
    },
    admits: (event) => event.seq === undefined || event.seq > floor,
  };
}

/** The floor of the production stores. It lasts for the life of the page. */
export const exportEventFloor: ExportEventFloor = createExportEventFloor();
