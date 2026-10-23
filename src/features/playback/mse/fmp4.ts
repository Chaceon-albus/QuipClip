/**
 * The parts of fragmented MP4 that the MediaSource preview reads (ADR 046).
 *
 * A remux window is an fMP4 stream: `ftyp`, `moov`, then `moof` and `mdat` pairs. The page needs
 * the codec strings of the `moov` to create its SourceBuffer, the time of the first sample of
 * the first `moof` for the self-check of the calibration, and the presentation time of each video
 * sample for the frame step (ADR 022). Everything else goes to the SourceBuffer as it comes.
 */

/** The kind of a track, from the handler of its media. */
export type Fmp4TrackKind = "video" | "audio" | "other";

/** A track of an init segment. */
export interface Fmp4Track {
  readonly id: number;
  readonly kind: Fmp4TrackKind;
  /** The ticks of one second in the timestamps of the track (`mdhd`). */
  readonly timescale: number;
  /**
   * The codec string of RFC 6381 for `MediaSource.isTypeSupported`, such as `avc1.64001f` or
   * `mp4a.40.2`, or null when the sample entry is one that the preview does not know.
   */
  readonly codec: string | null;
  /** The default sample duration of the fragments of the track (`trex`), or 0. */
  readonly defaultDuration: number;
  /** The default sample flags of the fragments of the track (`trex`), or null. */
  readonly defaultFlags: number | null;
}

/** The fragment of one track in a `moof`. */
export interface Fmp4Fragment {
  readonly trackId: number;
  /** The decode time of the first sample, in ticks of the track (`tfdt`). */
  readonly decodeTime: number;
  /** The presentation time of the first sample: the decode time and its composition offset. */
  readonly presentationTime: number;
  /** The sum of the sample durations in ticks, or null when the boxes state none. */
  readonly duration: number | null;
  /** True when the first sample is a sync sample, or null when no flags state it. */
  readonly sync: boolean | null;
  /**
   * The presentation time of each sample in ticks, in the order of the samples, or null when the
   * boxes state no duration for a sample that another sample follows.
   */
  readonly presentationTimes: readonly number[] | null;
}

/** The sample flag that marks a sample that is not a sync sample (ISO/IEC 14496-12 8.8.3). */
const NON_SYNC_SAMPLE = 0x00010000;

/** The largest box whose bytes the scanner keeps. A `moov` or a `moof` is much smaller. */
export const MAX_KEPT_BOX_BYTES = 16 * 1024 * 1024;

/** A top-level box that the scanner found complete. */
export interface Fmp4Box {
  readonly type: string;
  /** The offset of the box in the stream. */
  readonly offset: number;
  readonly size: number;
  /** The whole box, for `ftyp`, `moov` and `moof`. Null for every other box. */
  readonly bytes: Uint8Array | null;
}

/** The boxes whose bytes the scanner keeps. */
const KEPT_BOXES = new Set(["ftyp", "moov", "moof"]);

/** A box inside a parent, as offsets into the bytes of the parent. */
interface ChildBox {
  readonly type: string;
  /** The offset of the body, after the header. */
  readonly start: number;
  readonly end: number;
}

/** An error in the structure of a box. */
export class Fmp4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fmp4Error";
  }
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Reads a 64-bit unsigned value, which must be a safe integer. */
function readUint64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Fmp4Error("A 64-bit value is too large.");
  }
  return Number(value);
}

/** The boxes between `start` and `end` of `bytes`. */
function children(bytes: Uint8Array, start: number, end: number): ChildBox[] {
  const data = view(bytes);
  const boxes: ChildBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = data.getUint32(offset);
    const type = fourCc(bytes, offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        throw new Fmp4Error(`The box ${type} is truncated.`);
      }
      size = readUint64(data, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      throw new Fmp4Error(`The box ${type} is truncated.`);
    }
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function child(bytes: Uint8Array, parent: ChildBox, type: string): ChildBox | null {
  return (
    children(bytes, parent.start, parent.end).find((box) => box.type === type) ?? null
  );
}

function requireBody(box: ChildBox, length: number): void {
  if (box.end - box.start < length) {
    throw new Fmp4Error(`The box ${box.type} is too short.`);
  }
}

/** The whole box at the start of `bytes`, as a child box. */
function rootBox(bytes: Uint8Array, type: string): ChildBox {
  const [box] = children(bytes, 0, bytes.byteLength);
  if (box === undefined || box.type !== type) {
    throw new Fmp4Error(`The bytes do not hold a ${type} box.`);
  }
  return box;
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** `avc1.PPCCLL` from the `avcC` record. */
function avcCodec(entryType: string, bytes: Uint8Array, avcC: ChildBox): string {
  requireBody(avcC, 4);
  const profile = bytes[avcC.start + 1] ?? 0;
  const constraints = bytes[avcC.start + 2] ?? 0;
  const level = bytes[avcC.start + 3] ?? 0;
  return `${entryType}.${hex2(profile)}${hex2(constraints)}${hex2(level)}`;
}

/** The bits of a 32-bit value in reverse order. */
function reverseBits32(value: number): number {
  let result = 0;
  for (let bit = 0; bit < 32; bit++) {
    result = (result << 1) | ((value >>> bit) & 1);
  }
  return result >>> 0;
}

/**
 * `hvc1.A.B.C.D` from the `hvcC` record (ISO/IEC 14496-15 annex E): the profile space and
 * profile, the compatibility flags in reverse bit order, the tier and level, and the constraint
 * bytes without the trailing zero bytes.
 */
function hevcCodec(entryType: string, bytes: Uint8Array, hvcC: ChildBox): string {
  requireBody(hvcC, 13);
  const data = view(bytes);
  const first = bytes[hvcC.start + 1] ?? 0;
  const space = ["", "A", "B", "C"][first >> 6] ?? "";
  const tier = (first >> 5) & 1 ? "H" : "L";
  const profile = first & 0x1f;
  const compatibility = reverseBits32(data.getUint32(hvcC.start + 2)).toString(16);
  const constraints = Array.from(bytes.subarray(hvcC.start + 6, hvcC.start + 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) {
    constraints.pop();
  }
  const level = bytes[hvcC.start + 12] ?? 0;
  const parts = [
    entryType,
    `${space}${profile}`,
    compatibility,
    `${tier}${level}`,
    ...constraints.map((value) => value.toString(16).toUpperCase()),
  ];
  return parts.join(".");
}

/** Reads the length of an MPEG-4 descriptor, which takes one to four bytes. */
function descriptorLength(
  bytes: Uint8Array,
  offset: number,
  end: number,
): [number, number] {
  let length = 0;
  let position = offset;
  for (let count = 0; count < 4; count++) {
    if (position >= end) {
      throw new Fmp4Error("A descriptor is truncated.");
    }
    const value = bytes[position] ?? 0;
    position++;
    length = (length << 7) | (value & 0x7f);
    if ((value & 0x80) === 0) {
      break;
    }
  }
  return [length, position];
}

/**
 * `mp4a.OO[.A]` from the `esds` descriptors: the object type of the decoder configuration, and
 * for MPEG-4 audio the audio object type of its specific information.
 */
function mp4aCodec(bytes: Uint8Array, esds: ChildBox): string | null {
  // The full box header: version and flags.
  let offset = esds.start + 4;
  const end = esds.end;
  if (offset >= end || bytes[offset] !== 0x03) {
    return null;
  }
  let length: number;
  [length, offset] = descriptorLength(bytes, offset + 1, end);
  const esEnd = Math.min(end, offset + length);
  if (offset + 3 > esEnd) {
    return null;
  }
  const flags = bytes[offset + 2] ?? 0;
  offset += 3;
  if (flags & 0x80) {
    offset += 2;
  }
  if (flags & 0x40) {
    offset += 1 + (bytes[offset] ?? 0);
  }
  if (flags & 0x20) {
    offset += 2;
  }
  if (offset >= esEnd || bytes[offset] !== 0x04) {
    return null;
  }
  [length, offset] = descriptorLength(bytes, offset + 1, esEnd);
  const configEnd = Math.min(esEnd, offset + length);
  if (offset + 13 > configEnd) {
    return null;
  }
  const objectType = bytes[offset] ?? 0;
  const objectHex = hex2(objectType).toUpperCase();
  if (objectType !== 0x40) {
    return `mp4a.${objectHex}`;
  }
  offset += 13;
  if (offset >= configEnd || bytes[offset] !== 0x05) {
    return `mp4a.${objectHex}`;
  }
  [length, offset] = descriptorLength(bytes, offset + 1, configEnd);
  if (length < 1 || offset >= configEnd) {
    return `mp4a.${objectHex}`;
  }
  let audioObjectType = (bytes[offset] ?? 0) >> 3;
  if (audioObjectType === 31 && offset + 1 < configEnd) {
    audioObjectType =
      32 + ((((bytes[offset] ?? 0) & 0x07) << 3) | ((bytes[offset + 1] ?? 0) >> 5));
  }
  return `mp4a.${objectHex}.${audioObjectType}`;
}

/** The size of the fixed fields of a visual and of an audio sample entry, after the header. */
const VISUAL_ENTRY_FIELDS = 78;
const AUDIO_ENTRY_FIELDS = 28;

/** The codec string of the first sample entry of a `stsd`. */
function sampleEntryCodec(bytes: Uint8Array, stsd: ChildBox): string | null {
  // Version and flags, then the entry count.
  requireBody(stsd, 8);
  const [entry] = children(bytes, stsd.start + 8, stsd.end);
  if (entry === undefined) {
    return null;
  }
  const inner = (fields: number): ChildBox[] =>
    entry.start + fields <= entry.end
      ? children(bytes, entry.start + fields, entry.end)
      : [];
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      const avcC = inner(VISUAL_ENTRY_FIELDS).find((box) => box.type === "avcC");
      return avcC === undefined ? null : avcCodec(entry.type, bytes, avcC);
    }
    case "hvc1":
    case "hev1": {
      const hvcC = inner(VISUAL_ENTRY_FIELDS).find((box) => box.type === "hvcC");
      return hvcC === undefined ? null : hevcCodec(entry.type, bytes, hvcC);
    }
    case "mp4a": {
      const esds = inner(AUDIO_ENTRY_FIELDS).find((box) => box.type === "esds");
      return esds === undefined ? null : mp4aCodec(bytes, esds);
    }
    case "Opus":
      return "opus";
    case "fLaC":
      return "flac";
    case "ac-3":
    case "ec-3":
      return entry.type;
    default:
      return null;
  }
}

function trackOf(bytes: Uint8Array, trak: ChildBox): Fmp4Track | null {
  const tkhd = child(bytes, trak, "tkhd");
  const mdia = child(bytes, trak, "mdia");
  if (tkhd === null || mdia === null) {
    return null;
  }
  const data = view(bytes);
  requireBody(tkhd, 4);
  const tkhdVersion = bytes[tkhd.start] ?? 0;
  // After version and flags: creation and modification times of 4 or 8 bytes each.
  const idOffset = tkhd.start + 4 + (tkhdVersion === 1 ? 16 : 8);
  requireBody(tkhd, idOffset + 4 - tkhd.start);
  const id = data.getUint32(idOffset);

  const mdhd = child(bytes, mdia, "mdhd");
  const hdlr = child(bytes, mdia, "hdlr");
  if (mdhd === null || hdlr === null) {
    return null;
  }
  requireBody(mdhd, 4);
  const mdhdVersion = bytes[mdhd.start] ?? 0;
  const scaleOffset = mdhd.start + 4 + (mdhdVersion === 1 ? 16 : 8);
  requireBody(mdhd, scaleOffset + 4 - mdhd.start);
  const timescale = data.getUint32(scaleOffset);
  requireBody(hdlr, 12);
  const handler = fourCc(bytes, hdlr.start + 8);
  const kind: Fmp4TrackKind =
    handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";

  const minf = child(bytes, mdia, "minf");
  const stbl = minf === null ? null : child(bytes, minf, "stbl");
  const stsd = stbl === null ? null : child(bytes, stbl, "stsd");
  const codec = stsd === null ? null : sampleEntryCodec(bytes, stsd);
  return { id, kind, timescale, codec, defaultDuration: 0, defaultFlags: null };
}

/** The `trex` defaults of the tracks of a `moov`, by track id. */
function trackDefaults(
  bytes: Uint8Array,
  root: ChildBox,
): Map<number, { duration: number; flags: number }> {
  const defaults = new Map<number, { duration: number; flags: number }>();
  const mvex = child(bytes, root, "mvex");
  if (mvex === null) {
    return defaults;
  }
  const data = view(bytes);
  for (const trex of children(bytes, mvex.start, mvex.end)) {
    if (trex.type !== "trex" || trex.end - trex.start < 24) {
      continue;
    }
    defaults.set(data.getUint32(trex.start + 4), {
      duration: data.getUint32(trex.start + 12),
      flags: data.getUint32(trex.start + 20),
    });
  }
  return defaults;
}

/**
 * The tracks of a `moov` box.
 *
 * @param moov The whole `moov` box.
 * @throws Fmp4Error when the box structure is damaged.
 */
export function parseMovie(moov: Uint8Array): Fmp4Track[] {
  const root = rootBox(moov, "moov");
  const defaults = trackDefaults(moov, root);
  return children(moov, root.start, root.end)
    .filter((box) => box.type === "trak")
    .map((trak) => trackOf(moov, trak))
    .filter((track): track is Fmp4Track => track !== null && track.timescale > 0)
    .map((track) => {
      const trex = defaults.get(track.id);
      return trex === undefined
        ? track
        : { ...track, defaultDuration: trex.duration, defaultFlags: trex.flags };
    });
}

/**
 * The fragment of each track of a `moof` box.
 *
 * @param moof The whole `moof` box.
 * @param tracks The tracks of the `moov`, for the defaults of their fragments.
 * @throws Fmp4Error when the box structure is damaged.
 */
export function parseFragments(
  moof: Uint8Array,
  tracks: readonly Fmp4Track[] = [],
): Fmp4Fragment[] {
  const root = rootBox(moof, "moof");
  const data = view(moof);
  const fragments: Fmp4Fragment[] = [];
  for (const traf of children(moof, root.start, root.end)) {
    if (traf.type !== "traf") {
      continue;
    }
    const boxes = children(moof, traf.start, traf.end);
    const tfhd = boxes.find((box) => box.type === "tfhd");
    const tfdt = boxes.find((box) => box.type === "tfdt");
    if (tfhd === undefined || tfdt === undefined) {
      continue;
    }
    requireBody(tfhd, 8);
    const trackId = data.getUint32(tfhd.start + 4);
    const track = tracks.find((item) => item.id === trackId);
    const header = fragmentHeader(moof, tfhd, track);
    requireBody(tfdt, 8);
    const tfdtVersion = moof[tfdt.start] ?? 0;
    let decodeTime: number;
    if (tfdtVersion === 1) {
      requireBody(tfdt, 12);
      decodeTime = readUint64(data, tfdt.start + 4);
    } else {
      decodeTime = data.getUint32(tfdt.start + 4);
    }
    const runs = boxes
      .filter((box) => box.type === "trun")
      .map((trun) => readRun(moof, trun));
    const first = runs.find((run) => run.count > 0);
    let duration: number | null = 0;
    for (const run of runs) {
      const runDuration =
        run.durations ?? (header.duration > 0 ? header.duration * run.count : null);
      duration =
        duration === null || runDuration === null ? null : duration + runDuration;
    }
    const flags = first?.firstFlags ?? header.flags;
    fragments.push({
      trackId,
      decodeTime,
      presentationTime: decodeTime + (first?.firstOffset ?? 0),
      duration: runs.length === 0 ? null : duration,
      sync: flags === null ? null : (flags & NON_SYNC_SAMPLE) === 0,
      presentationTimes: samplePresentationTimes(decodeTime, runs, header.duration),
    });
  }
  return fragments;
}

/**
 * The presentation time of each sample of the runs of a track fragment: its decode time, which
 * the durations of the samples before it add up from `decodeTime`, and its composition offset.
 * Null when a sample that another sample follows has no duration, neither its own nor
 * `defaultDuration`.
 */
function samplePresentationTimes(
  decodeTime: number,
  runs: readonly TrackRun[],
  defaultDuration: number,
): number[] | null {
  const times: number[] = [];
  let sampleTime = decodeTime;
  let known = true;
  for (const run of runs) {
    for (let index = 0; index < run.count; index++) {
      if (!known) {
        return null;
      }
      times.push(sampleTime + (run.compositionOffsets?.[index] ?? 0));
      const sampleDuration =
        run.sampleDurations?.[index] ?? (defaultDuration > 0 ? defaultDuration : null);
      if (sampleDuration === null) {
        known = false;
      } else {
        sampleTime += sampleDuration;
      }
    }
  }
  return times;
}

/** The default duration and flags of the samples of a track fragment. */
function fragmentHeader(
  bytes: Uint8Array,
  tfhd: ChildBox,
  track: Fmp4Track | undefined,
): { duration: number; flags: number | null } {
  const data = view(bytes);
  const flags = data.getUint32(tfhd.start) & 0x00ffffff;
  let offset = tfhd.start + 8;
  if (flags & 0x1) {
    offset += 8;
  }
  if (flags & 0x2) {
    offset += 4;
  }
  let duration = track?.defaultDuration ?? 0;
  if (flags & 0x8) {
    requireBody(tfhd, offset + 4 - tfhd.start);
    duration = data.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x10) {
    offset += 4;
  }
  let sampleFlags = track?.defaultFlags ?? null;
  if (flags & 0x20) {
    requireBody(tfhd, offset + 4 - tfhd.start);
    sampleFlags = data.getUint32(offset);
  }
  return { duration, flags: sampleFlags };
}

/** The fields of a `trun` that the preview reads. */
interface TrackRun {
  readonly count: number;
  /** The sum of the stated sample durations, or null when the run states none. */
  readonly durations: number | null;
  /** The flags of the first sample, or null when the run states none. */
  readonly firstFlags: number | null;
  /** The composition offset of the first sample, or 0 when the run states none. */
  readonly firstOffset: number;
  /** The duration of each sample, or null when the run states none. */
  readonly sampleDurations: readonly number[] | null;
  /** The composition offset of each sample, or null when the run states none. */
  readonly compositionOffsets: readonly number[] | null;
}

function readRun(bytes: Uint8Array, trun: ChildBox): TrackRun {
  requireBody(trun, 8);
  const data = view(bytes);
  const version = bytes[trun.start] ?? 0;
  const flags = data.getUint32(trun.start) & 0x00ffffff;
  const count = data.getUint32(trun.start + 4);
  let offset = trun.start + 8;
  if (flags & 0x1) {
    offset += 4;
  }
  let firstFlags: number | null = null;
  if (flags & 0x4) {
    requireBody(trun, offset + 4 - trun.start);
    firstFlags = data.getUint32(offset);
    offset += 4;
  }
  const fields = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length;
  if (offset + fields * 4 * count > trun.end) {
    throw new Fmp4Error("The box trun is too short.");
  }
  let durations: number | null = flags & 0x100 ? 0 : null;
  let firstOffset = 0;
  const sampleDurations: number[] | null = flags & 0x100 ? [] : null;
  const compositionOffsets: number[] | null = flags & 0x800 ? [] : null;
  for (let index = 0; index < count; index++) {
    if (flags & 0x100) {
      const sampleDuration = data.getUint32(offset);
      durations = (durations ?? 0) + sampleDuration;
      sampleDurations?.push(sampleDuration);
      offset += 4;
    }
    if (flags & 0x200) {
      offset += 4;
    }
    if (flags & 0x400) {
      if (index === 0 && firstFlags === null) {
        firstFlags = data.getUint32(offset);
      }
      offset += 4;
    }
    if (flags & 0x800) {
      const compositionOffset =
        version === 0 ? data.getUint32(offset) : data.getInt32(offset);
      if (index === 0) {
        firstOffset = compositionOffset;
      }
      compositionOffsets?.push(compositionOffset);
      offset += 4;
    }
  }
  return {
    count,
    durations,
    firstFlags,
    firstOffset,
    sampleDurations,
    compositionOffsets,
  };
}

/**
 * Finds the top-level boxes of an fMP4 stream that arrives in pieces of any size. It keeps the
 * bytes of the `ftyp`, `moov` and `moof` boxes and skips the rest, so a large `mdat` costs no
 * copy.
 */
export class Fmp4Scanner {
  /** The bytes of the header of the current box, until it is complete. */
  private header = new Uint8Array(16);
  private headerLength = 0;
  /** The current box after its header, or null while its header is incomplete. */
  private box: {
    readonly type: string;
    readonly offset: number;
    readonly size: number;
    /** The bytes of a kept box, or null for a skipped one. */
    readonly bytes: Uint8Array | null;
    filled: number;
  } | null = null;
  private position = 0;

  /**
   * Reads the next piece of the stream and returns the boxes that it completes.
   *
   * @throws Fmp4Error when a box header is invalid.
   */
  push(chunk: Uint8Array): Fmp4Box[] {
    const found: Fmp4Box[] = [];
    let offset = 0;
    for (;;) {
      if (this.box === null) {
        if (offset >= chunk.byteLength) {
          break;
        }
        offset += this.readHeader(chunk, offset);
        continue;
      }
      const box = this.box;
      const take = Math.min(box.size - box.filled, chunk.byteLength - offset);
      box.bytes?.set(chunk.subarray(offset, offset + take), box.filled);
      box.filled += take;
      offset += take;
      if (box.filled === box.size) {
        // A box with no body completes with its header.
        found.push({
          type: box.type,
          offset: box.offset,
          size: box.size,
          bytes: box.bytes,
        });
        this.box = null;
      } else if (offset >= chunk.byteLength) {
        break;
      }
    }
    this.position += chunk.byteLength;
    return found;
  }

  /** Reads header bytes from `chunk` at `offset`, and returns how many it took. */
  private readHeader(chunk: Uint8Array, offset: number): number {
    const needed = this.headerLength < 8 ? 8 : 16;
    const take = Math.min(needed - this.headerLength, chunk.byteLength - offset);
    this.header.set(chunk.subarray(offset, offset + take), this.headerLength);
    this.headerLength += take;
    if (this.headerLength < needed) {
      return take;
    }
    const data = view(this.header);
    const type = fourCc(this.header, 4);
    let size = data.getUint32(0);
    if (size === 1 && this.headerLength < 16) {
      return take;
    }
    let headerSize = 8;
    if (size === 1) {
      size = readUint64(data, 8);
      headerSize = 16;
    }
    if (size === 0 || size < headerSize) {
      throw new Fmp4Error(`The box ${type} has an invalid size.`);
    }
    const boxOffset = this.position + offset + take - headerSize;
    const kept = KEPT_BOXES.has(type) && size <= MAX_KEPT_BOX_BYTES;
    if (KEPT_BOXES.has(type) && !kept) {
      throw new Fmp4Error(`The box ${type} is too large.`);
    }
    const bytes = kept ? new Uint8Array(size) : null;
    bytes?.set(this.header.subarray(0, headerSize), 0);
    this.box = { type, offset: boxOffset, size, bytes, filled: headerSize };
    this.headerLength = 0;
    return take;
  }
}
