import { describe, expect, it } from "vitest";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts } from "@/types/project";
import { LoudnessCache, loudnessCacheKey, loudnessIdentity } from "./cache";
import type { LoudnessScope } from "./types";

function scope(overrides: Partial<LoudnessScope> = {}): LoudnessScope {
  return {
    sources: [
      { id: "a", path: "/media/a.mp4", expectedRevision: { size: 10, mtime: 1 } },
      { id: "b", path: "/media/b.mp4", expectedRevision: { size: 20, mtime: 2 } },
    ],
    pieces: [
      { sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts },
      { sourceId: "b", inPts: "100" as Pts, outPts: "900" as Pts },
    ],
    segmentCount: 2,
    preset: createPresetDraft("p", "P"),
    streams: "videoAndAudio",
    effectiveAudio: {},
    ...overrides,
  };
}

describe("the key of a kept measurement (ADR 061)", () => {
  it("is the same for the same audio, whatever the ids of the sources", () => {
    const renamed = scope({
      sources: scope().sources.map((source) => ({ ...source, id: `x${source.id}` })),
      pieces: scope().pieces.map((piece) => ({
        ...piece,
        sourceId: `x${piece.sourceId}`,
      })),
    });
    expect(loudnessCacheKey(renamed)).toBe(loudnessCacheKey(scope()));
  });

  it("changes with each part that decides the audio", () => {
    const base = loudnessCacheKey(scope());
    const preset = scope().preset;
    const changed: LoudnessScope[] = [
      scope({
        sources: [
          { id: "a", path: "/media/a.mp4", expectedRevision: { size: 11, mtime: 1 } },
          scope().sources[1],
        ],
      }),
      scope({ pieces: [...scope().pieces].reverse() }),
      scope({ preset: { ...preset, audioSampleRate: 44_100 } }),
      scope({ preset: { ...preset, audioChannels: "mono" } }),
      scope({ preset: { ...preset, frameRate: { n: 25, d: 1 } } }),
      scope({ streams: "audioOnly" }),
    ];
    for (const other of changed) {
      expect(loudnessCacheKey(other)).not.toBe(base);
    }
    // The encoder, the bitrate and the gain of the preset do not change the measured audio.
    expect(
      loudnessCacheKey(
        scope({ preset: { ...preset, audioBitrate: 96, audioGainTenthsDb: -30 } }),
      ),
    ).toBe(base);
  });

  it("changes with the effective audio stream of a source, not with its override (ADR 070)", () => {
    const preferred = { index: 1, codec: "aac", sampleRate: 48000, channels: 2 };
    const second = { index: 2, codec: "opus", sampleRate: 48000, channels: 1 };
    // Source a with its preferred stream and no override: the key of a result kept before.
    const plain = scope({ effectiveAudio: { a: preferred, b: preferred } });
    const base = loudnessCacheKey(plain);
    // An override of the preferred stream measures the same audio, so it shares the result.
    const samePreferred = scope({
      sources: [{ ...scope().sources[0], audioStream: preferred }, scope().sources[1]],
      effectiveAudio: { a: preferred, b: preferred },
    });
    expect(loudnessCacheKey(samePreferred)).toBe(base);
    expect(loudnessIdentity(samePreferred)).toBe(loudnessIdentity(plain));

    // Another effective stream is another audio.
    const chosen = (stream: typeof second) =>
      scope({
        sources: [{ ...scope().sources[0], audioStream: stream }, scope().sources[1]],
        effectiveAudio: { a: stream, b: preferred },
      });
    const withSecond = loudnessCacheKey(chosen(second));
    expect(withSecond).not.toBeNull();
    expect(withSecond).not.toBe(base);
    expect(loudnessCacheKey(chosen({ ...second, index: 3 }))).not.toBe(withSecond);
    expect(loudnessCacheKey(chosen({ ...second }))).toBe(withSecond);
    expect(loudnessIdentity(chosen(second))).not.toBe(loudnessIdentity(plain));
    // The same stream on the other source is another audio.
    expect(
      loudnessCacheKey(scope({ effectiveAudio: { a: preferred, b: second } })),
    ).not.toBe(withSecond);
  });

  it("ignores the frame rate of an export without video", () => {
    const preset = scope().preset;
    expect(
      loudnessCacheKey(
        scope({
          streams: "audioOnly",
          preset: { ...preset, frameRate: { n: 25, d: 1 } },
        }),
      ),
    ).toBe(loudnessCacheKey(scope({ streams: "audioOnly" })));
  });

  it("keeps how the pieces group into sources", () => {
    // Two pieces of one source, and the same two pieces as two sources of the same file: the
    // export opens one input or two, so the two are not one key.
    const one = scope({
      sources: [scope().sources[0]],
      pieces: [
        { sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts },
        { sourceId: "a", inPts: "9000" as Pts, outPts: "18000" as Pts },
      ],
    });
    const two = scope({
      sources: [scope().sources[0], { ...scope().sources[0], id: "a2" }],
      pieces: [
        { sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts },
        { sourceId: "a2", inPts: "9000" as Pts, outPts: "18000" as Pts },
      ],
    });
    expect(loudnessCacheKey(one)).not.toBe(loudnessCacheKey(two));
  });

  it("reads a frame rate in lowest terms", () => {
    const preset = scope().preset;
    expect(
      loudnessCacheKey(scope({ preset: { ...preset, frameRate: { n: 48, d: 2 } } })),
    ).toBe(
      loudnessCacheKey(scope({ preset: { ...preset, frameRate: { n: 24, d: 1 } } })),
    );
  });

  it("is null for a source with no revision, which the cache must not keep", () => {
    expect(
      loudnessCacheKey(
        scope({ sources: [{ id: "a", path: "/media/a.mp4" }, scope().sources[1]] }),
      ),
    ).toBeNull();
    expect(
      loudnessCacheKey(
        scope({
          sources: [
            { id: "a", path: "/media/a.mp4", expectedRevision: null },
            scope().sources[1],
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("the identity of a measurement (ADR 061)", () => {
  const unrevised = (overrides: Partial<LoudnessScope> = {}) =>
    scope({
      sources: scope().sources.map(({ id, path }) => ({ id, path })),
      ...overrides,
    });

  it("is the cache key when every source has a revision", () => {
    expect(loudnessIdentity(scope())).toBe(loudnessCacheKey(scope()));
  });

  it("reads only what decides the audio when a source has no revision", () => {
    const preset = scope().preset;
    // Another name of the preset, and another frame rate for an export with no video.
    expect(loudnessIdentity(unrevised({ preset: { ...preset, name: "Q" } }))).toBe(
      loudnessIdentity(unrevised()),
    );
    expect(
      loudnessIdentity(
        unrevised({
          streams: "audioOnly",
          preset: { ...preset, frameRate: { n: 25, d: 1 } },
        }),
      ),
    ).toBe(loudnessIdentity(unrevised({ streams: "audioOnly" })));
    // Another rate of the audio is other audio.
    expect(
      loudnessIdentity(unrevised({ preset: { ...preset, audioSampleRate: 44100 } })),
    ).not.toBe(loudnessIdentity(unrevised()));
  });

  it("differs between the same audio with and without revisions", () => {
    // The user accepted a changed file: the step measures the file again.
    expect(loudnessIdentity(unrevised())).not.toBe(loudnessIdentity(scope()));
  });
});

describe("the cache of measurements", () => {
  it("keeps every result for the application run (ADR 061)", () => {
    const cache = new LoudnessCache();
    const values = (lufs: number) => ({ integratedLufs: lufs, truePeakDbtp: null });
    for (let index = 0; index < 500; index += 1) {
      cache.set(String(index), values(-index));
    }
    expect(cache.size).toBe(500);
    expect(cache.get("0")).toEqual(values(-0));
    expect(cache.get("499")).toEqual(values(-499));
    cache.set("0", values(-1));
    expect(cache.get("0")).toEqual(values(-1));
    expect(cache.get("none")).toBeUndefined();
  });
});
