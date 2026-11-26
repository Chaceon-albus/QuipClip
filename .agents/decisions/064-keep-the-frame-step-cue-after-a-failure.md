# 064. Turn the PCM cue of the frame step on again 3 seconds after a failure

- Status: Accepted
- Date: 2026-11-25
- Deciders: capric98
- Amends: ADR 046, ADR 062

## Context

A frame step plays a short burst of the sound at the new position (ADR 019). The PCM cue of
ADR 046 plays it for a source that plays through a `MediaSource` with audio. ADR 062 uses the
same cue for a native source with audio on macOS while its calibration is ready.

The PCM cue gets its PCM in two ways. On an FLV, the controller of the `MediaSource` gives the
cue the PCM that comes with a video window. On MPEG-TS, on Matroska and on a native source, the
cue opens its own PCM windows of the audio lane.

A review on 2026-11-25 found that the PCM cue turned itself off, with no way back, after one
failure. The committed cue did that in four cases:

- A PCM stream ended with the status `failed`. That is a PCM window of the cue, or the PCM of
  an FLV video window that the controller reports.
- The open of a PCM window of the cue was rejected with a code other than `superseded`, and the
  cue had not closed that window. The backend can refuse the open, and the client rejects a
  reply that it cannot read.
- The reply to the open of a PCM window of the cue gave no start time for its samples, and the
  cue had not closed that window.
- The cue could not create its audio output.

When it turned itself off, the cue stopped its burst, closed its PCM window and discarded its
PCM. After that it ignored each request and each piece of PCM. In one case it still kept a
request: when the output could not be created during a burst, that burst waited 1.05 seconds
for PCM, although the cue was off.

The cue stayed off until its owner replaced it. The owner of the cue of a `MediaSource` source
replaces it with the preview element. The owner of the cue of a native source also replaces it
when the calibration changes. So after one failure that the cue saw, the steps of a clip could
have no sound for the rest of the session, also where the audio is good.

## Decision

The four cases still turn the cue off, with the same steps as before. But the cue now turns
itself on again after 3 seconds. One timer of the cue ends that time. It is one of the timers
that the cue gets from its caller, so a test can run it.

A burst no longer waits for PCM when the cue turned itself off during that burst.

This record changes nothing else in the PCM cue, and nothing in the element cue of ADR 019.

### While the cue is off

The cue does what it did before in that state:

- It plays no burst, and it keeps no request for later.
- It opens no PCM window.
- It discards each piece of PCM that arrives.

One rule is new. The cue records each window whose PCM it discards: the windows of the PCM that
it held when it turned itself off, and the window of each piece that arrives while it is off.
After the cue is on again, it also discards the later pieces of such a window. Without that
rule, the later pieces would be placed at the start time of the window, which is the wrong
time.

A failure that the cue sees while it is off starts the 3 seconds again.

### When the cue is on again

The cue then holds no PCM, no PCM window and no request. It keeps its audio output if it has
one, its gain, and its record of the windows that it discards. It opens no window at that
moment.

- **The audio lane.** The next request for PCM opens a window: a burst, or one of the requests
  that get PCM ready after a seek or a pause (ADR 046, ADR 062).
- **An FLV.** The cue opens no window. It plays again when the controller gives it the PCM of a
  video window that it does not discard. A step inside a video window that the cue discards
  stays silent.

A failure that the cue sees after that turns it off for 3 seconds again. The record sets no
count of failures and no longer time.

### A file that changed

One case still turns the cue off until its owner replaces it. The open of a PCM window of the
cue is rejected with the code `sourceChanged`, and the cue had not closed that window. At that
open, the file was not the file of the import (ADR 058). This is a rule of the cue. The backend
checks the file at each open, so a later open could pass if the file of the import came back.

## Consequences

- After a failure that the cue saw, the steps make no sound for 3 seconds. After that, the cue
  plays again where it gets PCM. On the audio lane, that needs a PCM window that can be
  decoded. Such a window starts at its target less the seek margin, which is 5 seconds by
  default, or at the start of the file when the target is nearer to it than the margin. So a
  target soon after damaged audio can still fail.
- The cue discards the PCM of good parts too when it turns itself off. On the audio lane, the
  next request reads it again.
- The 3 seconds start when the cue sees a failure. A window that the cue replaced before it saw
  the failure of that window does not start them, as before. So the record sets no limit on how
  many windows the cue opens.
- These states of the committed cue stay as they are:
  - A PCM window of the cue that ended as `canceled`, with no close of the cue, is not a
    failure. The cue no longer counts on that window. The next request for PCM that the cue
    does not hold opens a window at once.
  - A PCM window of the cue that ended as `complete` still counts for its range when the cue
    decides whether to open a window. It gives no samples that did not arrive, so a burst there
    can make no sound. A window that sends nothing and does not end counts in the same way. In
    both cases, a target less than 1 second before the end of that range opens a new window.
  - An audio output that stays suspended plays nothing.
- The element cue still takes no new request until its next attach after an `error` event, and
  after a `play()` that failed for a reason other than an abort.
