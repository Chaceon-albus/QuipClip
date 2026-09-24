import { useTranslation } from "react-i18next";
import { DiagnosticDetails } from "@/components/common/DiagnosticDetails";

export interface ExportErrorDetailsProps {
  /** The diagnostic text of the failure. It shows unchanged (ADR 011). */
  detail: string;
}

/**
 * The diagnostic of a failed export, behind a disclosure that starts closed. The failed
 * panel places it below the tinted error notice. `DiagnosticDetails` holds the disclosure,
 * the Copy button, and its feedback.
 */
export function ExportErrorDetails({ detail }: ExportErrorDetailsProps) {
  const { t } = useTranslation();
  return (
    <DiagnosticDetails
      summary={t("export.details.show")}
      openSummary={t("export.details.hide")}
      text={detail}
    />
  );
}
