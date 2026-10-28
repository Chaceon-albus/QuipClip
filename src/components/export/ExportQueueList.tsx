import { useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { revealLabelKey } from "./exportFinishedPresenter";
import type { ExportQueueRowView, ExportQueueView } from "./exportQueuePresenter";

export interface ExportQueueListProps {
  view: ExportQueueView;
  /** True on macOS. The tooltip of Show File names the file manager of the platform. */
  macOS: boolean;
  /** Shows the file of the finished run `runId` in Finder or in File Explorer. */
  onShow: (runId: string) => void;
  /** Withdraws the waiting run `runId` from the queue. */
  onRemove: (runId: string) => void;
}

/**
 * The list of the runs of a batch, in the run view of the export dialog (ADR 049).
 *
 * The rows are keyed by run id, so a row keeps its place, and its focused button keeps the
 * focus, when the queue advances. The list scrolls inside a maximum height, so a long batch
 * does not make the dialog grow without limit.
 *
 * Remove carries `aria-disabled` and not `disabled` while the backend cancels its run, as the
 * locked switches of the setup step do. A disabled button loses the focus, and the focus would
 * then drop to the page body. A click on such a button does nothing. Show File follows the
 * Show File of the footer: it stays enabled with `aria-busy` while its request is in flight,
 * and the store ignores a second request for the run.
 *
 * The list itself can take the focus, so a long list scrolls with the keyboard also when no
 * row has a button.
 */
export function ExportQueueList({
  view,
  macOS,
  onShow,
  onRemove,
}: ExportQueueListProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  // The Remove button that had the focus at the last commit, or null.
  const focusedRemoveRef = useRef<HTMLButtonElement | null>(null);

  // A Remove button unmounts when its run leaves the list or takes the slot. When that button
  // had the focus, the focus would drop to the page body, so the list takes it. The effect runs
  // after each commit, and a removed element is no longer connected then. The ref is set on
  // focus and cleared here when another element has the focus, so a button that unmounts after
  // the user moved the focus away never pulls the focus back.
  useLayoutEffect(() => {
    const button = focusedRemoveRef.current;
    if (button === null) {
      return;
    }
    if (button.isConnected) {
      if (document.activeElement !== button) {
        focusedRemoveRef.current = null;
      }
      return;
    }
    focusedRemoveRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      listRef.current?.focus();
    }
  });

  // The list itself unmounts when the batch drops to one run, for example after a Remove.
  // When the focus was in the list, the dialog takes it, so Tab goes on from the dialog. The
  // cleanup of a layout effect runs before React removes the elements, so the `contains` check
  // below still finds the focus in the list. A dialog that closes keeps its own focus rule.
  useLayoutEffect(() => {
    const list = listRef.current;
    return () => {
      if (list === null || !list.contains(document.activeElement)) {
        return;
      }
      const dialog = list.closest<HTMLElement>('[role="dialog"]');
      if (dialog?.dataset.state === "open") {
        dialog.focus();
      }
    };
  }, []);

  const renderRow = (row: ExportQueueRowView) => (
    <li
      key={row.key}
      aria-current={row.current ? "step" : undefined}
      // The current row takes the selection style of the preset list.
      className={cn(
        "space-y-1 px-2.5 py-2",
        row.current && "bg-accent text-accent-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* The stem truncates and the extension stays visible, as in the title bar. */}
          <p
            className="flex min-w-0 text-sm font-medium text-foreground"
            title={row.fullPath}
          >
            <span className="truncate">{row.fileStem}</span>
            <span className="shrink-0">{row.fileExtension}</span>
          </p>
          {/* The preset name truncates, and the status always shows in full. */}
          <p className="flex min-w-0 text-xs text-muted-foreground">
            <span className="truncate">{row.presetName}</span>
            <span className="shrink-0 whitespace-pre">
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <span className={cn(row.error !== null && "text-destructive-text")}>
                {t(row.statusKey)}
              </span>
            </span>
          </p>
        </div>
        {row.show !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                aria-busy={row.show.pending || undefined}
                onClick={() => {
                  onShow(row.runId);
                }}
              >
                {row.show.pending && (
                  <Loader2
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                )}
                {t("export.action.showFile")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t(revealLabelKey(macOS))}</TooltipContent>
          </Tooltip>
        )}
        {(row.canRemove || row.removing) && (
          <Button
            variant="ghost"
            size="xs"
            aria-label={t("export.queue.removeNamed", { name: row.fileName })}
            aria-disabled={row.removing || undefined}
            aria-busy={row.removing || undefined}
            className="aria-disabled:opacity-70"
            onFocus={(event) => {
              focusedRemoveRef.current = event.currentTarget;
            }}
            onClick={() => {
              if (row.canRemove) {
                onRemove(row.runId);
              }
            }}
          >
            {t("export.queue.remove")}
          </Button>
        )}
      </div>
      {row.error !== null && (
        <p className="text-xs text-destructive-text">
          {(t as (k: string, opts?: Record<string, string | number>) => string)(
            row.error.key,
            row.error.values,
          )}
        </p>
      )}
      {row.show?.errorKey && (
        <div role="alert" className="text-xs text-destructive-text">
          <p>{t(row.show.errorKey)}</p>
          {row.show.errorDetail && (
            <p className="mt-1 font-mono break-all select-text">
              {row.show.errorDetail}
            </p>
          )}
        </div>
      )}
    </li>
  );

  return (
    <div className="space-y-1.5">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        {t("export.queue.heading")}
      </h3>
      <ol
        ref={listRef}
        tabIndex={0}
        aria-labelledby={headingId}
        // The ring is inset, because the body of the dialog scrolls and clips a ring outside.
        className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border focus-ring-inset outline-none"
      >
        {view.rows.map(renderRow)}
      </ol>
    </div>
  );
}
