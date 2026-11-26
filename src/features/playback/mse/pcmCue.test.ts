import { describe, expect, it } from "vitest";
import type { ScrubAudioTimers } from "../scrubAudio";
import {
  CHAIN_SECONDS,
  createPcmCue,
  PCM_SAMPLE_RATE,
  START_LEAD_SECONDS,
  type CueAudioOutput,
  type CueVoice,
  type PcmCue,
  type PcmCueOptions,
} from "./pcmCue";
import {
  PreviewWindowError,
  type WindowEnd,
  type WindowListener,
  type WindowOpened,
  type WindowSession,
} from "./windowClient";

/** The source starts at 100 s, so media time 0 is 100 s of the source. */
const START = 100;
/** The context clock when a test starts. */
const NOW = 50;

class FakeVoice implements CueVoice {
  readonly stops: (number | undefined)[] = [];
  constructor(
    readonly samples: Float32Array,
    readonly startedAt: number,
  ) {}
  stop = (when?: number): void => {
    this.stops.push(when);
  };
  /** The first sample of the voice. */
  first(): number {
    return this.samples[0] ?? Number.NaN;
  }
  /** The length of the voice in seconds. */
  seconds(): number {
    return this.samples.length / PCM_SAMPLE_RATE;
  }
  /** The last stop time, or null for a stop at once. */
  lastStop(): number | null {
    const last = this.stops[this.stops.length - 1];
    return last === undefined ? null : last;
  }
}

class FakeOutput implements CueAudioOutput {
  time = NOW;
  gain = 1;
  closed = false;
  resumes = 0;
  voices: FakeVoice[] = [];
  currentTime = (): number => this.time;
  play = (samples: Float32Array<ArrayBuffer>, when: number): CueVoice => {
    const voice = new FakeVoice(samples, when);
    this.voices.push(voice);
    return voice;
  };
  resume = (): void => {
    this.resumes++;
  };
  setGain = (gain: number): void => {
    this.gain = gain;
  };
  close = (): void => {
    this.closed = true;
  };
}

class FakeTimers implements ScrubAudioTimers {
  private next = 1;
  /** The time of the fake clock, in milliseconds since the start of the test. */
  now = 0;
  readonly pending = new Map<
    number,
    { callback: () => void; milliseconds: number; due: number }
  >();
  /** The callback of each timer ever set, also of a cleared one. */
  readonly callbacks = new Map<number, () => void>();
  setTimer = (callback: () => void, milliseconds: number): number => {
    const handle = this.next++;
    this.pending.set(handle, { callback, milliseconds, due: this.now + milliseconds });
    this.callbacks.set(handle, callback);
    return handle;
  };
  clearTimer = (handle: number): void => {
    this.pending.delete(handle);
  };
  /** Runs every timer that waits `milliseconds` or less. */
  run(milliseconds: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.milliseconds <= milliseconds + 1e-6) {
        this.pending.delete(handle);
        timer.callback();
      }
    }
  }
  /**
   * Moves the clock `milliseconds` forward and runs each timer that is due, in the order of
   * its due time. A timer that a callback sets runs too when it is due.
   */
  advance(milliseconds: number): void {
    const end = this.now + milliseconds;
    for (;;) {
      let first: [number, { callback: () => void; due: number }] | null = null;
      for (const entry of this.pending) {
        if (entry[1].due <= end && (first === null || entry[1].due < first[1].due)) {
          first = entry;
        }
      }
      if (first === null) {
        break;
      }
      this.pending.delete(first[0]);
      this.now = first[1].due;
      first[1].callback();
    }
    this.now = end;
  }
}

/** The handles of the timers that turn the cue on again: 3 s each (ADR 064). */
function offTimers(timers: FakeTimers): number[] {
  return [...timers.pending]
    .filter(([, timer]) => timer.milliseconds === 3000)
    .map(([handle]) => handle);
}

let probeKey = 1000;

/**
 * True when the cue plays: PCM of a new window at 100 s, then a request inside it. A cue that
 * is off discards the PCM and plays nothing.
 */
function playsNow(cue: PcmCue, output: FakeOutput): boolean {
  const before = output.voices.length;
  // A burst that sounds would take the request as its continuation.
  cue.stop();
  cue.addPcm(probeKey++, 100, pcm(1));
  cue.request(0.2, 1);
  return output.voices.length > before;
}

/** The end of a PCM window whose audio process failed. */
const FAILED: WindowEnd = {
  status: "failed",
  reachedEnd: false,
  next: null,
  bytesRead: 0,
  nonMonotonic: false,
  damaged: false,
  detail: "Decoder not found",
};

/**
 * PCM of `seconds` in which each sample holds its own index modulo 32768, so a voice shows
 * which sample it starts at.
 */
function pcm(seconds: number, first = 0): Uint8Array {
  const count = Math.round(seconds * PCM_SAMPLE_RATE);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    view.setInt16(index * 2, (first + index) % 32768, true);
  }
  return bytes;
}

/** The float that a voice holds for sample `index` of `pcm`. */
function sampleValue(index: number): number {
  return (index % 32768) / 32768;
}

function setup(options: Partial<PcmCueOptions> = {}) {
  const output = new FakeOutput();
  const timers = new FakeTimers();
  let created = 0;
  const cue = createPcmCue({
    videoStartSeconds: START,
    createOutput: (gain) => {
      created++;
      output.gain = gain;
      return output;
    },
    timers,
    ...options,
  });
  return { cue, output, timers, created: () => created };
}

/** Steps a held key forward: 40 ms of target and of clock each request. */
function hold(
  cue: ReturnType<typeof setup>["cue"],
  output: FakeOutput,
  from: number,
  steps: number,
) {
  let target = from;
  for (let count = 0; count < steps; count++) {
    target += 0.04;
    output.time += 0.04;
    cue.request(target, 1);
  }
  return target;
}

describe("createPcmCue", () => {
  describe("a burst", () => {
    it("plays 50 ms from the sample of the target, a little after the clock", () => {
      const { cue, output, created } = setup();
      cue.addPcm(1, 100, pcm(1));
      expect(created()).toBe(0);

      cue.request(0.25, 1);
      expect(created()).toBe(1);
      const [voice] = output.voices;
      expect(voice?.startedAt).toBeCloseTo(NOW + START_LEAD_SECONDS, 9);
      expect(voice?.first()).toBeCloseTo(sampleValue(12000), 9);
      expect(voice?.lastStop()).toBeCloseTo(NOW + START_LEAD_SECONDS + 0.05, 9);
    });

    it("gives the first voice the burst and the lag limit of the request", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(3));
      cue.request(0.25, 1, "step");
      expect(output.voices[0]?.seconds()).toBeCloseTo(0.8, 9);
      cue.request(1.25, 1, "drag");
      expect(output.voices[1]?.seconds()).toBeCloseTo(0.15, 9);
    });

    it("continues a forward step within the tolerance and the lag limit", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(3));
      cue.request(0.25, 1);
      output.time += 0.04;
      cue.request(0.29, 1);
      expect(output.voices).toHaveLength(1);
      expect(output.voices[0]?.lastStop()).toBeCloseTo(
        NOW + START_LEAD_SECONDS + 0.09,
        9,
      );
    });

    it("starts again for a backward request, a long step, or a drag that falls behind", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(3));
      cue.request(1, 1);
      cue.request(0.96, -1);
      expect(output.voices).toHaveLength(2);
      cue.request(1.2, 1);
      expect(output.voices).toHaveLength(3);

      // The burst plays 1.2 s at the start of its voice. A step to 1.25 s continues it. A drag
      // sample to 1.33 s lies 0.12 s ahead of it, past the lag limit of a drag.
      output.time = NOW + START_LEAD_SECONDS;
      cue.request(1.25, 1, "step");
      expect(output.voices).toHaveLength(3);
      cue.request(1.33, 1, "drag");
      expect(output.voices).toHaveLength(4);
    });

    it("does not continue a burst whose stop is less than 10 ms away", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(3));
      cue.request(1, 1);
      output.time = NOW + START_LEAD_SECONDS + 0.045;
      cue.request(1.04, 1);
      expect(output.voices).toHaveLength(2);
    });
  });

  describe("a held key", () => {
    it("plays on in a new voice that starts where the voice before it ends", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(5));
      cue.request(0, 1);
      hold(cue, output, 0, 20);
      expect(output.voices).toHaveLength(2);
      const [first, second] = output.voices;
      // The first voice holds 0.8 s, and the second one starts there.
      expect(first?.lastStop()).toBeCloseTo(NOW + START_LEAD_SECONDS + 0.8, 9);
      expect(second?.startedAt).toBeCloseTo(NOW + START_LEAD_SECONDS + 0.8, 9);
      expect(second?.first()).toBeCloseTo(sampleValue(0.8 * PCM_SAMPLE_RATE), 9);
      expect(second?.seconds()).toBeCloseTo(CHAIN_SECONDS, 9);
    });

    it("stops every voice of the chain on stop, on a backward request, and in the watchdog", () => {
      const silenced = (voice: FakeVoice | undefined) => voice?.lastStop() === null;
      for (const end of ["stop", "backward", "watchdog"] as const) {
        const { cue, output, timers } = setup();
        cue.addPcm(1, 100, pcm(5));
        cue.request(0, 1);
        const target = hold(cue, output, 0, 20);
        expect(output.voices).toHaveLength(2);
        if (end === "stop") {
          cue.stop();
        } else if (end === "backward") {
          cue.request(target - 0.04, -1);
        } else {
          timers.run(10_000);
        }
        expect(silenced(output.voices[0])).toBe(true);
        expect(silenced(output.voices[1])).toBe(true);
      }
    });

    it("ends with its PCM, and the next request waits for more and starts a new burst", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(0.5));
      cue.request(0.3, 1);
      // The voice holds 0.2 s. A held key reaches past its end, where no PCM follows.
      const target = hold(cue, output, 0.3, 4);
      expect(output.voices).toHaveLength(1);
      expect(output.voices[0]?.lastStop()).toBeCloseTo(
        NOW + START_LEAD_SECONDS + 0.2,
        9,
      );

      // The burst plays 0.495 s, 5 ms before the end of its PCM. It ends there, so the next
      // request does not continue it in silence.
      output.time = NOW + START_LEAD_SECONDS + 0.195;
      cue.request(target + 0.04, 1);
      expect(output.voices).toHaveLength(1);
      cue.addPcm(2, 100.5, pcm(1));
      expect(output.voices).toHaveLength(2);
      expect(output.voices[1]?.startedAt).toBeGreaterThanOrEqual(output.time);
    });

    it("never starts a voice before the clock", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(5));
      cue.request(0, 1);
      const target = hold(cue, output, 0, 18);
      expect(output.voices).toHaveLength(1);
      // The clock moves 100 ms between the check of the continuation and the start of the next
      // voice, past the end of the first voice.
      const read = output.currentTime;
      let reads = 0;
      output.currentTime = () => (reads++ === 0 ? read() : read() + 0.1);
      cue.request(target + 0.04, 1);
      expect(output.voices).toHaveLength(1);
      expect(output.voices[0]?.lastStop()).toBeCloseTo(
        NOW + START_LEAD_SECONDS + 0.8,
        9,
      );
    });

    it("keeps no voice of a long hold that has ended", () => {
      const { cue, output } = setup();
      cue.addPcm(1, 100, pcm(10));
      cue.request(0, 1);
      hold(cue, output, 0, 100);
      expect(output.voices.length).toBeGreaterThan(3);
      cue.stop();
      // Only the voices that could still sound get the stop.
      const stopped = output.voices.filter((voice) => voice.lastStop() === null);
      expect(stopped.length).toBeLessThanOrEqual(2);
    });
  });

  describe("the PCM", () => {
    it("waits for PCM that has not arrived for one burst and 1 s, then drops the request", () => {
      const { cue, output, timers } = setup();
      cue.request(2, 1);
      timers.run(1049);
      cue.addPcm(1, 101.5, pcm(1));
      expect(output.voices).toHaveLength(1);
      expect(output.voices[0]?.first()).toBeCloseTo(sampleValue(24000), 9);

      cue.request(5, 1);
      timers.run(1050);
      cue.addPcm(2, 104.5, pcm(1));
      expect(output.voices).toHaveLength(1);
    });

    it("joins the bytes of a sample across pieces, also across an empty piece", () => {
      const { cue, output } = setup();
      // Sample 0 is 0x8001 (-32767) and sample 1 is 0x7fff (32767), then silence.
      cue.addPcm(1, 100, new Uint8Array([0x01]));
      cue.addPcm(1, 100, new Uint8Array(0));
      cue.addPcm(1, 100, new Uint8Array([0x80, 0xff, 0x7f]));
      cue.addPcm(1, 100, new Uint8Array(PCM_SAMPLE_RATE * 2));
      cue.request(0, 1);
      const data = output.voices[0]?.samples ?? new Float32Array(0);
      expect(data[0]).toBeCloseTo(-32767 / 32768, 9);
      expect(data[1]).toBeCloseTo(32767 / 32768, 9);
      expect(data[2]).toBe(0);
    });

    it("keeps the PCM of the last windows up to its limit, and drops the rest of a dropped one", () => {
      const { cue, output } = setup({ keepSeconds: 2 });
      cue.addPcm(1, 100, pcm(1));
      cue.addPcm(2, 101, pcm(1));
      cue.addPcm(3, 102, pcm(1));
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(0);
      cue.request(2.2, 1);
      expect(output.voices).toHaveLength(1);
      // A late piece of the dropped window does not start a segment at its sample 0.
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(1);
    });

    it("stops and plays nothing until 3 s after a failed audio process", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      cue.endPcm(FAILED);
      expect(output.voices[0]?.lastStop()).toBeNull();
      expect(offTimers(timers)).toHaveLength(1);
      // The cue keeps no request, and it discards the PCM that arrives.
      cue.request(0.5, 1);
      expect(output.voices).toHaveLength(1);
      expect(timers.pending.size).toBe(1);
      cue.addPcm(2, 101, pcm(1));
      cue.request(1.2, 1);
      expect(output.voices).toHaveLength(1);
      cue.prime();
      expect(output.resumes).toBe(0);
      timers.advance(2999);
      expect(playsNow(cue, output)).toBe(false);
      timers.advance(1);
      expect(playsNow(cue, output)).toBe(true);
    });

    it("is on again after 3 s with no PCM, and plays the PCM of a new window", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      cue.endPcm(FAILED);
      timers.advance(3000);
      expect(timers.pending.size).toBe(0);
      // The PCM went. The request waits for PCM, as the request of a new cue does.
      cue.request(0.5, 1);
      expect(output.voices).toHaveLength(1);
      cue.addPcm(3, 100, pcm(1));
      expect(output.voices).toHaveLength(2);
      expect(output.voices[1]?.first()).toBeCloseTo(sampleValue(24000), 9);
    });

    it("discards the later pieces of a window whose PCM went when the cue turned off", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(1));
      cue.endPcm(FAILED);
      timers.advance(3000);
      cue.addPcm(1, 100, pcm(1, PCM_SAMPLE_RATE));
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(0);
    });

    it("discards the later pieces of a window whose first piece arrived while it was off", () => {
      const { cue, output, timers } = setup();
      cue.endPcm(FAILED);
      cue.addPcm(7, 100, pcm(1));
      timers.advance(3000);
      // Without the rule, this piece would start a segment at 100 s, 1 s before its samples.
      cue.addPcm(7, 100, pcm(1, PCM_SAMPLE_RATE));
      cue.request(0.2, 1);
      cue.request(1.2, 1);
      expect(output.voices).toHaveLength(0);
      // A window that the cue did not drop plays.
      cue.addPcm(8, 101, pcm(1));
      expect(output.voices).toHaveLength(1);
    });

    it("starts the 3 s again for a failure while it is off", () => {
      const { cue, output, timers } = setup();
      cue.endPcm(FAILED);
      const [first] = offTimers(timers);
      timers.advance(1000);
      cue.endPcm(FAILED);
      const [second] = offTimers(timers);
      expect(offTimers(timers)).toHaveLength(1);
      expect(second).not.toBe(first);
      // 3.999 s after the first failure, 2.999 s after the second one.
      timers.advance(2999);
      expect(playsNow(cue, output)).toBe(false);
      timers.advance(1);
      expect(playsNow(cue, output)).toBe(true);
    });

    it("ignores the callback of an off timer that a second failure replaced", () => {
      const { cue, output, timers } = setup();
      cue.endPcm(FAILED);
      const [first] = offTimers(timers);
      timers.advance(1000);
      cue.endPcm(FAILED);
      const [second] = offTimers(timers);
      // A timer implementation that runs a cleared callback.
      timers.callbacks.get(first ?? -1)?.();
      expect(playsNow(cue, output)).toBe(false);
      expect(offTimers(timers)).toEqual([second]);
      timers.advance(2999);
      expect(playsNow(cue, output)).toBe(false);
      timers.advance(1);
      expect(playsNow(cue, output)).toBe(true);
    });

    it("stops a burst that waits for PCM when the PCM of its window fails", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(0.01));
      cue.request(0.2, 1);
      expect(timers.pending.size).toBe(1);
      cue.endPcm(FAILED);
      // Only the off timer is left: the request waits no more.
      expect([...timers.pending.values()].map((timer) => timer.milliseconds)).toEqual([
        3000,
      ]);
      timers.advance(3000);
      // The rest of the window goes nowhere, and PCM of a new window plays no old request.
      cue.addPcm(1, 100, pcm(1));
      cue.addPcm(2, 100, pcm(1));
      expect(output.voices).toHaveLength(0);
    });

    it("treats a canceled or a complete end of the PCM as no failure", () => {
      const { cue, output, timers } = setup();
      cue.endPcm({ ...FAILED, status: "canceled", detail: null });
      cue.endPcm({ ...FAILED, status: "complete", detail: null });
      expect(timers.pending.size).toBe(0);
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(1);
    });
  });

  describe("the output", () => {
    it("starts and resumes the context at a gesture", () => {
      const { cue, output, created } = setup();
      cue.prime();
      expect(created()).toBe(1);
      expect(output.resumes).toBe(1);
    });

    it("silences the bursts through the gain node", () => {
      const { cue, output } = setup({ gain: 0 });
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(output.gain).toBe(0);
      cue.setGain(1);
      expect(output.gain).toBe(1);
    });

    it("plays at the full level when no gain is given", () => {
      const { cue, output } = setup();
      output.gain = Number.NaN;
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(output.gain).toBe(1);
    });

    it("sets the level of the bursts, and gives a later output the last level", () => {
      const { cue, output, created } = setup({ gain: 0.5 });
      cue.setGain(0.3);
      expect(created()).toBe(0);
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(created()).toBe(1);
      expect(output.gain).toBe(0.3);
      cue.setGain(0.8);
      expect(output.gain).toBe(0.8);
    });

    it("stops the burst and the wait on stop, and closes everything on destroy", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      cue.stop();
      expect(output.voices[0]?.lastStop()).toBeNull();
      cue.request(3, 1);
      cue.stop();
      expect(timers.pending.size).toBe(0);
      cue.destroy();
      expect(output.closed).toBe(true);
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(1);
    });

    it("never turns on again after destroy", () => {
      const { cue, output, timers } = setup();
      cue.endPcm(FAILED);
      const [handle] = offTimers(timers);
      cue.destroy();
      expect(timers.pending.size).toBe(0);
      // A timer implementation that runs a cleared callback.
      timers.callbacks.get(handle ?? -1)?.();
      cue.endPcm(FAILED);
      expect(timers.pending.size).toBe(0);
      timers.advance(3000);
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      cue.prime();
      expect(output.voices).toHaveLength(0);
      expect(output.resumes).toBe(0);
    });

    it("tries to create the output again 3 s after it could not", () => {
      const output = new FakeOutput();
      const timers = new FakeTimers();
      let attempts = 0;
      const cue = createPcmCue({
        videoStartSeconds: START,
        createOutput: () => {
          attempts++;
          if (attempts === 1) {
            throw new Error("no audio device");
          }
          return output;
        },
        timers,
      });
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      expect(attempts).toBe(1);
      // The cue is off with no output, and it keeps no request.
      expect(offTimers(timers)).toHaveLength(1);
      expect(timers.pending.size).toBe(1);
      cue.prime();
      cue.request(0.2, 1);
      expect(attempts).toBe(1);

      timers.advance(3000);
      cue.prime();
      expect(attempts).toBe(2);
      expect(output.resumes).toBe(1);
      cue.addPcm(2, 100, pcm(1));
      cue.request(0.2, 1);
      expect(output.voices).toHaveLength(1);
    });

    it("lets the next request start a burst after the watchdog", () => {
      const { cue, output, timers } = setup();
      cue.addPcm(1, 100, pcm(1));
      cue.request(0.2, 1);
      timers.run(1059);
      expect(output.voices[0]?.lastStop()).not.toBeNull();
      timers.run(1060);
      expect(output.voices[0]?.lastStop()).toBeNull();
      cue.request(0.24, 1);
      expect(output.voices).toHaveLength(2);
    });
  });

  describe("the PCM windows of MPEG-TS and Matroska", () => {
    function withWindows() {
      const windows: {
        startSeconds: number;
        listener: WindowListener;
        acks: number[];
        closed: boolean;
        open: (opened: Partial<WindowOpened>) => Promise<void>;
        refuse: (error: unknown) => Promise<void>;
      }[] = [];
      const harness = setup({
        openPcmWindow: (startSeconds, listener) => {
          let resolve: (opened: WindowOpened) => void = () => undefined;
          let reject: (error: unknown) => void = () => undefined;
          const opened = new Promise<WindowOpened>((onResolve, onReject) => {
            resolve = onResolve;
            reject = onReject;
          });
          const settle = async () => {
            for (let count = 0; count < 3; count++) {
              await Promise.resolve();
            }
          };
          const record = {
            startSeconds,
            listener,
            acks: [] as number[],
            closed: false,
            open: async (values: Partial<WindowOpened>) => {
              resolve({
                windowId: 1,
                method: null,
                nonMonotonic: false,
                firstKeyframePtsMs: null,
                pcmStartSeconds: null,
                seekSeconds: null,
                ...values,
              });
              await settle();
            },
            refuse: async (error: unknown) => {
              reject(error);
              await settle();
            },
          };
          windows.push(record);
          // A piece that arrives before the request returns.
          listener.onChunk(new Uint8Array(4));
          const session: WindowSession = {
            opened,
            ack: (bytes) => record.acks.push(bytes),
            close: () => {
              record.closed = true;
            },
            isClosed: () => record.closed,
          };
          return session;
        },
      });
      return { ...harness, windows };
    }

    it("requests a window where it holds no PCM, and acknowledges each piece", async () => {
      const { cue, windows, output } = withWindows();
      cue.ensure(30);
      expect(windows.map((window) => window.startSeconds)).toEqual([130]);
      expect(windows[0]?.acks).toEqual([4]);
      const bytes = pcm(1);
      windows[0]?.listener.onChunk(new Uint8Array(bytes));
      expect(windows[0]?.acks).toEqual([4, bytes.byteLength]);

      await windows[0]?.open({ pcmStartSeconds: 125 });
      // The held pieces now lie at 125 s, after the 4 bytes of the first piece.
      cue.request(25.5, 1);
      expect(output.voices).toHaveLength(1);
      expect(output.voices[0]?.first()).toBeCloseTo(sampleValue(24000 - 2), 9);
    });

    it("keeps the running window for a target inside it, and replaces it outside", () => {
      const { cue, windows } = withWindows();
      cue.ensure(30);
      cue.ensure(40);
      expect(windows).toHaveLength(1);
      cue.ensure(60);
      expect(windows).toHaveLength(2);
      expect(windows[0]?.closed).toBe(true);
    });

    it("requests the window of a burst whose PCM has not arrived", async () => {
      const { cue, windows, output } = withWindows();
      cue.request(30, 1);
      expect(windows).toHaveLength(1);
      await windows[0]?.open({ pcmStartSeconds: 129 });
      windows[0]?.listener.onChunk(new Uint8Array(pcm(2)));
      expect(output.voices).toHaveLength(1);
    });

    it("asks for the next window while a held key nears the end of the PCM", async () => {
      const { cue, windows, output } = withWindows();
      cue.ensure(0);
      await windows[0]?.open({ pcmStartSeconds: 100 });
      windows[0]?.listener.onChunk(new Uint8Array(pcm(20)));
      windows[0]?.listener.onEnd({
        status: "complete",
        reachedEnd: false,
        next: null,
        bytesRead: 0,
        nonMonotonic: false,
        damaged: false,
        detail: null,
      });
      cue.request(18.5, 1);
      hold(cue, output, 18.5, 15);
      expect(windows).toHaveLength(2);
      expect(windows[1]?.startSeconds).toBeGreaterThan(119);
    });

    it("turns off for 3 s after a refused window or a window with no start", async () => {
      const refused = withWindows();
      refused.cue.ensure(30);
      await refused.windows[0]?.refuse(new PreviewWindowError("spawnFailed"));
      refused.cue.ensure(80);
      refused.cue.request(80, 1);
      expect(refused.windows).toHaveLength(1);
      expect(offTimers(refused.timers)).toHaveLength(1);
      refused.timers.advance(3000);
      refused.cue.ensure(80);
      expect(refused.windows).toHaveLength(2);

      // A newer window replaced this one, so the cue stays on, and a time inside the range that
      // the replaced window would have covered opens a window again.
      const replaced = withWindows();
      replaced.cue.ensure(30);
      await replaced.windows[0]?.refuse({ code: "superseded" });
      replaced.cue.ensure(35);
      expect(replaced.windows).toHaveLength(2);
      expect(offTimers(replaced.timers)).toHaveLength(0);

      const startless = withWindows();
      startless.cue.ensure(30);
      await startless.windows[0]?.open({ pcmStartSeconds: null });
      startless.cue.ensure(80);
      expect(startless.windows).toHaveLength(1);
      startless.timers.advance(3000);
      startless.cue.ensure(80);
      expect(startless.windows).toHaveLength(2);
    });

    it("opens no window when it is on again, and opens one at the next request", async () => {
      const { cue, windows, output, timers } = withWindows();
      cue.ensure(30);
      await windows[0]?.open({ pcmStartSeconds: 125 });
      windows[0]?.listener.onChunk(new Uint8Array(pcm(10)));
      windows[0]?.listener.onEnd(FAILED);
      expect(windows[0]?.closed).toBe(true);
      timers.advance(3000);
      expect(windows).toHaveLength(1);
      // The PCM and the window went, so a target inside the old window needs a new one.
      cue.request(30, 1);
      expect(output.voices).toHaveLength(0);
      expect(windows.map((window) => window.startSeconds)).toEqual([130, 130]);
      await windows[1]?.open({ pcmStartSeconds: 129 });
      windows[1]?.listener.onChunk(new Uint8Array(pcm(2)));
      expect(output.voices).toHaveLength(1);
    });

    it("stops a burst that waits for PCM when its window fails before the reply", async () => {
      const { cue, windows, output, timers } = withWindows();
      cue.request(30, 1);
      expect(windows).toHaveLength(1);
      expect(timers.pending.size).toBe(1);
      windows[0]?.listener.onEnd(FAILED);
      expect(windows[0]?.closed).toBe(true);
      // Only the off timer is left: the request waits no more.
      expect([...timers.pending.values()].map((timer) => timer.milliseconds)).toEqual([
        3000,
      ]);
      // The reply and the PCM of the closed window arrive late. They play nothing, also after
      // the cue is on again.
      await windows[0]?.open({ pcmStartSeconds: 129 });
      windows[0]?.listener.onChunk(new Uint8Array(pcm(2)));
      expect(output.voices).toHaveLength(0);
      timers.advance(3000);
      windows[0]?.listener.onChunk(new Uint8Array(pcm(2, 2 * PCM_SAMPLE_RATE)));
      expect(output.voices).toHaveLength(0);
      expect(windows).toHaveLength(1);
    });

    it("stays off for the life of its owner after a refusal for a changed file", async () => {
      const { cue, windows, timers } = withWindows();
      cue.ensure(30);
      await windows[0]?.refuse(new PreviewWindowError("sourceChanged"));
      expect(windows[0]?.closed).toBe(true);
      expect(timers.pending.size).toBe(0);
      timers.advance(3000);
      cue.ensure(80);
      expect(windows).toHaveLength(1);
      // A later failure starts no timer.
      cue.endPcm(FAILED);
      expect(timers.pending.size).toBe(0);
    });

    it("ignores a refusal for a changed file of a window that it closed", async () => {
      const { cue, windows, timers } = withWindows();
      cue.ensure(30);
      cue.ensure(60);
      await windows[0]?.refuse(new PreviewWindowError("sourceChanged"));
      expect(timers.pending.size).toBe(0);
      expect(windows[1]?.closed).toBe(false);
      cue.ensure(90);
      expect(windows).toHaveLength(3);
    });

    it("opens no window again near the end of a window that ended normally", async () => {
      const { cue, windows, output } = withWindows();
      cue.ensure(0);
      await windows[0]?.open({ pcmStartSeconds: 95 });
      // The audio of the file ends at 112 s, so the PCM of the window ends there.
      windows[0]?.listener.onChunk(new Uint8Array(pcm(17)));
      windows[0]?.listener.onEnd({
        status: "complete",
        reachedEnd: false,
        next: null,
        bytesRead: 0,
        nonMonotonic: false,
        damaged: false,
        detail: null,
      });
      cue.request(11.5, 1);
      hold(cue, output, 11.5, 10);
      cue.ensure(11.8);
      expect(windows).toHaveLength(1);
    });

    it("stops its window when the audio fails", async () => {
      const { cue, windows } = withWindows();
      cue.ensure(30);
      await windows[0]?.open({ pcmStartSeconds: null });
      expect(windows[0]?.closed).toBe(true);
      cue.ensure(80);
      expect(windows).toHaveLength(1);
    });

    it("opens a window again where a canceled window covered the target", async () => {
      const { cue, windows } = withWindows();
      cue.ensure(30);
      await windows[0]?.open({ pcmStartSeconds: 125 });
      windows[0]?.listener.onEnd({
        status: "canceled",
        reachedEnd: false,
        next: null,
        bytesRead: 0,
        nonMonotonic: false,
        damaged: false,
        detail: null,
      });
      cue.ensure(31);
      expect(windows).toHaveLength(2);
    });

    it("stops its window when the audio output cannot start", async () => {
      const windows: { closed: boolean }[] = [];
      const { cue } = setup({
        createOutput: () => {
          throw new Error("no audio device");
        },
        openPcmWindow: () => {
          const record = { closed: false };
          windows.push(record);
          return {
            opened: new Promise<never>(() => undefined),
            ack: () => undefined,
            close: () => {
              record.closed = true;
            },
            isClosed: () => record.closed,
          };
        },
      });
      cue.ensure(30);
      cue.prime();
      expect(windows[0]?.closed).toBe(true);
      await Promise.resolve();
    });

    it("needs no window where it holds PCM", () => {
      const { cue, windows } = withWindows();
      cue.addPcm(1, 120, pcm(20));
      cue.ensure(25);
      expect(windows).toHaveLength(0);
    });
  });
});
