/**
 * The scrub cue that the playback store asks for (ADR 019, ADR 046).
 *
 * A native source plays its cue through the hidden `<audio>` element of `scrubAudio.ts`. A source
 * that plays through a MediaSource has no such element: its cue plays PCM through Web Audio,
 * because WebKit starts the media clock of a MediaSource element 210 to 250 ms after `play()`.
 * The preview chooses the cue for each source, and the store always talks to this router, so it
 * needs to know nothing about the decoder.
 */

import { scrubAudioController, type ScrubAudioRequestKind } from "./scrubAudio";

/** What the store asks of a cue. */
export interface ScrubCue {
  request: (
    targetSeconds: number,
    direction: 1 | -1,
    kind?: ScrubAudioRequestKind,
  ) => void;
  stop: () => void;
}

/** The cue of the open source, or null for the element cue of a native source. */
let activeCue: ScrubCue | null = null;

function current(): ScrubCue {
  return activeCue ?? scrubAudioController;
}

/**
 * Make `cue` the cue of the open source, or the element cue when `cue` is null. The cue that
 * sounded before stops, so two cues never sound together. The router does not know the
 * sources, so the preview clears a cue when its source closes.
 */
export function setScrubCue(cue: ScrubCue | null): void {
  if (cue === activeCue) {
    return;
  }
  current().stop();
  activeCue = cue;
}

/** The router that the store calls. It passes the arguments on as they came. */
export const scrubCue: ScrubCue = {
  request: (...args) => {
    current().request(...args);
  },
  stop: () => {
    current().stop();
  },
};
