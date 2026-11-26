/**
 * The open state of the Export Order dialog (ADR 066).
 *
 * The store holds no draft: the dialog reads the segments of the export when it opens, and keeps
 * its draft itself until the confirm.
 *
 * The module has no React or DOM dependency, so the tests need no document.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

export interface ExportOrderDialogState {
  /** True while the dialog is open. */
  readonly isOpen: boolean;
  /**
   * Counts the opens. The dialog keys its content by it, so each open starts with the order of
   * that moment, and a confirm acts only for the open that mounted its content.
   */
  readonly openCount: number;
  /** Opens the dialog. Does nothing while the dialog is open. */
  readonly open: () => void;
  /** Closes the dialog. */
  readonly close: () => void;
}

export type ExportOrderDialogStore = StoreApi<ExportOrderDialogState>;

/** Creates a closed dialog store. */
export function createExportOrderDialogStore(): ExportOrderDialogStore {
  return createStore<ExportOrderDialogState>()((set, get) => ({
    isOpen: false,
    openCount: 0,
    open: () => {
      // The dialog is modal, so a second open while it is open starts no new draft.
      if (get().isOpen) {
        return;
      }
      set((state) => ({ isOpen: true, openCount: state.openCount + 1 }));
    },
    close: () => {
      if (get().isOpen) {
        set({ isOpen: false });
      }
    },
  }));
}

/** The dialog store of the application. */
export const exportOrderDialogStore: ExportOrderDialogStore =
  createExportOrderDialogStore();
