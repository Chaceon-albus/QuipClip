import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { STEP_FADE_IN_CLASS, shouldFadeStep } from "./stepFadeModel";

// True when a `StepFade` that mounts now fades in. False outside a scope.
const StepFadeContext = createContext(false);

export interface StepFadeScopeProps {
  /** A name for the current step. A change of it lets the content of the next step fade in. */
  step: string;
  children: ReactNode;
}

/**
 * Holds the rule of `shouldFadeStep` for the steps of one dialog.
 *
 * Put it inside the dialog content, so that it mounts when the dialog opens and each open
 * starts again on its first step. A reopen during the exit animation keeps the mounted
 * scope, so its first step and its record of a change carry over. Key each `StepFade` inside
 * it on the block that it holds, so that a new block mounts a new element and its animation
 * runs.
 */
export function StepFadeScope({ step, children }: StepFadeScopeProps) {
  const [firstStep] = useState(step);
  const [changed, setChanged] = useState(false);
  const fadeIn = shouldFadeStep(firstStep, step, changed);
  if (fadeIn && !changed) {
    // Records the change, so that a return to the first step fades in too. A state update
    // during render that depends on a prop is the React pattern for this: React renders
    // this component again at once, before it commits.
    setChanged(true);
  }
  return <StepFadeContext value={fadeIn}>{children}</StepFadeContext>;
}

/**
 * A `div` that fades in when it mounts on a step change inside a `StepFadeScope`.
 *
 * The scope is read once, at mount, and the class never changes after it. An element can stay
 * mounted across a step change, such as the run panel from the progress step into the
 * result. If the class followed the scope, that element would get the fade on the change and
 * fade up from invisible while it was already on the screen.
 */
export function StepFade({ className, ...props }: ComponentProps<"div">) {
  const fadeInAtMount = useContext(StepFadeContext);
  const [fadeIn] = useState(fadeInAtMount);
  return <div {...props} className={cn(fadeIn && STEP_FADE_IN_CLASS, className)} />;
}
