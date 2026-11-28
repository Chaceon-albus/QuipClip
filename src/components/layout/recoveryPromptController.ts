/**
 * The recovery prompt (ADR 073, "The offers at the start", "The recovery prompt").
 *
 * The prompt shows for the first offer to show of the recovery controller. It shows only while no
 * other dialog of the window is open, no flow of the quit guard runs, the quit did not start, and
 * no trim of a segment edge is armed, drags or waits to commit. Otherwise it waits, and it shows
 * when each of them ended.
 *
 * # How it waits
 *
 * It needs no polling. It subscribes to the offers to show, and, only while an offer waits and
 * the prompt cannot show, to each source that can end the wait (`watch`): the quit guard
 * (`subscribe`), the project dialog, the dialog of a save that failed, the export dialog, an
 * open step of the export that waits, the trim session, the file dialogs of the system, the
 * native context menus, and the document for each other modal layer (`MODAL_LAYER_SELECTOR`,
 * with a `MutationObserver` on the body). Each notification queues one test in a microtask, so a
 * test never sees a store in the middle of a change, such as the moment between the end of a
 * flow and the start of the next one.
 *
 * Three hand-offs would otherwise leave a moment in which the prompt could show and take the
 * place of what the user asked for:
 *
 * - An Export request whose open step still checks the source counts as the export dialog
 *   (`isExportOpenStepWaiting`).
 * - The Open dialog counts as a file dialog of the system until the quit guard took its request
 *   (`openMediaFileDialog`), so the gate sees the dialog or the flow of the guard.
 * - A native context menu counts as open while its choice is pending after the popup reply
 *   (`isChoicePending`), so the item that the user chose runs first.
 *
 * # The buttons
 *
 * - Restore: the prompt closes, and the restore starts through the quit guard. After a restore
 *   that changed the session, or that a request to quit stopped, no prompt shows more in this
 *   life of the page. When the restore stopped before step 8 by an error, by Cancel, or by the
 *   save prompt, or when the guard did not take it, the offer goes back to the front of the
 *   offers to show, and the prompt shows again for it after each dialog closed.
 * - Discard: the recovery removes the offer, and then the prompt shows for the next offer to
 *   show. A removal that failed changes nothing in this order: the offer stays for the next start.
 * - Not Now, Escape and each other dismissal: no prompt shows more in this life of the page. The
 *   offers stay for the next start.
 *
 * A request to quit while the prompt shows runs the quit above it, with no other change: the
 * prompt reads nothing of the quit while it shows.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import { segmentTrimSession } from "@/components/timeline/segmentTrimSession";
import { exportPanelStore } from "@/features/export/panelStore";
import type { RestoreProjectResult } from "@/features/project/openStep";
import { projectSaveErrorStore } from "@/features/project/saveErrorStore";
import type { RecoveryOffersStore } from "@/features/recovery/controller";
import { recoveryController } from "@/features/recovery/pageController";
import type { RecoveryOfferSummary } from "@/features/recovery/types";
import { subscribeSystemFileDialog } from "@/lib/systemFileDialog";
import {
  isExportOpenStepWaiting,
  subscribeExportOpenStep,
} from "./exportFlowController";
import { nativeContextMenuState } from "./nativeContextMenuState";
import { isOtherDialogOpen } from "./projectOpenStep";
import { quitGuard } from "./quitGuardController";

/** What the prompt shows. */
export interface RecoveryPromptState {
  /** The offer that the prompt shows, or null while the prompt is closed. */
  readonly offer: RecoveryOfferSummary | null;
}

/** A source of notifications: it calls the listener, and answers the function that stops it. */
export type RecoveryPromptSource = (listener: () => void) => () => void;

/** The dependencies of the prompt. */
export interface RecoveryPromptDependencies {
  /** The offers to show of the recovery controller. */
  readonly offers: RecoveryOffersStore;
  /** True when the prompt can show now: no other dialog, no flow, no quit, and no trim. */
  readonly canShow: () => boolean;
  /** Subscribes to each change that can change `canShow`. */
  readonly watch: RecoveryPromptSource;
  /** Starts the restore of an offer through the quit guard (`requestRestore`). */
  readonly restore: (offer: RecoveryOfferSummary) => Promise<RestoreProjectResult>;
  /** Removes an offer (`discard` of the recovery controller). */
  readonly discard: (id: string) => Promise<unknown>;
  /** Runs a task later. Defaults to `queueMicrotask`. */
  readonly schedule?: (task: () => void) => void;
}

/** The recovery prompt of a page. */
export interface RecoveryPrompt {
  readonly store: StoreApi<RecoveryPromptState>;
  /** Restore: closes the prompt and restores its offer. The promise ends with the restore. */
  readonly restore: () => Promise<void>;
  /** Discard: closes the prompt and removes its offer. The promise ends with the removal. */
  readonly discard: () => Promise<void>;
  /** Not Now: closes the prompt, and no prompt shows more in this life of the page. */
  readonly notNow: () => void;
  /**
   * Escape, or any other dismissal of the prompt: Not Now. With `shown`, it acts only while that
   * offer is still the offer of the prompt, so the dismissal that Radix sends after a button does
   * nothing.
   */
  readonly cancel: (shown?: RecoveryOfferSummary) => void;
  /** Stops each subscription. The prompt then shows nothing more. */
  readonly dispose: () => void;
}

/** True when a restore ended so that no prompt shows more in this life of the page. */
function endsThePrompts(result: RestoreProjectResult): boolean {
  return (
    result.status === "restored" ||
    (result.status === "canceled" && result.by === "quit")
  );
}

/** Creates the recovery prompt over `dependencies`. It subscribes to the offers at once. */
export function createRecoveryPrompt(
  dependencies: RecoveryPromptDependencies,
): RecoveryPrompt {
  const { offers } = dependencies;
  const schedule = dependencies.schedule ?? ((task) => queueMicrotask(task));
  const store = createStore<RecoveryPromptState>()(() => ({ offer: null }));

  /** True after Not Now, after a restore that changed the session or that a quit stopped. */
  let ended = false;
  /** True while a restore or a removal of the prompt runs. */
  let busy = false;
  let queued = false;
  let releaseWatch: (() => void) | null = null;

  const stopWatching = (): void => {
    releaseWatch?.();
    releaseWatch = null;
  };

  /** Shows the prompt for the first offer to show when it can, or waits for a change. */
  const update = (): void => {
    if (
      ended ||
      busy ||
      store.getState().offer !== null ||
      offers.getState().offers.length === 0
    ) {
      stopWatching();
      return;
    }
    if (!dependencies.canShow()) {
      releaseWatch ??= dependencies.watch(request);
      return;
    }
    stopWatching();
    const next = offers.getState().takeNext();
    if (next !== null) {
      store.setState({ offer: next });
    }
  };

  /** Queues one `update`, after the change that called it. */
  function request(): void {
    if (queued) {
      return;
    }
    queued = true;
    schedule(() => {
      queued = false;
      update();
    });
  }

  const releaseOffers = offers.subscribe(request);
  request();

  const end = (): void => {
    ended = true;
    store.setState({ offer: null });
    stopWatching();
    releaseOffers();
  };

  /** Closes the prompt and answers its offer, or null when it does not show or another task runs. */
  const take = (): RecoveryOfferSummary | null => {
    const offer = store.getState().offer;
    if (offer === null || ended || busy) {
      return null;
    }
    busy = true;
    store.setState({ offer: null });
    return offer;
  };

  const notNow = (): void => {
    if (store.getState().offer === null || ended) {
      return;
    }
    end();
  };

  return {
    store,
    restore: async () => {
      // The prompt closes before the restore starts, so React draws the closed dialog before the
      // open step tests for another dialog of the window, which it does after a wait of its own.
      const offer = take();
      if (offer === null) {
        return;
      }
      let result: RestoreProjectResult;
      try {
        result = await dependencies.restore(offer);
      } catch {
        // The guard and the open step do not reject. A rejection changed nothing.
        result = { status: "blocked" };
      }
      busy = false;
      if (endsThePrompts(result)) {
        end();
        return;
      }
      // The user gave no last answer for the offer: the prompt shows again for it.
      offers.getState().putBack(offer);
      request();
    },
    discard: async () => {
      const offer = take();
      if (offer === null) {
        return;
      }
      try {
        await dependencies.discard(offer.id);
      } catch {
        // The recovery does not reject. A removal that failed keeps the offer for the next start.
      }
      busy = false;
      request();
    },
    notNow,
    cancel: (shown) => {
      const offer = store.getState().offer;
      if (offer === null || (shown !== undefined && shown !== offer)) {
        return;
      }
      notNow();
    },
    dispose: () => {
      ended = true;
      stopWatching();
      releaseOffers();
    },
  };
}

/** The facts that `canShowRecoveryPrompt` reads. */
export interface RecoveryPromptFacts {
  /** The quit guard takes a request: no prompt of its own, no flow, and no quit (`canOpen`). */
  readonly guardFree: boolean;
  /** The project dialog shows (the store of the open step is not idle). */
  readonly projectDialogOpen: boolean;
  /** The dialog of a save that failed shows. */
  readonly saveErrorOpen: boolean;
  /** The export dialog shows. */
  readonly exportDialogOpen: boolean;
  /**
   * An open step of the export waits before it opens the export dialog, as while it checks the
   * source (`isExportOpenStepWaiting`).
   */
  readonly exportOpenStepWaiting: boolean;
  /**
   * A native context menu is open, or its choice is pending after its popup reply
   * (`isChoicePending`), so the item that the user chose can still run.
   */
  readonly nativeMenuOpen: boolean;
  /**
   * Another dialog of the window, as the open step tests it (`isOtherDialogOpen`): a modal layer
   * of the page, a native context menu, a file dialog of the system, or a trim of a segment edge.
   */
  readonly otherDialogOpen: boolean;
}

/**
 * True when the recovery prompt can show. The stores of the dialogs of the main window say that a
 * dialog opens before React draws it, so a prompt never opens over a dialog that is about to show.
 */
export function canShowRecoveryPrompt(facts: RecoveryPromptFacts): boolean {
  return (
    facts.guardFree &&
    !facts.projectDialogOpen &&
    !facts.saveErrorOpen &&
    !facts.exportDialogOpen &&
    !facts.exportOpenStepWaiting &&
    !facts.nativeMenuOpen &&
    !facts.otherDialogOpen
  );
}

/** Subscribes `listener` to each source, and answers one function that stops them all. */
export function watchEach(
  sources: readonly RecoveryPromptSource[],
  listener: () => void,
): () => void {
  const releases = sources.map((source) => source(listener));
  return () => {
    for (const release of releases) {
      release();
    }
  };
}

/**
 * Calls `listener` after each change of the document that can open or close a modal layer: an
 * element that the body gains or loses, and a change of `data-state` or `role`. Nothing outside a
 * document.
 */
function watchDocument(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    listener();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "role"],
  });
  return () => {
    observer.disconnect();
  };
}

/** The dependencies of the recovery prompt of the page. */
function pageRecoveryPromptDependencies(): RecoveryPromptDependencies {
  return {
    offers: recoveryController.offers,
    canShow: () =>
      canShowRecoveryPrompt({
        guardFree: quitGuard.canOpen(),
        projectDialogOpen: quitGuard.openStep.store.getState().phase.kind !== "idle",
        saveErrorOpen: projectSaveErrorStore.getState().error !== null,
        exportDialogOpen: exportPanelStore.getState().open,
        exportOpenStepWaiting: isExportOpenStepWaiting(),
        nativeMenuOpen:
          nativeContextMenuState.isOpen() || nativeContextMenuState.isChoicePending(),
        otherDialogOpen: isOtherDialogOpen(),
      }),
    watch: (listener) =>
      watchEach(
        [
          (next) => quitGuard.subscribe(next),
          (next) => quitGuard.openStep.store.subscribe(next),
          (next) => projectSaveErrorStore.subscribe(next),
          (next) => exportPanelStore.subscribe(next),
          subscribeExportOpenStep,
          (next) => segmentTrimSession.subscribe(next),
          subscribeSystemFileDialog,
          (next) => nativeContextMenuState.subscribe(next),
          watchDocument,
        ],
        listener,
      ),
    restore: (offer) => quitGuard.requestRestore(offer),
    discard: (id) => recoveryController.discard(id),
  };
}

/** The recovery prompt of the page. `RecoveryPromptDialog` shows it. */
export const recoveryPrompt: RecoveryPrompt = createRecoveryPrompt(
  pageRecoveryPromptDependencies(),
);
