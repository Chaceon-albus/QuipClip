import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaStore, mediaStore } from "@/features/media/store";
import type { AudioProbe, ImportMediaResult } from "@/features/media/types";
import { PRESET_CONTAINERS } from "@/features/settings/types";
import type { FrameCount, Pts, TickCount } from "@/types/project";
import {
  BOTH_EXPORT_STREAMS,
  bindStreamChoiceToMedia,
  createExportStreamChoiceStore,
  exportOutputExtension,
  exportStreamChoiceStore,
  resolveExportStreams,
  sourceHasAudio,
  type ExportStreamChoice,
} from "./streamChoice";
import { EXPORT_STREAMS } from "./types";

const STEREO: AudioProbe = { index: 1, codec: "aac", sampleRate: 48000, channels: 2 };

function createMediaResult(
  fileName: string,
  audio: AudioProbe | null,
): ImportMediaResult {
  return {
    path: `/media/${fileName}`,
    fileName,
    size: 1048576,
    mtime: 1724976000,
    probe: {
      formatNames: ["mov", "mp4"],
      formatLongName: "QuickTime / MOV",
      formatStartTime: null,
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      bitDepth: 8,
      width: 1920,
      height: 1080,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 90000 },
      videoStartPts: "0" as Pts,
      videoDurationTicks: "900000" as TickCount,
      approximateDurationSeconds: 10.0,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300" as FrameCount,
      audio,
    },
  };
}

const VIDEO_ONLY: ExportStreamChoice = { video: true, audio: false };
const AUDIO_ONLY: ExportStreamChoice = { video: false, audio: true };
const NEITHER: ExportStreamChoice = { video: false, audio: false };

describe("sourceHasAudio", () => {
  it("is true for a probe with an audio stream, and false for a probe without one", () => {
    expect(sourceHasAudio({ audio: STEREO })).toBe(true);
    expect(sourceHasAudio({ audio: null })).toBe(false);
  });

  it("is true with no source, because nothing says that the audio is missing", () => {
    expect(sourceHasAudio(null)).toBe(true);
  });
});

describe("resolveExportStreams", () => {
  it.each([
    [BOTH_EXPORT_STREAMS, "videoAndAudio"],
    [VIDEO_ONLY, "videoOnly"],
    [AUDIO_ONLY, "audioOnly"],
    // The store never holds this choice. It still names one stream.
    [NEITHER, "videoOnly"],
  ] as const)("gives %o for a source with audio as %s", (choice, streams) => {
    expect(resolveExportStreams(choice, true)).toBe(streams);
  });

  it.each([BOTH_EXPORT_STREAMS, VIDEO_ONLY, AUDIO_ONLY, NEITHER])(
    "gives the video only for a source with no audio, whatever the choice (%o)",
    (choice) => {
      expect(resolveExportStreams(choice, false)).toBe("videoOnly");
    },
  );

  it("names a value of the wire contract for every input", () => {
    for (const choice of [BOTH_EXPORT_STREAMS, VIDEO_ONLY, AUDIO_ONLY, NEITHER]) {
      for (const hasAudio of [true, false]) {
        expect(EXPORT_STREAMS).toContain(resolveExportStreams(choice, hasAudio));
      }
    }
  });
});

describe("exportOutputExtension", () => {
  it.each([
    ["mp4", "videoAndAudio", "mp4"],
    ["mov", "videoAndAudio", "mov"],
    ["mkv", "videoAndAudio", "mkv"],
    ["mp4", "videoOnly", "mp4"],
    ["mov", "videoOnly", "mov"],
    ["mkv", "videoOnly", "mkv"],
    ["mp4", "audioOnly", "m4a"],
    ["mov", "audioOnly", "m4a"],
    ["mkv", "audioOnly", "mka"],
  ] as const)(
    "gives a %s preset with %s the extension %s",
    (container, streams, ext) => {
      expect(exportOutputExtension(container, streams)).toBe(ext);
    },
  );

  it("covers every container", () => {
    for (const container of PRESET_CONTAINERS) {
      expect(exportOutputExtension(container, "audioOnly")).toMatch(/^m4a$|^mka$/);
    }
  });
});

describe("createExportStreamChoiceStore", () => {
  it("starts with both streams on", () => {
    expect(createExportStreamChoiceStore().getState().choice).toStrictEqual({
      video: true,
      audio: true,
    });
  });

  it("turns one stream off and on again", () => {
    const store = createExportStreamChoiceStore();
    store.getState().setStream("audio", false);
    expect(store.getState().choice).toStrictEqual(VIDEO_ONLY);
    store.getState().setStream("audio", true);
    expect(store.getState().choice).toStrictEqual(BOTH_EXPORT_STREAMS);
    store.getState().setStream("video", false);
    expect(store.getState().choice).toStrictEqual(AUDIO_ONLY);
  });

  it("keeps the last stream that is on", () => {
    const store = createExportStreamChoiceStore();
    store.getState().setStream("video", false);
    store.getState().setStream("audio", false);
    expect(store.getState().choice).toStrictEqual(AUDIO_ONLY);

    store.getState().setStream("video", true);
    store.getState().setStream("audio", false);
    store.getState().setStream("video", false);
    expect(store.getState().choice).toStrictEqual(VIDEO_ONLY);
  });

  it("notifies no listener for a change that changes nothing", () => {
    const store = createExportStreamChoiceStore(VIDEO_ONLY);
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().setStream("video", true);
    store.getState().setStream("audio", false);
    store.getState().setStream("video", false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("turns both streams on at a reset", () => {
    const store = createExportStreamChoiceStore(AUDIO_ONLY);
    store.getState().reset();
    expect(store.getState().choice).toStrictEqual(BOTH_EXPORT_STREAMS);
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().reset();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("bindStreamChoiceToMedia", () => {
  it("turns both streams on when another file opens", async () => {
    const media = createMediaStore({
      importMedia: (path) =>
        Promise.resolve(createMediaResult(path.split("/").pop() ?? path, STEREO)),
    });
    const choice = createExportStreamChoiceStore();
    bindStreamChoiceToMedia(media, choice);

    await media.getState().importPath("/media/first.mp4");
    choice.getState().setStream("video", false);
    expect(choice.getState().choice).toStrictEqual(AUDIO_ONLY);

    await media.getState().importPath("/media/second.mp4");
    expect(choice.getState().choice).toStrictEqual(BOTH_EXPORT_STREAMS);
  });

  it("turns both streams on when the same file opens again, and when the media closes", async () => {
    const media = createMediaStore({
      importMedia: () => Promise.resolve(createMediaResult("clip.mp4", STEREO)),
    });
    const choice = createExportStreamChoiceStore();
    bindStreamChoiceToMedia(media, choice);

    await media.getState().importPath("/media/clip.mp4");
    choice.getState().setStream("audio", false);
    await media.getState().importPath("/media/clip.mp4");
    expect(choice.getState().choice).toStrictEqual(BOTH_EXPORT_STREAMS);

    choice.getState().setStream("audio", false);
    media.getState().reset();
    expect(choice.getState().choice).toStrictEqual(BOTH_EXPORT_STREAMS);
  });

  it("keeps the choice while the same media stays open", async () => {
    let fail = false;
    const media = createMediaStore({
      importMedia: () =>
        fail
          ? Promise.reject(new Error("unreadable"))
          : Promise.resolve(createMediaResult("clip.mp4", STEREO)),
    });
    const choice = createExportStreamChoiceStore();
    bindStreamChoiceToMedia(media, choice);

    await media.getState().importPath("/media/clip.mp4");
    choice.getState().setStream("video", false);

    // A failed import keeps the open media, and so do the loading state and the error.
    fail = true;
    await media.getState().importPath("/media/broken.mp4");
    media.getState().dismissError();
    expect(media.getState().media?.fileName).toBe("clip.mp4");
    expect(choice.getState().choice).toStrictEqual(AUDIO_ONLY);
  });

  it("stops at the function that it returns", async () => {
    const media = createMediaStore({
      importMedia: () => Promise.resolve(createMediaResult("clip.mp4", null)),
    });
    const choice = createExportStreamChoiceStore(AUDIO_ONLY);
    const unbind = bindStreamChoiceToMedia(media, choice);
    unbind();

    await media.getState().importPath("/media/clip.mp4");
    expect(choice.getState().choice).toStrictEqual(AUDIO_ONLY);
  });
});

describe("the application stores", () => {
  afterEach(() => {
    mediaStore.getState().reset();
    exportStreamChoiceStore.getState().reset();
  });

  it("bind the stream choice to the open media for the session", () => {
    mediaStore.setState({ media: createMediaResult("first.mp4", STEREO) });
    exportStreamChoiceStore.getState().setStream("audio", false);
    expect(exportStreamChoiceStore.getState().choice).toStrictEqual(VIDEO_ONLY);

    mediaStore.setState({ media: createMediaResult("second.mp4", STEREO) });
    expect(exportStreamChoiceStore.getState().choice).toStrictEqual(
      BOTH_EXPORT_STREAMS,
    );
  });
});
