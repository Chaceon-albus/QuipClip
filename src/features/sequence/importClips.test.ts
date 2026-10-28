import { describe, expect, it } from "vitest";
import { createMediaStore } from "@/features/media/store";
import type { ImportMediaResult } from "@/features/media/types";
import { createTimelineStore } from "@/features/timeline/store";
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
});
