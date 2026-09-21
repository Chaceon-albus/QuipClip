import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacOS, isMacOSUserAgent } from "@/lib/platform";

describe("platform detection", () => {
  describe("isMacOSUserAgent", () => {
    it("returns true for a real macOS Safari user agent", () => {
      const macOSSafari =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
      expect(isMacOSUserAgent(macOSSafari)).toBe(true);
    });

    it("returns true for a real macOS WKWebView user agent", () => {
      const macOSWKWebView =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
      expect(isMacOSUserAgent(macOSWKWebView)).toBe(true);
    });

    it("returns false for a real Windows user agent", () => {
      const windowsUA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
      expect(isMacOSUserAgent(windowsUA)).toBe(false);
    });

    it("returns false for a Linux user agent", () => {
      const linuxUA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
      expect(isMacOSUserAgent(linuxUA)).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(isMacOSUserAgent("")).toBe(false);
    });

    // The substring rule comes unchanged from the private function this module replaced, and that it is knowingly loose.
    it("characterizes the inherited rule for a string containing 'Mac' in another position", () => {
      expect(isMacOSUserAgent("CustomApp/1.0 Machine")).toBe(true);
      expect(isMacOSUserAgent("Arch-Mac-Test/2.0")).toBe(true);
      expect(isMacOSUserAgent("Device: BigMac")).toBe(true);
    });
  });

  describe("isMacOS", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns false when there is no navigator", () => {
      vi.stubGlobal("navigator", undefined);
      expect(isMacOS()).toBe(false);
    });

    it("reads the user agent of the current environment", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });
      expect(isMacOS()).toBe(true);
    });
  });
});
