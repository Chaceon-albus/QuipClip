/**
 * Pure rules that keep an unsaved preset draft from being lost when the user leaves it.
 *
 * The preset library reports its draft to the settings dialog as a `PresetDraftGuard`. The
 * dialog asks `decideCloseRequest` what a close request does. When the request cannot close
 * the dialog, the dialog shows the prompt that `presentUnsavedDraftPrompt` describes. The
 * preset library shows the same prompt when the user selects another preset.
 *
 * The rules have no DOM and no React, so the tests need no document. They return translation
 * keys and values without calling the i18n runtime. The prompt message is one complete
 * catalog message, so no sentence is assembled from fragments (ADR 011).
 */

import type { PresetLibraryView } from "./presetLibraryController";
import type { MessageView } from "./presetPresenter";

/** The state of the preset draft that the settings dialog reads. */
export type PresetDraftStatus = {
  /** True while the draft holds an edit that is not saved. */
  readonly dirty: boolean;
  /** The name that the prompts show for the draft, or null when there is no draft. */
  readonly presetName: string | null;
  /** True when a save of the draft can start: the draft is dirty and has no issue. */
  readonly canSave: boolean;
  /** True while a write of the preset library is in flight. */
  readonly pending: boolean;
};

/**
 * The draft state together with the two actions that settle the draft, so the settings
 * dialog can save or discard the draft from its own prompt.
 */
export type PresetDraftGuard = PresetDraftStatus & {
  /**
   * Saves the draft. Resolves true only when the save succeeded and no unsaved edit remains,
   * so the caller can leave the draft. See `PresetLibraryController.saveDraftBeforeLeaving`.
   */
  readonly save: () => Promise<boolean>;
  /** Discards the unsaved edit and loads the stored preset again. */
  readonly discard: () => void;
};

/**
 * The guard of a preset library that holds no unsaved edit. The preset library reports it
 * when it unmounts, so the dialog never keeps the guard of a draft that no longer exists.
 */
export const CLEAN_PRESET_DRAFT_GUARD: PresetDraftGuard = {
  dirty: false,
  presetName: null,
  canSave: false,
  pending: false,
  save: () => Promise.resolve(true),
  discard: () => undefined,
};

/**
 * Derives the draft state from the controller view. It copies `dirty`, `canSave`, and
 * `pending` from the controller and adds no rule of its own.
 *
 * The name is the name of the stored preset, which is the name the preset list shows. The
 * draft name can be half typed or empty. The draft name is used only when the document has
 * no preset with the draft id.
 */
export function presentPresetDraftStatus(view: PresetLibraryView): PresetDraftStatus {
  const draft = view.draft;
  if (draft === null) {
    return { dirty: false, presetName: null, canSave: false, pending: view.pending };
  }
  const stored = view.presets.find((preset) => preset.id === draft.id);
  return {
    dirty: view.dirty,
    presetName: stored?.name ?? draft.name,
    canSave: view.canSave,
    pending: view.pending,
  };
}

/** The unsaved-changes prompt of the settings dialog footer and of the preset library. */
export type UnsavedDraftPromptView = {
  message: MessageView;
  /** Disables the button that saves the draft. */
  saveDisabled: boolean;
  /**
   * Disables the buttons that discard the draft or return to it. They wait for a write in
   * flight, as every write action of the preset library does, so a save that the user started
   * from the prompt cannot finish after the user made a different choice.
   */
  choicesDisabled: boolean;
};

/**
 * Presents the unsaved-changes prompt, or returns null when the draft holds no unsaved edit.
 *
 * The save button uses the gate of the Save button in the preset editor: it needs `canSave`,
 * and it waits while a write is in flight.
 */
export function presentUnsavedDraftPrompt(
  draft: PresetDraftStatus,
): UnsavedDraftPromptView | null {
  if (!draft.dirty) {
    return null;
  }
  return {
    message: {
      key: "settings.preset.unsavedPrompt",
      values: { name: draft.presetName ?? "" },
    },
    saveDisabled: !draft.canSave || draft.pending,
    choicesDisabled: draft.pending,
  };
}

/**
 * True for the row of the preset list that holds the unsaved draft. The draft always
 * belongs to the selected preset.
 */
export function isUnsavedPresetRow(view: PresetLibraryView, presetId: string): boolean {
  return view.dirty && view.draft !== null && view.selectedPresetId === presetId;
}

/**
 * What the settings dialog does with a request to close it: from Escape, from the close
 * button in the header, or from the Close button in the footer.
 *
 * - `close`: the dialog closes. The draft holds no unsaved edit.
 * - `raise`: the dialog stays open and shows the unsaved-changes prompt.
 * - `cancel`: the prompt is already open, and the request dismisses it as its Cancel button
 *   does. A second Escape backs out of the prompt, as it does on a macOS save sheet.
 * - `hold`: the prompt is already open and a save is in flight, so Cancel is disabled. The
 *   prompt stays, and the dialog keeps the focus inside it.
 */
export type CloseRequestDecision = "close" | "raise" | "cancel" | "hold";

export function decideCloseRequest(
  draft: PresetDraftStatus,
  promptOpen: boolean,
): CloseRequestDecision {
  const prompt = presentUnsavedDraftPrompt(draft);
  if (prompt === null) {
    return "close";
  }
  if (!promptOpen) {
    return "raise";
  }
  return prompt.choicesDisabled ? "hold" : "cancel";
}

/**
 * What the settings dialog does when a save from its unsaved-changes prompt settles.
 *
 * - `close`: the save succeeded and nothing unsaved remains.
 * - `revealError`: the save failed. The dialog stays open and scrolls its body to the top,
 *   where the error notice is. The user can be far down in the preset editor, and the notice
 *   would then be out of view.
 * - `stay`: the save did not fail, but an edit arrived while it was in flight. The dialog
 *   stays open on the prompt, and there is no error to show.
 */
export type PromptSaveOutcome = "close" | "revealError" | "stay";

export function decidePromptSaveOutcome(
  saved: boolean,
  hasError: boolean,
): PromptSaveOutcome {
  if (saved) {
    return "close";
  }
  return hasError ? "revealError" : "stay";
}

/** The narrow view of an element that the focus rules read, so a test can pass a fake. */
export interface PromptFocusTarget {
  /** False after the element left the document. */
  readonly isConnected: boolean;
  /**
   * False while the element is not rendered. The settings panels are force-mounted, and an
   * inactive panel is `display: none`, so a control in another tab is connected but cannot
   * take the focus.
   */
  readonly isRendered: boolean;
  /** True while the element cannot take the focus, such as a disabled button. */
  readonly isDisabled: boolean;
  focus: () => void;
}

/** The members of a DOM element that `isElementRendered` reads. */
export interface RenderedElementProbe {
  checkVisibility?: () => boolean;
  readonly offsetParent: unknown;
}

/**
 * True when the element is rendered. `checkVisibility` answers directly where the web view
 * has it. An older web view falls back to `offsetParent`, which is null for an element inside
 * a `display: none` subtree. None of the prompt targets is `position: fixed`, the one other
 * case where `offsetParent` is null.
 */
export function isElementRendered(element: RenderedElementProbe): boolean {
  return element.checkVisibility?.() ?? element.offsetParent !== null;
}

function canTakeFocus<T extends PromptFocusTarget>(target: T | null): target is T {
  return (
    target !== null && target.isConnected && target.isRendered && !target.isDisabled
  );
}

/**
 * Returns the element that takes the focus when the unsaved-changes prompt of the settings
 * dialog opens, or when a close request arrives while it is open.
 *
 * That is Cancel, as in `ConfirmDialog`, so Enter picks the choice that changes nothing.
 * While a save is in flight Cancel is disabled, and the prompt message takes the focus, so
 * the focus stays inside the prompt instead of falling to the document body.
 */
export function pickPromptOpenFocus<T extends PromptFocusTarget>(
  cancel: T | null,
  message: T | null,
): T | null {
  if (canTakeFocus(cancel)) {
    return cancel;
  }
  return canTakeFocus(message) ? message : null;
}

/**
 * Returns the element that takes the focus when the user cancels the unsaved-changes prompt
 * of the settings dialog.
 *
 * That is the element that held the focus when the close request raised the prompt, such as
 * the field the user was editing. The fallback, the Close button that the footer shows again,
 * takes the focus when that element cannot:
 *
 * - The prompt replaces the footer Close button, so a close request from that button leaves
 *   a detached element.
 * - A close request from the General or the FFmpeg tab switches to the preset tab, and the
 *   element then sits in a panel that is not rendered.
 */
export function pickPromptCancelFocus<T extends PromptFocusTarget>(
  returnFocus: T | null,
  fallback: T | null,
): T | null {
  if (canTakeFocus(returnFocus)) {
    return returnFocus;
  }
  return canTakeFocus(fallback) ? fallback : null;
}
