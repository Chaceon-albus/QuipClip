import { describe, expect, it } from "vitest";
import { TITLE_BAR_SELECTOR } from "@/lib/titleBar";
import {
  keepsFocusOnPress,
  presentTitleBarModal,
  type TitleBarModalInput,
} from "./titleBarModal";

/** An event target whose nearest title bar ancestor is `bar`, or that has none. */
function target(bar: object | null) {
  return {
    closest: (selector: string) => (selector === TITLE_BAR_SELECTOR ? bar : null),
  };
}

const NONE_OPEN: TitleBarModalInput = {
  exportDialogOpen: false,
  quitPromptOpen: false,
  saveErrorOpen: false,
  projectOpenOpen: false,
  recoveryPromptOpen: false,
};

const DIALOGS = Object.keys(NONE_OPEN) as (keyof TitleBarModalInput)[];

/** Each input with one or more dialogs open. */
function eachOpenInput(): TitleBarModalInput[] {
  const inputs: TitleBarModalInput[] = [];
  for (let mask = 1; mask < 1 << DIALOGS.length; mask += 1) {
    const input = { ...NONE_OPEN };
    DIALOGS.forEach((dialog, index) => {
      input[dialog] = (mask & (1 << index)) !== 0;
    });
    inputs.push(input);
  }
  return inputs;
}

describe("presentTitleBarModal", () => {
  it("changes nothing while no dialog is open", () => {
    expect(presentTitleBarModal(NONE_OPEN)).toEqual({
      modalOpen: false,
      barClass: "",
      appControlClass: "",
    });
  });

  it("gives the bar the pointer and takes it from the controls while a dialog is open", () => {
    // Radix puts `pointer-events: none` on <body>. The bar takes the pointer back for the
    // window drag and the window buttons, and the File menu and Export stay out of reach.
    const open = {
      modalOpen: true,
      barClass: "pointer-events-auto",
      appControlClass: "pointer-events-none",
    };
    // The quit prompt opens above the export dialog, the project dialog and the recovery prompt,
    // and the dialog of a save that failed can open above them (ADR 072, ADR 073).
    const inputs = eachOpenInput();
    expect(inputs).toHaveLength(31);
    for (const input of inputs) {
      expect(presentTitleBarModal(input)).toEqual(open);
    }
  });

  it("knows the recovery prompt alone (ADR 073)", () => {
    expect(
      presentTitleBarModal({ ...NONE_OPEN, recoveryPromptOpen: true }).modalOpen,
    ).toBe(true);
  });
});

describe("keepsFocusOnPress", () => {
  const closed = presentTitleBarModal(NONE_OPEN);
  const open = presentTitleBarModal({ ...NONE_OPEN, exportDialogOpen: true });

  it("keeps the focus in the dialog for a press in the bar while a dialog is open", () => {
    expect(keepsFocusOnPress(open, target({}))).toBe(true);
  });

  it("leaves a press in the dialog alone", () => {
    // The export dialog is a React child of the bar, so React passes its presses up to the
    // bar. Its portal is under <body>, so the target is not in the bar.
    expect(keepsFocusOnPress(open, target(null))).toBe(false);
    expect(keepsFocusOnPress(open, null)).toBe(false);
  });

  it("leaves every press alone while no dialog is open", () => {
    expect(keepsFocusOnPress(closed, target({}))).toBe(false);
    expect(keepsFocusOnPress(closed, target(null))).toBe(false);
  });
});
