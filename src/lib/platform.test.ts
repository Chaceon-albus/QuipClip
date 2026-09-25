import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLATFORM_ATTRIBUTE,
  applyPlatformAttribute,
  interfacePlatformOf,
  isMacOS,
  isMacOSUserAgent,
  isWindows,
  isWindowsUserAgent,
  type PlatformRoot,
} from "@/lib/platform";

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

  describe("isWindowsUserAgent", () => {
    it("returns true for a real WebView2 user agent", () => {
      const webView2 =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
      expect(isWindowsUserAgent(webView2)).toBe(true);
    });

    it("returns false for a real macOS WKWebView user agent", () => {
      const macOSWKWebView =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
      expect(isWindowsUserAgent(macOSWKWebView)).toBe(false);
    });

    it("returns false for a Linux user agent", () => {
      const linuxUA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
      expect(isWindowsUserAgent(linuxUA)).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(isWindowsUserAgent("")).toBe(false);
    });
  });

  describe("isWindows", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns false when there is no navigator", () => {
      vi.stubGlobal("navigator", undefined);
      expect(isWindows()).toBe(false);
    });

    it("reads the user agent of the current environment", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });
      expect(isWindows()).toBe(true);
    });
  });

  describe("interfacePlatformOf", () => {
    it("maps macOS to the macOS branch and every other platform to Windows", () => {
      expect(
        interfacePlatformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
      ).toBe("macos");
      expect(interfacePlatformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
        "windows",
      );
      expect(interfacePlatformOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("windows");
      expect(interfacePlatformOf("")).toBe("windows");
    });
  });

  describe("applyPlatformAttribute", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function fakeRoot(): PlatformRoot & { attributes: Map<string, string> } {
      const attributes = new Map<string, string>();
      return {
        attributes,
        setAttribute: (name, value) => {
          attributes.set(name, value);
        },
      };
    }

    it("writes the branch of the given user agent on the root", () => {
      const root = fakeRoot();
      applyPlatformAttribute(root, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
      expect(PLATFORM_ATTRIBUTE).toBe("data-platform");
      expect(root.attributes.get(PLATFORM_ATTRIBUTE)).toBe("macos");

      applyPlatformAttribute(root, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      expect(root.attributes.get(PLATFORM_ATTRIBUTE)).toBe("windows");
    });

    it("reads the navigator when no user agent is given", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });
      const root = fakeRoot();
      applyPlatformAttribute(root);
      expect(root.attributes.get(PLATFORM_ATTRIBUTE)).toBe("macos");
    });

    it("takes the Windows branch with no navigator", () => {
      vi.stubGlobal("navigator", undefined);
      const root = fakeRoot();
      applyPlatformAttribute(root);
      expect(root.attributes.get(PLATFORM_ATTRIBUTE)).toBe("windows");
    });

    it("does nothing with a null root or outside a document", () => {
      expect(() => applyPlatformAttribute(null, "Macintosh")).not.toThrow();
      expect(() => applyPlatformAttribute(undefined, "Macintosh")).not.toThrow();
    });
  });
});
