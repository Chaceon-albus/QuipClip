/**
 * The Gain field of the Adjust switch and the measurement that fills it, outside React (ADR 061).
 *
 * `follow` takes the scope of the export while the switch is active, and null while it is not.
 * A scope with a new identity starts a request: the measurement store measures it, or answers
 * from its kept results, and the field shows the gain of the selected preset until the
 * measurement of that request completes. Then the field holds the gain that brings the true peak
 * to -1.0 dBTP, until the user types another value. After a failure, the field shows the gain of
 * the selected preset. Null stops the measurement and forgets the request.
 *
 * The state names the request that it follows. A render that names another request, such as the
 * first render after the scope changed and before the effect calls `follow`, sees no result
 * yet, so the export waits (`presentGainAdjust`).
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  loudnessRequestId,
  type LoudnessMeasurement,
  type LoudnessStoreState,
} from "@/features/loudness/store";
import type { LoudnessScope } from "@/features/loudness/types";
import { filledFieldText, gainFieldText } from "./loudnessAdjustPresenter";

export type GainAdjustState = {
  /** The identity of the request that the field follows, or null while the switch is not active. */
  readonly request: string | null;
  /** The first generation of the measurement store that answers the request. */
  readonly awaited: number | null;
  /**
   * The text that the measurement filled or the user typed for the request, or null: the field
   * shows the gain of the selected preset.
   */
  readonly text: string | null;
  /** The generation that filled the field last. */
  readonly filled: number | null;
};

export interface GainAdjust {
  readonly store: StoreApi<GainAdjustState>;
  /** Follow the scope of the export, or nothing. A scope of the same identity changes nothing. */
  follow(scope: LoudnessScope | null): void;
  /** The user types `text` in the field. */
  type(text: string): void;
}

export function createGainAdjust(loudness: StoreApi<LoudnessStoreState>): GainAdjust {
  const store = createStore<GainAdjustState>()(() => ({
    request: null,
    awaited: null,
    text: null,
    filled: null,
  }));

  // Fill the field when the measurement of the request completes, once for each generation. A
  // complete state of an earlier request has a lower generation, so it fills nothing. A state
  // that the store publishes again does not overwrite a value that the user typed.
  const fill = (measurement: LoudnessMeasurement): void => {
    const { request, awaited, filled } = store.getState();
    if (
      request === null ||
      awaited === null ||
      measurement.status !== "complete" ||
      measurement.generation < awaited ||
      measurement.generation === filled
    ) {
      return;
    }
    store.setState({
      filled: measurement.generation,
      text: filledFieldText(measurement),
    });
  };
  // The field follows the measurement store for the life of both stores.
  loudness.subscribe((state) => {
    fill(state.measurement);
  });

  return {
    store,
    follow(scope) {
      const request = scope === null ? null : loudnessRequestId(scope);
      if (request === store.getState().request) {
        return;
      }
      // A new request, or none. A value that the user typed for another request does not stay.
      store.setState({ request, awaited: null, text: null, filled: null });
      if (scope === null) {
        if (loudness.getState().measurement.status !== "idle") {
          loudness.getState().stop();
        }
        return;
      }
      loudness.getState().measure(scope);
      const measurement = loudness.getState().measurement;
      store.setState({ awaited: measurement.generation });
      // A kept result answers inside `measure`, before the field awaited it.
      fill(measurement);
    },
    type(text) {
      if (store.getState().request !== null) {
        store.setState({ text });
      }
    },
  };
}

/** What the setup step shows for the Adjust switch, and whether the export waits. */
export type GainAdjustView = {
  /** The text of the Gain field. */
  readonly fieldText: string;
  /** The measurement of the request, as the step shows it. Idle while there is no request. */
  readonly measurement: LoudnessMeasurement;
  /** True until the measurement of the request ends: the export waits for it. */
  readonly pending: boolean;
};

/**
 * The view of the Adjust switch for the request that the render names (`request`, null while the
 * switch is not active), from the state of `createGainAdjust` and of the measurement store.
 */
export function presentGainAdjust(
  state: GainAdjustState,
  measurement: LoudnessMeasurement,
  request: string | null,
  presetGainTenths: number,
): GainAdjustView {
  const presetText = gainFieldText(presetGainTenths);
  if (request === null) {
    return {
      fieldText: presetText,
      measurement: { status: "idle", generation: measurement.generation },
      pending: false,
    };
  }
  const answers =
    state.request === request &&
    state.awaited !== null &&
    measurement.generation >= state.awaited;
  if (!answers) {
    // The state follows another request, or the measurement of this one has not started.
    return {
      fieldText: presetText,
      measurement: {
        status: "measuring",
        generation: measurement.generation,
        progress: null,
      },
      pending: true,
    };
  }
  return {
    fieldText: state.text ?? presetText,
    measurement,
    // An idle state here is a cancel that the page did not ask for, as at the exit: the
    // measurement ended with no result, the step shows no line, and the field keeps its gain.
    pending: measurement.status === "measuring",
  };
}
