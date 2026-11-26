/**
 * The envelope controller of the page (ADR 056), on the media store of the page.
 *
 * A source can leave the media store, as at a clear of the timeline. Its job is then canceled
 * and its envelope dropped, so no data of a source that the page no longer holds stays in
 * memory. A change of the effective audio stream of a source ends its job and drops its envelope
 * too (ADR 070).
 */

import { audioOverrideStore } from "@/features/media/audioOverrideStore";
import { sourcesWithChangedEffectiveStream } from "@/features/media/audioStream";
import { mediaStore } from "@/features/media/store";
import { createWaveformController } from "./controller";
import { waveformData } from "./data";
import { waveformStore } from "./store";

export const waveformController = createWaveformController({ mediaStore });

mediaStore.subscribe((state, previous) => {
  if (state.sources === previous.sources) {
    return;
  }
  const known = new Set([
    ...waveformData.sourceIds(),
    ...Object.keys(waveformStore.getState().sources),
  ]);
  for (const sourceId of known) {
    if (state.sources[sourceId] === undefined) {
      // A running job ends canceled, which drops its data. A source that does not run drops
      // its data at once.
      waveformController.cancel(sourceId);
      waveformController.hide(sourceId);
    }
  }
});

// ADR 070: a change of the effective audio stream of a source ends its job and removes its
// envelope, which belong to the old stream. A new override of the stream that was already
// effective changes nothing.
audioOverrideStore.subscribe((state, previous) => {
  if (state.overrides === previous.overrides) {
    return;
  }
  const probes = Object.fromEntries(
    Object.entries(mediaStore.getState().sources).map(([id, media]) => [
      id,
      media.probe,
    ]),
  );
  for (const sourceId of sourcesWithChangedEffectiveStream(
    probes,
    previous.overrides,
    state.overrides,
  )) {
    waveformController.streamChanged(sourceId);
  }
});
