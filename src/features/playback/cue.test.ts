import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubCue, setScrubCue } from "./cue";
import { scrubAudioController } from "./scrubAudio";

describe("the scrub cue router (ADR 019, ADR 046)", () => {
  afterEach(() => {
    setScrubCue(null);
    vi.restoreAllMocks();
  });

  function fakeCue() {
    return { request: vi.fn(), stop: vi.fn() };
  }

  it("sends the requests to the element cue while no other cue is set", () => {
    const request = vi
      .spyOn(scrubAudioController, "request")
      .mockImplementation(() => {});
    const stop = vi.spyOn(scrubAudioController, "stop").mockImplementation(() => {});

    scrubCue.request(2.04, 1);
    scrubCue.request(3, 1, "drag");
    scrubCue.stop();

    expect(request.mock.calls).toEqual([
      [2.04, 1],
      [3, 1, "drag"],
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("sends the requests to the cue of the open source, and stops the element cue", () => {
    const request = vi
      .spyOn(scrubAudioController, "request")
      .mockImplementation(() => {});
    const stop = vi.spyOn(scrubAudioController, "stop").mockImplementation(() => {});
    const cue = fakeCue();

    setScrubCue(cue);
    expect(stop).toHaveBeenCalledTimes(1);

    scrubCue.request(5, -1, "step");
    scrubCue.stop();
    expect(cue.request).toHaveBeenCalledWith(5, -1, "step");
    expect(cue.stop).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("stops the cue of the source when the element cue comes back", () => {
    const request = vi
      .spyOn(scrubAudioController, "request")
      .mockImplementation(() => {});
    vi.spyOn(scrubAudioController, "stop").mockImplementation(() => {});
    const cue = fakeCue();
    setScrubCue(cue);

    setScrubCue(null);
    expect(cue.stop).toHaveBeenCalledTimes(1);
    scrubCue.request(1, 1);
    expect(request).toHaveBeenCalledWith(1, 1);
    expect(cue.request).not.toHaveBeenCalled();
  });

  it("stops the cue that sounded when another cue replaces it", () => {
    vi.spyOn(scrubAudioController, "stop").mockImplementation(() => {});
    const first = fakeCue();
    const second = fakeCue();
    setScrubCue(first);

    setScrubCue(second);
    expect(first.stop).toHaveBeenCalledTimes(1);
    scrubCue.request(1, 1);
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(first.request).not.toHaveBeenCalled();
  });

  it("does nothing when the same cue is set again", () => {
    vi.spyOn(scrubAudioController, "stop").mockImplementation(() => {});
    const cue = fakeCue();
    setScrubCue(cue);

    setScrubCue(cue);
    expect(cue.stop).not.toHaveBeenCalled();
  });
});
