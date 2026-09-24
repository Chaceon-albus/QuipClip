/**
 * Pure rules that keep an unsaved preset draft from being lost when the user leaves it.
 *
 * The preset library reports its draft to the settings dialog as a `PresetDraftGuard`. The
 * dialog asks `decideCloseRequest` what a close request does. When the request cannot close
 * the dialog, the dialog shows the prompt that `presentUnsavedDraftPrompt` describes. The
 * preset library shows the same prompt when the user selects another preset or adds one.
 *
 * The rules have no DOM and no React, so the tests need no document. They read elements
 * through narrow interfaces, and `toPromptFocusTarget` in `components/common/focusTarget.ts`
 * is the one adapter that wraps a DOM element for them. They return translation keys and values without calling the i18n
 * runtime. The prompt message is one complete catalog message, so no sentence is assembled
 * from fragments (ADR 011).
 */

import { canTakeFocus, type PromptFocusTarget } from "@/components/common/focusTarget";
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
 * dialog can save or discard the draft from its own prompt, and the state of the preset
 * library's own prompt, so that only one of the two prompts is open at a time.
 */
export type PresetDraftGuard = PresetDraftStatus & {
  /**
   * Saves the draft. Resolves true only when the save succeeded and no unsaved edit remains,
   * so the caller can leave the draft. See `PresetLibraryController.saveDraftBeforeLeaving`.
   */
  readonly save: () => Promise<boolean>;
  /** Discards the unsaved edit and loads the stored preset again. */
  readonly discard: () => void;
  /**
   * True while the preset library shows its own unsaved-changes prompt, for a switch to
   * another preset or for Add. See `decideCloseRequest`.
   */
  readonly leavePromptOpen: boolean;
  /** Moves the focus to the prompt of the preset library. Does nothing when it is closed. */
  readonly focusLeavePrompt: () => void;
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
  leavePromptOpen: false,
  focusLeavePrompt: () => undefined,
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
 * The attribute that marks the unsaved-changes prompt of the preset library. Escape inside
 * that prompt means "Keep Editing", as Escape means Cancel on a macOS sheet, so the settings
 * dialog does not take it as a request to close. See `isInsideLeavePrompt`.
 */
export const PRESET_LEAVE_PROMPT_ATTRIBUTE = "data-preset-leave-prompt";

/** The narrow view of a key event target that `isInsideLeavePrompt` reads. */
export interface LeavePromptProbe {
  closest: (selector: string) => unknown;
}

/**
 * True when `target` is inside the unsaved-changes prompt of the preset library. The settings
 * dialog then leaves Escape to that prompt.
 */
export function isInsideLeavePrompt(target: LeavePromptProbe | null): boolean {
  return (
    target !== null && target.closest(`[${PRESET_LEAVE_PROMPT_ATTRIBUTE}]`) !== null
  );
}

/**
 * What a key press inside the unsaved-changes prompt of the preset library does.
 *
 * - `keepEditing`: Escape. The prompt closes as "Keep Editing" closes it.
 * - `hold`: Escape while a save is in flight. "Keep Editing" is disabled, so the key does
 *   nothing, and the prompt stays.
 * - `ignore`: any other key. The buttons of the prompt keep their own keys.
 */
export type LeavePromptKeyDecision = "keepEditing" | "hold" | "ignore";

export function decideLeavePromptKey(
  key: string,
  prompt: Pick<UnsavedDraftPromptView, "choicesDisabled">,
): LeavePromptKeyDecision {
  if (key !== "Escape") {
    return "ignore";
  }
  return prompt.choicesDisabled ? "hold" : "keepEditing";
}

/**
 * What the preset library does when the user asks to leave the draft: a switch to another
 * preset from the list, or Add.
 *
 * - `ignore`: a write is in flight. A Save and Switch that is running holds its target, and a
 *   request now would either move the prompt to a target that the running save then ignores,
 *   or select a preset under that save.
 * - `leave`: the draft holds no unsaved edit, so the request runs at once.
 * - `defer`: the settings dialog already shows its unsaved-changes prompt about this draft.
 *   The request opens no second prompt. The focus goes to the prompt that is open.
 * - `raise`: the preset library shows its own prompt, or changes the target of the prompt
 *   that is open.
 */
export type LeaveRequestDecision = "ignore" | "leave" | "defer" | "raise";

export function decideLeaveRequest(
  draft: Pick<PresetDraftStatus, "dirty" | "pending">,
  closePromptOpen: boolean,
): LeaveRequestDecision {
  if (draft.pending) {
    return "ignore";
  }
  if (!draft.dirty) {
    return "leave";
  }
  return closePromptOpen ? "defer" : "raise";
}

/**
 * What the user asked for in the preset library while the draft held an unsaved edit: a
 * switch to another preset in the list, or a new preset from Add. Both select another preset,
 * and a selection discards the draft, so both wait for the answer to the unsaved-changes
 * prompt.
 */
export type PendingLeave =
  { readonly kind: "select"; readonly id: string } | { readonly kind: "add" };

/**
 * The label key of the prompt button that saves the draft and then carries out `request`:
 * "Save and Switch" for a switch to another preset, and "Save and Add" for Add.
 */
export function presentSaveAndLeaveLabel(request: PendingLeave): string {
  return request.kind === "add"
    ? "settings.preset.saveAndAdd"
    : "settings.preset.saveAndSwitch";
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
 * - `defer`: the preset library shows its own unsaved-changes prompt (`leavePromptOpen`). The
 *   dialog opens no second prompt about the same draft. The focus goes to the prompt that is
 *   open, and the dialog stays open.
 */
export type CloseRequestDecision = "close" | "raise" | "cancel" | "hold" | "defer";

export function decideCloseRequest(
  draft: PresetDraftStatus,
  promptOpen: boolean,
  leavePromptOpen = false,
): CloseRequestDecision {
  const prompt = presentUnsavedDraftPrompt(draft);
  if (prompt === null) {
    return "close";
  }
  if (leavePromptOpen) {
    return "defer";
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

/**
 * Returns the element that takes the focus when the unsaved-changes prompt of the settings
 * dialog opens, or when a close request arrives while it is open.
 *
 * That is Cancel, as in `ConfirmDialog`, so Enter picks the choice that changes nothing.
 * While a save is in flight Cancel is disabled, and the prompt message takes the focus, so
 * the focus stays inside the prompt instead of falling to the document body.
 *
 * The prompt of the preset library applies the same rule. Its Cancel is "Keep Editing".
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
 *
 * The prompt of the preset library applies the same rule to "Keep Editing". The element that
 * held the focus is the row the user was on, for a switch from the list, or the field the
 * user was editing. The fallback is the selected row of the preset list.
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

/**
 * Returns the element that a prompt gives the focus back to when the user cancels it (see
 * `pickPromptCancelFocus`): the element that holds the focus when the prompt opens, or null
 * when that is the document body or no element. The caller passes `document.activeElement` and
 * `document.body`.
 */
export function pickPromptReturnFocus<T>(active: T | null, body: T | null): T | null {
  return active === null || active === body ? null : active;
}

/**
 * The narrow view of the element that holds the focus, so a test can pass a fake.
 * `document.activeElement` satisfies it.
 */
export interface FocusHolderProbe {
  readonly tagName: string;
  getAttribute: (name: string) => string | null;
}

/**
 * True when the focus rests on no control of the dialog:
 *
 * - No element, or the document body, holds the focus. The browser moves the focus to the
 *   body when the focused button becomes disabled.
 * - The dialog element itself holds the focus. Radix moves the focus there when the focused
 *   element leaves the document, as the buttons of the unsaved-changes prompt do when the
 *   prompt closes.
 */
export function isFocusLost(active: FocusHolderProbe | null): boolean {
  if (active === null) {
    return true;
  }
  return active.tagName === "BODY" || active.getAttribute("role") === "dialog";
}

/**
 * Returns the button that takes the focus back after an Add or a Duplicate of the preset
 * library that did not select a new preset, or null when the focus must stay where it is.
 *
 * The button is disabled while the write is in flight, so the focus is lost when the write
 * ends (see `isFocusLost`). The button that started the action then takes it back, so a
 * keyboard user can try again. An Add that the unsaved-changes prompt started has no button
 * of its own left, because the prompt closed, and the caller passes the Add button.
 *
 * When the focus is on a control, the user moved it there during the write, for example into
 * the name field, and it stays there. The button must also be able to take the focus again,
 * so the caller calls this rule after the write, when the button is enabled.
 */
export function pickCreateFailureFocus<T extends PromptFocusTarget>(
  button: T | null,
  active: FocusHolderProbe | null,
): T | null {
  return isFocusLost(active) && canTakeFocus(button) ? button : null;
}
