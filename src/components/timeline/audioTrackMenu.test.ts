import { describe, expect, it } from "vitest";
import { DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import type { AudioProbe, ListedAudioStream } from "@/features/media/types";
import { createI18nInstance } from "@/i18n";
import {
  audioTrackItemText,
  presentAudioTrackMenu,
  type AudioTrackTranslate,
} from "./audioTrackMenu";

function listed(
  index: number,
  overrides: Partial<ListedAudioStream> = {},
): ListedAudioStream {
  return {
    index,
    codec: "aac",
    sampleRate: 48000,
    channels: 2,
    default: false,
    language: null,
    title: null,
    ...overrides,
  };
}

/** A file whose preferred stream is its second audio stream, stream 3. */
const STREAMS = [
  listed(1, { language: "eng", title: "Desktop" }),
  listed(3, { codec: "opus", channels: 1, default: true, language: "jpn" }),
  listed(4, { codec: null, channels: null }),
];
const PREFERRED: AudioProbe = {
  index: 3,
  codec: "opus",
  sampleRate: 48000,
  channels: 1,
};

/** The format names of a Matroska file, which can hold an override. */
const MKV = ["matroska", "webm"];

describe("the Audio Track submenu (ADR 070)", () => {
  it("shows only for a source with two or more audio streams", () => {
    expect(presentAudioTrackMenu(undefined, undefined, "native")).toBeNull();
    expect(
      presentAudioTrackMenu(
        { audio: null, audioStreams: [], formatNames: MKV },
        undefined,
        "native",
      ),
    ).toBeNull();
    expect(
      presentAudioTrackMenu(
        { audio: PREFERRED, audioStreams: [listed(3)], formatNames: MKV },
        undefined,
        "native",
      ),
    ).toBeNull();
    // A probe that a test builds without the list has no submenu either.
    expect(
      presentAudioTrackMenu(
        { audio: PREFERRED, formatNames: MKV },
        undefined,
        "native",
      ),
    ).toBeNull();
  });

  it("shows no submenu for an FLV, however many audio streams ffprobe lists", () => {
    // An FLV has one audio stream for QuipClip, and its readers map it as 0:a:0.
    expect(
      presentAudioTrackMenu(
        { audio: PREFERRED, audioStreams: STREAMS, formatNames: ["flv"] },
        undefined,
        "native",
      ),
    ).toBeNull();
  });

  it("lists every stream in the order of the file, with its number from 1 and its name", () => {
    const menu = presentAudioTrackMenu(
      { audio: PREFERRED, audioStreams: STREAMS, formatNames: MKV },
      undefined,
      "native",
    );
    expect(
      menu?.items.map((item) => [item.stream.index, item.number, item.name]),
    ).toEqual([
      // The title wins over the language, and the language stands in for a missing title.
      [1, 1, "Desktop"],
      [3, 2, "jpn"],
      [4, 3, null],
    ]);
  });

  it("marks the effective stream: the override, else the preferred stream", () => {
    const probe = { audio: PREFERRED, audioStreams: STREAMS, formatNames: MKV };
    expect(presentAudioTrackMenu(probe, undefined, "native")?.checkedIndex).toBe(3);
    expect(
      presentAudioTrackMenu(
        probe,
        { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
        "native",
      )?.checkedIndex,
    ).toBe(1);
  });

  it("shows the note of the preview only for a native source, for each effective stream", () => {
    // The element of a native source plays the track that the web view chooses, also when the
    // effective stream is the preferred one. A MediaSource preview plays the effective stream.
    const probe = { audio: PREFERRED, audioStreams: STREAMS, formatNames: MKV };
    const fourth = { index: 4, codec: null, sampleRate: 48000, channels: null };
    expect(presentAudioTrackMenu(probe, undefined, "native")?.showsPreviewNote).toBe(
      true,
    );
    expect(presentAudioTrackMenu(probe, fourth, "native")?.showsPreviewNote).toBe(true);
    expect(
      presentAudioTrackMenu(probe, undefined, "mediaSource")?.showsPreviewNote,
    ).toBe(false);
    expect(presentAudioTrackMenu(probe, fourth, "mediaSource")?.showsPreviewNote).toBe(
      false,
    );
    // A source with one audio stream has no submenu, so no note, on either path.
    const single = { audio: PREFERRED, audioStreams: [listed(3)], formatNames: MKV };
    expect(presentAudioTrackMenu(single, undefined, "native")).toBeNull();
    expect(presentAudioTrackMenu(single, undefined, "mediaSource")).toBeNull();
  });

  it.each([
    [
      "en",
      [
        "Track 1: Desktop (aac, 2 channels)",
        "Track 2: jpn (opus, 1 channel)",
        "Track 3 (unknown codec)",
      ],
      "Track 2 (aac, 6 channels)",
      "Track 1: Desktop (aac)",
      "Audio Track",
      "The preview can play a different audio track from the one that the export uses.",
    ],
    [
      "zh-CN",
      [
        "音轨 1：Desktop（aac，2 声道）",
        "音轨 2：jpn（opus，1 声道）",
        "音轨 3（未知编解码器）",
      ],
      "音轨 2（aac，6 声道）",
      "音轨 1：Desktop（aac）",
      "音轨",
      "预览播放的音轨可能与导出使用的音轨不同。",
    ],
  ] as const)(
    "gives the text of each item in %s",
    async (language, items, unnamed, namedNoChannels, title, note) => {
      const instance = await createI18nInstance({
        initialPreference: language,
        storage: null,
        systemLanguages: [],
      });
      const t = instance.t as unknown as AudioTrackTranslate;
      const menu = presentAudioTrackMenu(
        { audio: PREFERRED, audioStreams: STREAMS, formatNames: MKV },
        undefined,
        "native",
      );
      expect(menu?.items.map((item) => audioTrackItemText(item, t))).toEqual(items);
      expect(
        audioTrackItemText(
          { stream: listed(9, { channels: 6 }), number: 2, name: null },
          t,
        ),
      ).toBe(unnamed);
      expect(
        audioTrackItemText(
          { stream: listed(9, { channels: null }), number: 1, name: "Desktop" },
          t,
        ),
      ).toBe(namedNoChannels);
      const translate = instance.t as unknown as (key: string) => string;
      expect(translate("timeline.clip.audioTrack")).toBe(title);
      expect(translate("timeline.clip.audioTrackPreviewNote")).toBe(note);
    },
  );

  it("caps the submenu at the height that Radix gives and lets it scroll", () => {
    // A file with many tracks must keep every item and the note reachable.
    const element = DropdownMenuSubContent({}) as {
      props: { className: string };
    };
    const classes = element.props.className.split(" ");
    expect(classes).toContain("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).not.toContain("overflow-hidden");
  });
});
