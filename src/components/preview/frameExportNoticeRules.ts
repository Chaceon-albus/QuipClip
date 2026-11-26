/**
 * The notice of Export Frame in the notification area of the preview (ADR 069).
 *
 * The notice belongs to the action, not to the clip on screen: it comes from the state of the
 * controller, so a change of the clip does not remove it. A saved image shows its file name. A
 * failure shows its message and, when there is one, the diagnostic text of FFmpeg.
 *
 * The notice has no button that shows the file in the file manager: ADR 029 permits that action
 * only for the path of an export run.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { FrameExportErrorCode, FrameExportNotice } from "@/features/frameExport";

/** The catalog key of the message of a saved image. */
export const FRAME_EXPORT_SAVED_KEY = "preview.frameExport.saved";

/** The catalog key of the message of a failure with `code`. Each one is a whole sentence. */
export type FrameExportErrorKey = `frameExportError.${FrameExportErrorCode}`;

/** What the notice shows. `id` is the id of the notice of the controller, for the dismiss. */
export type FrameExportNoticeView =
  | {
      readonly kind: "frameExport";
      readonly id: number;
      readonly messageKey: typeof FRAME_EXPORT_SAVED_KEY;
      readonly name: string;
    }
  | {
      readonly kind: "frameExportError";
      readonly id: number;
      readonly messageKey: FrameExportErrorKey;
      /** The untranslated diagnostic text of the failure (ADR 011), or null. */
      readonly detail: string | null;
    };

/** The notice to show for the state of the controller, or null for none. */
export function presentFrameExportNotice(
  notice: FrameExportNotice | null,
): FrameExportNoticeView | null {
  if (notice === null) {
    return null;
  }
  if (notice.kind === "saved") {
    return {
      kind: "frameExport",
      id: notice.id,
      messageKey: FRAME_EXPORT_SAVED_KEY,
      name: notice.fileName,
    };
  }
  return {
    kind: "frameExportError",
    id: notice.id,
    messageKey: `frameExportError.${notice.code}`,
    detail: notice.detail,
  };
}
