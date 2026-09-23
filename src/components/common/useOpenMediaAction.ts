import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { quitGuard } from "@/components/layout/quitGuardController";
import { openMediaFileDialog } from "@/features/media";

/**
 * Returns the Open Media action: the native file dialog, then the import of the chosen file.
 *
 * The File menu item in the title bar and the Open button of the empty preview both call this
 * one handler, so the two entry points cannot drift apart in their filter label or their
 * error handling. A file that would replace an open video with segments asks first.
 */
export function useOpenMediaAction(): () => void {
  const { t } = useTranslation();
  return useCallback(() => {
    void openMediaFileDialog({
      filterName: t("dialog.videoFilter"),
      // The quit guard asks before the file replaces an open video with segments (ADR 027).
      importPath: quitGuard.requestOpen,
    });
  }, [t]);
}
