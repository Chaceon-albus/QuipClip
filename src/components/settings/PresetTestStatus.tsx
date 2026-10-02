import {
  CircleCheck,
  CircleX,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type {
  PresetTestIcon,
  PresetTestStatusView,
  PresetTestTone,
} from "./presetTestPresenter";

type Translate = (key: string, options?: Record<string, string | number>) => string;

/** The text colour of each tone, as the FFmpeg status of the Settings window uses them. */
const TONE_CLASSES: Record<PresetTestTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success-text",
  warning: "text-warning-text",
  destructive: "text-destructive-text",
};

/** The icon of each status. */
const ICONS: Record<PresetTestIcon, LucideIcon> = {
  spinner: Loader2,
  passed: CircleCheck,
  warning: TriangleAlert,
  failed: CircleX,
};

/**
 * The icon of a status, decorative: the sentence or the label beside it carries its meaning.
 * It takes the colour of `tone`, or of its parent with no tone, and a spinner turns.
 */
export function PresetTestGlyph({
  icon,
  tone,
  className,
}: {
  icon: PresetTestIcon;
  tone?: PresetTestTone;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        tone !== undefined && TONE_CLASSES[tone],
        icon === "spinner" && "animate-spin",
        className,
      )}
    />
  );
}

/**
 * The status line of a preset test: an icon and a sentence, and under them the FFmpeg line or
 * the diagnostic, as it is, in the monospaced face.
 *
 * The block is plain text and not a live region: it changes with each preset that the list
 * selects and with each background test, and a screen reader would read every change.
 * `PresetTestAnnouncement` speaks for a test that the user started. `id` is the target of the
 * `aria-describedby` of the button that starts the test. The line is clamped to three lines on
 * screen and keeps its whole text in its title and in the accessibility tree.
 */
export function PresetTestStatus({
  id,
  view,
  className,
}: {
  id?: string;
  view: PresetTestStatusView;
  className?: string;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const line =
    view.line ??
    (view.lineMessage === null
      ? null
      : translate(view.lineMessage.key, view.lineMessage.values));
  return (
    <div id={id} className={cn("min-w-0 space-y-0.5 text-xs", className)}>
      <p className={cn("flex items-start gap-1.5", TONE_CLASSES[view.tone])}>
        {view.icon !== null ? (
          <PresetTestGlyph icon={view.icon} className="mt-px size-3.5" />
        ) : null}
        <span className="min-w-0">
          {translate(view.message.key, view.message.values)}
        </span>
      </p>
      {line !== null ? (
        <p
          title={line}
          className="line-clamp-3 font-mono text-2xs wrap-anywhere text-muted-foreground"
        >
          {line}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The live region of the tests that the user started: visually hidden, and polite. It stays
 * mounted, so a change of `text` is announced, and `usePresetTestAction` changes it only when
 * such a test starts and when it ends.
 */
export function PresetTestAnnouncement({ text }: { text: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}
