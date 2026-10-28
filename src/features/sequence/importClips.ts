/**
 * Imports files as clips of the sequence (ADR 052).
 *
 * Each file goes through the import of the media store (probe, asset grant, revision), one after
 * another, so the latest-request rule of that store never drops a file of the same request. Each
 * imported file becomes one clip, inserted at the junction of the request in the order of the
 * paths. The first clip of an empty sequence becomes the attached clip, so the preview shows it.
 */

import { toSequenceSource } from "@/features/media/sequenceSource";
import { mediaStore, type MediaStore } from "@/features/media/store";
import { ImportMediaError, type ImportMediaResult } from "@/features/media/types";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import type { Clip } from "@/types/project";

/** Dependencies of `importClips`, injected for tests. */
export interface ImportClipsDependencies {
  readonly media?: MediaStore;
  readonly timeline?: TimelineStore;
  /** Makes a clip identifier. Defaults to a random UUID. */
  readonly generateClipId?: () => string;
}

/** Makes a clip identifier. Clip identifiers are never used again (ADR 052). */
export function generateClipId(): string {
  return `clip-${crypto.randomUUID()}`;
}

/**
 * Imports `paths` and inserts one clip for each file that imports, from junction `index`, or at
 * the end when `index` is null or past the end. A file that fails to import reports its error in
 * the media store, and the next files still import. A source with no extent next to another clip
 * cannot join the sequence (ADR 052), and reports `sourceExtentUnknown`.
 *
 * @returns The clips that joined the sequence, in sequence order.
 */
export function importClips(
  paths: readonly string[],
  index: number | null = null,
  dependencies: ImportClipsDependencies = {},
): Promise<Clip[]> {
  // One import at a time: the media store keeps only the latest request, so a second request
  // that started during the first one would drop the file of the first one with no error.
  const run = queue.then(() => importClipsNow(paths, index, dependencies));
  queue = run.catch(() => undefined);
  return run;
}

let queue: Promise<unknown> = Promise.resolve();

async function importClipsNow(
  paths: readonly string[],
  index: number | null,
  dependencies: ImportClipsDependencies,
): Promise<Clip[]> {
  const media = dependencies.media ?? mediaStore;
  const timeline = dependencies.timeline ?? timelineStore;
  const generateId = dependencies.generateClipId ?? generateClipId;
  const added: Clip[] = [];
  let at = index;
  // The next import clears the error of a failed file, so the last failure shows again at the end.
  let failure: unknown = null;
  for (const path of paths) {
    const result: ImportMediaResult | null = await media.getState().importPath(path);
    if (result === null) {
      failure = media.getState().error ?? failure;
      continue;
    }
    const source = toSequenceSource(result);
    if (source === null) {
      continue;
    }
    const state = timeline.getState();
    const position =
      at === null || at < 0 || at > state.clips.length ? state.clips.length : at;
    const clip: Clip = { id: generateId(), sourceId: source.id };
    const wasEmpty = state.clips.length === 0;
    if (!state.insertClips(position, [clip], [source])) {
      failure = new ImportMediaError({ code: "sourceExtentUnknown" });
      media.getState().reportError(failure);
      continue;
    }
    if (wasEmpty) {
      timeline.getState().setAttachedClip(clip.id);
    }
    added.push(clip);
    at = position + 1;
  }
  if (failure !== null && media.getState().error === null) {
    media.getState().reportError(failure);
  }
  return added;
}
