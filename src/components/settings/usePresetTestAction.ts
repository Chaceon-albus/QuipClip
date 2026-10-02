/**
 * Starts a preset test that the user asked for, and keeps the text of its announcement.
 *
 * The status line of a test is not a live region (see `PresetTestStatus`). The button that
 * starts a test uses this hook instead, and renders `announcement` in a
 * `PresetTestAnnouncement`: the text changes when the test starts and when it ends, and at no
 * other time. A background test of the export setup calls the store directly and is not
 * announced. A test that ends after the probe located another binary empties the region, because
 * the status line no longer shows that test.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { presetTestStore } from "@/features/settings/presetTestStore";
import type { Preset } from "@/features/settings/types";
import { presentPresetTestAnnouncement } from "./presetTestPresenter";

type Translate = (key: string, options?: Record<string, string | number>) => string;

export function usePresetTestAction(): {
  /** The text of the live region, empty before the first test that the user started. */
  readonly announcement: string;
  /** Tests `preset` and announces its start and its end. */
  readonly start: (preset: Preset) => void;
} {
  const { t } = useTranslation();
  const translate = t as Translate;
  const [announcement, setAnnouncement] = useState("");

  const start = useCallback(
    (preset: Preset) => {
      const announce = (
        message: { key: string; values?: Record<string, string | number> } | null,
      ) => {
        setAnnouncement(message === null ? "" : translate(message.key, message.values));
      };
      const store = presetTestStore.getState();
      announce(presentPresetTestAnnouncement(null, store.generation));
      void store.runTest(preset).then((run) => {
        announce(
          presentPresetTestAnnouncement(run, presetTestStore.getState().generation),
        );
      });
    },
    [translate],
  );

  return { announcement, start };
}
