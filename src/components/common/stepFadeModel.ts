/**
 * Pure rules for `StepFade`: which step of a dialog fades in, and how.
 *
 * The rules have no DOM and no React, so the tests need no document.
 */

/**
 * Classes of a step that fades in.
 *
 * Only the opacity changes. Nothing moves or scales, so the fade stays when the system asks
 * for reduced motion. That is the rule of the overlays in `globals.css`, where a dialog also
 * keeps only its fade: a change of opacity is not motion.
 */
export const STEP_FADE_IN_CLASS =
  "animate-in fade-in-0 duration-(--motion-base) ease-enter";

/**
 * Answers whether the content of `step` fades in.
 *
 * The step that the content opened on does not fade, because the dialog itself fades in with
 * it. Every later step fades, and so does a return to the first step: `changed` records that
 * a change occurred, and it never goes back to false while the content stays mounted.
 *
 * The answer applies to an element only when it mounts. `StepFade` keeps the answer of its
 * mount, so an element that stays on the screen across a step change never starts to fade.
 */
export function shouldFadeStep(
  firstStep: string,
  step: string,
  changed: boolean,
): boolean {
  return changed || step !== firstStep;
}
