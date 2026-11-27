/**
 * The error of the last save that failed (ADR 072, "Menus, keys and permissions"). A save that
 * fails shows a dialog of its own, and that dialog shows the error of this store. The Save action
 * and the save prompt of the quit and of Clear Timeline report into it.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectSaveError } from "./saveStep";

export interface ProjectSaveErrorState {
  /** The error that the dialog shows, or null while the dialog is closed. */
  readonly error: ProjectSaveError | null;
  /** Shows `error`. An error that shows already gives its place to the new one. */
  readonly report: (error: ProjectSaveError) => void;
  /** Closes the dialog. */
  readonly dismiss: () => void;
}

export type ProjectSaveErrorStore = StoreApi<ProjectSaveErrorState>;

export function createProjectSaveErrorStore(): ProjectSaveErrorStore {
  return createStore<ProjectSaveErrorState>()((set) => ({
    error: null,
    report: (error) => {
      set({ error });
    },
    dismiss: () => {
      set({ error: null });
    },
  }));
}

/** The save error of this page. `ProjectSaveErrorDialog` shows it. */
export const projectSaveErrorStore: ProjectSaveErrorStore =
  createProjectSaveErrorStore();

/** React hook for the production save error store. */
export function useProjectSaveErrorStore<T>(
  selector: (state: ProjectSaveErrorState) => T,
): T {
  return useStore(projectSaveErrorStore, selector);
}
