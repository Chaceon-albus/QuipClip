# 004. Render source-PTS segments through accurate decode and normalization

- Status: Accepted
- Date: 2026-08-31
- Deciders: capric98

## Context

QuipClip stores each segment as a half-open interval in one source video stream's PTS
domain. A future renderer must seek efficiently and still cut at the selected presented
frames. It must also normalize video and audio before it concatenates segments.

An input seek can change the timestamp domain that later FFmpeg filters observe. Raw
source PTS values therefore cannot be inserted into a filter expression without first
resolving that post-seek domain.

Different sources can use different time bases and unrelated timestamp origins. Their raw
PTS values are never directly comparable.

## Decision

The future renderer will process each segment with these semantic steps:

1. Resolve the segment's `sourceId` to the original source.
2. Convert the stored source PTS boundaries with that source's video time base.
3. Seek before the In boundary as an optimization.
4. Decode accurately through the selected interval.
5. Resolve both stored source PTS boundaries into FFmpeg's actual post-seek timestamp
   domain.
6. Keep the half-open interval `[inPts, outPts)`.
7. Derive the matching audio interval from the same source-relative rational times.
8. Reset the segment timestamps to a local origin.
9. Normalize video, audio, codec, rate, size, and sample format as required.
10. Concatenate segments in project array order.

This ADR does not prescribe a raw `trim` or `atrim` expression. It does not prescribe the
placement of input `-ss`. Implementation work must first define the timestamps that FFmpeg
exposes after the selected seek configuration.

Output normalization does not change project edit points. VFR-to-CFR conversion, scaling,
codec conversion, and audio resampling belong only to the render layer.

The renderer must use exact rational arithmetic when it compares or rescales source
times. It can select a runtime common time base only when every rescale is exact. It must
not compare raw PTS values from different sources.

The future renderer must also:

- decode from the original media, not a lossy preview proxy
- generate silence for a segment whose source has no audio when concat requires audio
- read machine progress from `-progress pipe:1 -nostats`
- pass `-nostdin`
- write a temporary output in the destination directory and rename it on success
- use a filter-graph file when the platform command-line limit requires one

## Consequences

- Export implementation remains out of scope for the source-PTS refactor.
- A renderer cannot assume that a stored raw PTS is valid after input seeking.
- Each source needs its own timestamp-domain resolution.
- Output frame rate remains a render setting and does not define source edit positions.
- Render tests will need CFR, VFR, non-zero-start, negative-start, audio, and multi-source
  fixtures.
