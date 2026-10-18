import { describe, expect, it } from "vitest";
import {
  Fmp4Error,
  Fmp4Scanner,
  parseFragments,
  parseMovie,
  type Fmp4Box,
} from "./fmp4";
import {
  ascii,
  audioEntry,
  box,
  bytes,
  concat,
  esds,
  fromBase64,
  full,
  i32,
  largeBox,
  trak,
  u32,
  u64,
  visualEntry,
  WINDOW_FTYP,
  WINDOW_MOOF,
  WINDOW_MOOV,
} from "./testSupport";

function codecOf(entry: Uint8Array): string | null {
  const [track] = parseMovie(box("moov", trak(1, "soun", 48000, entry)));
  return track?.codec ?? null;
}

describe("parseMovie", () => {
  it("reads the tracks of a remux window", () => {
    expect(parseMovie(fromBase64(WINDOW_MOOV))).toEqual([
      {
        id: 1,
        kind: "video",
        timescale: 16000,
        codec: "avc1.4d400a",
        defaultDuration: 0,
        defaultFlags: 0,
      },
      {
        id: 2,
        kind: "audio",
        timescale: 48000,
        codec: "mp4a.40.2",
        defaultDuration: 0,
        defaultFlags: 0,
      },
    ]);
  });

  it("builds the HEVC codec string of ISO/IEC 14496-15 annex E", () => {
    // Main profile, level 3.1, the progressive and frame-only constraint flags.
    const hvcC = box(
      "hvcC",
      bytes(0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 93),
      new Uint8Array(10),
    );
    const [hvc1] = parseMovie(
      box("moov", trak(1, "vide", 90000, visualEntry("hvc1", hvcC))),
    );
    expect(hvc1?.codec).toBe("hvc1.1.6.L93.B0");
    // Profile space 1, the high tier, Main 10 with its compatibility flag.
    const highTier = box(
      "hvcC",
      bytes(0x01, 0x62, 0x20, 0x00, 0x00, 0x00, 0x90, 0, 0, 0, 0, 0, 120),
    );
    const [hev1] = parseMovie(
      box("moov", trak(1, "vide", 90000, visualEntry("hev1", highTier))),
    );
    expect(hev1?.codec).toBe("hev1.A2.4.H120.90");
  });

  it("reads each audio codec that a window can carry", () => {
    expect(codecOf(audioEntry("mp4a", esds(0x40, bytes(0x11, 0x90))))).toBe(
      "mp4a.40.2",
    );
    // HE-AAC v2 (object type 29) and an escaped object type (42, USAC).
    expect(codecOf(audioEntry("mp4a", esds(0x40, bytes(0xeb, 0x88))))).toBe(
      "mp4a.40.29",
    );
    expect(codecOf(audioEntry("mp4a", esds(0x40, bytes(0xf9, 0x40))))).toBe(
      "mp4a.40.42",
    );
    expect(codecOf(audioEntry("mp4a", esds(0x6b, null)))).toBe("mp4a.6B");
    expect(codecOf(audioEntry("mp4a", esds(0x40, null)))).toBe("mp4a.40");
    expect(codecOf(audioEntry("Opus"))).toBe("opus");
    expect(codecOf(audioEntry("fLaC"))).toBe("flac");
    expect(codecOf(audioEntry("ac-3"))).toBe("ac-3");
    expect(codecOf(audioEntry("ec-3"))).toBe("ec-3");
  });

  it("gives no codec for an unknown sample entry or a missing configuration", () => {
    expect(codecOf(audioEntry("alaw"))).toBeNull();
    expect(codecOf(audioEntry("mp4a"))).toBeNull();
    const [avc] = parseMovie(box("moov", trak(1, "vide", 1000, visualEntry("avc1"))));
    expect(avc).toMatchObject({ id: 1, kind: "video", timescale: 1000, codec: null });
  });

  it("reads a version 1 track header and media header, and other handlers", () => {
    const moov = box(
      "moov",
      box("mvhd", full(0, 0), new Uint8Array(96)),
      box(
        "trak",
        box("tkhd", full(1, 3), u64(0), u64(0), u32(7), new Uint8Array(80)),
        box(
          "mdia",
          box("mdhd", full(1, 0), u64(0), u64(0), u32(90000), u64(0), u32(0)),
          box("hdlr", full(0, 0), u32(0), ascii("text"), new Uint8Array(13)),
        ),
      ),
    );
    expect(parseMovie(moov)).toEqual([
      {
        id: 7,
        kind: "other",
        timescale: 90000,
        codec: null,
        defaultDuration: 0,
        defaultFlags: null,
      },
    ]);
  });

  it("refuses bytes that are not a whole moov box", () => {
    expect(() => parseMovie(box("moof"))).toThrow(Fmp4Error);
    const moov = fromBase64(WINDOW_MOOV);
    expect(() => parseMovie(moov.subarray(0, moov.byteLength - 1))).toThrow(Fmp4Error);
  });
});

describe("parseFragments", () => {
  it("reads the fragment of each track of a remux window", () => {
    expect(
      parseFragments(fromBase64(WINDOW_MOOF), parseMovie(fromBase64(WINDOW_MOOV))),
    ).toEqual([
      // 1280 / 16000 = 80 ms, the PTS of the first video packet of the FLV. 13 frames of
      // 640 ticks from the default of the tfhd. The first-sample flags mark a sync sample.
      { trackId: 1, decodeTime: 0, presentationTime: 1280, duration: 8320, sync: true },
      // 2832 / 48000 = 59 ms. 22 frames whose durations the trun states.
      {
        trackId: 2,
        decodeTime: 2832,
        presentationTime: 2832,
        duration: 22520,
        sync: true,
      },
    ]);
  });

  it("reads a 32-bit decode time, a negative offset of a version 1 trun, and every field", () => {
    const moof = box(
      "moof",
      box("mfhd", full(0, 0), u32(1)),
      box(
        "traf",
        box("tfhd", full(0, 0x020000), u32(3)),
        box("tfdt", full(0, 0), u32(90000)),
        // data offset, first sample flags, then duration, size, flags and offset per sample.
        box(
          "trun",
          full(1, 0xf05),
          u32(2),
          u32(100),
          u32(0x01010000),
          u32(3000),
          u32(10),
          u32(0),
          i32(-3000),
          u32(3003),
          u32(10),
          u32(0),
          i32(0),
        ),
      ),
      largeBox(
        "traf",
        box("tfhd", full(0, 0), u32(4)),
        box("tfdt", full(1, 0), u64(2 ** 40)),
      ),
    );
    expect(parseFragments(moof)).toEqual([
      {
        trackId: 3,
        decodeTime: 90000,
        presentationTime: 87000,
        duration: 6003,
        sync: false,
      },
      {
        trackId: 4,
        decodeTime: 2 ** 40,
        presentationTime: 2 ** 40,
        duration: null,
        sync: null,
      },
    ]);
  });

  it("takes the defaults of the tfhd, then of the trex", () => {
    const tracks = parseMovie(
      box(
        "moov",
        trak(5, "vide", 1000, visualEntry("avc1")),
        box(
          "mvex",
          box("trex", full(0, 0), u32(5), u32(1), u32(40), u32(0), u32(0x01010000)),
        ),
      ),
    );
    const moof = (tfhd: Uint8Array, trunFlags: number, ...samples: Uint8Array[]) =>
      box(
        "moof",
        box(
          "traf",
          tfhd,
          box("tfdt", full(0, 0), u32(0)),
          box("trun", full(0, trunFlags), u32(3), ...samples),
        ),
      );
    // Only the trex: 3 × 40 ticks, not a sync sample.
    expect(
      parseFragments(moof(box("tfhd", full(0, 0), u32(5)), 0), tracks),
    ).toMatchObject([{ duration: 120, sync: false }]);
    // The tfhd states a duration of 33 and the flags of a sync sample.
    expect(
      parseFragments(
        moof(box("tfhd", full(0, 0x28), u32(5), u32(33), u32(0x02000000)), 0),
        tracks,
      ),
    ).toMatchObject([{ duration: 99, sync: true }]);
    // The flags of the first sample of the trun win.
    expect(
      parseFragments(
        moof(
          box("tfhd", full(0, 0), u32(5)),
          0x400,
          u32(0x02000000),
          u32(0x01010000),
          u32(0),
        ),
        tracks,
      ),
    ).toMatchObject([{ duration: 120, sync: true }]);
  });

  it("refuses a trun that ends inside its samples", () => {
    const moof = box(
      "moof",
      box(
        "traf",
        box("tfhd", full(0, 0), u32(1)),
        box("tfdt", full(0, 0), u32(0)),
        box("trun", full(0, 0x800), u32(1)),
      ),
    );
    expect(() => parseFragments(moof)).toThrow(Fmp4Error);
  });
});

describe("Fmp4Scanner", () => {
  const ftyp = WINDOW_FTYP;
  const moov = fromBase64(WINDOW_MOOV);
  const moof = fromBase64(WINDOW_MOOF);
  const mdat = box("mdat", new Uint8Array(5000).fill(7));
  const empty = box("free");
  const large = largeBox("mdat", new Uint8Array(300));
  const stream = concat(ftyp, moov, moof, mdat, empty, large, moof);

  function scan(pieceSize: number): Fmp4Box[] {
    const scanner = new Fmp4Scanner();
    const found: Fmp4Box[] = [];
    for (let offset = 0; offset < stream.byteLength; offset += pieceSize) {
      found.push(...scanner.push(stream.subarray(offset, offset + pieceSize)));
    }
    return found;
  }

  it.each([1, 7, 16, 1000, 1 << 20])(
    "finds the boxes in pieces of %i bytes",
    (pieceSize) => {
      const found = scan(pieceSize);
      expect(found.map((item) => [item.type, item.offset, item.size])).toEqual([
        ["ftyp", 0, ftyp.byteLength],
        ["moov", ftyp.byteLength, moov.byteLength],
        ["moof", ftyp.byteLength + moov.byteLength, moof.byteLength],
        ["mdat", ftyp.byteLength + moov.byteLength + moof.byteLength, mdat.byteLength],
        [
          "free",
          stream.byteLength - moof.byteLength - large.byteLength - empty.byteLength,
          8,
        ],
        [
          "mdat",
          stream.byteLength - moof.byteLength - large.byteLength,
          large.byteLength,
        ],
        ["moof", stream.byteLength - moof.byteLength, moof.byteLength],
      ]);
      expect(found[0]?.bytes).toEqual(ftyp);
      expect(found[1]?.bytes).toEqual(moov);
      expect(found[2]?.bytes).toEqual(moof);
      expect(found[3]?.bytes).toBeNull();
      expect(found[4]?.bytes).toBeNull();
      expect(found[6]?.bytes).toEqual(moof);
    },
  );

  it("refuses a box whose size is smaller than its header", () => {
    const scanner = new Fmp4Scanner();
    expect(() => scanner.push(concat(u32(4), ascii("moof")))).toThrow(Fmp4Error);
    expect(() => new Fmp4Scanner().push(concat(u32(0), ascii("mdat")))).toThrow(
      Fmp4Error,
    );
  });

  it("refuses a kept box that is too large", () => {
    expect(() =>
      new Fmp4Scanner().push(concat(u32(0x7fffffff), ascii("moov"))),
    ).toThrow(Fmp4Error);
  });
});
