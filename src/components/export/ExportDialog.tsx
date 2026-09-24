import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleSlash, Loader2, XIcon } from "lucide-react";
import { DESTRUCTIVE_CONFIRM_CLASS } from "@/components/common/confirmDialogModel";
import { DialogActions } from "@/components/common/DialogActions";
import {
  canTakeFocus,
  isInOpenDialog,
  toPromptFocusTarget,
} from "@/components/common/focusTarget";
import { Notice } from "@/components/common/Notice";
import { StepFade, StepFadeScope } from "@/components/common/StepFade";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  confirmExportFlow,
  runExportFlow,
} from "@/components/layout/exportFlowController";
import {
  exportStore,
  isExportRunLive,
  useExportOutputActionStore,
  useExportStore,
  type ExportOutputAction,
  useExportRunTiming,
  type ExportOutputActionState,
  type ExportRunTiming,
  type ExportState,
} from "@/features/export";
import { mediaStore, openMediaFileDialog } from "@/features/media";
import {
  settingsPanelStore,
  settingsStore,
  useSettingsStore,
  type SettingsSection,
} from "@/features/settings";
import { isMacOS } from "@/lib/platform";
import { ExportErrorDetails } from "./ExportErrorDetails";
import { ExportRunPanel } from "./ExportRunPanel";
import { ExportSetup } from "./ExportSetup";
import {
  canGoBackToSetup,
  createOpenStepGeneration,
  runOpenStepAgain,
  type OpenStepEffects,
} from "./exportBackToSetup";
import { resolveExportDismissal } from "./exportCancelState";
import {
  resolveExportDialogFocusOrder,
  resolveExportDialogFooter,
  resolveExportDialogStep,
  resolveExportDialogTitleKey,
  selectShownFrame,
  type ExportDialogFocusTarget,
} from "./exportDialogFrame";
import {
  errorNoticeKey,
  presentExportOutcome,
  showsOutcomeNotice,
  type ExportErrorView,
} from "./exportErrorPresenter";
import {
  outputActionErrorKey,
  presentFinishedExport,
  revealLabelKey,
} from "./exportFinishedPresenter";
import {
  exportElapsedMs,
  selectExportProgressFields,
  type ExportProgressFields,
} from "./exportRunPresenter";
import {
  createSettingsCloseListener,
  createSettingsReturnSlot,
  planSettingsReturn,
} from "./exportSettingsReturn";
import { presentSetupBlocker, resolveSetupPresetId } from "./exportSetupPresenter";
import {
  decideStopClick,
  presentStopButton,
  refreshStopArmedAt,
  stopArmRemainingMs,
} from "./exportStopPresenter";

/**
 * The dialog top sits at a fixed height, so the dialog grows only downward when a step
 * changes its height. The height stops above the bottom of the window, and the body between
 * the header and the footer scrolls. At the minimum window height of 640 px, the dialog can
 * be 521 px tall.
 */
const DIALOG_CONTENT_CLASS =
  "top-[16vh] flex max-h-[calc(84vh-1rem)] translate-y-0 flex-col sm:max-w-md";

/**
 * Gives the focus to the first element of `order` that can take it, and does nothing when
 * none can. See `resolveExportDialogFocusOrder`.
 *
 * The dialog itself takes the focus with no test. It is rendered while it is open, and it is
 * `position: fixed`, which the rendered test of an older web view reads as not rendered
 * (`isElementRendered`).
 */
function focusFirstAvailable(
  order: readonly ExportDialogFocusTarget[],
  elements: Readonly<Record<ExportDialogFocusTarget, HTMLElement | null>>,
): void {
  for (const target of order) {
    const element = elements[target];
    if (target === "dialog") {
      element?.focus();
      return;
    }
    const candidate = toPromptFocusTarget(element);
    if (canTakeFocus(candidate)) {
      candidate.focus();
      return;
    }
  }
}

/**
 * Everything the dialog renders that can change while it closes.
 *
 * The dialog holds the frame that showed when a close started, and renders it until the
 * exit animation ends (`selectShownFrame`). A close can reset the store and the local state
 * at once, and a hidden run can end during the animation. Without the held frame, the content
 * would collapse or change to another step while it fades out.
 */
interface ExportDialogFrame
  extends
    Pick<
      ExportState,
      "status" | "runId" | "outputPath" | "cancelRequested" | "tracking" | "error"
    >,
    Pick<ExportOutputActionState, "pending" | "failure"> {
  requestedPresetId: string | null;
  choosingDestination: boolean;
  backCheckPending: boolean;
  stopArmed: boolean;
  timing: ExportRunTiming;
  /**
   * The progress fields of the store, in a held frame only. A live frame leaves them to the
   * run panel, which subscribes to them, so a progress event does not render the dialog.
   */
  progress: ExportProgressFields | null;
}

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /**
   * Resumes a refused export, past the replacement confirmation, to the setup step.
   *
   * Defaults to re-running the export flow with the replacement check skipped. Injected so
   * this panel never has to know how an export starts.
   */
  onExportAnyway?: () => void;

  /**
   * Opens the media dialog so the user can import the file again.
   *
   * Defaults to `openMediaFileDialog`, the same action the File menu uses. Injected so an
   * error panel never reaches into the media store.
   */
  onReimport?: () => void;
}

export function ExportDialog({
  open,
  onOpenChange,
  onExportAnyway,
  onReimport,
}: ExportDialogProps) {
  const { t } = useTranslation();
  // Holds the preset id requested by the user during the setup step. When null, the dialog
  // falls back to the settings activePresetId or first preset (ADR 024).
  const [requestedPresetId, setRequestedPresetId] = useState<string | null>(null);
  // Guard against double clicks triggering multiple concurrent native save dialogs.
  const [choosingDestination, setChoosingDestination] = useState(false);
  // True while the open step that Back runs again has not answered. The setup step shows
  // meanwhile, and Export stays disabled, so no export starts before the checks end.
  const [backCheckPending, setBackCheckPending] = useState(false);
  // One generation for each open step that the dialog runs again: after Back, and after the
  // return from the settings dialog. A close invalidates it, so a step that answers after the
  // close changes nothing (`exportBackToSetup.ts`).
  const [backStep] = useState(createOpenStepGeneration);
  // Counts the clicks on Back. The Back button leaves the document with the failed panel, so
  // the effect below gives the focus to the first control of the setup step once per click.
  const [backClicks, setBackClicks] = useState(0);
  const setupFirstControlRef = useRef<HTMLButtonElement>(null);
  // The default button of the setup step, and Cancel of the confirmation. Each takes the
  // focus when its footer shows (`resolveExportDialogFocusOrder`).
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  // The dialog element, while it is mounted. It takes the focus when no control of the footer
  // rule can.
  const contentRef = useRef<HTMLDivElement>(null);
  // The element that held the focus when the dialog opened, or null. It takes the focus back
  // when the dialog closes. The settings dialog also gives the focus back to it, because the
  // "Open Settings..." button is gone by then.
  const openerRef = useRef<HTMLElement | null>(null);
  // What the setup step showed while the settings dialog that it opened is open. The dialog
  // opens again on the setup step when that settings dialog closes (`exportSettingsReturn.ts`).
  const [settingsReturn] = useState(() => createSettingsReturnSlot<HTMLElement>());
  // True from a return until the dialog places its first focus. The return sets `openerRef` to
  // the opener that it carried, and `onOpenAutoFocus` then keeps it: the element that holds the
  // focus at that time is a control of the closing settings dialog. When the return opens the
  // dialog during its exit animation, `onOpenAutoFocus` does not run, and the effect of the
  // footer focus below clears the flag instead.
  const keepOpenerRef = useRef(false);
  // The time of the click that armed Stop Export, or null when it is not armed. The time is
  // from `performance.now()`, which is monotonic, so a change of the system clock cannot
  // shorten or lengthen the window.
  const [stopArmedAt, setStopArmedAt] = useState<number | null>(null);
  // The start and the end of the run, on the same clock. The Stop Export rule, the elapsed
  // time of the readout, and the time on the finished panel read it. Its store changes
  // inside the same update as the status, so the render of a status change already has the
  // timing of that change, and the first frame of a finished panel has its time
  // (`runTiming.ts` in the export feature).
  const timing = useExportRunTiming();
  // The frame that showed when the last close started, or null. It shows until the content
  // unmounts at the end of the exit animation (`ExportDialogFrame`).
  const [heldFrame, setHeldFrame] = useState<ExportDialogFrame | null>(null);
  // An open dialog drops the held frame, so a reopen during the exit animation can never
  // leave an old frame for a later close to show. The update during render is the React
  // pattern for state that follows a prop: React renders again at once, before it commits.
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setHeldFrame(null);
    }
  }
  // The primary action of the finished panel. It takes the focus when that panel shows.
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const stopNoteId = useId();
  // Done names the result and a Show or Open error as its description.
  const finishedNoticeId = useId();
  const outputErrorId = useId();

  const status = useExportStore((state) => state.status);
  const runId = useExportStore((state) => state.runId);
  const outputPath = useExportStore((state) => state.outputPath);
  const cancelRequested = useExportStore((state) => state.cancelRequested);
  const tracking = useExportStore((state) => state.tracking);
  const error = useExportStore((state) => state.error);
  const cancelExport = useExportStore((state) => state.cancelExport);
  const reset = useExportStore((state) => state.reset);

  const outputActionPending = useExportOutputActionStore((state) => state.pending);
  const outputActionFailure = useExportOutputActionStore((state) => state.failure);
  const runOutputAction = useExportOutputActionStore((state) => state.run);

  // An armed state belongs to one run. When the run is no longer live (`isExportRunLive`),
  // clear it, so a later run can never start with the confirmation label from this one. A
  // `failed` that the store still tracks is live, and it offers Stop Export again. This
  // component stays mounted while the dialog is hidden (ADR 025), so it sees every change.
  useEffect(
    () =>
      exportStore.subscribe((state, previous) => {
        const changed =
          state.status !== previous.status || state.tracking !== previous.tracking;
        if (changed && !isExportRunLive(state)) {
          setStopArmedAt(null);
        }
      }),
    [],
  );

  // Reverts an armed Stop Export button when its window ends. A hidden or occluded window can
  // delay the timer, so the armed time is also checked against the clock when the window
  // becomes visible or takes the focus again. The label then never stays armed after its
  // window.
  useEffect(() => {
    if (stopArmedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        setStopArmedAt(null);
      },
      stopArmRemainingMs(stopArmedAt, performance.now()),
    );
    const refresh = () => {
      setStopArmedAt((current) => refreshStopArmedAt(current, performance.now()));
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [stopArmedAt]);

  // The finished panel replaces the footer of the run, so the button that had the focus is
  // gone. Done takes the focus, as the default button of the result.
  useEffect(() => {
    if (open && status === "finished") {
      doneButtonRef.current?.focus();
    }
  }, [open, status]);

  // Opens the dialog again on the setup step when the settings dialog that the setup step
  // opened closes, by any path (`createSettingsCloseListener`). The listener drops the return
  // for a settings dialog that another control opened, for a live run, and for a source that
  // closed or changed. The dialog opens in the same update as the close, so the two dialogs
  // cross-fade, and `onOpenAutoFocus` places the focus on the setup step.
  //
  // Each return runs the open step of ADR 024 again, as Back does, and Export stays disabled
  // until it answers. The settings dialog can close a Back step before its source check
  // answered, and the file can change while the settings dialog is open. The step replaces a
  // stale step for the same file, which would otherwise hold the guard of `runExportFlow`
  // and leave this return with no check. A check that fails shows its own panel.
  useEffect(
    () =>
      settingsPanelStore.subscribe(
        createSettingsCloseListener({
          slot: settingsReturn,
          readExportState: () => exportStore.getState(),
          readMedia: () => mediaStore.getState().media,
          readPresets: () => settingsStore.getState().settings?.presets ?? [],
          onReturn: (decision) => {
            setRequestedPresetId(decision.requestedPresetId);
            setChoosingDestination(false);
            setStopArmedAt(null);
            openerRef.current = decision.opener;
            keepOpenerRef.current = true;
            onOpenChange(true);
            void runOpenStepAgain({
              generation: backStep,
              effects: {
                setModalOpen: onOpenChange,
                reportError: (err) => {
                  exportStore.getState().reportError(err);
                },
              },
              setPending: setBackCheckPending,
              run: (effects: OpenStepEffects) =>
                runExportFlow(
                  { ...effects, filterName: t("dialog.videoFilter") },
                  { replace: true },
                ),
            });
          },
        }),
      ),
    [settingsReturn, backStep, onOpenChange, t],
  );

  // Runs once for each click on Back, after the commit that the click made. That commit holds
  // the reset and any failure that the open step reported before its first await, such as
  // `sourceNotFound`, so the status read here is the one on the screen. When it is idle, the
  // setup step rendered in the same commit, and its first control exists. When the open
  // step failed, the failed panel shows and the focus stays on the dialog. No flag outlives
  // the click, so a later close or reset never moves the focus. While the settings load,
  // the step has no control, and the focus stays on the dialog too.
  useEffect(() => {
    if (backClicks === 0) {
      return;
    }
    if (exportStore.getState().status === "idle") {
      setupFirstControlRef.current?.focus();
    }
  }, [backClicks]);

  // Everything below renders from `frame`: the live values while the dialog is open, and
  // the held frame while it closes. A closing dialog is inert, so no handler runs on a held
  // frame, and the two are equal whenever a handler can run.
  const liveFrame: ExportDialogFrame = {
    status,
    runId,
    outputPath,
    cancelRequested,
    tracking,
    error,
    pending: outputActionPending,
    failure: outputActionFailure,
    requestedPresetId,
    choosingDestination,
    backCheckPending,
    stopArmed: stopArmedAt !== null,
    timing,
    progress: null,
  };
  const frame = selectShownFrame(open, liveFrame, heldFrame);
  const step = resolveExportDialogStep(frame.status);

  const settings = useSettingsStore((state) => state.settings);
  const effectivePresetId = resolveSetupPresetId(settings, frame.requestedPresetId);
  const selectedPreset =
    settings?.presets.find((preset) => preset.id === effectivePresetId) ?? null;
  const blocker = presentSetupBlocker(selectedPreset);
  const exportDisabled =
    effectivePresetId === null ||
    blocker !== null ||
    frame.choosingDestination ||
    frame.backCheckPending;

  // Dismissal hides the dialog while the run is live, and resets the store in every other
  // status (ADR 025). A live run is an active status, or `failed` while the store still
  // tracks the run: a Stop request failed, and the backend still encodes.
  const hidesOnDismiss =
    resolveExportDismissal({ status: frame.status, tracking: frame.tracking }) ===
    "hide";
  // The footer. Every live run, also a `failed` that the store still tracks, shows the run
  // footer: Stop Export and "Run in Background" (`resolveExportDialogFooter`).
  const footer = resolveExportDialogFooter({
    status: frame.status,
    tracking: frame.tracking,
    error: frame.error,
  });

  // The elements that the focus rule names (`resolveExportDialogFocusOrder`). It reads the
  // refs when it runs, so it sees the controls of the footer on the screen.
  const readFocusTargets = useCallback(
    (
      dialog: HTMLElement | null,
    ): Record<ExportDialogFocusTarget, HTMLElement | null> => ({
      primary: exportButtonRef.current,
      setupFirstControl: setupFirstControlRef.current,
      cancel: confirmationCancelRef.current,
      done: doneButtonRef.current,
      dialog,
    }),
    [],
  );

  // Places the focus by the rule of the footer when the footer changes while the dialog is
  // open, and when the dialog opens again during its exit animation, which does not run the
  // open auto focus again. It acts only while no control of the dialog has the focus: the
  // control that had it left with the old footer, the closing dialog was inert, or the focus
  // is on the element outside that opened the dialog again. The dialog itself, the body, and
  // a control of a dialog in its exit animation count as no control. The last one is the
  // settings dialog that this dialog returns from (`exportSettingsReturn.ts`), when this dialog
  // opens again before its own exit animation ends. A control of the dialog that has the focus
  // keeps it. That is the case after Back, because the effect of Back above runs first and
  // gives the focus to the first control of the setup step. A dialog above this one, such as
  // the quit guard, also keeps the focus. A dialog that is not mounted gets its focus from
  // `onOpenAutoFocus` below, when Radix mounts it.
  useEffect(() => {
    const dialog = contentRef.current;
    if (!open || dialog === null) {
      return;
    }
    // The content is mounted, so `onOpenAutoFocus` either ran already or does not run for
    // this opening. A return from the settings dialog set the opener already.
    keepOpenerRef.current = false;
    const active = document.activeElement;
    if (active !== dialog && isInOpenDialog(active)) {
      return;
    }
    focusFirstAvailable(
      resolveExportDialogFocusOrder(footer),
      readFocusTargets(dialog),
    );
  }, [open, footer, readFocusTargets]);
  // "publishing" always disables the button: the backend already ran its last cancel test
  // before it emitted the event that puts the interface into that phase (ADR 016), so a stop
  // there cannot stop the rename. "running" with no run id disables it, and an outstanding
  // cancel disables it in any live status. A `failed` that the store still tracks enables it,
  // so the user can ask again after a Stop request that failed. `isCancelEnabled` holds these
  // rules keyed to `cancelRequested` in the store (ADR 025), and `presentStopButton` applies
  // them.
  const stopView = presentStopButton({
    status: frame.status,
    runId: frame.runId,
    cancelRequested: frame.cancelRequested,
    tracking: frame.tracking,
    armed: frame.stopArmed,
  });
  // The close control hides the dialog while the run is live, and the export continues.
  // The label says so, because an X usually reads as "close".
  const closeLabel = hidesOnDismiss ? t("export.action.hide") : t("common.close");

  // Holds the frame on the screen before a close changes it. The progress fields are read
  // from the store here, because only the run panel subscribes to them. A close while the
  // dialog is already closed keeps the first frame, because the live frame can then show a
  // reset store.
  const holdFrame = () => {
    if (!open) {
      return;
    }
    setHeldFrame({
      ...liveFrame,
      progress: selectExportProgressFields(exportStore.getState()),
    });
  };

  const hideDialog = () => {
    holdFrame();
    setStopArmedAt(null);
    onOpenChange(false);
  };

  // The store is read at the call and not at the render. A live run is never reset here,
  // whatever the caller saw: the reset would drop the only record of a run that the backend
  // still encodes, so the dialog hides instead, the same as a dismissal (ADR 025).
  const closeAndReset = () => {
    if (resolveExportDismissal(exportStore.getState()) === "hide") {
      hideDialog();
      return;
    }
    holdFrame();
    backStep.invalidate();
    onOpenChange(false);
    setRequestedPresetId(null);
    setChoosingDestination(false);
    setBackCheckPending(false);
    setStopArmedAt(null);
    // The reset changes the run id, and that change clears the Show and Open state
    // (`bindOutputActionsToExportRun`).
    reset();
  };

  // The state of Show and Open shows only for the run that it names.
  const outputFailure =
    frame.failure !== null && frame.failure.runId === frame.runId
      ? frame.failure
      : null;
  const busyOutputAction =
    frame.pending !== null && frame.pending.runId === frame.runId
      ? frame.pending.action
      : null;
  const canActOnOutput = frame.runId !== null && frame.outputPath !== null;

  // The store ignores a second request for the run while one is in flight. The busy button
  // stays enabled, with `aria-busy`, so it keeps the focus.
  const handleOutputAction = (action: ExportOutputAction) => {
    if (runId === null) {
      return;
    }
    void runOutputAction(action, runId);
  };

  // A closed dialog has nothing to dismiss. During the exit animation, Escape can still reach
  // the closing layer, and a run that ended since the hide must not reset before the user
  // sees its result. An open dialog renders the live frame, so `hidesOnDismiss` is live
  // there.
  const dismiss = () => {
    if (!open) {
      return;
    }
    if (hidesOnDismiss) {
      hideDialog();
    } else {
      closeAndReset();
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      dismiss();
      return;
    }
    onOpenChange(true);
  };

  // The replacement confirmation is not a failure the user can only close: it carries its own
  // three actions, so the standard footer is replaced while it shows.
  const isSourceRevisionConfirmation = footer === "confirmation";

  // The notice of a run that ended without an output, and the recovery that its footer
  // offers beside Close. Null in every other status, and for the confirmation.
  const outcome =
    (frame.status === "failed" || frame.status === "canceled") &&
    !isSourceRevisionConfirmation
      ? presentExportOutcome({
          status: frame.status,
          error: frame.error,
          tracking: frame.tracking,
        })
      : null;
  const recovery = outcome?.recovery ?? null;
  const recoverySettingsSection =
    recovery?.kind === "openSettings" ? recovery.section : null;

  // Resumes the export the check refused. The store is reset and the modal closed first, so the
  // flow proceeds past the source revision check to the setup step with no stale confirmation behind it;
  // the flow re-opens the modal itself at the setup step.
  //
  // The preset choice survives the confirmation, as it survives Back and the return from the
  // settings dialog, which can both raise the confirmation. `closeAndReset` clears the choice,
  // and the call after it sets the saved value again. React batches the two updates, so the
  // saved value is the one that renders.
  const handleExportAnyway = () => {
    const kept = requestedPresetId;
    closeAndReset();
    setRequestedPresetId(kept);
    if (onExportAnyway) {
      onExportAnyway();
      return;
    }
    void runExportFlow({
      setModalOpen: onOpenChange,
      filterName: t("dialog.videoFilter"),
      skipSourceRevisionCheck: true,
    });
  };

  const handleReimport = () => {
    closeAndReset();
    if (onReimport) {
      onReimport();
      return;
    }
    void openMediaFileDialog({ filterName: t("dialog.videoFilter") });
  };

  // Closes this dialog before the settings dialog opens, so the two modal dialogs are never
  // open together. They show together only while one fades out and the other fades in. The
  // failed panel and the setup step offer this, and neither holds a live run.
  // The store is read at the click and not at the render, so a run that became live since
  // the render is hidden and not reset, the same as a dismissal (ADR 025).
  //
  // From the setup step, the dialog keeps the preset choice, and the settings dialog opens on
  // the preset that the step shows. The dialog opens again on the setup step when the
  // settings dialog closes, and runs the open step again (`exportSettingsReturn.ts`). A Back
  // step that runs now becomes stale with the close below, and the return runs its own. The
  // recovery of a failed run does not return.
  const handleOpenSettings = (section: SettingsSection, fromSetup: boolean) => {
    const exportState = exportStore.getState();
    const opener = openerRef.current;
    // Read before the reset below, which clears the choice.
    const kept = fromSetup
      ? planSettingsReturn({
          exportState,
          media: mediaStore.getState().media,
          requestedPresetId,
          shownPresetId: effectivePresetId,
          opener,
        })
      : null;
    if (resolveExportDismissal(exportState) === "hide") {
      hideDialog();
    } else {
      closeAndReset();
    }
    if (kept !== null) {
      settingsReturn.hold(kept);
    }
    // The settings dialog gives the focus back to the element that opened this dialog. It
    // skips an opener that left the document, such as the status bar indicator, which
    // hides while this dialog shows.
    settingsPanelStore.getState().show(section, {
      returnFocus: opener,
      selectPresetId: kept?.shownPresetId ?? null,
      returnTo: kept !== null ? "exportSetup" : null,
    });
  };

  // Goes back to the setup step after a failure. The store is reset to idle, and the open
  // step of ADR 024 runs again, the same step the Export button runs. Its checks therefore
  // see the media, the segments, and the source file as they are now, and a check that
  // fails shows its own panel. The dialog stays open, so it does not close and open again,
  // and the preset that the user chose stays selected.
  //
  // Back is offered only while the store no longer tracks the run: `failed`, and not the
  // failed stop request that leaves the backend encoding (`canGoBackToSetup`). A `failed`
  // status alone does not prove that the backend has no run. The store is read at the click
  // and not at the render. Until the step answers, Export is disabled: the source check
  // reads the file, which on a share that stopped answering can take seconds, and an export
  // must not start before it ends. A close in that time makes the step stale.
  const handleBackToSetup = () => {
    if (!canGoBackToSetup(exportStore.getState())) {
      return;
    }
    setBackClicks((count) => count + 1);
    setChoosingDestination(false);
    setStopArmedAt(null);
    reset();
    void runOpenStepAgain({
      generation: backStep,
      effects: {
        setModalOpen: onOpenChange,
        reportError: (err) => {
          exportStore.getState().reportError(err);
        },
      },
      setPending: setBackCheckPending,
      run: (effects) =>
        runExportFlow({ ...effects, filterName: t("dialog.videoFilter") }),
    });
  };

  const handleConfirmExport = async () => {
    if (!effectivePresetId || exportDisabled) {
      return;
    }
    setChoosingDestination(true);
    try {
      const started = await confirmExportFlow(
        {
          setModalOpen: onOpenChange,
          filterName: t("dialog.videoFilter"),
        },
        effectivePresetId,
      );
      if (started) {
        // Clear the user's manual selection once the export has started so that a subsequent
        // export setup step defaults to the project's active preset (ADR 024) even if this
        // run completes while the dialog is hidden (ADR 025). The started request already
        // carries the preset id.
        setRequestedPresetId(null);
      }
    } finally {
      setChoosingDestination(false);
    }
  };

  // The first click on a long export only arms the button, and the second half of a
  // double-click is ignored. See `decideStopClick`. The rule reads the clock, and the label
  // reads `stopArmedAt`, which the timer and the refresh above clear. A timer that fires late
  // can show the confirmation label for a few milliseconds after the window. A click in that
  // gap arms the button again and does not stop, which is the safe direction.
  const handleStopClick = () => {
    if (!stopView.enabled) {
      return;
    }
    const decision = decideStopClick({
      now: performance.now(),
      startedAt: timing.endedAt === null ? timing.startedAt : null,
      armedAt: stopArmedAt,
    });
    if (decision.kind === "ignore") {
      return;
    }
    if (decision.kind === "arm") {
      setStopArmedAt(decision.armedAt);
      return;
    }
    setStopArmedAt(null);
    void cancelExport();
  };

  // The content of the result step. The run panel shows it below the bar of the run, or
  // alone after a failure of the open step, which has no bar.
  const renderResult = () => {
    switch (frame.status) {
      case "finished": {
        const finished = presentFinishedExport(
          frame.outputPath,
          exportElapsedMs(frame.timing, null),
        );
        let location: string | null = null;
        if (finished?.folderName) {
          location =
            finished.elapsed !== null
              ? t("export.finished.folderAndElapsed", {
                  folder: finished.folderName,
                  elapsed: finished.elapsed,
                })
              : t("export.finished.folder", { folder: finished.folderName });
        }
        return (
          <div className="space-y-2">
            <Notice
              id={finishedNoticeId}
              tone="success"
              role="status"
              icon={CircleCheck}
            >
              <p className="font-medium">{t("export.finished.title")}</p>
              {finished && (
                // The stem truncates and the extension stays visible, as in the title bar.
                <p
                  className="mt-1 flex min-w-0 text-sm font-medium text-foreground"
                  title={finished.fullPath}
                >
                  <span className="truncate">{finished.fileStem}</span>
                  <span className="shrink-0">{finished.fileExtension}</span>
                </p>
              )}
              {location && (
                <p className="truncate text-xs text-muted-foreground" title={location}>
                  {location}
                </p>
              )}
            </Notice>
            {outputFailure && (
              <div
                id={outputErrorId}
                role="alert"
                className="text-xs text-destructive-text"
              >
                <p>{t(outputActionErrorKey(outputFailure.error.code))}</p>
                {outputFailure.error.detail && (
                  <p className="mt-1 font-mono break-all select-text">
                    {outputFailure.error.detail}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      }

      case "failed":
      case "canceled": {
        // `outcome` is null here only for the confirmation.
        if (isSourceRevisionConfirmation || outcome === null) {
          return (
            <Notice tone="warning" role="alert">
              {t("exportError.sourceRevisionChanged")}
            </Notice>
          );
        }

        // A stop that the user asked for is a result, not an error, so it is neutral.
        if (outcome.kind === "canceled") {
          return (
            <Notice tone={outcome.tone} role={outcome.role} icon={CircleSlash}>
              {t(outcome.message.key)}
            </Notice>
          );
        }

        // The notice of a failed Stop request hides while the next Stop request is
        // outstanding, because the Stop button then says "Stopping...".
        if (!showsOutcomeNotice(outcome, frame.cancelRequested)) {
          return null;
        }

        // A failure, or a failed Stop request while the run continues. Both carry the
        // diagnostic text when there is one. The key is new for each error instance, so a
        // second failed Stop request mounts a new alert, and a screen reader announces it.
        const message: ExportErrorView = outcome.message;
        return (
          <div key={errorNoticeKey(frame.error)} className="space-y-2">
            <Notice tone={outcome.tone} role={outcome.role}>
              <p>
                {(t as (k: string, opts?: Record<string, string | number>) => string)(
                  message.key,
                  message.values,
                )}
              </p>
            </Notice>
            {outcome.detail && (
              // The key starts a new diagnostic closed, with no "Copied" left from the last.
              <ExportErrorDetails key={outcome.detail} detail={outcome.detail} />
            )}
          </div>
        );
      }

      default:
        return null;
    }
  };

  // Each block is keyed, so a new block mounts new content and `StepFade` fades it in. The
  // run panel is one block from the progress step into the result, so the change from the
  // setup fades the bar and the readout together, and the bar stays mounted into the
  // result. Inside the panel, the change from the progress to the result fades on its own.
  const renderBody = () => {
    if (step === "setup") {
      return (
        <StepFade key="setup">
          <ExportSetup
            selectedPresetId={effectivePresetId}
            selectedPreset={selectedPreset}
            blocker={blocker}
            onSelect={setRequestedPresetId}
            onOpenSettings={(section) => {
              handleOpenSettings(section, true);
            }}
            firstControlRef={setupFirstControlRef}
          />
        </StepFade>
      );
    }
    return (
      <StepFade key="run">
        <ExportRunPanel
          step={step}
          status={frame.status}
          cancelRequested={frame.cancelRequested}
          tracking={frame.tracking}
          outputPath={frame.outputPath}
          timing={frame.timing}
          held={frame.progress}
          result={step === "result" ? renderResult() : undefined}
        />
      </StepFade>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        aria-describedby={undefined}
        className={DIALOG_CONTENT_CLASS}
        // A closing dialog takes no input, so a repeated key press or a click during the exit
        // animation cannot act on the held content.
        inert={!open}
        onOpenAutoFocus={(event) => {
          // Radix dispatches this before it moves the focus, so the active element is still
          // the element that opened the dialog. After a return from the settings dialog, it
          // is a control of that closing dialog, and the return already set the opener.
          if (keepOpenerRef.current) {
            keepOpenerRef.current = false;
          } else {
            const opener = document.activeElement;
            openerRef.current =
              opener instanceof HTMLElement && opener !== document.body ? opener : null;
          }
          // Radix would focus the first tabbable element. The footer names the control
          // instead (`resolveExportDialogFocusOrder`): "Export..." on the setup step, Cancel
          // on the confirmation, Done on a finished run, and else the dialog itself, so Tab
          // reaches the first control of the body. The dialog is open here, so the footer is
          // the live one.
          event.preventDefault();
          focusFirstAvailable(
            resolveExportDialogFocusOrder(footer),
            readFocusTargets(
              event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
            ),
          );
        }}
        // The content unmounted, so the held frame has done its work. A later close that
        // holds no frame then shows the live content and never an old frame.
        onCloseAutoFocus={(event) => {
          setHeldFrame(null);
          keepOpenerRef.current = false;
          // A dialog that opened meanwhile keeps the focus, such as the settings dialog that
          // this dialog opened.
          if (isInOpenDialog(document.activeElement)) {
            event.preventDefault();
            return;
          }
          // Radix would focus the element that held the focus when the content mounted.
          // After a return from the settings dialog, that element left the document with the
          // settings dialog, so the opener that the return carried takes the focus. In every
          // other case the opener is that same element. With no opener, Radix does as before.
          const opener = openerRef.current;
          if (opener !== null && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(resolveExportDialogTitleKey(footer))}</DialogTitle>
        </DialogHeader>

        {/* The body scrolls when the dialog reaches its maximum height. The negative margin
            and the padding give the focus rings of the controls room inside the scroll box. */}
        <div className="-m-1 min-h-0 overflow-y-auto p-1">
          <StepFadeScope step={step}>{renderBody()}</StepFadeScope>
        </div>

        {/* Each footer is keyed, so a change of footer mounts new buttons. A button of the
            old footer never stays under the focus with the label and the action of a button
            of the new footer, and the focus rule of the new footer applies. */}
        <DialogFooter>
          {footer === "setup" ? (
            <DialogActions
              key="setup"
              cancel={
                <Button variant="outline" onClick={closeAndReset}>
                  {t("common.cancel")}
                </Button>
              }
              primary={
                <Button
                  ref={exportButtonRef}
                  disabled={exportDisabled}
                  aria-busy={frame.backCheckPending || undefined}
                  onClick={() => void handleConfirmExport()}
                  onKeyDown={(event) => {
                    // The button has the focus when the step opens, so a held Enter can
                    // reach it. A held Enter repeats its keydown, and each keydown clicks
                    // the button, so only a separate press continues to the save dialog.
                    if (event.key === "Enter" && event.repeat) {
                      event.preventDefault();
                    }
                  }}
                >
                  {frame.backCheckPending && (
                    <Loader2
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {t("export.action.chooseDestination")}
                </Button>
              }
            />
          ) : footer === "confirmation" ? (
            <DialogActions
              key="confirmation"
              cancel={
                <Button
                  ref={confirmationCancelRef}
                  variant="outline"
                  onClick={closeAndReset}
                >
                  {t("common.cancel")}
                </Button>
              }
              extras={[
                {
                  key: "reimport",
                  role: "alternative",
                  node: (
                    <Button variant="outline" onClick={handleReimport}>
                      {t("export.action.reimport")}
                    </Button>
                  ),
                },
              ]}
              primary={
                <Button onClick={handleExportAnyway}>
                  {t("export.action.exportAnyway")}
                </Button>
              }
            />
          ) : footer === "run" ? (
            // Stop Export throws away the encode, so it is a discard: at the far left on
            // macOS, apart from "Run in Background", and after it on Windows. The footer has
            // no Cancel, because Cancel of the setup step only closes the dialog (ADR 025).
            // The note is the leading content only while it shows, so an empty item never
            // moves Stop Export away from the edge.
            <DialogActions
              key="run"
              leading={
                stopView.noteKey ? (
                  <p id={stopNoteId} className="min-w-0 text-xs text-muted-foreground">
                    {t(stopView.noteKey)}
                  </p>
                ) : null
              }
              extras={[
                {
                  key: "stop",
                  role: "discard",
                  node: (
                    // One element in every state, so the focus stays on it after the first
                    // click and a second Enter confirms.
                    <Button
                      variant={
                        stopView.appearance === "outline" ? "outline" : "default"
                      }
                      className={
                        stopView.appearance === "destructive"
                          ? DESTRUCTIVE_CONFIRM_CLASS
                          : undefined
                      }
                      onClick={handleStopClick}
                      onKeyDown={(event) => {
                        // A held Enter repeats its keydown, and each keydown clicks the
                        // button. The repeat would confirm the stop that the first keydown
                        // armed, so only a second, separate press confirms.
                        if (event.key === "Enter" && event.repeat) {
                          event.preventDefault();
                        }
                      }}
                      disabled={!stopView.enabled}
                      aria-describedby={stopView.noteKey ? stopNoteId : undefined}
                    >
                      {t(stopView.labelKey)}
                    </Button>
                  ),
                },
              ]}
              primary={
                <Button onClick={hideDialog}>
                  {t("export.action.runInBackground")}
                </Button>
              }
            />
          ) : footer === "finished" ? (
            <DialogActions
              key="finished"
              extras={[
                {
                  key: "reveal",
                  role: "alternative",
                  node: canActOnOutput && (
                    <Button
                      variant="outline"
                      aria-busy={busyOutputAction === "reveal" || undefined}
                      onClick={() => handleOutputAction("reveal")}
                    >
                      {busyOutputAction === "reveal" && (
                        <Loader2
                          aria-hidden="true"
                          className="animate-spin motion-reduce:animate-none"
                        />
                      )}
                      {t(revealLabelKey(isMacOS()))}
                    </Button>
                  ),
                },
                {
                  key: "open",
                  role: "alternative",
                  node: canActOnOutput && (
                    <Button
                      variant="secondary"
                      aria-busy={busyOutputAction === "open" || undefined}
                      onClick={() => handleOutputAction("open")}
                    >
                      {busyOutputAction === "open" && (
                        <Loader2
                          aria-hidden="true"
                          className="animate-spin motion-reduce:animate-none"
                        />
                      )}
                      {t("export.action.open")}
                    </Button>
                  ),
                },
              ]}
              // Done closes the dialog and changes nothing, so it takes the Cancel place:
              // last on both platforms, as the Close button of a WinUI dialog. It is still the
              // default button, so it keeps the filled style and takes the focus.
              cancel={
                <Button
                  ref={doneButtonRef}
                  aria-describedby={
                    outputFailure
                      ? `${finishedNoticeId} ${outputErrorId}`
                      : finishedNoticeId
                  }
                  onClick={closeAndReset}
                >
                  {t("export.action.done")}
                </Button>
              }
            />
          ) : (
            // The recovery of the error is the primary action.
            <DialogActions
              key="result"
              cancel={
                <Button variant="outline" onClick={closeAndReset}>
                  {t("common.close")}
                </Button>
              }
              primary={
                recoverySettingsSection !== null ? (
                  <Button
                    onClick={() => handleOpenSettings(recoverySettingsSection, false)}
                  >
                    {t("export.action.openSettings")}
                  </Button>
                ) : (
                  recovery?.kind === "backToSetup" &&
                  canGoBackToSetup({
                    status: frame.status,
                    tracking: frame.tracking,
                  }) && (
                    <Button onClick={handleBackToSetup}>
                      {t("export.action.back")}
                    </Button>
                  )
                )
              }
            />
          )}
          {/* Announces the armed state of Stop Export. A screen reader does not reliably read
              a name change of the focused button, and a live region must exist before its
              content changes, so it mounts with the run footer. It is beside the buttons and
              not in the row, so it takes no place there. */}
          {footer === "run" && (
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {stopView.armed ? t("export.action.stopConfirm") : ""}
            </span>
          )}
        </DialogFooter>

        {/* The close control comes after the footer in the document, so it is the last stop
            of the Tab order. It still draws at the top right corner. A Radix tooltip opens
            on every focus that no pointer press on its trigger started, so the tooltip shows
            when Tab reaches the control, and not when the dialog opens. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2"
              onClick={dismiss}
            >
              <XIcon />
              <span className="sr-only">{closeLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      </DialogContent>
    </Dialog>
  );
}
