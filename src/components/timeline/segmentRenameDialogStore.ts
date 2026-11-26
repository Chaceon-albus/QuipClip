/**
 * The open state of the Rename Segment dialog (ADR 065).
 *
 * The dialog names its segment by the id that the action gave it, from the moment it opens. A
 * change of the current segment while it is open does not change that id. The store holds no
 * text: the dialog reads the name of the segment when it opens.
 *
 * The module has no React or DOM dependency, so the tests need no document.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

export interface SegmentRenameDialogState {
  /** The id of the segment that the open dialog renames, or null while it is closed. */
  readonly segmentId: string | null;
  /**
   * Counts the opens. The dialog keys its content by it, so each open starts with the name of
   * its segment, also when the same segment opens again.
   */
  readonly openCount: number;
  /** Opens the dialog for the segment. Does nothing while the dialog is open. */
  readonly open: (segmentId: string) => void;
  /** Closes the dialog. */
  readonly close: () => void;
}

export type SegmentRenameDialogStore = StoreApi<SegmentRenameDialogState>;

/** Creates a closed dialog store. */
export function createSegmentRenameDialogStore(): SegmentRenameDialogStore {
  return createStore<SegmentRenameDialogState>()((set, get) => ({
    segmentId: null,
    openCount: 0,
    open: (segmentId) => {
      // The dialog is modal, so a second open can only come from a late menu event. It does not
      // move an open dialog to another segment.
      if (get().segmentId !== null) {
        return;
      }
      set((state) => ({ segmentId, openCount: state.openCount + 1 }));
    },
    close: () => {
      if (get().segmentId !== null) {
        set({ segmentId: null });
      }
    },
  }));
}

/** The dialog store of the application. */
export const segmentRenameDialogStore: SegmentRenameDialogStore =
  createSegmentRenameDialogStore();
