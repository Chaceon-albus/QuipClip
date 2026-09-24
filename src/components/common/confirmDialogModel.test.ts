import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DESTRUCTIVE_CONFIRM_CLASS,
  createConfirmFocusReturn,
  type FocusCandidate,
} from "./confirmDialogModel";

/** A fake element. Its state is writable, so a test can change it after the dialog opened. */
type FakeCandidate = {
  isConnected: boolean;
  isDisabled: boolean;
  isDocumentBody?: boolean;
  focusCount: number;
  focus: () => void;
};

function createCandidate(
  overrides: Partial<
    Pick<FocusCandidate, "isConnected" | "isDisabled" | "isDocumentBody">
  > = {},
): FakeCandidate {
  const candidate: FakeCandidate = {
    isConnected: true,
    isDisabled: false,
    focusCount: 0,
    focus: () => {
      candidate.focusCount += 1;
    },
    ...overrides,
  };
  return candidate;
}

describe("createConfirmFocusReturn", () => {
  it("returns the opener after a cancel, when the opener can still take the focus", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate();
    const fallback = createCandidate();

    rule.noteOpened(opener, fallback);

    expect(rule.takeCloseTarget()).toBe(opener);
  });

  it("falls back to the enclosing dialog when the confirmed write disabled the opener", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate({ isDisabled: true });
    const fallback = createCandidate();

    rule.noteOpened(opener, fallback);

    expect(rule.takeCloseTarget()).toBe(fallback);
  });

  it("falls back to the enclosing dialog when the confirmed delete removed the opener", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate({ isConnected: false });
    const fallback = createCandidate();

    rule.noteOpened(opener, fallback);

    expect(rule.takeCloseTarget()).toBe(fallback);
  });

  it("returns null when neither recorded element can take the focus", () => {
    const rule = createConfirmFocusReturn();

    rule.noteOpened(createCandidate({ isConnected: false }), null);

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("returns null when the dialog opened with nothing focused", () => {
    const rule = createConfirmFocusReturn();

    rule.noteOpened(null, null);

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("tries each fallback in order and takes the first that can take the focus", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate({ isConnected: false });
    const named = createCandidate({ isDisabled: true });
    const enclosing = createCandidate();

    rule.noteOpened(opener, named, enclosing);

    expect(rule.takeCloseTarget()).toBe(enclosing);
  });

  it("prefers the first fallback over a later one when both can take the focus", () => {
    const rule = createConfirmFocusReturn();
    const named = createCandidate();

    rule.noteOpened(createCandidate({ isConnected: false }), named, createCandidate());

    expect(rule.takeCloseTarget()).toBe(named);
  });

  it("skips a null fallback", () => {
    const rule = createConfirmFocusReturn();
    const enclosing = createCandidate();

    rule.noteOpened(createCandidate({ isDisabled: true }), null, enclosing);

    expect(rule.takeCloseTarget()).toBe(enclosing);
  });

  it("returns null when the dialog opened with nothing focused and no fallback", () => {
    const rule = createConfirmFocusReturn();

    rule.noteOpened(null);

    expect(rule.takeCloseTarget()).toBeNull();
  });

  // Nothing held the focus when the dialog opened, as after a pointer press on a button that
  // does not take the focus in WebKit. Focusing the body again would leave the user nowhere.
  it("treats the document body as no opener, so the fallbacks apply", () => {
    const rule = createConfirmFocusReturn();
    const body = createCandidate({ isDocumentBody: true });
    const fallback = createCandidate();

    rule.noteOpened(body, fallback);

    expect(rule.takeCloseTarget()).toBe(fallback);
  });

  it("returns null for a body opener with no fallback", () => {
    const rule = createConfirmFocusReturn();

    rule.noteOpened(createCandidate({ isDocumentBody: true }));

    expect(rule.takeCloseTarget()).toBeNull();
  });

  describe("after a confirm", () => {
    it("puts the confirm target before the opener, whatever the opener", () => {
      const rule = createConfirmFocusReturn();
      const opener = createCandidate();
      const target = createCandidate();

      rule.noteOpened(opener, createCandidate());
      rule.noteConfirmed(target);

      expect(rule.takeCloseTarget()).toBe(target);
    });

    it("falls back to the opener and then the fallbacks when the target cannot take the focus", () => {
      const rule = createConfirmFocusReturn();
      const opener = createCandidate({ isDisabled: true });
      const fallback = createCandidate();

      rule.noteOpened(opener, fallback);
      rule.noteConfirmed(createCandidate({ isConnected: false }));

      expect(rule.takeCloseTarget()).toBe(fallback);
    });

    it("keeps the opener first when the confirm names no target", () => {
      const rule = createConfirmFocusReturn();
      const opener = createCandidate();

      rule.noteOpened(opener, createCandidate());
      rule.noteConfirmed(null);

      expect(rule.takeCloseTarget()).toBe(opener);
    });

    it("forgets the confirm after the close, so a later cancel returns to its opener", () => {
      const rule = createConfirmFocusReturn();
      rule.noteOpened(createCandidate());
      rule.noteConfirmed(createCandidate());
      rule.takeCloseTarget();

      const opener = createCandidate();
      rule.noteOpened(opener);

      expect(rule.takeCloseTarget()).toBe(opener);
    });

    it("forgets a confirm from an earlier open when the dialog opens again", () => {
      const rule = createConfirmFocusReturn();
      rule.noteOpened(createCandidate());
      rule.noteConfirmed(createCandidate());

      const opener = createCandidate();
      rule.noteOpened(opener);

      expect(rule.takeCloseTarget()).toBe(opener);
    });
  });

  it("reads the state of the opener when the dialog closes, not when it opens", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate();
    const fallback = createCandidate();

    rule.noteOpened(opener, fallback);
    opener.isDisabled = true;

    expect(rule.takeCloseTarget()).toBe(fallback);
  });

  it("forgets every element after a close, so a stale element never takes the focus", () => {
    const rule = createConfirmFocusReturn();
    rule.noteOpened(createCandidate(), createCandidate(), createCandidate());

    rule.takeCloseTarget();

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("never focuses an element itself; the caller focuses the returned target", () => {
    const rule = createConfirmFocusReturn();
    const opener = createCandidate();

    rule.noteOpened(opener, null);
    rule.takeCloseTarget();

    expect(opener.focusCount).toBe(0);
  });
});

describe("DESTRUCTIVE_CONFIRM_CLASS", () => {
  // The contrast figures in confirmDialogModel.ts hold only when these classes replace the
  // fill, the text, the hover fill, and the press fill of the default button. If
  // tailwind-merge kept a class of the default variant beside them, the stylesheet order
  // would decide the color instead.
  it("replaces every color class of the default button", () => {
    const merged = cn(buttonVariants({ variant: "default" }), DESTRUCTIVE_CONFIRM_CLASS)
      .split(" ")
      .filter((token) => token.length > 0);

    expect(merged).not.toContain("bg-primary");
    expect(merged).not.toContain("text-primary-foreground");
    expect(merged).not.toContain("hover:bg-primary-hover");
    expect(merged).not.toContain("active:bg-primary-active");
    for (const token of DESTRUCTIVE_CONFIRM_CLASS.split(" ")) {
      expect(merged).toContain(token);
    }
  });
});
