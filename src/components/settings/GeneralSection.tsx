import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createLanguageMenuController } from "@/components/layout/languageMenuController";
import {
  isTimecodeFormat,
  timecodePreferenceStore,
  useTimecodePreference,
} from "@/features/settings/timecodePreference";
import { getLanguagePreference, type LanguagePreference } from "@/i18n";

/**
 * The General tab of the settings dialog. It holds the settings that belong to the
 * application as a whole. Each setting is one field component, so a later setting adds a
 * field and does not touch the wiring of the others.
 */
export function GeneralSection() {
  return (
    <section className="space-y-4">
      <LanguageField />
      <TimecodeField />
    </section>
  );
}

/**
 * The interface language (ADR 011). The language lives in web view storage, not in the
 * settings file, so this field does not read the settings store and a damaged settings file
 * does not disable it.
 */
function LanguageField() {
  const { t, i18n } = useTranslation();
  const triggerId = useId();
  const [preference, setPreference] = useState<LanguagePreference>(() =>
    getLanguagePreference(),
  );

  const controller = useMemo(
    () =>
      createLanguageMenuController({
        instance: i18n,
        initialPreference: getLanguagePreference(),
        onPreferenceChange: setPreference,
      }),
    [i18n],
  );

  // Sync preference state when i18n language changes externally
  useEffect(() => {
    controller.activate();
    const handleLanguageChanged = () => {
      controller.handleLanguageChanged();
    };
    i18n.on("languageChanged", handleLanguageChanged);
    return () => {
      i18n.off("languageChanged", handleLanguageChanged);
      controller.deactivate();
    };
  }, [i18n, controller]);

  const handleLanguageChange = (value: string) => {
    void controller.requestPreference(value);
  };

  return (
    <div className="space-y-1">
      <label htmlFor={triggerId} className="text-xs font-medium text-muted-foreground">
        {t("settings.language.label")}
      </label>
      <Select value={preference} onValueChange={handleLanguageChange}>
        <SelectTrigger id={triggerId} className="w-64 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">{t("settings.language.system")}</SelectItem>
          <SelectItem value="en">{t("settings.language.en")}</SelectItem>
          <SelectItem value="zh-CN">{t("settings.language.zhCN")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const { setFormat: setTimecodeFormat } = timecodePreferenceStore.getState();

/**
 * The timecode format (ADR 028). Like the language, it lives in web view storage and not in
 * the settings file. A change applies at once to every timecode that reads the preference.
 */
function TimecodeField() {
  const { t } = useTranslation();
  const triggerId = useId();
  const hintId = useId();
  const format = useTimecodePreference((state) => state.format);

  const handleFormatChange = (value: string) => {
    if (isTimecodeFormat(value)) {
      setTimecodeFormat(value);
    }
  };

  return (
    <div className="space-y-1">
      <label htmlFor={triggerId} className="text-xs font-medium text-muted-foreground">
        {t("settings.timecode.label")}
      </label>
      <Select value={format} onValueChange={handleFormatChange}>
        <SelectTrigger
          id={triggerId}
          aria-describedby={hintId}
          className="w-64 max-w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="frames">{t("settings.timecode.frames")}</SelectItem>
          <SelectItem value="milliseconds">
            {t("settings.timecode.milliseconds")}
          </SelectItem>
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t("settings.timecode.hint")}
      </p>
    </div>
  );
}
