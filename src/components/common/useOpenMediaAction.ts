import { runOpenAction } from "@/components/layout/openAction";

const handleOpen = () => {
  void runOpenAction();
};

/**
 * Returns the Open action (ADR 072, "One Open action"): the file dialog of the system for
 * videos and project files, then one request to the quit guard with all the chosen files.
 *
 * The File menu item in the title bar and the Open button of the empty preview both call this
 * one handler, and the key and the item of the macOS menu run the same `runOpenAction`, so the
 * entry points cannot drift apart in their filter label or their error handling.
 */
export function useOpenMediaAction(): () => void {
  return handleOpen;
}
