/**
 * The project document of the session, the content of the project, and the test of a document
 * (ADR 072).
 *
 * - `buildProjectDocument` makes the `Project` document that a save sends: the clips of the
 *   sequence in order, the live segments in array order, and one source entry for each source
 *   that a clip names, in the order of first use.
 * - `projectContentOf` gives the content of the project as one comparable value. The project is
 *   modified when this value is not equal to the saved content.
 * - `checkProjectDocument` tests a document with the rules of the sequence that the backend does
 *   not test, with the facts of the document only. The save step (step 2) and the open step
 *   (step 4) call it. It uses the test of the load of the timeline store (`checkSequenceLoad`),
 *   so it refuses exactly what `loadSequence` would refuse for the same data.
 *
 * Every function is pure. Each object of a document lists each field explicitly, with no object
 * spread, so no runtime field reaches the file (ADR 010).
 */

import type { AudioStreamOverride } from "@/features/media/audioStream";
import type { ImportMediaResult } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import {
  checkSequenceLoad,
  type SequenceLoadCheck,
} from "@/features/timeline/sequenceLoad";
import { liveSegments } from "@/features/timeline/store";
import type { TimelineTruth } from "@/features/timeline/types";
import {
  PROJECT_SCHEMA_VERSION,
  type Clip,
  type PersistedSource,
  type Project,
  type SequenceSegment,
} from "@/types/project";

/** The parts of the timeline truth that the document and the content read. */
export type ProjectTimeline = Pick<
  TimelineTruth,
  "clips" | "sequenceSegments" | "sequenceSources"
>;

/** The audio stream overrides of the session, by source id (ADR 070). */
export type ProjectAudioOverrides = Readonly<Record<string, AudioStreamOverride>>;

/** The imported media of the session, by source id (`MediaState.sources`). */
export type ProjectMediaSources = Readonly<Record<string, ImportMediaResult>>;

/** The ids of the sources that the clips name, in the order of first use. */
function namedSourceIds(clips: readonly Clip[]): string[] {
  return [...new Set(clips.map((clip) => clip.sourceId))];
}

function copyClip(clip: Clip): Clip {
  return { id: clip.id, sourceId: clip.sourceId };
}

function copySegment(segment: SequenceSegment): SequenceSegment {
  const copy: SequenceSegment = {
    id: segment.id,
    inClipId: segment.inClipId,
    inPts: segment.inPts,
    outClipId: segment.outClipId,
    outPts: segment.outPts,
  };
  // The file has the field only for a segment with a name (ADR 065).
  if (segment.name !== undefined) {
    copy.name = segment.name;
  }
  return copy;
}

/**
 * The persisted entry of source `id`: the path, the size, the modification time and the
 * fingerprint of its import, the facts of the video stream of its probe, and the index of the
 * audio stream that the user chose (ADR 010, ADR 070, ADR 072).
 *
 * It lists each field and writes no `relPath`: the backend writes that field at each save. It has
 * `audioStreamIndex` only for a source with an override, and `fingerprint` only for an import that
 * kept one.
 */
export function toPersistedSource(
  id: string,
  media: ImportMediaResult,
  override: AudioStreamOverride | undefined,
): PersistedSource {
  const probe = media.probe;
  const persisted: PersistedSource = {
    id,
    path: media.path,
    size: media.size,
    mtime: media.mtime,
    videoStreamIndex: probe.videoStreamIndex,
    videoTimeBase: { n: probe.videoTimeBase.n, d: probe.videoTimeBase.d },
    videoStartPts: probe.videoStartPts,
    videoEndPts: probe.videoEndPts,
    videoDurationTicks: probe.videoDurationTicks,
    approximateDurationSeconds: probe.approximateDurationSeconds,
    avgFrameRate:
      probe.avgFrameRate === null
        ? null
        : { n: probe.avgFrameRate.n, d: probe.avgFrameRate.d },
    rFrameRate:
      probe.rFrameRate === null
        ? null
        : { n: probe.rFrameRate.n, d: probe.rFrameRate.d },
    reportedFrameCount: probe.reportedFrameCount,
  };
  if (override !== undefined) {
    persisted.audioStreamIndex = override.index;
  }
  if (media.fingerprint !== undefined) {
    persisted.fingerprint = {
      start: media.fingerprint.start,
      fnv1a64: media.fingerprint.fnv1a64,
    };
  }
  return persisted;
}

/** The result of `buildProjectDocument`. */
export type BuildProjectDocumentResult =
  | { readonly ok: true; readonly project: Project }
  /** A clip names a source of which the media store has no import. */
  | { readonly ok: false; readonly missingSourceId: string };

/**
 * The `Project` document of the session (ADR 072, "The document"):
 *
 * - `clips`: the clips of the sequence, in sequence order;
 * - `segments`: the live segments (`liveSegments`), in array order, with their names;
 * - `sources`: one entry for each source that a clip names, in the order of first use, from the
 *   import of that source in `media` and its override in `overrides` (`toPersistedSource`).
 *
 * The document holds the ids of the session. They are names inside the document only.
 */
export function buildProjectDocument(
  timeline: ProjectTimeline,
  media: ProjectMediaSources,
  overrides: ProjectAudioOverrides,
): BuildProjectDocumentResult {
  const sources: PersistedSource[] = [];
  for (const id of namedSourceIds(timeline.clips)) {
    const imported = media[id];
    if (imported === undefined) {
      return { ok: false, missingSourceId: id };
    }
    sources.push(toPersistedSource(id, imported, overrides[id]));
  }
  return {
    ok: true,
    project: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      sources,
      clips: timeline.clips.map(copyClip),
      segments: liveSegments(timeline).map(copySegment),
    },
  };
}

/**
 * The content of the project as one comparable value (ADR 072, "The project of the session"). Two
 * contents are equal when their values are equal (`===`).
 */
export type ProjectContent = string & { readonly __brand: "ProjectContent" };

/**
 * The content of the project of the session:
 *
 * - the clips, in sequence order: each clip is the id of its source at its place;
 * - the live segments, in array order, with their edit points and their names: an edit point
 *   names its clip by the index of that clip in the sequence;
 * - for each source that a clip names, in the order of first use, the index of the audio stream
 *   that the user chose, or null for no choice.
 *
 * The ids of the clips and of the segments are not content: a segment that the user deletes and
 * marks again with the same In and Out, and a clip that the user removes and imports again at the
 * same place, give the same content. The pending In, the selection, the playhead, the attached
 * clip and the history are not content, and neither are the paths, the sizes and the times of the
 * files. Two sessions with equal content give equal values, whatever the identities of their
 * objects are.
 */
export function projectContentOf(
  timeline: ProjectTimeline,
  overrides: ProjectAudioOverrides,
): ProjectContent {
  const indexes = new Map(timeline.clips.map((clip, index) => [clip.id, index]));
  // A live segment names clips of the sequence, so each index exists.
  const indexOf = (clipId: string): number => indexes.get(clipId) ?? -1;
  const value = {
    clips: timeline.clips.map((clip) => clip.sourceId),
    segments: liveSegments(timeline).map((segment) => [
      indexOf(segment.inClipId),
      segment.inPts,
      indexOf(segment.outClipId),
      segment.outPts,
      segment.name ?? null,
    ]),
    audio: namedSourceIds(timeline.clips).map((id) => [
      id,
      overrides[id]?.index ?? null,
    ]),
  };
  return JSON.stringify(value) as ProjectContent;
}

/** The content of the empty sequence: the saved content of a project with no file. */
export const EMPTY_PROJECT_CONTENT: ProjectContent = projectContentOf(
  { clips: [], sequenceSegments: [], sequenceSources: {} },
  {},
);

/** The timing facts of a persisted source that the sequence reads (ADR 052). */
export function sequenceSourceOfPersisted(source: PersistedSource): SequenceSource {
  return {
    id: source.id,
    videoTimeBase: { n: source.videoTimeBase.n, d: source.videoTimeBase.d },
    videoStartPts: source.videoStartPts,
    videoEndPts: source.videoEndPts,
    videoDurationTicks: source.videoDurationTicks,
    approximateDurationSeconds: source.approximateDurationSeconds,
  };
}

/**
 * Tests a document with the rules of the sequence that the backend does not test (ADR 072, Save
 * step 2, open step 4), with the facts of the document only and no length from the web view.
 *
 * It is `checkSequenceLoad` of the clips, the sources and the segments of the document, so it
 * refuses exactly what `loadSequence` of the timeline store would refuse for the same data. When
 * a clip has no extent next to another clip, the problem is `clipExtentUnknown`, with the id of
 * the clip and the id of its source in the document: the save step names the file of that source.
 */
export function checkProjectDocument(project: Project): SequenceLoadCheck {
  return checkSequenceLoad(
    project.clips,
    project.sources.map(sequenceSourceOfPersisted),
    project.segments,
  );
}
