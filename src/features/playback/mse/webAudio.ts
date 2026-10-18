/**
 * The Web Audio output of the scrub cue of a MediaSource source (ADR 046): an `AudioContext`
 * with a gain node that the Mute toggle sets.
 */

import { PCM_SAMPLE_RATE, type CueAudioOutput } from "./pcmCue";

/**
 * Creates the output. The cue calls it at the first pointer or key gesture, or at the first
 * burst, which a drag can request outside a gesture.
 */
export function createWebAudioOutput(muted: boolean): CueAudioOutput {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.value = muted ? 0 : 1;
  gain.connect(context.destination);
  return {
    currentTime: () => context.currentTime,
    play: (samples, when) => {
      // A context that starts outside a user gesture stays suspended until it resumes.
      if (context.state === "suspended") {
        context.resume().catch(() => undefined);
      }
      const buffer = context.createBuffer(
        1,
        Math.max(1, samples.length),
        PCM_SAMPLE_RATE,
      );
      buffer.copyToChannel(samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(gain);
      node.start(when);
      return {
        stop: (at) => {
          try {
            node.stop(at);
          } catch {
            // The node has ended.
          }
        },
      };
    },
    resume: () => {
      if (context.state === "suspended") {
        context.resume().catch(() => undefined);
      }
    },
    setMuted: (value) => {
      gain.gain.value = value ? 0 : 1;
    },
    close: () => {
      context.close().catch(() => undefined);
    },
  };
}
