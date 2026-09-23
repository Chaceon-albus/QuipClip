/**
 * Export panel store managing the open/closed state of the export dialog.
 *
 * The store holds only whether the export dialog is open, so the title bar and the
 * status bar can both open it (ADR 025). The dialog keeps one mount in the title bar (ADR 020).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export type ExportPanelState = { open: boolean };

export type ExportPanelActions = {
  setOpen: (open: boolean) => void;
  show: () => void;
  hide: () => void;
};

export type ExportPanelStoreState = ExportPanelState & ExportPanelActions;

export function createExportPanelStore(
  initialState?: Partial<ExportPanelState>,
): StoreApi<ExportPanelStoreState> {
  return createStore<ExportPanelStoreState>()((set) => ({
    open: initialState?.open ?? false,
    setOpen: (open: boolean) => set({ open }),
    show: () => set({ open: true }),
    hide: () => set({ open: false }),
  }));
}

export type ExportPanelStore = ReturnType<typeof createExportPanelStore>;

export const exportPanelStore: ExportPanelStore = createExportPanelStore();

const defaultSelector = (state: ExportPanelStoreState): ExportPanelStoreState => state;

export function useExportPanelStore(): ExportPanelStoreState;
export function useExportPanelStore<T>(
  selector: (state: ExportPanelStoreState) => T,
): T;
export function useExportPanelStore<T>(
  selector?: (state: ExportPanelStoreState) => T,
): T | ExportPanelStoreState {
  return useStore(
    exportPanelStore,
    (selector ?? defaultSelector) as (state: ExportPanelStoreState) => T,
  );
}
