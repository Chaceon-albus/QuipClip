import { describe, expect, it } from "vitest";
import { TITLE_BAR_SELECTOR } from "@/lib/titleBar";
import { keepsFocusOnPress, presentTitleBarModal } from "./titleBarModal";

/** An event target whose nearest title bar ancestor is `bar`, or that has none. */
function target(bar: object | null) {
  return {
    closest: (selector: string) => (selector === TITLE_BAR_SELECTOR ? bar : null),
  };
}

describe("presentTitleBarModal", () => {
  it("changes nothing while no dialog is open", () => {
    expect(
      presentTitleBarModal({ exportDialogOpen: false, quitPromptOpen: false }),
    ).toEqual({ modalOpen: false, barClass: "", appControlClass: "" });
  });

  it("gives the bar the pointer and takes it from the controls while a dialog is open", () => {
    // Radix puts `pointer-events: none` on <body>. The bar takes the pointer back for the
    // window drag and the window buttons, and the File menu and Export stay out of reach.
    const open = {
      modalOpen: true,
      barClass: "pointer-events-auto",
      appControlClass: "pointer-events-none",
    };
    expect(
      presentTitleBarModal({ exportDialogOpen: true, quitPromptOpen: false }),
    ).toEqual(open);
    expect(
      presentTitleBarModal({ exportDialogOpen: false, quitPromptOpen: true }),
    ).toEqual(open);
    // The quit prompt opens above the export dialog.
    expect(
      presentTitleBarModal({ exportDialogOpen: true, quitPromptOpen: true }),
    ).toEqual(open);
  });
});

describe("keepsFocusOnPress", () => {
  const closed = presentTitleBarModal({
    exportDialogOpen: false,
    quitPromptOpen: false,
  });
  const open = presentTitleBarModal({ exportDialogOpen: true, quitPromptOpen: false });

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
