import { describe, expect, it } from "vitest";
import {
  describeContextMenuTarget,
  isEditableTextField,
  MEDIA_ELEMENT_SELECTOR,
  shouldSuppressContextMenu,
  TEXT_INPUT_TYPES,
  type ContextMenuElement,
  type ContextMenuTarget,
} from "./contextMenuPolicy";

interface FakeElementOptions {
  readonly tagName: string;
  readonly type?: unknown;
  readonly isContentEditable?: unknown;
  /** The selectors that `matches` answers true for. */
  readonly matching?: readonly string[];
  /** The selectors that `closest` finds an ancestor or the element itself for. */
  readonly within?: readonly string[];
}

/** A small fake element. It records each selector that the reader asks about. */
function fakeElement(options: FakeElementOptions): ContextMenuElement & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    tagName: options.tagName,
    type: options.type,
    isContentEditable: options.isContentEditable,
    asked,
    matches(selector) {
      asked.push(`matches ${selector}`);
      return options.matching?.includes(selector) ?? false;
    },
    closest(selector) {
      asked.push(`closest ${selector}`);
      return options.within?.includes(selector) ? {} : null;
    },
  };
}

describe("describeContextMenuTarget", () => {
  it("gives null for a target that is not an element", () => {
    expect(describeContextMenuTarget(null)).toBeNull();
    expect(describeContextMenuTarget(undefined)).toBeNull();
    // The document and the window have no tag name.
    expect(describeContextMenuTarget({ addEventListener: () => {} })).toBeNull();
    expect(describeContextMenuTarget({ tagName: "DIV" })).toBeNull();
  });

  it("describes a plain element", () => {
    const element = fakeElement({ tagName: "DIV" });
    expect(describeContextMenuTarget(element)).toEqual({
      tagName: "DIV",
      inputType: null,
      isContentEditable: false,
      isDisabled: false,
      isInsideMedia: false,
    });
    expect(element.asked).toEqual([
      "matches :disabled",
      `closest ${MEDIA_ELEMENT_SELECTOR}`,
    ]);
  });

  it("reads the type of an input and ignores the type of any other element", () => {
    for (const type of ["text", "password", "checkbox", "range"]) {
      expect(
        describeContextMenuTarget(fakeElement({ tagName: "INPUT", type }))?.inputType,
      ).toBe(type);
    }
    // A button and a list item also have a `type` property.
    expect(
      describeContextMenuTarget(fakeElement({ tagName: "BUTTON", type: "submit" }))
        ?.inputType,
    ).toBeNull();
    expect(
      describeContextMenuTarget(fakeElement({ tagName: "OL", type: "1" }))?.inputType,
    ).toBeNull();
    // A type that is not a string reads as no type, which the rule takes as text.
    expect(
      describeContextMenuTarget(fakeElement({ tagName: "INPUT", type: 5 }))?.inputType,
    ).toBeNull();
  });

  it("reads a disabled control from :disabled", () => {
    const described = describeContextMenuTarget(
      fakeElement({ tagName: "INPUT", type: "text", matching: [":disabled"] }),
    );
    expect(described?.isDisabled).toBe(true);
    // A disabled text field is not editable, so a release build opens no menu on it.
    expect(shouldSuppressContextMenu(described, false)).toBe(true);
  });

  it("reads a media element and an element inside one from closest", () => {
    const video = describeContextMenuTarget(
      fakeElement({ tagName: "VIDEO", within: [MEDIA_ELEMENT_SELECTOR] }),
    );
    expect(video?.isInsideMedia).toBe(true);
    expect(shouldSuppressContextMenu(video, true)).toBe(true);

    const track = describeContextMenuTarget(
      fakeElement({ tagName: "TRACK", within: [MEDIA_ELEMENT_SELECTOR] }),
    );
    expect(track?.isInsideMedia).toBe(true);
  });

  it("reads isContentEditable only when it is true", () => {
    expect(
      describeContextMenuTarget(
        fakeElement({ tagName: "SPAN", isContentEditable: true }),
      )?.isContentEditable,
    ).toBe(true);
    // An SVG element has no isContentEditable.
    expect(
      describeContextMenuTarget(fakeElement({ tagName: "svg" }))?.isContentEditable,
    ).toBe(false);
    expect(
      describeContextMenuTarget(
        fakeElement({ tagName: "SPAN", isContentEditable: "true" }),
      )?.isContentEditable,
    ).toBe(false);
  });

  it("gives a description that keeps the menu of a text field in a release build", () => {
    const field = describeContextMenuTarget(
      fakeElement({ tagName: "INPUT", type: "text" }),
    );
    expect(shouldSuppressContextMenu(field, false)).toBe(false);
    const area = describeContextMenuTarget(fakeElement({ tagName: "TEXTAREA" }));
    expect(shouldSuppressContextMenu(area, false)).toBe(false);
    const box = describeContextMenuTarget(
      fakeElement({ tagName: "INPUT", type: "checkbox" }),
    );
    expect(shouldSuppressContextMenu(box, false)).toBe(true);
  });
});

function target(overrides: Partial<ContextMenuTarget> = {}): ContextMenuTarget {
  return {
    tagName: "DIV",
    inputType: null,
    isContentEditable: false,
    isDisabled: false,
    isInsideMedia: false,
    ...overrides,
  };
}

const input = (type: string | null, overrides: Partial<ContextMenuTarget> = {}) =>
  target({ tagName: "INPUT", inputType: type, ...overrides });

describe("isEditableTextField", () => {
  it.each(TEXT_INPUT_TYPES)("is true for an input of type %s", (type) => {
    expect(isEditableTextField(input(type))).toBe(true);
  });

  it("is true for an input with no type and for an empty type", () => {
    expect(isEditableTextField(input(null))).toBe(true);
    expect(isEditableTextField(input(""))).toBe(true);
  });

  it("ignores the case of the tag name and of the type", () => {
    expect(isEditableTextField(target({ tagName: "input", inputType: "Search" }))).toBe(
      true,
    );
    expect(isEditableTextField(target({ tagName: "textarea" }))).toBe(true);
  });

  it.each([
    "checkbox",
    "radio",
    "range",
    "button",
    "submit",
    "file",
    "color",
    "hidden",
  ])("is false for an input of type %s", (type) => {
    expect(isEditableTextField(input(type))).toBe(false);
  });

  it("is true for a text area", () => {
    expect(isEditableTextField(target({ tagName: "TEXTAREA" }))).toBe(true);
  });

  it("is false for a disabled text input and a disabled text area", () => {
    expect(isEditableTextField(input("text", { isDisabled: true }))).toBe(false);
    expect(isEditableTextField(target({ tagName: "TEXTAREA", isDisabled: true }))).toBe(
      false,
    );
  });

  it("is true for an editable region and for an element inside one", () => {
    expect(isEditableTextField(target({ isContentEditable: true }))).toBe(true);
    expect(
      isEditableTextField(target({ tagName: "SPAN", isContentEditable: true })),
    ).toBe(true);
  });

  it.each(["DIV", "BUTTON", "SELECT", "PRE", "CODE", "P", "VIDEO"])(
    "is false for a %s element",
    (tagName) => {
      expect(isEditableTextField(target({ tagName }))).toBe(false);
    },
  );
});

describe("shouldSuppressContextMenu", () => {
  describe("in a release build", () => {
    it("suppresses the menu on the chrome, on a button and on selectable text", () => {
      expect(shouldSuppressContextMenu(target(), false)).toBe(true);
      expect(shouldSuppressContextMenu(target({ tagName: "BUTTON" }), false)).toBe(
        true,
      );
      // The diagnostic text and the install commands are selectable, not editable. They
      // have a Copy button, and the Edit menu copies a selection.
      expect(shouldSuppressContextMenu(target({ tagName: "PRE" }), false)).toBe(true);
      expect(shouldSuppressContextMenu(target({ tagName: "CODE" }), false)).toBe(true);
    });

    it("suppresses the menu when the target is not an element", () => {
      expect(shouldSuppressContextMenu(null, false)).toBe(true);
    });

    it("keeps the menu of an editable text field", () => {
      expect(shouldSuppressContextMenu(input("text"), false)).toBe(false);
      expect(shouldSuppressContextMenu(input(null), false)).toBe(false);
      expect(shouldSuppressContextMenu(target({ tagName: "TEXTAREA" }), false)).toBe(
        false,
      );
      expect(
        shouldSuppressContextMenu(target({ isContentEditable: true }), false),
      ).toBe(false);
    });

    it("suppresses the menu of a field that takes no text", () => {
      expect(shouldSuppressContextMenu(input("checkbox"), false)).toBe(true);
      expect(
        shouldSuppressContextMenu(input("text", { isDisabled: true }), false),
      ).toBe(true);
    });
  });

  describe("in a development build", () => {
    it("keeps the menu everywhere, so a developer can inspect an element", () => {
      expect(shouldSuppressContextMenu(target(), true)).toBe(false);
      expect(shouldSuppressContextMenu(target({ tagName: "BUTTON" }), true)).toBe(
        false,
      );
      expect(shouldSuppressContextMenu(input("text"), true)).toBe(false);
      expect(shouldSuppressContextMenu(null, true)).toBe(false);
    });
  });

  it("always suppresses the menu of a media element", () => {
    // Loop, Show Controls and Picture in Picture would change the element behind the store.
    for (const isDevBuild of [false, true]) {
      expect(
        shouldSuppressContextMenu(
          target({ tagName: "VIDEO", isInsideMedia: true }),
          isDevBuild,
        ),
      ).toBe(true);
      expect(
        shouldSuppressContextMenu(
          target({ tagName: "AUDIO", isInsideMedia: true }),
          isDevBuild,
        ),
      ).toBe(true);
    }
  });
});
