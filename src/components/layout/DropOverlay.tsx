import { useTranslation } from "react-i18next";
import { FileVideo } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFileDropOpen } from "./useFileDropOpen";

/**
 * The frame that covers the window while the user drags a file over it, and the listener
 * that opens the file on a drop.
 *
 * Mount it once, in the application shell. It holds the drag state itself, so a drag renders
 * this component and not the shell around it.
 *
 * A screen reader can skip a live region that mounts with its text already in it. The
 * status element therefore stays mounted for the life of the component, and only its text
 * changes. The visible frame repeats the same text, so it is hidden from assistive
 * technology.
 *
 * The frame takes no pointer events, so it never becomes the target of the drag. The
 * message sits on a solid card, because the frame is translucent and covers both the dark
 * preview and the themed panels, and text on the frame alone could not keep its contrast on
 * both. The frame mounts again for each drag, so the fade runs on every `enter`. The fade is
 * the only motion, so it also stays under reduced motion.
 */
export function DropOverlay() {
  const { t } = useTranslation();
  const state = useFileDropOpen();

  const supported = state?.kind === "open";
  const message =
    state === null
      ? null
      : supported
        ? t("fileDrop.release")
        : t("fileDrop.unsupported");
  const note =
    state?.kind === "open" && state.extraIgnored ? t("fileDrop.othersIgnored") : null;

  return (
    <>
      <div role="status" className="sr-only">
        {message !== null && <p>{message}</p>}
        {note !== null && <p>{note}</p>}
      </div>
      {message !== null && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none fixed inset-0 z-40 m-2 grid animate-in place-items-center rounded-xl border-2 border-dashed duration-(--motion-base) ease-enter fade-in-0",
            supported
              ? "border-primary bg-primary/10"
              : "border-destructive bg-destructive/10",
          )}
        >
          <div className="flex max-w-sm flex-col items-center gap-2 rounded-lg border border-border bg-popover px-6 py-4 text-center text-popover-foreground shadow-lg">
            <FileVideo
              className={cn("size-8", supported ? "text-primary" : "text-destructive")}
            />
            <p
              className={cn(
                "text-sm font-medium",
                !supported && "text-destructive-text",
              )}
            >
              {message}
            </p>
            {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
          </div>
        </div>
      )}
    </>
  );
}
