import { describe, expect, it } from "vitest";
import { createTimelineStore } from "@/features/timeline/store";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { Clip, Pts, TickCount } from "@/types/project";
import { previewElementKey, previewSequenceGeneration } from "./previewElementKey";

const SOURCE: SequenceSource = {
  id: "a",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: "0" as Pts,
  videoEndPts: "10000" as Pts,
  videoDurationTicks: "10000" as TickCount,
  approximateDurationSeconds: 10,
};
const CLIP: Clip = { id: "c1", sourceId: "a" };
const REVISION = "/media/a.mp4:4096:7";

describe("previewElementKey", () => {
  it("gives two keys for the same file under two generations", () => {
    expect(previewElementKey(REVISION, 1, 0)).not.toBe(
      previewElementKey(REVISION, 2, 0),
    );
  });

  it("still changes with the source and with the reload counter, and only with them", () => {
    expect(previewElementKey(REVISION, 1, 0)).toBe(previewElementKey(REVISION, 1, 0));
    expect(previewElementKey(REVISION, 1, 0)).not.toBe(
      previewElementKey("/media/b.mp4:4096:7", 1, 0),
    );
    expect(previewElementKey(REVISION, 1, 0)).not.toBe(
      previewElementKey(REVISION, 1, 1),
    );
    // No media gives the empty revision key, which still has a key.
    expect(previewElementKey("", 1, 0)).toBe(":1:0");
  });
});

describe("previewSequenceGeneration", () => {
  it("keeps the element of the first import when its clip joins the sequence", () => {
    const timeline = createTimelineStore();
    // Before the clip joins, the preview shows the import that the media store passes through.
    const before = previewSequenceGeneration(timeline.getState());
    timeline.getState().insertClips(0, [CLIP], [SOURCE]);
    expect(previewSequenceGeneration(timeline.getState())).toBe(before);
  });

  it("changes with a whole-sequence load of the same file and the same clip", () => {
    const timeline = createTimelineStore();
    timeline.getState().insertClips(0, [CLIP], [SOURCE]);
    const shown = previewElementKey(
      REVISION,
      previewSequenceGeneration(timeline.getState()),
      0,
    );
    timeline.getState().loadSequence([CLIP], [SOURCE], []);
    expect(
      previewElementKey(REVISION, previewSequenceGeneration(timeline.getState()), 0),
    ).not.toBe(shown);
  });

  it("does not change with a clip edit, an Undo or a Redo that keeps a clip", () => {
    const timeline = createTimelineStore();
    timeline.getState().insertClips(0, [CLIP], [SOURCE]);
    const generation = previewSequenceGeneration(timeline.getState());
    timeline.getState().insertClips(1, [{ id: "c2", sourceId: "a" }], [SOURCE]);
    timeline.getState().moveClip(1, 0);
    timeline.getState().removeClip(0);
    timeline.getState().undo();
    timeline.getState().redo();
    expect(timeline.getState().clips).toHaveLength(1);
    expect(previewSequenceGeneration(timeline.getState())).toBe(generation);
  });
});
