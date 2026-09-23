import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  describe("the elevation shadows from globals.css", () => {
    it("keeps a shadow size and a shadow colour together", () => {
      expect(cn("shadow-dialog", "shadow-black/20")).toBe(
        "shadow-dialog shadow-black/20",
      );
    });

    it("lets a later shadow size replace an elevation shadow", () => {
      expect(cn("shadow-floating", "shadow-none")).toBe("shadow-none");
    });

    it("lets a later elevation shadow replace a default shadow size", () => {
      expect(cn("shadow-md", "shadow-floating")).toBe("shadow-floating");
    });

    it("replaces a shadow size under the same variant prefix only", () => {
      expect(
        cn("data-[state=open]:shadow-sm", "data-[state=open]:shadow-floating"),
      ).toBe("data-[state=open]:shadow-floating");
      expect(cn("shadow-sm", "data-[state=open]:shadow-floating")).toBe(
        "shadow-sm data-[state=open]:shadow-floating",
      );
    });

    it.each(["shadow-raised", "shadow-floating", "shadow-dialog"])(
      "treats %s as a shadow size, not a ring or a colour",
      (shadow) => {
        expect(cn(shadow, "ring-1 ring-foreground/10", "shadow-black/20")).toBe(
          `${shadow} ring-1 ring-foreground/10 shadow-black/20`,
        );
        expect(cn("shadow-lg", shadow)).toBe(shadow);
      },
    );
  });
});
