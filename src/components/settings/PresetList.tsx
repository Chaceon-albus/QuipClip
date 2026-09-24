import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Ellipsis, Minus, Plus } from "lucide-react";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FfmpegState } from "@/features/ffmpeg/types";
import { cn } from "@/lib/utils";
import { DefaultBadge } from "./DefaultBadge";
import { isUnsavedPresetRow } from "./presetDraftGuard";
import type { PresetLibraryView } from "./presetLibraryController";
import { decidePresetListKey } from "./presetListKeyboard";
import {
  canStartPresetDelete,
  findPresetRow,
  pickListTabStopId,
  PRESET_ROW_ID_ATTRIBUTE,
  type PresetToolbarActionView,
} from "./presetListPresenter";
import {
  joinDescribedBy,
  presentPresetEncoderMark,
  presentPresetRowSummary,
} from "./presetPresenter";

type Translate = (key: string, options?: Record<string, string | number>) => string;

// A row does not take the focus from a pointer press (`preventFocusOnMouseDown`). The section
// moves the focus when the press selects the row. When the unsaved-draft prompt stops the
// selection, the focus must not rest on a row that is not selected, or the next arrow key would
// start from that row.

export interface PresetListProps {
  view: PresetLibraryView;
  ffmpegState: Pick<FfmpegState, "status" | "results">;
  numberFormatter: Intl.NumberFormat;
  /** The `listbox` element. The section finds a row in it to move the focus. */
  listRef: RefObject<HTMLDivElement | null>;
  /** True while the tab of the list is the visible tab. */
  visible: boolean;
  /**
   * Selects the row through the unsaved-draft guard of the section, and moves the focus to the
   * row when the selection changes.
   */
  onSelectRow: (id: string) => void;
  /** Moves the focus to the name field of the editor for the row. */
  onEditName: (id: string) => void;
  /** Asks the user to confirm the delete of the row. */
  onDeleteRow: (id: string) => void;
}

/**
 * The preset list: a single-select `listbox` with one Tab stop. See `presetListKeyboard.ts`
 * for its keys. Each row shows the stored name of the preset, not the draft name, and a second
 * line with its container, video encoder, and quality.
 */
export function PresetList({
  view,
  ffmpegState,
  numberFormatter,
  listRef,
  visible,
  onSelectRow,
  onEditName,
  onDeleteRow,
}: PresetListProps) {
  const { t } = useTranslation();
  const translate = t as Translate;

  const presetIds = view.presets.map((preset) => preset.id);
  const tabStopId = pickListTabStopId(presetIds, view.selectedPresetId);
  const canDelete = canStartPresetDelete(view);

  // Keep the selected row in view when the selection changes: after Add and Duplicate, which
  // select a row at the end of the list, and when the tab opens on a preset far down the list.
  // The panel of a hidden tab stays mounted but is `display: none`, and a hidden row cannot
  // scroll into view. So the effect runs again when the tab becomes visible, for example after
  // a switch from the General tab.
  useEffect(() => {
    if (!visible) {
      return;
    }
    findPresetRow(listRef.current, view.selectedPresetId)?.scrollIntoView({
      block: "nearest",
    });
  }, [listRef, view.selectedPresetId, visible]);

  if (!view.ready) {
    return <p className="p-2 text-xs text-muted-foreground">{t("common.loading")}</p>;
  }
  if (view.presets.length === 0) {
    return (
      <p className="p-2 text-xs text-muted-foreground">{t("settings.preset.empty")}</p>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    const decision = decidePresetListKey(
      {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      },
      { presetIds, focusedId: id, canDelete },
    );
    if (decision.kind === "ignore") {
      return;
    }
    event.preventDefault();
    switch (decision.kind) {
      case "consume":
        return;
      case "select":
        onSelectRow(decision.id);
        return;
      case "editName":
        onEditName(id);
        return;
      case "delete":
        onDeleteRow(decision.id);
        return;
    }
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("settings.preset.section")}
      className="space-y-0.5 p-1"
    >
      {view.presets.map((preset) => {
        const selected = preset.id === view.selectedPresetId;
        const encoderMark = presentPresetEncoderMark(ffmpegState, preset);
        const summary = presentPresetRowSummary(preset, numberFormatter);
        const summaryText = translate(summary.key, summary.values);
        return (
          <div
            key={preset.id}
            {...{ [PRESET_ROW_ID_ATTRIBUTE]: preset.id }}
            role="option"
            aria-selected={selected}
            tabIndex={preset.id === tabStopId ? 0 : -1}
            onMouseDown={preventFocusOnMouseDown}
            onClick={() => onSelectRow(preset.id)}
            onKeyDown={(event) => handleKeyDown(event, preset.id)}
            className={cn(
              // The ring is inset, because the scrolling pane around the list would clip a
              // ring drawn outside the row. A row keeps the arrow cursor of a native list.
              "flex cursor-default flex-col gap-0.5 rounded px-2 py-1.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-muted/50",
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium" title={preset.name}>
                {preset.name}
              </span>
              {isUnsavedPresetRow(view, preset.id) ? (
                <>
                  {/* The dot is decorative. The `sr-only` span carries its meaning into the
                      row's accessible name, as the encoder badge does. */}
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                  <span className="sr-only">{` ${t("settings.preset.unsaved")}`}</span>
                </>
              ) : null}
              {/* `DefaultBadge` holds the contrast ratios of its text on these rows. */}
              {preset.id === view.activePresetId ? (
                <DefaultBadge className="ml-auto" />
              ) : null}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="truncate text-2xs text-muted-foreground"
                title={summaryText}
              >
                {summaryText}
              </span>
              {encoderMark ? (
                <Tooltip>
                  {/* The badge cannot take the focus: the row around it is the option that
                      holds the focus, and a focusable child would nest one control inside
                      another. The tooltip therefore reaches a mouse only; the `sr-only` span
                      carries the same encoder name and reason into the row's accessible name,
                      where a keyboard or screen-reader user reads them. */}
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-2xs leading-none font-semibold",
                        encoderMark.tone === "warning"
                          ? "bg-warning/10 text-warning-text"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {translate(encoderMark.badgeKey)}
                      <span className="sr-only">
                        {` ${translate(encoderMark.titleKey, encoderMark.titleValues)} ${translate(encoderMark.reasonKey)}`}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="flex-col items-start gap-1">
                    <p className="font-semibold">
                      {translate(encoderMark.titleKey, encoderMark.titleValues)}
                    </p>
                    <p>{translate(encoderMark.reasonKey)}</p>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * True when the tooltip of a toolbar button may open: the pointer is over the trigger, or the
 * button shows its focus ring.
 */
function isToolbarTooltipWanted(trigger: HTMLElement | null): boolean {
  return (
    trigger !== null &&
    (trigger.matches(":hover") || trigger.querySelector(":focus-visible") !== null)
  );
}

/**
 * The tooltip of one toolbar button: the name of its action and, while the button is off, a
 * second line that says why.
 *
 * A Radix tooltip opens on every focus that no pointer press on its trigger started. That
 * includes the focus that a menu or a confirmation gives back to its opener when it closes
 * after a pointer press somewhere else, and the tooltip would then open away from the pointer.
 * This tooltip therefore opens only while the pointer is over the trigger or the focus ring
 * shows, which is the case for a focus from the keyboard.
 *
 * A disabled button takes no pointer events, so the span around it is the tooltip trigger, as
 * in the transport bar. The span has no tabIndex, so the Tab order does not change. The reason
 * is also in an `sr-only` span, which the button names in `aria-describedby`.
 */
function ToolbarTooltip({
  label,
  reason,
  reasonId,
  children,
}: {
  label: string;
  reason: string | null;
  reasonId: string;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        setOpen(next && isToolbarTooltipWanted(triggerRef.current));
      }}
    >
      <TooltipTrigger asChild>
        <span ref={triggerRef} className="inline-flex">
          {children}
          {reason !== null ? (
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <ShortcutTooltipContent label={label} reason={reason} />
    </Tooltip>
  );
}

/** A menu item that runs only after the menu has closed. See `PresetListToolbar`. */
type MenuAction = "duplicate" | "restore";

export interface PresetListToolbarProps {
  add: PresetToolbarActionView;
  remove: PresetToolbarActionView;
  duplicate: PresetToolbarActionView;
  restore: PresetToolbarActionView;
  /** Disables the menu button. */
  menuDisabled: boolean;
  /** The Add button, which takes the focus back after an Add that failed. */
  addButtonRef: RefObject<HTMLButtonElement | null>;
  /** The menu button, which takes the focus back after a Duplicate that failed. */
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  onAdd: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRestore: () => void;
}

/**
 * The toolbar under the preset list, in the style of the buttons under a macOS source list:
 * Add, Delete, and a menu with Duplicate and Restore Built-in Presets. Delete and Duplicate act
 * on the selected preset.
 */
export function PresetListToolbar({
  add,
  remove,
  duplicate,
  restore,
  menuDisabled,
  addButtonRef,
  moreButtonRef,
  onAdd,
  onDelete,
  onDuplicate,
  onRestore,
}: PresetListToolbarProps) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const idBase = useId();
  const addReasonId = `${idBase}-add-reason`;
  const deleteReasonId = `${idBase}-delete-reason`;
  const moreReasonId = `${idBase}-more-reason`;
  const duplicateLabelId = `${idBase}-duplicate-label`;
  const duplicateReasonId = `${idBase}-duplicate-reason`;
  const moreDescriptionId = `${idBase}-more-description`;

  const addReason = add.reason ? translate(add.reason.key, add.reason.values) : null;
  const deleteReason = remove.reason
    ? translate(remove.reason.key, remove.reason.values)
    : null;
  const duplicateReason = duplicate.reason
    ? translate(duplicate.reason.key, duplicate.reason.values)
    : null;

  // The menu item that the user chose. It runs when the menu has closed, in `onCloseAutoFocus`,
  // just before Radix gives the focus back to the menu button. The confirmation of Restore
  // Built-in Presets then records the menu button as its opener, and gives the focus back to
  // it. A Duplicate that succeeds focuses the name field of the copy after the menu button has
  // the focus, so the menu does not take the focus from that field.
  const chosenActionRef = useRef<MenuAction | null>(null);

  return (
    <div className="flex shrink-0 items-center gap-0.5 border-t border-border bg-muted/30 p-1">
      <ToolbarTooltip
        label={t("settings.preset.add")}
        reason={addReason}
        reasonId={addReasonId}
      >
        <Button
          ref={addButtonRef}
          variant="tool-ghost"
          size="icon-xs"
          aria-label={t("settings.preset.add")}
          aria-describedby={joinDescribedBy(addReason !== null && addReasonId)}
          disabled={add.disabled}
          onClick={onAdd}
        >
          <Plus />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip
        label={t("settings.preset.delete")}
        reason={deleteReason}
        reasonId={deleteReasonId}
      >
        <Button
          variant="tool-ghost"
          size="icon-xs"
          aria-label={t("settings.preset.delete")}
          aria-describedby={joinDescribedBy(deleteReason !== null && deleteReasonId)}
          disabled={remove.disabled}
          onClick={onDelete}
        >
          <Minus />
        </Button>
      </ToolbarTooltip>
      <DropdownMenu>
        <ToolbarTooltip
          label={t("settings.preset.moreActions")}
          reason={null}
          reasonId={moreReasonId}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreButtonRef}
              variant="tool-ghost"
              size="icon-xs"
              aria-label={t("settings.preset.moreActions")}
              aria-describedby={joinDescribedBy(
                duplicateReason !== null && moreDescriptionId,
              )}
              disabled={menuDisabled}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        {/* Radix skips a disabled menu item, so the keyboard never reaches the reason inside
            the Duplicate item. The menu button therefore also carries the reason, which a
            screen reader reads with the button, before the menu opens. */}
        {duplicateReason !== null ? (
          <span id={moreDescriptionId} className="sr-only">
            {duplicateReason}
          </span>
        ) : null}
        <DropdownMenuContent
          align="start"
          className="w-auto max-w-64 min-w-44"
          onCloseAutoFocus={() => {
            const action = chosenActionRef.current;
            chosenActionRef.current = null;
            if (action === "duplicate") {
              onDuplicate();
            } else if (action === "restore") {
              onRestore();
            }
          }}
        >
          {/* The reason is a second line of the item, so the menu holds only menu items. The
              label names the item, and the reason describes it, so a screen reader reads
              "Duplicate Preset" and then why it is off. The reason is dimmed with the item:
              WCAG 1.4.3 does not ask for contrast in a control that is not available. */}
          <DropdownMenuItem
            disabled={duplicate.disabled}
            aria-labelledby={duplicateLabelId}
            aria-describedby={joinDescribedBy(
              duplicateReason !== null && duplicateReasonId,
            )}
            onSelect={() => {
              chosenActionRef.current = "duplicate";
            }}
          >
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span id={duplicateLabelId}>{t("settings.preset.duplicate")}</span>
              {duplicateReason !== null ? (
                <span
                  id={duplicateReasonId}
                  className="text-xs whitespace-normal text-muted-foreground"
                >
                  {duplicateReason}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={restore.disabled}
            onSelect={() => {
              chosenActionRef.current = "restore";
            }}
          >
            {t("settings.preset.restoreBuiltIn")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
