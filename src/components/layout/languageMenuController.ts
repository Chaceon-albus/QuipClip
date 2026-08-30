/**
 * Pure language menu controller and serialized update queue for QuipClip layout.
 *
 * Coordinates optimistic UI updates, strictly serialized async preference changes,
 * error handling with state/storage rollback, and event synchronization.
 */

import {
  DEFAULT_LANGUAGE_PREFERENCE,
  LANGUAGE_PREFERENCES,
  getLanguagePreference,
  setLanguagePreference,
  setStoredPreference,
  type LanguagePreference,
  type PreferenceStorage,
} from "@/i18n";
import type { i18n as I18nInstance } from "i18next";

/**
 * Type guard to safely narrow unknown values to valid LanguagePreference.
 */
export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return (
    typeof value === "string" &&
    (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * Options for configuring a LanguageMenuController instance.
 */
export interface LanguageMenuControllerOptions {
  /**
   * Initial confirmed and displayed preference.
   * Defaults to reading from storage (or DEFAULT_LANGUAGE_PREFERENCE).
   */
  initialPreference?: LanguagePreference;

  /**
   * Target i18next runtime instance.
   */
  instance?: I18nInstance;

  /**
   * Optional custom storage to read and persist language preferences.
   */
  storage?: PreferenceStorage | null;

  /**
   * Optional systemLanguages list for dynamic system locale resolution.
   */
  systemLanguages?: readonly string[] | null;

  /**
   * Callback invoked whenever the visual displayed preference changes.
   */
  onPreferenceChange?: (preference: LanguagePreference) => void;

  /**
   * Custom preference application function.
   * Defaults to calling `setLanguagePreference`.
   */
  applyPreference?: (preference: LanguagePreference) => Promise<unknown>;

  /**
   * Custom function to persist/restore stored preference.
   * Defaults to calling `setStoredPreference`.
   */
  setStoredPreference?: (preference: LanguagePreference) => void;

  /**
   * Custom function to read current stored preference.
   * Defaults to calling `getLanguagePreference`.
   */
  getStoredPreference?: () => LanguagePreference;

  /**
   * Callback for reporting unhandled errors during language change.
   */
  onError?: (error: unknown, requestedPreference: LanguagePreference) => void;
}

/**
 * Controller managing language menu state, optimistic updates, and serialized asynchronous changes.
 */
export class LanguageMenuController {
  private confirmedPreference: LanguagePreference;
  private displayedPreference: LanguagePreference;
  private latestRequestedPreference: LanguagePreference;
  private lastNotifiedPreference: LanguagePreference;
  private latestRequestId = 0;
  private pendingCount = 0;
  private queue: Promise<void> = Promise.resolve();
  private active = true;

  private readonly onPreferenceChange?: (preference: LanguagePreference) => void;
  private readonly applyPreferenceFn: (
    preference: LanguagePreference,
  ) => Promise<unknown>;
  private readonly setStoredPreferenceFn: (preference: LanguagePreference) => void;
  private readonly getStoredPreferenceFn: () => LanguagePreference;
  private readonly onErrorFn: (
    error: unknown,
    requestedPreference: LanguagePreference,
  ) => void;

  constructor(options: LanguageMenuControllerOptions = {}) {
    const storage = options.storage;
    this.getStoredPreferenceFn =
      options.getStoredPreference ?? (() => getLanguagePreference(storage));
    this.setStoredPreferenceFn =
      options.setStoredPreference ??
      ((pref: LanguagePreference) => setStoredPreference(pref, storage));

    const initial =
      options.initialPreference ??
      this.getStoredPreferenceFn() ??
      DEFAULT_LANGUAGE_PREFERENCE;

    this.confirmedPreference = initial;
    this.displayedPreference = initial;
    this.latestRequestedPreference = initial;
    this.lastNotifiedPreference = initial;

    this.onPreferenceChange = options.onPreferenceChange;
    this.applyPreferenceFn =
      options.applyPreference ??
      ((pref: LanguagePreference) =>
        setLanguagePreference(pref, {
          instance: options.instance,
          storage: options.storage,
          systemLanguages: options.systemLanguages,
        }));
    this.onErrorFn =
      options.onError ??
      ((error: unknown) => {
        console.error("Failed to change language preference:", error);
      });
  }

  /**
   * Gets the last successfully confirmed language preference.
   */
  getConfirmedPreference(): LanguagePreference {
    return this.confirmedPreference;
  }

  /**
   * Gets the current visual displayed preference (including optimistic choices).
   */
  getDisplayedPreference(): LanguagePreference {
    return this.displayedPreference;
  }

  /**
   * Gets the latest requested language preference.
   */
  getLatestRequestedPreference(): LanguagePreference {
    return this.latestRequestedPreference;
  }

  /**
   * Gets the number of pending language change requests in the queue.
   */
  getPendingCount(): number {
    return this.pendingCount;
  }

  /**
   * Checks if any language change requests are currently pending.
   */
  isPending(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * Checks whether the controller is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Requests a language preference change.
   *
   * 1. Validates preference.
   * 2. Increments monotonic request token and optimistically updates visual displayed preference immediately.
   * 3. Serializes asynchronous update execution in invocation order.
   * 4. Updates confirmed preference on success.
   * 5. Restores storage and rolls back visual preference on failure (only if still latest request token).
   * 6. Guarantees the returned promise resolves without unhandled rejections and continues queue execution.
   */
  requestPreference(value: unknown): Promise<boolean> {
    if (!isLanguagePreference(value)) {
      return Promise.resolve(false);
    }

    const requestedPreference = value;
    const requestId = ++this.latestRequestId;
    this.latestRequestedPreference = requestedPreference;
    this.updateDisplayedPreference(requestedPreference);

    this.pendingCount++;

    const runTask = async (): Promise<boolean> => {
      try {
        await this.applyPreferenceFn(requestedPreference);
        this.confirmedPreference = requestedPreference;
        return true;
      } catch (error) {
        this.onErrorFn(error, requestedPreference);

        // Restore storage to the last confirmed preference
        try {
          this.setStoredPreferenceFn(this.confirmedPreference);
        } catch {
          // Gracefully ignore storage write failures
        }

        // Restore the checked radio only if that failed request is still the latest request by monotonic ID
        if (this.latestRequestId === requestId) {
          this.updateDisplayedPreference(this.confirmedPreference);
        }

        return false;
      } finally {
        this.pendingCount--;
      }
    };

    const taskPromise = this.queue.then(runTask, runTask);
    this.queue = taskPromise.then(
      () => {},
      () => {},
    );

    return taskPromise;
  }

  /**
   * Handles external `languageChanged` events from i18next.
   *
   * Ignores events while queued requests are pending to prevent overwriting optimistic choices.
   * When idle, synchronizes state from stored preference (preserving 'system').
   */
  handleLanguageChanged(): void {
    if (this.pendingCount > 0) {
      return;
    }

    const stored = this.getStoredPreferenceFn();
    if (isLanguagePreference(stored) && stored !== this.displayedPreference) {
      this.confirmedPreference = stored;
      this.latestRequestedPreference = stored;
      this.latestRequestId++;
      this.updateDisplayedPreference(stored);
    }
  }

  /**
   * Activates the controller, re-enabling UI callbacks and safely synchronizing displayed state.
   */
  activate(): void {
    this.active = true;

    // When idle, ensure displayed and confirmed preferences match current storage
    if (this.pendingCount === 0) {
      const stored = this.getStoredPreferenceFn();
      if (isLanguagePreference(stored) && stored !== this.displayedPreference) {
        this.confirmedPreference = stored;
        this.latestRequestedPreference = stored;
        this.latestRequestId++;
        this.displayedPreference = stored;
      }
    }

    // Safely sync displayed state to UI callback if it diverged while deactivated
    if (this.lastNotifiedPreference !== this.displayedPreference) {
      this.lastNotifiedPreference = this.displayedPreference;
      this.onPreferenceChange?.(this.displayedPreference);
    }
  }

  /**
   * Deactivates the controller to suppress callbacks when the component unmounts.
   */
  deactivate(): void {
    this.active = false;
  }

  /**
   * Disposes / deactivates the controller.
   */
  dispose(): void {
    this.deactivate();
  }

  private updateDisplayedPreference(preference: LanguagePreference): void {
    this.displayedPreference = preference;
    if (this.active) {
      this.lastNotifiedPreference = preference;
      this.onPreferenceChange?.(preference);
    }
  }
}

/**
 * Factory helper to create a LanguageMenuController instance.
 */
export function createLanguageMenuController(
  options: LanguageMenuControllerOptions = {},
): LanguageMenuController {
  return new LanguageMenuController(options);
}
