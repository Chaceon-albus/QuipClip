/**
 * The gate of the submissions while the export queue recovers after a page reload.
 *
 * The recovery (`recovery.ts`) replaces the state of the export store and of the queue store.
 * A submission that started before that replacement could start a batch that the restore then
 * overwrites. So `submit` of the queue store waits at this gate before its duplicate check.
 *
 * The gate is open when no recovery work runs. `pending` then gives null, so a submission does
 * not wait at all and keeps its synchronous start.
 */

export interface ExportRecoveryGate {
  /** The promise of the recovery work that runs now, or null when the gate is open. */
  readonly pending: () => Promise<void> | null;
  /**
   * Closes the gate until the returned function runs. A submission that comes meanwhile waits.
   * The returned function opens the gate. A second call of it does nothing.
   */
  readonly close: () => () => void;
}

export function createExportRecoveryGate(): ExportRecoveryGate {
  let holds = 0;
  let current: Promise<void> | null = null;
  let release: (() => void) | null = null;
  return {
    pending: () => current,
    close: () => {
      if (current === null) {
        current = new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      holds += 1;
      let opened = false;
      return () => {
        if (opened) {
          return;
        }
        opened = true;
        holds -= 1;
        if (holds === 0) {
          const resolve = release;
          current = null;
          release = null;
          resolve?.();
        }
      };
    },
  };
}

/** The gate of the production queue store. */
export const exportRecoveryGate: ExportRecoveryGate = createExportRecoveryGate();
