/**
 * The envelopes of this application run, by generated source ID (ADR 056).
 *
 * The codes live outside React and Zustand: a write raises `version` and calls the listeners,
 * and the canvas reads the buffers when it draws. A write therefore never renders React again.
 * Nothing here goes into the project file, the settings file, the undo stack or web view
 * storage.
 */

import { WaveformBuffer } from "./buffer";

export type WaveformDataListener = () => void;

export interface WaveformDataRegistry {
  /** The envelope of a source, or undefined when the page holds none. */
  get(sourceId: string): WaveformBuffer | undefined;
  /** Gives the source a new empty envelope, in place of the one it had. */
  reset(sourceId: string): WaveformBuffer;
  /**
   * Writes pairs into the envelope of a source. Returns false when the source holds no envelope
   * or the buffer refused the write.
   */
  write(sourceId: string, startBucket: number, pairs: Uint8Array): boolean;
  /** Drops the envelope of a source. */
  drop(sourceId: string): void;
  /** The IDs of the sources that hold an envelope. */
  sourceIds(): string[];
  /** Rises at each change. */
  version(): number;
  /** Calls `listener` after each change. Returns the function that stops it. */
  subscribe(listener: WaveformDataListener): () => void;
}

export function createWaveformDataRegistry(
  createBuffer: () => WaveformBuffer = () => new WaveformBuffer(),
): WaveformDataRegistry {
  const buffers = new Map<string, WaveformBuffer>();
  const listeners = new Set<WaveformDataListener>();
  let version = 0;

  const changed = (): void => {
    version += 1;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    get: (sourceId) => buffers.get(sourceId),
    reset: (sourceId) => {
      const buffer = createBuffer();
      buffers.set(sourceId, buffer);
      changed();
      return buffer;
    },
    write: (sourceId, startBucket, pairs) => {
      const buffer = buffers.get(sourceId);
      if (buffer === undefined || !buffer.write(startBucket, pairs)) {
        return false;
      }
      changed();
      return true;
    },
    drop: (sourceId) => {
      if (buffers.delete(sourceId)) {
        changed();
      }
    },
    sourceIds: () => [...buffers.keys()],
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The envelopes of this page. */
export const waveformData: WaveformDataRegistry = createWaveformDataRegistry();
