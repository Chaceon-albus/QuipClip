import { describe, expect, it, vi } from "vitest";
import {
  createLanguageMenuController,
  isLanguagePreference,
  LanguageMenuController,
} from "./languageMenuController";
import {
  createI18nInstance,
  type LanguagePreference,
  type PreferenceStorage,
} from "@/i18n";

/**
 * Creates a deferred promise helper to control async execution in tests.
 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Creates an in-memory storage implementation for testing.
 */
function createMemoryStorage(
  initialValues: Record<string, string> = {},
): PreferenceStorage & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initialValues));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("LanguageMenuController", () => {
  describe("isLanguagePreference type guard", () => {
    it("identifies valid language preferences", () => {
      expect(isLanguagePreference("system")).toBe(true);
      expect(isLanguagePreference("en")).toBe(true);
      expect(isLanguagePreference("zh-CN")).toBe(true);
    });

    it("rejects invalid language preference values", () => {
      expect(isLanguagePreference("fr")).toBe(false);
      expect(isLanguagePreference("")).toBe(false);
      expect(isLanguagePreference(null)).toBe(false);
      expect(isLanguagePreference(undefined)).toBe(false);
      expect(isLanguagePreference(123)).toBe(false);
      expect(isLanguagePreference({})).toBe(false);
    });
  });

  describe("single selection success", () => {
    it("optimistically updates displayed preference and confirms on success", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onPreferenceChange = vi.fn();
      const applyPreference = vi.fn().mockResolvedValue("zh-CN");

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
      });

      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");
      expect(controller.isPending()).toBe(false);

      const promise = controller.requestPreference("zh-CN");

      // Optimistic visual update
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getLatestRequestedPreference()).toBe("zh-CN");
      expect(controller.isPending()).toBe(true);
      expect(onPreferenceChange).toHaveBeenCalledWith("zh-CN");

      const result = await promise;

      expect(result).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.isPending()).toBe(false);
      expect(applyPreference).toHaveBeenCalledWith("zh-CN");
    });
  });

  describe("failure rollback", () => {
    it("restores storage and checked preference to last confirmed on failure", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onPreferenceChange = vi.fn();
      const onError = vi.fn();
      const failureError = new Error("Failed to load catalog");
      const applyPreference = vi.fn().mockImplementation(() => {
        // Simulate setLanguagePreference persisting before failing changeLanguage
        storage.setItem("quipclip.language_preference", "zh-CN");
        return Promise.reject(failureError);
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
        onError,
      });

      expect(controller.getConfirmedPreference()).toBe("system");

      const result = await controller.requestPreference("zh-CN");

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalledWith(failureError, "zh-CN");

      // Storage rolled back to last confirmed preference
      expect(storage.getItem("quipclip.language_preference")).toBe("system");

      // Checked preference rolled back to last confirmed preference
      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");
      expect(onPreferenceChange).toHaveBeenLastCalledWith("system");
    });

    it("invokes custom setStoredPreference callback during rollback", async () => {
      const setStoredPreference = vi.fn();
      const onError = vi.fn();
      const applyPreference = vi.fn().mockRejectedValue(new Error("Network error"));

      const controller = new LanguageMenuController({
        initialPreference: "en",
        setStoredPreference,
        applyPreference,
        onError,
      });

      await controller.requestPreference("zh-CN");

      expect(setStoredPreference).toHaveBeenCalledWith("en");
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("en");
    });
  });

  describe("rapid selections serialization and latest-selection semantics", () => {
    it("handles two rapid selections where both succeed in invocation order", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      const onPreferenceChange = vi.fn();

      const applyCalls: LanguagePreference[] = [];
      const applyPreference = vi.fn().mockImplementation((pref: LanguagePreference) => {
        applyCalls.push(pref);
        if (pref === "zh-CN") {
          return deferred1.promise;
        }
        return deferred2.promise;
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
      });

      // User rapidly selects zh-CN then en
      const p1 = controller.requestPreference("zh-CN");
      const p2 = controller.requestPreference("en");

      // Latest requested choice appears optimistically
      expect(controller.getDisplayedPreference()).toBe("en");
      expect(controller.getLatestRequestedPreference()).toBe("en");
      expect(controller.getPendingCount()).toBe(2);

      await Promise.resolve();

      // Only first task is running
      expect(applyCalls).toEqual(["zh-CN"]);

      // Resolve first task
      deferred1.resolve("zh-CN");
      const res1 = await p1;

      expect(res1).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      // Displayed preference must NOT be overwritten by earlier completed request
      expect(controller.getDisplayedPreference()).toBe("en");
      expect(controller.getPendingCount()).toBe(1);

      await Promise.resolve();

      // Now second task runs
      expect(applyCalls).toEqual(["zh-CN", "en"]);

      // Resolve second task
      deferred2.resolve("en");
      const res2 = await p2;

      expect(res2).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("en");
      expect(controller.getPendingCount()).toBe(0);
    });

    it("handles two rapid selections where the first fails and the second succeeds", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      const onPreferenceChange = vi.fn();
      const onError = vi.fn();

      const applyPreference = vi.fn().mockImplementation((pref: LanguagePreference) => {
        if (pref === "zh-CN") {
          return deferred1.promise;
        }
        return deferred2.promise;
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
        onError,
      });

      const p1 = controller.requestPreference("zh-CN");
      const p2 = controller.requestPreference("en");

      expect(controller.getDisplayedPreference()).toBe("en");

      // Reject first request
      const error1 = new Error("First failed");
      deferred1.reject(error1);
      const res1 = await p1;

      expect(res1).toBe(false);
      expect(onError).toHaveBeenCalledWith(error1, "zh-CN");

      // Because 'zh-CN' is no longer the latest request, displayed preference is NOT rolled back to 'system'
      expect(controller.getDisplayedPreference()).toBe("en");
      expect(controller.getConfirmedPreference()).toBe("system");

      // Resolve second request
      deferred2.resolve("en");
      const res2 = await p2;

      expect(res2).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("en");
      expect(controller.getPendingCount()).toBe(0);
    });

    it("handles two rapid selections where the first succeeds and the second fails", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      const onPreferenceChange = vi.fn();
      const onError = vi.fn();

      const applyPreference = vi.fn().mockImplementation((pref: LanguagePreference) => {
        if (pref === "zh-CN") {
          return deferred1.promise;
        }
        return deferred2.promise;
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
        onError,
      });

      const p1 = controller.requestPreference("zh-CN");
      const p2 = controller.requestPreference("en");

      // First succeeds
      deferred1.resolve("zh-CN");
      await p1;

      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("en");

      // Second fails
      const error2 = new Error("Second failed");
      deferred2.reject(error2);
      const res2 = await p2;

      expect(res2).toBe(false);
      expect(onError).toHaveBeenCalledWith(error2, "en");

      // Rollback restores to the last confirmed preference ('zh-CN', NOT 'system')
      expect(storage.getItem("quipclip.language_preference")).toBe("zh-CN");
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(onPreferenceChange).toHaveBeenLastCalledWith("zh-CN");
    });

    it("handles repeated sequence zh-CN -> en -> zh-CN with first failure and final success without rolling back displayed state", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();
      const deferred3 = createDeferred<string>();
      const onPreferenceChange = vi.fn();
      const onError = vi.fn();

      const applyCalls: LanguagePreference[] = [];
      const applyPreference = vi.fn().mockImplementation((pref: LanguagePreference) => {
        applyCalls.push(pref);
        storage.setItem("quipclip.language_preference", pref);
        if (applyCalls.length === 1) {
          return deferred1.promise;
        }
        if (applyCalls.length === 2) {
          return deferred2.promise;
        }
        return deferred3.promise;
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
        onError,
      });

      // User rapidly selects the exact repeated sequence zh-CN -> en -> zh-CN
      const p1 = controller.requestPreference("zh-CN");
      const p2 = controller.requestPreference("en");
      const p3 = controller.requestPreference("zh-CN");

      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getLatestRequestedPreference()).toBe("zh-CN");
      expect(controller.getPendingCount()).toBe(3);
      expect(onPreferenceChange).toHaveBeenCalledTimes(3);
      expect(onPreferenceChange).toHaveBeenNthCalledWith(1, "zh-CN");
      expect(onPreferenceChange).toHaveBeenNthCalledWith(2, "en");
      expect(onPreferenceChange).toHaveBeenNthCalledWith(3, "zh-CN");

      // Task 1 fails
      const error1 = new Error("First zh-CN request failed");
      deferred1.reject(error1);
      const res1 = await p1;

      expect(res1).toBe(false);
      expect(onError).toHaveBeenCalledWith(error1, "zh-CN");

      // Monotonic request ID ensures displayed state is NOT rolled back to "system",
      // even though the failed request (zh-CN) matches the latest requested value (zh-CN).
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getPendingCount()).toBe(2);

      // Task 2 succeeds
      deferred2.resolve("en");
      const res2 = await p2;

      expect(res2).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getPendingCount()).toBe(1);

      // Task 3 succeeds
      deferred3.resolve("zh-CN");
      const res3 = await p3;

      expect(res3).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getPendingCount()).toBe(0);
      expect(storage.getItem("quipclip.language_preference")).toBe("zh-CN");
    });

    it("continues queue processing after multiple successive rejections", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onError = vi.fn();
      const applyPreference = vi
        .fn()
        .mockRejectedValueOnce(new Error("Fail 1"))
        .mockRejectedValueOnce(new Error("Fail 2"))
        .mockResolvedValueOnce("zh-CN");

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        applyPreference,
        onError,
      });

      const p1 = controller.requestPreference("en");
      const p2 = controller.requestPreference("system");
      const p3 = controller.requestPreference("zh-CN");

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toBe(false);
      expect(r2).toBe(false);
      expect(r3).toBe(true);

      expect(onError).toHaveBeenCalledTimes(2);
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
      expect(controller.getPendingCount()).toBe(0);
    });
  });

  describe("languageChanged event synchronization", () => {
    it("does not overwrite optimistic visual choice when languageChanged fires during pending requests", async () => {
      const deferred = createDeferred<string>();
      const controller = new LanguageMenuController({
        initialPreference: "system",
        applyPreference: () => deferred.promise,
      });

      const requestPromise = controller.requestPreference("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");

      // languageChanged event emitted from runtime while request is in flight
      controller.handleLanguageChanged();

      // Must remain optimistic choice
      expect(controller.getDisplayedPreference()).toBe("zh-CN");

      deferred.resolve("zh-CN");
      await requestPromise;
    });

    it("synchronizes displayed preference from storage when idle, preserving system preference", () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onPreferenceChange = vi.fn();

      const controller = new LanguageMenuController({
        initialPreference: "en",
        storage,
        onPreferenceChange,
      });

      expect(controller.getDisplayedPreference()).toBe("en");

      // Idle external language change
      storage.setItem("quipclip.language_preference", "system");
      controller.handleLanguageChanged();

      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");
      expect(onPreferenceChange).toHaveBeenCalledWith("system");
    });
  });

  describe("lifecycle, activation, and deactivation semantics", () => {
    it("supports symmetric setup -> cleanup -> setup lifecycle and re-enables callbacks", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onPreferenceChange = vi.fn();
      let shouldFail = false;
      const applyPreference = vi.fn().mockImplementation((pref: LanguagePreference) => {
        if (shouldFail) {
          return Promise.reject(new Error("Failed to set preference"));
        }
        return Promise.resolve(pref);
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
        applyPreference,
      });

      // Initial setup (effect mount)
      controller.activate();
      expect(controller.isActive()).toBe(true);

      // Effect cleanup (StrictMode unmount simulation)
      controller.deactivate();
      expect(controller.isActive()).toBe(false);

      // Effect setup replay (StrictMode remount simulation)
      controller.activate();
      expect(controller.isActive()).toBe(true);
      onPreferenceChange.mockClear();

      // Prove later selection updates state
      const res1 = await controller.requestPreference("en");
      expect(res1).toBe(true);
      expect(onPreferenceChange).toHaveBeenCalledWith("en");
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("en");

      // Prove later rollback updates state
      shouldFail = true;
      const res2 = await controller.requestPreference("zh-CN");
      expect(res2).toBe(false);
      expect(onPreferenceChange).toHaveBeenCalledWith("zh-CN"); // optimistic update
      expect(onPreferenceChange).toHaveBeenLastCalledWith("en"); // rollback update
      expect(controller.getConfirmedPreference()).toBe("en");
      expect(controller.getDisplayedPreference()).toBe("en");
    });

    it("suppresses UI callbacks while deactivated and syncs rolled back state on reactivation", async () => {
      const deferred = createDeferred<string>();
      const onPreferenceChange = vi.fn();
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        applyPreference: () => deferred.promise,
        onPreferenceChange,
      });

      controller.activate();

      // Request preference optimistically
      const requestPromise = controller.requestPreference("zh-CN");
      expect(onPreferenceChange).toHaveBeenCalledWith("zh-CN");
      onPreferenceChange.mockClear();

      // Component unmounts: deactivate controller
      controller.deactivate();
      expect(controller.isActive()).toBe(false);

      // Deferred request rejects while deactivated (would trigger rollback callback if active)
      deferred.reject(new Error("Async network failure during unmount"));
      const res = await requestPromise;

      expect(res).toBe(false);
      // Callback must be suppressed because controller is deactivated
      expect(onPreferenceChange).not.toHaveBeenCalled();
      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");

      // Reactivating the controller synchronizes the rolled back displayed state to the UI callback
      controller.activate();
      expect(onPreferenceChange).toHaveBeenCalledWith("system");
    });

    it("suppresses external languageChanged callbacks while deactivated and syncs on activation", () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const onPreferenceChange = vi.fn();

      const controller = new LanguageMenuController({
        initialPreference: "system",
        storage,
        onPreferenceChange,
      });

      controller.activate();
      onPreferenceChange.mockClear();

      // Deactivate (unmount)
      controller.deactivate();
      expect(controller.isActive()).toBe(false);

      // Storage changes externally
      storage.setItem("quipclip.language_preference", "zh-CN");
      controller.handleLanguageChanged();

      // Callback suppressed while deactivated
      expect(onPreferenceChange).not.toHaveBeenCalled();

      // Syncs on activation
      controller.activate();
      expect(onPreferenceChange).toHaveBeenCalledWith("zh-CN");
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");
    });
  });

  describe("edge cases and options", () => {
    it("preserves system preference when explicitly selected", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "en",
      });
      const applyPreference = vi.fn().mockResolvedValue("en");

      const controller = createLanguageMenuController({
        initialPreference: "en",
        storage,
        applyPreference,
      });

      const res = await controller.requestPreference("system");

      expect(res).toBe(true);
      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");
      expect(applyPreference).toHaveBeenCalledWith("system");
    });

    it("ignores invalid preference input without queuing or changing state", async () => {
      const applyPreference = vi.fn();
      const onPreferenceChange = vi.fn();

      const controller = createLanguageMenuController({
        initialPreference: "system",
        applyPreference,
        onPreferenceChange,
      });

      const res = await controller.requestPreference("invalid-locale");

      expect(res).toBe(false);
      expect(controller.getDisplayedPreference()).toBe("system");
      expect(controller.isPending()).toBe(false);
      expect(applyPreference).not.toHaveBeenCalled();
      expect(onPreferenceChange).not.toHaveBeenCalled();
    });
  });

  describe("integration with i18n instance and setLanguagePreference", () => {
    it("updates real i18next instance and storage end-to-end", async () => {
      const storage = createMemoryStorage({
        "quipclip.language_preference": "system",
      });
      const instance = await createI18nInstance({
        initialPreference: "system",
        storage,
        systemLanguages: ["en-US"],
      });

      const onPreferenceChange = vi.fn();
      const controller = new LanguageMenuController({
        instance,
        storage,
        systemLanguages: ["en-US"],
        onPreferenceChange,
      });

      expect(instance.language).toBe("en");
      expect(controller.getConfirmedPreference()).toBe("system");

      // Switch to zh-CN
      const res1 = await controller.requestPreference("zh-CN");
      expect(res1).toBe(true);
      expect(instance.language).toBe("zh-CN");
      expect(storage.getItem("quipclip.language_preference")).toBe("zh-CN");
      expect(controller.getConfirmedPreference()).toBe("zh-CN");
      expect(controller.getDisplayedPreference()).toBe("zh-CN");

      // Switch back to system (which resolves to en)
      const res2 = await controller.requestPreference("system");
      expect(res2).toBe(true);
      expect(instance.language).toBe("en");
      expect(storage.getItem("quipclip.language_preference")).toBe("system");
      expect(controller.getConfirmedPreference()).toBe("system");
      expect(controller.getDisplayedPreference()).toBe("system");
    });
  });
});
