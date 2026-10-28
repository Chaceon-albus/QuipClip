import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
  openExportFlow,
  runExportFlow,
} from "@/components/layout/exportFlowController";
import {
  canCopyAudio,
  composeFlowTarget,
  exportComposeStore,
  exportStore,
  isExportRunLive,
  resolveExportAudioMode,
  resolveExportStreams,
  exportQueueStore,
  selectExportOutputAction,
  selectExportQueueRows,
  sourceHasAudio,
  useExportComposeStore,
  useExportOutputActionStore,
  useExportQueueStore,
  useExportStore,
  useExportRunTiming,
  useExportStreamChoice,
  type ExportFlowTarget,
  type ExportOutputActionRunState,
  type ExportRunTiming,
  type ExportState,
} from "@/features/export";
import { quitGuard } from "@/components/layout/quitGuardController";
import { openMediaFileDialog } from "@/features/media";
import { useAttachedMediaStore } from "@/features/sequence/attachedMedia";
import { useSettingsStore, type SettingsSection } from "@/features/settings";
import { openSettingsWindow } from "@/features/settings/settingsWindowClient";
import { isMacOS } from "@/lib/platform";
import { ExportErrorDetails } from "./ExportErrorDetails";
import { ExportQueueList } from "./ExportQueueList";
import { ExportRunPanel } from "./ExportRunPanel";
import { ExportSetup } from "./ExportSetup";
import {
  canGoBackToSetup,
  createOpenStepGeneration,
  guardOpenStepEffects,
  runOpenStepAgain,
} from "./exportBackToSetup";
import {
  addsToQueue,
  resolveComposeExit,
  resolveExportCloseLabelKey,
  resolveSetupConfirmLabelKey,
  selectExportDialogTargetState,
  showsNewExportAction,
  type ExportComposeExitTrigger,
} from "./exportDialogCompose";
import { resolveExportDismissal } from "./exportCancelState";
import { useExportSourceFacts } from "./useExportSourceFacts";
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
import { presentExportQueue, type ExportQueueView } from "./exportQueuePresenter";
import {
  exportElapsedMs,
  selectExportProgressFields,
  type ExportProgressFields,
} from "./exportRunPresenter";
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
 * Reads the state that the handlers of the dialog act on, at the call: the compose store while
 * it composes, and else the export store (`selectExportDialogTargetState`).
 */
function readTargetState() {
  return selectExportDialogTargetState(
    exportComposeStore.getState(),
    exportStore.getState(),
  );
}

/**
 * The target options of the export flow controller for a step of the dialog: the compose
 * store while the dialog composes (ADR 049), and else none, so the controller uses its
 * defaults, the export store.
 */
function flowTargetOf(composes: boolean): Partial<ExportFlowTarget> {
  return composes ? composeFlowTarget : {};
}

/** The progress fields of the run panel for a failure of the compose state, which has no run. */
const NO_PROGRESS: ExportProgressFields = {
  frame: null,
  expectedFrames: null,
  fps: null,
  speed: null,
  encodeStarted: false,
};

/**
 * Everything the dialog renders that can change while it closes.
 *
 * The dialog holds the frame that showed when a close started, and renders it until the
 * exit animation ends (`selectShownFrame`). A close can reset the store and the local state
 * at once, and a hidden run can end during the animation. Without the held frame, the content
 * would collapse or change to another step while it fades out.
 */
interface ExportDialogFrame extends Pick<
  ExportState,
  "status" | "runId" | "outputPath" | "cancelRequested" | "tracking" | "error"
> {
  /**
   * True while the dialog sets up an export that joins the queue (ADR 049). The status, the
   * tracking, and the error of the frame then come from the compose store
   * (`selectExportDialogTargetState`), and the run fields are empty.
   */
  composing: boolean;
  /**
   * True while the export store holds a live run (`isExportRunLive`). In the compose state the
   * status of the frame does not say this, and the close control still hides a live run.
   */
  exportRunLive: boolean;
  /** True while an export that the setup step starts joins the queue (`addsToQueue`). */
  addsToQueue: boolean;
  /** The state of Show for the run of the frame (`selectExportOutputAction`). */
  outputAction: ExportOutputActionRunState;
  /**
   * The queue list of the batch, or null when it does not show (`presentExportQueue`). The
   * frame holds the view, with the Show state of each row, so the list does not change while
   * the dialog fades out.
   */
  queue: ExportQueueView | null;
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
  // True after "Export anyway": the user accepted a source file that changed on disk. The START
  // step then sends no expected revision, so the backend does not refuse that file (ADR 024).
  // A close, Back, or a started export clears it.
  const [sourceChangeAccepted, setSourceChangeAccepted] = useState(false);
  // True while the open step that Back runs again has not answered. The setup step shows
  // meanwhile, and Export stays disabled, so no export starts before the checks end.
  const [backCheckPending, setBackCheckPending] = useState(false);
  // One generation for each open step that the dialog runs again after Back. A close
  // invalidates it, so a step that answers after the close changes nothing
  // (`exportBackToSetup.ts`).
  const [backStep] = useState(createOpenStepGeneration);
  // Counts the clicks on Back. The Back button leaves the document with the failed panel, so
  // the effect below gives the focus to the first control of the setup step once per click.
  const [backClicks, setBackClicks] = useState(0);
  // True while the open step that "New Export…" runs has not answered. The source check can
  // take up to 3 seconds, so the button shows that it is busy, and a second click does
  // nothing. The ref answers the second click of a double click before React renders.
  const [newExportPending, setNewExportPending] = useState(false);
  const newExportPendingRef = useRef(false);
  const setupFirstControlRef = useRef<HTMLButtonElement>(null);
  // The default button of the setup step, and Cancel of the confirmation. Each takes the
  // focus when its footer shows (`resolveExportDialogFocusOrder`).
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  // The dialog element, while it is mounted. It takes the focus when no control of the footer
  // rule can.
  const contentRef = useRef<HTMLDivElement>(null);
  // The element that held the focus when the dialog opened, or null. It takes the focus back
  // when the dialog closes.
  const openerRef = useRef<HTMLElement | null>(null);
  // The time of the click that armed Stop Export, or null when it is not armed. The time is
  // from `performance.now()`, which is monotonic, so a change of the system clock cannot
  // shorten or lengthen the window.
  const [stopArmedAt, setStopArmedAt] = useState<number | null>(null);
  // The time of the last click that armed Stop Export. Unlike `stopArmedAt`, the end of the
  // run does not clear it, so `decideStopClick` can tell that a click confirms an arming of
  // the run before (`lastArmedAt`).
  const lastStopArmedAtRef = useRef<number | null>(null);
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
  // Done names the result and a Show error as its description.
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

  // The setup of an export that joins the queue (ADR 049). While `composing` is true, the
  // dialog shows the state of the compose store, and the handlers act on it.
  const composing = useExportComposeStore((state) => state.composing);
  const composeStatus = useExportComposeStore((state) => state.status);
  const composeError = useExportComposeStore((state) => state.error);
  const exportRunLive = isExportRunLive({ status, tracking });

  const outputAction = useExportOutputActionStore((state) =>
    selectExportOutputAction(state, runId),
  );
  const revealOutput = useExportOutputActionStore((state) => state.reveal);
  // The Show state of every run, for the rows of the queue list.
  const outputActionRuns = useExportOutputActionStore((state) => state.runs);

  // The slices of the queue store that the rows of the queue list read. Each slice keeps its
  // identity until the store changes it, so the memo below builds new rows only on a change.
  // `selectExportQueueRows` returns a new array on each call, so it is never a selector here.
  const queueJobs = useExportQueueStore((state) => state.jobs);
  const queueOrder = useExportQueueStore((state) => state.order);
  const queueWaiting = useExportQueueStore((state) => state.waiting);
  const queueEnded = useExportQueueStore((state) => state.ended);
  const queueRemoving = useExportQueueStore((state) => state.removing);
  // The open submissions. With the waiting runs, they name the confirm button of the setup
  // step (`addsToQueue`).
  const queueSubmitting = useExportQueueStore((state) => state.submitting);
  const queueView = useMemo(
    () =>
      presentExportQueue({
        rows: selectExportQueueRows(
          {
            jobs: queueJobs,
            order: queueOrder,
            waiting: queueWaiting,
            ended: queueEnded,
            removing: queueRemoving,
          },
          { runId },
        ),
        batchSize: queueOrder.length,
        exportState: { status, tracking, error },
        outputActions: { runs: outputActionRuns },
      }),
    [
      queueJobs,
      queueOrder,
      queueWaiting,
      queueEnded,
      queueRemoving,
      runId,
      status,
      tracking,
      error,
      outputActionRuns,
    ],
  );

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

  // Runs once for each click on Back, after the commit that the click made. That commit holds
  // the reset and any failure that the open step reported before its first await, such as
  // `sourceNotFound`, so the status read here is the one on the screen. The status is the one
  // of the target of the dialog: the compose store while it composes, and else the export
  // store (`readTargetState`). When it is idle, the setup step rendered in the same commit,
  // and its first control exists. When the open step failed, the failed panel shows and the
  // focus stays on the dialog. No flag outlives the click, so a later close or reset never
  // moves the focus. While the settings load, the step has no control, and the focus stays on
  // the dialog too.
  useEffect(() => {
    if (backClicks === 0) {
      return;
    }
    if (readTargetState().status === "idle") {
      setupFirstControlRef.current?.focus();
    }
  }, [backClicks]);

  // Everything below renders from `frame`: the live values while the dialog is open, and
  // the held frame while it closes. A closing dialog is inert, so no handler runs on a held
  // frame, and the two are equal whenever a handler can run.
  //
  // While the dialog composes, the status, the tracking, and the error come from the compose
  // store, and the fields of the run of the export store are empty. The pure rules of the
  // step, the footer, and the title then give the setup step, the confirmation, or the result
  // of the compose state. The queue list belongs to the run view, so it does not show.
  const target = selectExportDialogTargetState(
    { composing, status: composeStatus, error: composeError },
    { status, tracking, error },
  );
  const liveFrame: ExportDialogFrame = {
    ...target,
    composing,
    exportRunLive,
    addsToQueue: addsToQueue({
      exportState: { status, tracking },
      queue: { waiting: queueWaiting, submitting: queueSubmitting },
      ownSubmission: choosingDestination,
    }),
    runId: composing ? null : runId,
    outputPath: composing ? null : outputPath,
    cancelRequested: composing ? false : cancelRequested,
    outputAction,
    queue: composing ? null : queueView,
    requestedPresetId,
    choosingDestination,
    backCheckPending,
    stopArmed: stopArmedAt !== null,
    timing,
    progress: null,
  };
  const frame = selectShownFrame(open, liveFrame, heldFrame);
  const step = resolveExportDialogStep(frame.status);

  // The finished panel replaces the footer of the run, so the button that had the focus is
  // gone. Done takes the focus, as the default button of the result. The status is the one on
  // the screen, so a run that finishes behind the compose state moves no focus.
  const shownStatus = frame.status;
  useEffect(() => {
    if (open && shownStatus === "finished") {
      doneButtonRef.current?.focus();
    }
  }, [open, shownStatus]);

  const settings = useSettingsStore((state) => state.settings);
  const effectivePresetId = resolveSetupPresetId(settings, frame.requestedPresetId);
  const selectedPreset =
    settings?.presets.find((preset) => preset.id === effectivePresetId) ?? null;
  // The stream switches of the setup step, and the streams that the export writes with them
  // (ADR 036). The choice lasts for the session and turns both streams on again when the media
  // changes (`exportStreamChoiceStore`). The setup step resolves the same streams for its
  // summary.
  const streamChoice = useExportStreamChoice((state) => state.choice);
  const setStream = useExportStreamChoice((state) => state.setStream);
  const probe = useAttachedMediaStore((state) => state.media?.probe ?? null);
  // With several clips, the sources of the pieces decide, not the attached clip (ADR 053).
  const sourceFacts = useExportSourceFacts(probe);
  const streams = resolveExportStreams(
    streamChoice,
    sourceHasAudio(sourceFacts.output),
  );
  // The copy of the audio (ADR 048): the request asks for it only while the setup step offers
  // it, which the setup step resolves the same way for its switch and its summary.
  const copyAudio = useExportStreamChoice((state) => state.copyAudio);
  const setCopyAudio = useExportStreamChoice((state) => state.setCopyAudio);
  const audioMode = resolveExportAudioMode(
    copyAudio,
    selectedPreset !== null &&
      canCopyAudio({
        probe: sourceFacts.copyProbe,
        container: selectedPreset.container,
        streams,
        segmentCount: sourceFacts.copySegmentCount,
      }),
  );
  // The blocker does not read the copy: the backend encodes the audio with the preset when it
  // cannot copy it.
  const blocker = presentSetupBlocker(selectedPreset, streams);
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
  // a control of a dialog in its exit animation count as no control. A control of the dialog
  // that has the focus keeps it. That is the case after Back, because the effect of Back above
  // runs first and gives the focus to the first control of the setup step. A dialog above this
  // one, such as the quit guard, also keeps the focus. A dialog that is not mounted gets its
  // focus from `onOpenAutoFocus` below, when Radix mounts it.
  useEffect(() => {
    const dialog = contentRef.current;
    if (!open || dialog === null) {
      return;
    }
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
  // The label says so, because an X usually reads as "close". In the compose state the close
  // control also hides the dialog, and a live run of the export store continues behind it.
  const closeLabel = t(resolveExportCloseLabelKey(frame.exportRunLive));

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

  // Clears the transient state of the setup step, and makes a Back step or a confirmation
  // that has not answered stale, so it changes nothing when it answers. The choice of the
  // preset goes too, so the next setup step shows the active preset (ADR 024).
  const clearSetupStep = () => {
    backStep.invalidate();
    setRequestedPresetId(null);
    setSourceChangeAccepted(false);
    setChoosingDestination(false);
    setBackCheckPending(false);
  };

  // Leaves the compose state (ADR 049). The export store keeps its state: a live run
  // continues, and a result stays. `resolveComposeExit` decides whether the dialog closes or
  // shows the run view of the export store. The store is read at the call.
  const leaveCompose = (trigger: ExportComposeExitTrigger) => {
    const exit = resolveComposeExit(trigger, exportStore.getState());
    if (exit === "closeDialog") {
      holdFrame();
    }
    clearSetupStep();
    exportComposeStore.getState().exit();
    if (exit === "closeDialog") {
      setStopArmedAt(null);
      onOpenChange(false);
    }
  };

  // The store is read at the call and not at the render. A live run is never reset here,
  // whatever the caller saw: the reset would drop the only record of a run that the backend
  // still encodes, so the dialog hides instead, the same as a dismissal (ADR 025).
  //
  // In the compose state, Cancel and Close leave the compose state and never reset the export
  // store (`resolveComposeExit`).
  const closeAndReset = () => {
    if (exportComposeStore.getState().composing) {
      leaveCompose("cancel");
      return;
    }
    if (resolveExportDismissal(exportStore.getState()) === "hide") {
      hideDialog();
      return;
    }
    holdFrame();
    onOpenChange(false);
    clearSetupStep();
    setStopArmedAt(null);
    // The reset changes the run id, and that change drops the Show state of the runs that
    // the interface no longer lists (`bindOutputActionsToExportRun`).
    reset();
  };

  // The frame holds the state of Show for its own run only.
  const outputFailure = frame.outputAction.error;
  const revealBusy = frame.outputAction.pending;
  const canActOnOutput = frame.runId !== null && frame.outputPath !== null;

  // The store ignores a second request for the run while one is in flight. The busy button
  // stays enabled, with `aria-busy`, so it keeps the focus.
  const handleReveal = () => {
    if (runId === null) {
      return;
    }
    void revealOutput(runId);
  };

  // Show File of a row of the queue list. The store ignores a second request for a run while
  // one is in flight.
  const handleRevealRun = (shownRunId: string) => {
    void revealOutput(shownRunId);
  };

  // Remove of a waiting row. The store marks the run as `removing` before it sends the
  // request, so the button is disabled at once and a second click sends nothing. The run stays
  // in the list until its event decides. A refused or failed request makes it removable again.
  const handleRemoveRun = (removedRunId: string) => {
    void exportQueueStore.getState().remove(removedRunId);
  };

  // A closed dialog has nothing to dismiss. During the exit animation, Escape can still reach
  // the closing layer, and a run that ended since the hide must not reset before the user
  // sees its result. An open dialog renders the live frame, so `hidesOnDismiss` is live
  // there. In the compose state, a dismissal leaves the compose state and closes the dialog.
  // A live run continues, and the export store keeps its state (`resolveComposeExit`).
  const dismiss = () => {
    if (!open) {
      return;
    }
    if (exportComposeStore.getState().composing) {
      leaveCompose("dismiss");
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
  // The preset choice survives the confirmation, as it survives Back, which can raise the
  // confirmation. `closeAndReset` clears the choice, and the call after it sets the saved value
  // again. React batches the two updates, so the saved value is the one that renders.
  //
  // In the compose state, the dialog stays open. The compose store goes back to the setup
  // step, and the open step runs again on the compose store with the check skipped. The
  // export store and its live run do not change. A step that answers after the user left the
  // compose state changes nothing (`backStep`).
  const handleExportAnyway = () => {
    if (exportComposeStore.getState().composing) {
      setSourceChangeAccepted(true);
      setChoosingDestination(false);
      composeFlowTarget.reset();
      if (onExportAnyway) {
        onExportAnyway();
        return;
      }
      const isCurrent = backStep.begin();
      void runExportFlow({
        ...composeFlowTarget,
        ...guardOpenStepEffects(isCurrent, {
          setModalOpen: onOpenChange,
          reportError: composeFlowTarget.reportError,
        }),
        filterName: t("dialog.videoFilter"),
        audioFilterName: t("dialog.audioFilter"),
        skipSourceRevisionCheck: true,
      });
      return;
    }
    const kept = requestedPresetId;
    closeAndReset();
    setRequestedPresetId(kept);
    setSourceChangeAccepted(true);
    if (onExportAnyway) {
      onExportAnyway();
      return;
    }
    void runExportFlow({
      setModalOpen: onOpenChange,
      filterName: t("dialog.videoFilter"),
      audioFilterName: t("dialog.audioFilter"),
      skipSourceRevisionCheck: true,
    });
  };

  // In the compose state, Re-import leaves the compose state and closes the dialog, so the
  // user sees the window behind it. A live run continues.
  const handleReimport = () => {
    if (exportComposeStore.getState().composing) {
      leaveCompose("dismiss");
    } else {
      closeAndReset();
    }
    if (onReimport) {
      onReimport();
      return;
    }
    // A file that changed on disk is a new source, so Re-import adds it as a clip (ADR 052).
    void openMediaFileDialog({
      filterName: t("dialog.videoFilter"),
      importPath: quitGuard.requestOpen,
    });
  };

  // Opens the Settings window on `section`, or brings it forward. The Settings window is a
  // window of its own, so this dialog stays open with its state: the preset choice of the
  // setup step, and the failed panel with its Back. A change in Settings reaches this window
  // (`settings:changed`), and the setup step lists the presets as they are now. From the setup
  // step, the Presets tab selects the preset that the step shows, unless Settings holds an
  // unsaved edit. The recovery of a failed run names no preset.
  const handleOpenSettings = (section: SettingsSection, presetId: string | null) => {
    void openSettingsWindow(section, presetId);
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
  //
  // In the compose state, Back reads, resets, and reports to the compose store, and the export
  // store and its live run do not change. Leaving the compose state makes the step stale.
  const handleBackToSetup = () => {
    const composes = exportComposeStore.getState().composing;
    if (!canGoBackToSetup(readTargetState())) {
      return;
    }
    setBackClicks((count) => count + 1);
    setSourceChangeAccepted(false);
    setChoosingDestination(false);
    setStopArmedAt(null);
    if (composes) {
      composeFlowTarget.reset();
    } else {
      reset();
    }
    void runOpenStepAgain({
      generation: backStep,
      effects: {
        setModalOpen: onOpenChange,
        reportError: composes
          ? composeFlowTarget.reportError
          : (err) => {
              exportStore.getState().reportError(err);
            },
      },
      setPending: setBackCheckPending,
      run: (effects) =>
        runExportFlow({
          ...flowTargetOf(composes),
          ...effects,
          filterName: t("dialog.videoFilter"),
          audioFilterName: t("dialog.audioFilter"),
        }),
    });
  };

  // In the compose state, the START step reads, reports to, and resets the compose store
  // (ADR 049). When the export joins the queue, or starts because the batch ended meanwhile,
  // the dialog leaves the compose state and shows the run view with the new run.
  //
  // The step begins a generation of `backStep`. When the user leaves the compose state or
  // closes the dialog during the await, that generation is stale, and the updates after the
  // await change nothing: they would act on a newer setup step.
  const handleConfirmExport = async () => {
    if (!effectivePresetId || exportDisabled) {
      return;
    }
    const composes = exportComposeStore.getState().composing;
    const isCurrent = backStep.begin();
    setChoosingDestination(true);
    try {
      const started = await confirmExportFlow(
        {
          ...flowTargetOf(composes),
          setModalOpen: onOpenChange,
          filterName: t("dialog.videoFilter"),
          audioFilterName: t("dialog.audioFilter"),
          skipSourceRevisionCheck: sourceChangeAccepted,
        },
        effectivePresetId,
        streams,
        audioMode,
      );
      if (started && isCurrent()) {
        // Clear the user's manual selection once the export has started so that a subsequent
        // export setup step defaults to the project's active preset (ADR 024) even if this
        // run completes while the dialog is hidden (ADR 025). The started request already
        // carries the whole preset.
        setRequestedPresetId(null);
        setSourceChangeAccepted(false);
        if (composes) {
          clearSetupStep();
          exportComposeStore.getState().exit();
        }
      }
    } finally {
      if (isCurrent()) {
        setChoosingDestination(false);
      }
    }
  };

  // Sets up the next export of the queue from the run view. The title bar is behind the
  // modal, so the run footer offers the Export action of the title bar (`openExportFlow`).
  // While the export store holds a live run, the flow enters the compose state.
  //
  // A confirmation of the setup step before can still wait for its answer, because the run
  // view shows as soon as the export store starts the run. `clearSetupStep` makes that
  // confirmation stale, so its updates after the await cannot change the new setup step.
  const handleNewExport = () => {
    if (newExportPendingRef.current) {
      return;
    }
    clearSetupStep();
    setStopArmedAt(null);
    newExportPendingRef.current = true;
    setNewExportPending(true);
    void openExportFlow({
      setModalOpen: onOpenChange,
      filterName: t("dialog.videoFilter"),
      audioFilterName: t("dialog.audioFilter"),
    }).finally(() => {
      newExportPendingRef.current = false;
      setNewExportPending(false);
    });
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
      lastArmedAt: lastStopArmedAtRef.current,
    });
    if (decision.kind === "ignore") {
      return;
    }
    if (decision.kind === "arm") {
      lastStopArmedAtRef.current = decision.armedAt;
      setStopArmedAt(decision.armedAt);
      return;
    }
    // The arming led to this stop. It must not ignore a Stop of the next run.
    lastStopArmedAtRef.current = null;
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
                <p>{t(outputActionErrorKey(outputFailure.code))}</p>
                {outputFailure.detail && (
                  <p className="mt-1 font-mono break-all select-text">
                    {outputFailure.detail}
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
        // outstanding, because the Stop button then says "Stopping…".
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
            streamChoice={streamChoice}
            onStreamChange={setStream}
            copyAudio={copyAudio}
            onCopyAudioChange={setCopyAudio}
            streamsFrozen={frame.choosingDestination}
            onOpenSettings={(section) => {
              handleOpenSettings(section, effectivePresetId);
            }}
            firstControlRef={setupFirstControlRef}
          />
          {frame.composing && frame.addsToQueue && (
            <p className="pt-2 text-xs text-muted-foreground">
              {t("export.setup.queueNote")}
            </p>
          )}
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
          // A failure of the compose state has no run, so it shows no progress of the run
          // that the export store holds.
          held={frame.composing ? NO_PROGRESS : frame.progress}
          result={step === "result" ? renderResult() : undefined}
        />
        {/* The runs of the batch, below the run panel. It shows only for a batch of more
            than one run, so a single export looks as before (ADR 049). */}
        {frame.queue !== null && (
          <div className="pt-2">
            <ExportQueueList
              view={frame.queue}
              macOS={isMacOS()}
              onShow={handleRevealRun}
              onRemove={handleRemoveRun}
            />
          </div>
        )}
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
          // the element that opened the dialog.
          const opener = document.activeElement;
          openerRef.current =
            opener instanceof HTMLElement && opener !== document.body ? opener : null;
          // Radix would focus the first tabbable element. The footer names the control
          // instead (`resolveExportDialogFocusOrder`): "Export…" on the setup step, Cancel
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
          // A dialog that opened meanwhile keeps the focus, such as the quit guard.
          if (isInOpenDialog(document.activeElement)) {
            event.preventDefault();
            return;
          }
          // Radix would focus the element that held the focus when the content mounted, which
          // is the opener. With no opener, Radix does as before.
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
                  {t(resolveSetupConfirmLabelKey(frame.addsToQueue))}
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
                {
                  // Sets up an export that joins the queue (ADR 049). It is not the
                  // default button, so Enter does not reach it by accident. The busy
                  // button stays enabled, with `aria-busy`, so it keeps the focus.
                  key: "newExport",
                  role: "alternative",
                  node: showsNewExportAction(stopView.noteKey) && (
                    <Button
                      variant="outline"
                      aria-busy={newExportPending || undefined}
                      onClick={handleNewExport}
                    >
                      {newExportPending && (
                        <Loader2
                          aria-hidden="true"
                          className="animate-spin motion-reduce:animate-none"
                        />
                      )}
                      {t("export.action.newExport")}
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
                  // The label is the same on both platforms. The tooltip names the file
                  // manager, and Radix makes it the description of the button while it
                  // shows, so the accessible name stays the visible label (WCAG 2.5.3).
                  node: canActOnOutput && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          aria-busy={revealBusy || undefined}
                          onClick={handleReveal}
                        >
                          {revealBusy && (
                            <Loader2
                              aria-hidden="true"
                              className="animate-spin motion-reduce:animate-none"
                            />
                          )}
                          {t("export.action.showFile")}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t(revealLabelKey(isMacOS()))}</TooltipContent>
                    </Tooltip>
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
                    onClick={() => handleOpenSettings(recoverySettingsSection, null)}
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
