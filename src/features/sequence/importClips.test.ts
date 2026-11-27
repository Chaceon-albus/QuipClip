import { describe, expect, it } from "vitest";
import { createMediaStore } from "@/features/media/store";
import type { ImportMediaResult } from "@/features/media/types";
import { createTimelineStore } from "@/features/timeline/store";
import { canUndoEdit } from "@/components/layout/actionConditions";
import { createAttachedMediaStore } from "./attachedMedia";
import type { Pts, TickCount } from "@/types/project";
import { importClips } from "./importClips";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

/** An imported file of 10 s at `path`, or one with no extent at all. */
function imported(path: string, extent = true): ImportMediaResult {
  return {
    path,
    fileName: path.slice(1),
    size: 1,
    mtime: 1,
    probe: {
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: pts("0"),
      videoEndPts: extent ? pts("10000") : null,
      videoDurationTicks: extent ? ticks("10000") : null,
      approximateDurationSeconds: extent ? 10 : null,
    },
  } as unknown as ImportMediaResult;
}

function harness(files: Record<string, ImportMediaResult | Error>) {
  const media = createMediaStore({
    importMedia: (path) => {
      const file = files[path];
      return file instanceof Error || file === undefined
        ? Promise.reject(file ?? new Error("missing"))
        : Promise.resolve(file);
    },
  });
  const timeline = createTimelineStore();
  let next = 0;
  const generateClipId = () => `clip-${++next}`;
  return { media, timeline, deps: { media, timeline, generateClipId } };
}

describe("importClips", () => {
  it("adds one clip for each file, in order, and attaches the first clip", async () => {
    const h = harness({ "/a": imported("/a"), "/b": imported("/b") });
    const added = await importClips(["/a", "/b"], null, h.deps);
    expect(added.map((clip) => clip.id)).toEqual(["clip-1", "clip-2"]);
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual([
      "clip-1",
      "clip-2",
    ]);
    expect(h.timeline.getState().attachedClipId).toBe("clip-1");
  });

  it("inserts at a junction and keeps the attached clip", async () => {
    const h = harness({
      "/a": imported("/a"),
      "/b": imported("/b"),
      "/c": imported("/c"),
    });
    await importClips(["/a", "/b"], null, h.deps);
    await importClips(["/c"], 1, h.deps);
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual([
      "clip-1",
      "clip-3",
      "clip-2",
    ]);
    expect(h.timeline.getState().attachedClipId).toBe("clip-1");
  });

  it("goes on after a file that fails, and reports the error", async () => {
    const h = harness({ "/a": imported("/a"), "/c": imported("/c") });
    const added = await importClips(["/a", "/broken", "/c"], null, h.deps);
    expect(added).toHaveLength(2);
    expect(h.timeline.getState().clips).toHaveLength(2);
  });

  it("refuses a file with no extent next to another clip", async () => {
    const h = harness({ "/a": imported("/a"), "/x": imported("/x", false) });
    await importClips(["/a", "/x"], null, h.deps);
    expect(h.timeline.getState().clips).toHaveLength(1);
    expect(h.media.getState().error?.code).toBe("sourceExtentUnknown");
  });

  it("brings back the clips, the segments and the attached clip with Undo after Clear Timeline (ADR 072)", async () => {
    const h = harness({ "/a": imported("/a"), "/b": imported("/b") });
    const attached = createAttachedMediaStore(h.media, h.timeline);
    await importClips(["/a", "/b"], null, h.deps);
    // The first clip is attached, and its virtual PTS values are its source PTS values.
    h.timeline.getState().markIn(pts("1000"));
    h.timeline.getState().markOut(pts("2000"));
    const clips = h.timeline.getState().clips;
    const segments = h.timeline.getState().sequenceSegments;
    expect(segments).toHaveLength(1);

    h.timeline.getState().clearTimeline();
    expect(h.timeline.getState().clips).toEqual([]);
    expect(attached.getState().media).toBeNull();
    // No video is in the preview, and Undo is available.
    expect(
      canUndoEdit(
        false,
        h.timeline.getState().clips.length === 0,
        h.timeline.getState().canUndo,
      ),
    ).toBe(true);

    h.timeline.getState().undo();
    const state = h.timeline.getState();
    expect(state.clips).toEqual(clips);
    expect(state.sequenceSegments).toEqual(segments);
    expect(state.segments.map((segment) => segment.id)).toEqual([segments[0]?.id]);
    // The preview has a clip to show again: the first clip, with its file.
    expect(state.attachedClipId).toBe("clip-1");
    expect(attached.getState().media?.path).toBe("/a");

    // Redo empties the sequence again, and Undo of that comes back once more.
    h.timeline.getState().redo();
    expect(h.timeline.getState().clips).toEqual([]);
    expect(h.timeline.getState().attachedClipId).toBeNull();
    expect(attached.getState().media).toBeNull();
    h.timeline.getState().undo();
    expect(h.timeline.getState().attachedClipId).toBe("clip-1");
    expect(attached.getState().media?.path).toBe("/a");
  });

  it("goes back to an empty sequence with Undo of the first import, and Redo brings the clip back", async () => {
    const h = harness({ "/a": imported("/a") });
    const attached = createAttachedMediaStore(h.media, h.timeline);
    await importClips(["/a"], null, h.deps);
    h.timeline.getState().undo();
    expect(h.timeline.getState().clips).toEqual([]);
    expect(attached.getState().media).toBeNull();
    expect(h.timeline.getState().canRedo).toBe(true);
    h.timeline.getState().redo();
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual(["clip-1"]);
    expect(h.timeline.getState().attachedClipId).toBe("clip-1");
    expect(attached.getState().media?.path).toBe("/a");
  });

  it("keeps the facts of a source that the session has when the same revision imports again (ADR 072)", async () => {
    let probe = 0;
    const media = createMediaStore({
      importMedia: (path) => {
        probe += 1;
        // The second probe of the same revision reads another end.
        const result = imported(path);
        return Promise.resolve(
          probe === 1
            ? result
            : {
                ...result,
                probe: { ...result.probe, videoEndPts: pts("9000") },
              },
        );
      },
    });
    const timeline = createTimelineStore();
    let next = 0;
    const deps = { media, timeline, generateClipId: () => `clip-${++next}` };
    await importClips(["/known"], null, deps);
    const sourceId = timeline.getState().clips[0]?.sourceId ?? "";
    const known = timeline.getState().sequenceSources[sourceId];

    await importClips(["/known"], null, deps);

    expect(timeline.getState().clips.map((clip) => clip.sourceId)).toEqual([
      sourceId,
      sourceId,
    ]);
    expect(timeline.getState().sequenceSources[sourceId]).toBe(known);
    expect(known?.videoEndPts).toBe("10000");
    expect(media.getState().sources[sourceId]?.probe.videoEndPts).toBe("10000");
  });
});
