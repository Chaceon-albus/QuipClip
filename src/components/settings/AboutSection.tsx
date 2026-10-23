import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadBuildInfo, type BuildInfo } from "@/lib/buildInfo";
import { presentVersionLine } from "./aboutPresenter";

/**
 * The About tab of the Settings window (ADR 047). It names the application and gives the
 * version with the source of the build, so a person can tell two builds of one version apart
 * and copy the line into a bug report. The tab can hold more about the application later,
 * such as the licenses.
 *
 * The build info is fixed when the Rust crate is compiled, so the tab reads it once. Until it
 * arrives, and when the read fails, the tab shows no version line.
 */
export function AboutSection() {
  const { t } = useTranslation();
  const translate = t as (key: string, options?: Record<string, string>) => string;
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let active = true;
    void loadBuildInfo().then((value) => {
      if (active) {
        setInfo(value);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const line = info === null ? null : presentVersionLine(info);

  return (
    <section className="space-y-1">
      <h2 className="text-base font-semibold">{t("app.name")}</h2>
      {line !== null ? (
        // The page turns text selection off. The version line takes it back, so a person can
        // copy it.
        <p className="text-muted-foreground select-text">
          {translate(line.key, line.values)}
        </p>
      ) : null}
    </section>
  );
}
