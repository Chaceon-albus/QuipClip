/**
 * Builders of fMP4 boxes and a real remux window, for the tests of the MediaSource preview.
 * Only test files import this module.
 */

/**
 * The `moov` and the first `moof` of a remux window that FFmpeg wrote with the window flags of
 * ADR 046 from a one-second FLV: H.264 Main at level 1.0 on 1/16000 with B-frames, and AAC LC
 * at 48 kHz. The first video packet of the FLV has DTS 0 and PTS 80 ms, and the first audio
 * packet has PTS 59 ms.
 */
export const WINDOW_MOOV =
  "AAAExm1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAA" +
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHq" +
  "dHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAA" +
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAJAAAAAABhm1kaWEAAAAgbWRoZAAAAAAAAAAA" +
  "AAAAAAAAPoAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVy" +
  "AAAAATFtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJs" +
  "IAAAAAEAAADxc3RibAAAAKVzdHNkAAAAAAAAAAEAAACVYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAA" +
  "AABAACQASAAAAEgAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAAC9h" +
  "dmNDAU1ACv/hABhnTUAK7KI/z4CIAAADAAgAAAMBkHiRLLABAARozg/IAAAAEHBhc3AAAAABAAAAAQAA" +
  "ABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAA" +
  "AAAAAAAAAAABv3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAQEA" +
  "AAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAVttZGlhAAAAIG1k" +
  "aGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNv" +
  "dW5kSGFuZGxlcgAAAAEGbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEA" +
  "AAAMdXJsIAAAAAEAAADKc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAA" +
  "AQAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQACAASAgIAXQBUAAAAAAH0AAAB9AAWAgIAFEYhW5QAG" +
  "gICAAQIAAAAUYnRydAAAAAAAAH0AAAB9AAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAA" +
  "FHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAA" +
  "AQAAAAAAAAAAAAAAAAAAACB0cmV4AAAAAAAAAAIAAAABAAAAAAAAAAAAAAAAAAAAYXVkdGEAAABZbWV0" +
  "YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRh" +
  "dGEAAAABAAAAAExhdmY2My4xLjEwMg==";
export const WINDOW_MOOF =
  "AAABzG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAuHRyYWYAAAAcdGZoZAACADgAAAABAAACgAAAByEBAQAA" +
  "AAAAFHRmZHQBAAAAAAAAAAAAAAAAAACAdHJ1bgAACgUAAAANAAAB1AIAAAAAAAchAAAFAAAAADgAAAoA" +
  "AAAACwAAAoAAAAALAAACgAAAAFkAAAoAAAAADQAAAoAAAAAKAAACgAAAAMQAAAoAAAAALQAAAoAAAAAV" +
  "AAACgAAAAIMAAAoAAAAAEgAAAoAAAAAPAAACgAAAAPx0cmFmAAAAHHRmaGQAAgA4AAAAAgAABAAAAACP" +
  "AgAAAAAAABR0ZmR0AQAAAAAAAAAAAAsQAAAAxHRydW4AAAMBAAAAFgAAC10AAAQAAAAAjwAAA/gAAACj" +
  "AAAEAAAAAFcAAAQAAAAAVgAABAAAAABNAAAEAAAAAFsAAAQAAAAAVgAABAAAAABNAAAEAAAAAFsAAAQA" +
  "AAAAVgAABAAAAABNAAAEAAAAAFsAAAQAAAAAVgAABAAAAABNAAAEAAAAAFsAAAQAAAAAVgAABAAAAABN" +
  "AAAEAAAAAFsAAAQAAAAAVgAABAAAAABNAAAEAAAAAFsAAAQAAAAAVg==";

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

export function i32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value);
  return bytes;
}

export function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

export function bytes(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** A box with a 32-bit size. */
export function box(type: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(8 + body.byteLength), ascii(type), body);
}

/** A box with a 64-bit size. */
export function largeBox(type: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(1), ascii(type), u64(16 + body.byteLength), body);
}

/** The version and flags of a full box. */
export function full(version: number, flags: number): Uint8Array {
  return u32(((version & 0xff) << 24) | (flags & 0xffffff));
}

/** A track of a `moov` with one sample entry. */
export function trak(
  id: number,
  handler: string,
  timescale: number,
  entry: Uint8Array,
): Uint8Array {
  return box(
    "trak",
    box("tkhd", full(0, 3), u32(0), u32(0), u32(id), new Uint8Array(68)),
    box(
      "mdia",
      box("mdhd", full(0, 0), u32(0), u32(0), u32(timescale), u32(0), u32(0)),
      box("hdlr", full(0, 0), u32(0), ascii(handler), new Uint8Array(13)),
      box("minf", box("stbl", box("stsd", full(0, 0), u32(1), entry))),
    ),
  );
}

export function visualEntry(type: string, ...inner: readonly Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array(78), ...inner);
}

export function audioEntry(type: string, ...inner: readonly Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array(28), ...inner);
}

/** An `esds` with a decoder configuration of `objectType` and specific information. */
export function esds(objectType: number, specific: Uint8Array | null): Uint8Array {
  const specificDescriptor =
    specific === null
      ? new Uint8Array(0)
      : concat(bytes(0x05, specific.byteLength), specific);
  const config = concat(
    bytes(objectType, 0x15),
    new Uint8Array(11),
    specificDescriptor,
  );
  const configDescriptor = concat(bytes(0x04, config.byteLength), config);
  const es = concat(bytes(0x00, 0x01, 0x00), configDescriptor);
  return box("esds", full(0, 0), bytes(0x03, es.byteLength), es);
}

/** The video part of a test fragment. */
export interface TestVideoRun {
  readonly id: number;
  readonly decodeTime: number;
  /** The duration of each sample in ticks. */
  readonly duration?: number;
  readonly count?: number;
  /** True when the first sample is a keyframe. */
  readonly sync?: boolean;
  /** The composition offset of the first sample. */
  readonly offset?: number;
}

/** The audio part of a test fragment. */
export interface TestAudioRun {
  readonly id: number;
  readonly decodeTime: number;
  readonly duration?: number;
  readonly count?: number;
}

/**
 * The bytes of a `moof` with one video and one audio fragment, as FFmpeg writes them: the
 * default duration in the `tfhd`, and the flags of the first sample in the `trun`.
 */
export function fragment(video: TestVideoRun, audio?: TestAudioRun): Uint8Array {
  const count = video.count ?? 1;
  const samples: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(u32(100), u32(index === 0 ? (video.offset ?? 0) : 0));
  }
  const videoTraf = box(
    "traf",
    box("tfhd", full(0, 0x020008), u32(video.id), u32(video.duration ?? 0)),
    box("tfdt", full(1, 0), u64(video.decodeTime)),
    box(
      "trun",
      full(0, 0xa05),
      u32(count),
      u32(0),
      u32(video.sync === false ? 0x01010000 : 0x02000000),
      ...samples,
    ),
  );
  const audioCount = audio?.count ?? 1;
  const audioTraf =
    audio === undefined
      ? new Uint8Array(0)
      : box(
          "traf",
          box("tfhd", full(0, 0x020008), u32(audio.id), u32(audio.duration ?? 1024)),
          box("tfdt", full(1, 0), u64(audio.decodeTime)),
          box(
            "trun",
            full(0, 0x201),
            u32(audioCount),
            u32(0),
            ...Array.from({ length: audioCount }, () => u32(10)),
          ),
        );
  return box("moof", box("mfhd", full(0, 0), u32(1)), videoTraf, audioTraf);
}

/** An `ftyp` box as FFmpeg writes it for a window. */
export const WINDOW_FTYP = box("ftyp", ascii("isom"), u32(512), ascii("isomiso6"));
