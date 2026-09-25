import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MediaProbe } from "@/features/media";
import { playbackStore, usePlaybackStore } from "@/features/playback";
import type { TimecodeDisplay } from "@/lib/timecode";
import { formatPreviewCurrentTime, showsApproximateBadge } from "./previewFrame";
import { closesFieldOnPress } from "./timecodeFieldPress";
import {
  resolveTimecodeEntry,
  runTimecodeEntryCommand,
  type TimecodeEntryErrorCode,
} from "./timecodeEntrySeek";

/**
 * Marks the current timecode as approximate. It is a small `≈` badge before the value, and
 * its tooltip gives the same explanation as the status bar's approximate-position chip. The
 * badge can take the focus, so a keyboard user can open the tooltip, and its accessible
 * name is the chip's label, because a screen reader would read the symbol alone as a
 * relation.
 *
 * The preview section is always dark, so the `-text` token resolves to its dark value here.
 */
function ApproximateBadge() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="mr-1.5 rounded-sm bg-warning/15 px-1 text-2xs text-warning-text focus-ring outline-none"
        >
          <span aria-hidden="true">≈</span>
          <span className="sr-only">{t("statusBar.approximatePosition")}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
        <p>{t("statusBar.approximatePositionDetail")}</p>
        <p>{t("statusBar.approximatePositionMarks")}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The most characters that the field takes. The longest time that the formats write, such as
 * `-00:00:00:000`, has 13, so the limit leaves room for spaces and extra digits, and it keeps a
 * pasted text from growing the field without end.
 */
const FIELD_MAX_LENGTH = 32;

/** The widest that the field grows, in character widths of the monospace font. */
const FIELD_MAX_WIDTH_CH = 18;

/**
 * The classes of each hidden copy of a text that sizes the field. It takes the padding of the
 * button, so the field is exactly as wide as the button (`-mx-1 px-1`) until the typed text is
 * longer than the value. `min-w-0` and `overflow-hidden` let the width stop at
 * `FIELD_MAX_WIDTH_CH`.
 */
const FIELD_SIZER_CLASS =
  "invisible col-start-1 row-start-1 min-w-0 overflow-hidden px-1 whitespace-pre";

/** The open field: its text, its error, and the source it was opened for. */
interface TimecodeDraft {
  readonly text: string;
  readonly error: TimecodeEntryErrorCode | null;
  readonly sourceRevisionKey: string | null;
}

/**
 * Current preview timecode. It subscribes to `presentedFrame` and to the approximate clock on
 * its own, so the surrounding pane, and with it the `<video>` element, does not re-render once
 * for every presented video frame or every `timeupdate`.
 *
 * The value is a button. A click, or Enter while it has the focus, turns it into a text field
 * that holds the current value, selected, as in Premiere Pro, DaVinci Resolve and Final Cut Pro.
 * The user types a time in the format of the source (`parseTimecodeEntry`), and the seek follows
 * `planTimecodeEntrySeek`.
 *
 * - Enter goes to the time and closes the field. A text that is not a time keeps the field open
 *   and shows why, and an empty field closes as Escape does.
 * - Escape closes the field and keeps the position.
 * - A press outside the field closes it and keeps the position, as Premiere Pro does
 *   (`closesFieldOnPress`). A press somewhere else is not a request to go to the time: a click
 *   on the ruler would seek twice, and a click on a button would do its action and also move the
 *   playhead. The pressed control still acts. The rule does not wait for a blur, because several
 *   buttons keep no focus from a press, and the field would then stay open.
 * - A blur inside the window, as from Tab, also closes the field and keeps the position. A blur
 *   because the window lost the focus keeps the field open, and the focus returns to it with the
 *   window.
 *
 * The keyboard layer of the window does nothing while the field has the focus, because it does
 * nothing for a key press whose target is an `input` (ADR 021). The field therefore keeps every
 * key that it types, such as `+`, `-`, Backspace and the arrow keys.
 */
export function PreviewTimecode({
  probe,
  display,
  decodeFailed,
}: {
  probe: MediaProbe;
  display: TimecodeDisplay;
  decodeFailed: boolean;
}) {
  const { t } = useTranslation();
  const presentedFrame = usePlaybackStore((s) => s.presentedFrame);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    (s) => s.approximateBrowserTimeSeconds,
  );
  const seekTargetSeconds = usePlaybackStore((s) => s.seekTargetSeconds);
  const isAttached = usePlaybackStore((s) => s.isAttached);
  const isReady = usePlaybackStore((s) => s.isReady);
  const attachedSourceRevisionKey = usePlaybackStore(
    (s) => s.attachedSourceRevisionKey,
  );

  // The seek target first, then the source-relative time of a ready inferred PTS, then the
  // approximate browser time (ADR 022), in the format of the source (ADR 028).
  const currentTimeDisplay = formatPreviewCurrentTime(
    presentedFrame,
    calibrationStatus,
    probe.videoStartPts,
    probe.videoTimeBase,
    approximateBrowserTimeSeconds ?? 0,
    seekTargetSeconds,
    display,
  );

  // A time can be typed while the source can seek: the same condition as the seek actions.
  const canEnterTime = isAttached && isReady && !decodeFailed;

  const [draft, setDraft] = useState<TimecodeDraft | null>(null);
  // The field closes when seeking stops being possible or the source changes while it is open.
  if (
    draft !== null &&
    (!canEnterTime || draft.sourceRevisionKey !== attachedSourceRevisionKey)
  ) {
    setDraft(null);
  }

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Set when Enter or Escape closes the field, so the focus returns to the button. A blur leaves
  // the focus where the user put it.
  const returnFocusRef = useRef(false);
  const isEditing = draft !== null;
  useLayoutEffect(() => {
    if (!isEditing && returnFocusRef.current) {
      returnFocusRef.current = false;
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [isEditing]);

  // The field takes the focus and selects its text once, when it mounts. A stable callback runs
  // only on mount and unmount, so a render while the user types does not select the text again.
  const fieldRef = useCallback((field: HTMLInputElement | null) => {
    if (field !== null) {
      field.focus({ preventScroll: true });
      field.select();
    }
  }, []);

  // A press outside the field closes it (`closesFieldOnPress`). The listener is on the document
  // in the capture phase while the field is open, so it runs before the handler of the pressed
  // control, which still acts. The focus stays where the press puts it.
  const fieldContainerRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (closesFieldOnPress(fieldContainerRef.current, target)) {
        returnFocusRef.current = false;
        setDraft(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
  }, [isEditing]);

  const openHintId = useId();
  const fieldHintId = useId();
  const errorId = useId();

  const open = () => {
    if (!canEnterTime) {
      return;
    }
    setDraft({
      text: currentTimeDisplay,
      error: null,
      sourceRevisionKey: attachedSourceRevisionKey,
    });
  };

  const close = (returnFocus: boolean) => {
    returnFocusRef.current = returnFocus;
    setDraft(null);
  };

  const commit = (text: string) => {
    const outcome = resolveTimecodeEntry(text, {
      probe,
      playback: playbackStore.getState(),
      display,
    });
    if (outcome.kind === "error") {
      setDraft((current) =>
        current === null ? null : { ...current, error: outcome.error },
      );
      return;
    }
    if (outcome.kind === "run" && outcome.command !== null) {
      runTimecodeEntryCommand(outcome.command, playbackStore.getState());
    }
    close(true);
  };

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // A key that an input method takes belongs to the composition.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const onFieldBlur = () => {
    // Enter or Escape already closed the field. Some web views send a blur when the focused
    // field leaves the document, and that blur must not cancel the return of the focus.
    if (returnFocusRef.current) {
      return;
    }
    // A blur while the document keeps the focus moved it to another place in the window. A
    // blur while the window loses the focus keeps the field, because the focus comes back to it.
    if (document.hasFocus()) {
      close(false);
    }
  };

  const format = display.format;
  const errorMessage =
    draft?.error == null ? null : timecodeEntryErrorMessage(t, draft.error, format);

  return (
    <>
      {showsApproximateBadge(calibrationStatus, decodeFailed) && <ApproximateBadge />}
      {draft === null ? (
        <>
          {/* The same left padding as the field, so the value does not move when the field
              opens. The hidden copies in the field take the padding of this button, so the
              field is as wide as the button (FIELD_SIZER_CLASS). */}
          <button
            ref={buttonRef}
            type="button"
            disabled={!canEnterTime}
            onClick={open}
            aria-describedby={openHintId}
            className="-mx-1 cursor-text rounded-sm px-1 py-0.5 text-primary focus-ring transition-colors outline-none hover:bg-preview-foreground/10 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="sr-only">{t("preview.timecodeEntry.currentTime")} </span>
            {currentTimeDisplay}
          </button>
          <span id={openHintId} className="sr-only">
            {t("preview.timecodeEntry.openHint")}
          </span>
        </>
      ) : (
        <span
          ref={fieldContainerRef}
          className="-mx-1 inline-grid"
          style={{ maxWidth: `${FIELD_MAX_WIDTH_CH}ch` }}
        >
          {/* The field and two hidden copies of text share one grid cell. The copies of the
              typed text and of the value set the width, so the field is as wide as the longer
              of the two. A width in `ch` cannot do this: `ch` ignores the tight letter spacing
              of the row, so the field was wider than the button, and the total after it moved
              to the right when the field opened. `size={1}` keeps the default width of an
              input out of the cell. The right padding of the field is 2px less than that of
              the copies, so the caret at the end of the text has room and the text does not
              scroll. */}
          <span aria-hidden="true" className={FIELD_SIZER_CLASS}>
            {draft.text}
          </span>
          <span aria-hidden="true" className={FIELD_SIZER_CLASS}>
            {currentTimeDisplay}
          </span>
          {/* `select-text` restores text selection, which the preview section turns off. A web
              view that inherits `user-select: none` into a field can refuse to edit it. The
              1px ring is the edge of the field, as the border of an Input: --border-strong,
              and the destructive colour while the text is not a time. The focus ring is the
              one of every control, and it also takes the destructive colour while the text is
              not a time (5.54:1 on the preview background). */}
          <input
            ref={fieldRef}
            type="text"
            value={draft.text}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setDraft((current) =>
                current === null ? null : { ...current, text, error: null },
              );
            }}
            onKeyDown={onFieldKeyDown}
            onBlur={onFieldBlur}
            aria-label={t("preview.timecodeEntry.fieldLabel")}
            aria-invalid={draft.error !== null}
            aria-describedby={
              draft.error === null ? fieldHintId : `${errorId} ${fieldHintId}`
            }
            maxLength={FIELD_MAX_LENGTH}
            size={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="col-start-1 row-start-1 h-6 w-full min-w-0 rounded-sm bg-preview-surface pr-0.5 pl-1 text-preview-foreground ring-1 ring-border-strong focus-ring outline-none select-text aria-invalid:ring-destructive aria-invalid:focus-visible:outline-destructive"
          />
          <span id={fieldHintId} className="sr-only">
            {format === "frames"
              ? t("preview.timecodeEntry.fieldHint.frames")
              : t("preview.timecodeEntry.fieldHint.milliseconds")}
          </span>
          {/* The error sits above the field, over the bottom of the picture, so the row keeps
              its height. `role="alert"` reads it out when it appears. It is placed against the
              timecode row of the preview, which is `relative` and spans the pane (PreviewPane),
              so its width never passes the pane: `max-w-full` is the width of that row. */}
          {errorMessage !== null && (
            <span
              id={errorId}
              role="alert"
              className="absolute bottom-full left-0 z-20 mb-2 w-max max-w-full rounded-md border border-destructive/60 bg-preview-background px-2 py-1 font-sans text-xs leading-snug font-normal tracking-normal whitespace-normal text-destructive-text shadow-md"
            >
              {errorMessage}
            </span>
          )}
        </span>
      )}
    </>
  );
}

/** The message of an entry error, in the format of the source for a text that is not a time. */
function timecodeEntryErrorMessage(
  t: ReturnType<typeof useTranslation>["t"],
  error: TimecodeEntryErrorCode,
  format: TimecodeDisplay["format"],
): string {
  switch (error) {
    case "invalid":
      return format === "frames"
        ? t("preview.timecodeEntry.error.invalid.frames")
        : t("preview.timecodeEntry.error.invalid.milliseconds");
    case "tooManyDecimals":
      return t("preview.timecodeEntry.error.tooManyDecimals");
    case "tooLarge":
      return t("preview.timecodeEntry.error.tooLarge");
  }
}
