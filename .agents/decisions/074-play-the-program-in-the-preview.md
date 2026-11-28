# 074. Play the program in the preview

- Status: Accepted
- Date: 2026-11-27
- Deciders: capric98
- Amends: ADR 003, ADR 022, ADR 026, ADR 052

## Context

ADR 003 named two preview modes. The Source preview plays the source. The Program preview
"plays the ordered segments and seeks across excluded source ranges". Only the first exists:
the preview plays the sequence, one clip at a time (ADR 052), and ADR 052 left the Program
preview unbuilt.

So the user sees what an export contains only after the export. For a long recording that is
an encode of minutes. The part that the user must check is small: each join between two
segments. Does the cut come at the right word, and does the next segment start where it must?

Play Segment (ADR 026) plays one segment and stops on its last frame. The playback store
keeps a stop point for it (ADR 022).

The user chose to build the Program preview. A play of only the joins was the first step that
the proposal named.

## Decision

### The program

The **program** is the list of the segments of the export, in the export order (ADR 066): the
segments that an export of the whole sequence joins. A selection of segments (ADR 067) does not
change it.

### Two actions

The key table (ADR 026) gets two actions. A repeated key press is taken and does nothing.

- **Play Program**, on `P`. It plays each segment of the program from its In to its last
  frame, one after another.
- **Play Joins**, on `Shift` with `P`. It plays only the parts at each join: up to 2 seconds
  at the end of a segment, and then up to 2 seconds at the start of the next segment.

The transport bar gets one button, Play Program, after the Play button. Its tooltip names the
key, and a second line says that `Shift` with a click plays only the joins.

### The parts of a program play

A program play is a list of **parts**. Each part is on ONE clip: the clip, a start, and an end
that is not in the part, as PTS values of the source of that clip. The action makes the list
one time, when it starts.

The export makes **pieces** of a segment: one piece for each clip that the segment is on
(ADR 052, `expandSegment`). A segment on one clip has one piece.

**Play Program** has one part for each piece of each segment, from the segment where the play
starts to the last segment of the program, in the order of the export.

**Play Joins** uses two ranges of a piece. Both are counts of ticks of the time base of the
source of the piece, and 2 seconds are that count of ticks, rounded down:

- the **tail** of a segment: the end of its last piece. It starts 2 seconds before the end of
  that piece, but not before its start.
- the **head** of a segment: the start of its first piece. It ends 2 seconds after the start
  of that piece, but not after its end.

The list of Play Joins, from the segment where the play starts:

1. The tail of the first segment.
2. For each later segment that is not the last of the program: its head, and then its tail.
   When the segment has one piece, and the head ends at or after the start of the tail, the
   two are one part: the whole piece.
3. For the last segment of the program: its head.

In both lists, a part that holds no frame is left out. The test is the test of Play Segment on
the source of the part (`canPlaySegment`).

So a part never crosses a junction of two clips, and each boundary of a part is a PTS of its
source. A segment that crosses a junction plays as two parts, as the export joins two pieces.
The start of a tail can lie inside a frame. The part then starts with the frame that holds
that tick, as each seek does (ADR 022).

### Where a program play starts

The **current segment** is the segment that Play Segment would play: the one selected segment,
or else the one segment under the frame on screen. With two or more selected segments, only
the frame on screen can name it.

The play starts at the current segment when the sequence has one and it is in the program.
Otherwise it starts at the first segment of the program. For Play Joins, a current segment
that is the last of the program is as no current segment.

### The segment playback of the store

The playback store gets one new fact (this amends ADR 022). Each segment playback that the
store accepts gets a number, and the store says of the last one whether it **reached its
stop**.

- A segment playback is accepted when `playSegment` set its stop point. The store then
  publishes its number, with "not reached".
- It reached its stop when the store itself ended the playback because of the stop point: the
  pause on the last frame, the seek back from a frame after the last frame, the stop of the
  clock for a playback that presents no frame (a hidden window), or the end of the media inside
  the segment playback. The store publishes "reached" one time for one number, as the last
  step of the handler that made the stop, after that handler paused the element and started
  its seek back or left it out. A later frame in the seek-back window (ADR 022) does not
  publish again.
- The store does not take an element that something else paused as a stop: when the element
  is paused away from the end of the media, and the store did not pause it, the frame test and
  the clock test of the stop do nothing, and the pause that the element reports then drops the
  stop point as today. At the end of the media the browser pauses the element itself. The
  store handles that end first, as today, and it is a stop reached.
- Each other end of a segment playback publishes nothing: a pause, a seek, a play, an error, a
  decode stall, a detach, a recalibration.
- An `ended` event that comes when the element is not at its end is dropped before the
  playback of the sequence and the store read it. Today such an event can still continue a
  play on the next clip, and it ends the play session of a playback that started after that
  end.

Play Segment itself does not change, but for the first rule of the note below.

(Changed on 2026-11-27, with the code of this section.) The review of the code found cases
that the rules above did not cover. These rules apply to them:

- **A frame from before a seek.** The callback of a frame that the browser presented before
  the seek to the In can arrive after that seek ended (ADR 022). Before, such a frame at or
  after the last frame stopped a segment playback that had not started. So after each seek,
  the store is in doubt until it has **confirmed** the playback. A frame that lies at most 0.1
  seconds after the position that the element reports confirms it. A frame from before the
  seek that can stop the playback lies after that position, because the element is at the
  target of the seek.
  - While the playback is not confirmed, the frame test of the stop does nothing for the
    first frame that lies more than 0.1 seconds after the position, also when that frame meets
    the stop. That frame is **in doubt**.
  - A second frame, with another time than the frame in doubt, confirms the playback whatever
    the position is. At most one callback of a frame from before the seek comes after the
    seek ended. And a web view can report a position that trails the picture (ADR 046), which
    must not make the store miss the last frame.
  - After the playback is confirmed, each frame counts as before, with no test of the
    position.
  - Each seek on the element, also one that the system makes, opens the doubt again.
  - The clock does nothing with the frame in doubt. The store cannot know that this frame is
    still on screen.

  Three limits stay. A frame from before the seek that lies at most 0.1 seconds after the
  position counts. A second frame from before the seek counts. And when the first frame after
  a seek is a frame of the playback that meets the stop, and it lies more than 0.1 seconds
  after the position, it does nothing: the next frame, the clock test, or the end of the
  media then stops the playback, one frame later or up to the length of the stop window
  later.
- **At its end.** An element is at its end only when it reports `ended` and reports no seek.
  A scrub that the system makes can pause the element during its seek, and WebKit then reports
  `ended` from the target of that seek. Such a pause is a pause from outside: it drops the
  stop point and publishes nothing. The preview uses the same test for an `ended` event, and
  for the pause that comes before it (ADR 052). One limit stays: when the media ends, and a
  seek of the system to that same end starts before the page reads the `pause` and `ended`
  events of that end, the page takes the end as a pause from outside. The playback then stops
  there and does not go on at the next clip.
- **A dropped `ended` event.** When the preview drops an `ended` event, the playback of the
  sequence forgets what it noted at the pause before that event. A later `ended` event that
  no pause came before then cannot continue a play on the next clip. That is also so while a
  Play Segment crosses a junction: the playback goes on at the next clip only when the element
  played to its end, and an end with no playback drops the play intent of that segment
  (ADR 052).
- **A seek back that did not start.** When the stop needs a seek back and the store cannot
  start it, the store publishes nothing. The stop point goes, and the store reports the seek
  that failed. A seek back that is not necessary, because the element is already at the
  position of the last frame, is a stop reached. A web view can then keep the picture of the
  frame after the last frame (ADR 022), as before this record.
- **A change inside the stop.** A handler that makes a stop reads the stop point again after
  each of its own writes. When a listener of such a write replaced or dropped the stop point,
  the handler ends there and publishes nothing.

### How a program play runs

A program play is a **run** of the playback of the sequence. One run exists at most. The start
of a run drops the play intent of an earlier Play Segment that crosses a junction (ADR 052),
and while a run exists, the end of a clip does not continue on the next clip of the sequence:
the run alone decides what plays next.

For each part, in the order of the list:

1. When the clip of the part is not the clip on screen, the clip attaches first (the cold
   switch of ADR 052).
2. When the element of that clip is ready and its calibration is ready, the run tests that
   the start of the part lies before the end of the media that the element reports. Then it
   asks the playback store for a segment playback of the part.
3. The part **started** when the store accepted it. The run keeps the number.
4. The part **completed** when the store published "reached" for that number. The run then
   goes to the next part, in a task of its own and not inside the call of the store. It first
   tests that it is still the run.
5. After the last part completed, the run ends and changes nothing more. The stop point stays
   in the store as after Play Segment, so the correction of a late frame still works
   (ADR 022).

The run reads each change of the store in a task of its own, after the call of the store that
made the change returned. It reads "reached" for its number first. Only when that is not
published does a stop point that is gone mean a failure. So a handler of the store that drops
the stop point and then publishes "reached" is one event for the run. Each such read, and the
timer of a part, first tests that the run is still the run and that the part is still its
part. The run takes "reached" one time for a part. The timer of a part tests for "reached"
before it fails.

(Changed on 2026-11-28, with the code of the run.) A part must make progress. A time of 10
seconds starts when the run asks for the part (step 1). It starts again when the store
accepts the part, and then at each change of the clock of the element that the store
publishes. That clock moves also in a window that presents no frame. When the 10 seconds end
and the part is not completed, the run fails. So a part that plays never fails by the time,
however long it is. A clip that does not show, a seek to the start that does not end (it can
wait for a long time at a gap of the media, ADR 046), and a play that does not start fail 10
seconds after the last progress. A part whose start is not before the end of the media, and a
part that the store does not accept, also end the run as a failure (see below). The store
does not accept a part when the calibration of the clip is not ready, or when the seek to its
start fails.

Before, this record said that a part must "play" within 10 seconds: the seek to its start
ended, and the store reports a playback. The published state cannot prove that. A hidden
window keeps the display target of the store (ADR 022), a frame of the seek clears it before
the element plays, and the store reports a playback from the request on.

(Changed on 2026-11-28, with the code of the run.) Three rules say more exactly how the run
reads the store:

- **A read is a microtask.** It runs after the call of the store returned, and it can run
  before another listener of the same event of the element. One limit follows. The stop of a
  part can come in a `timeupdate` event that the controller of a MediaSource source (ADR 046)
  also reads, to find a playback with no progress. The run can then start the next part
  before the controller reads the event, and the controller does not report the fault at the
  position that the run left. A task of a timer has no such order, but a hidden window slows
  it down.
- **A part starts in a read of the run.** When the clip of a waiting part becomes ready, the
  run does not ask the store inside that notification. Its next read tests the start against
  the end of the media that the store reports then, and asks the store.
- **The order of a read.** A read first tests a change of the program and a failure (see
  "What ends a run"), then "reached", and then the stop point that is gone. So a stop that
  publishes "reached" in the same task as an edit or a reload does not start the next part.

The stop of a part is the stop of Play Segment, with its limits (ADR 022, ADR 026). A frame
after the last frame can show for a moment before the store seeks back. For a source off the
frame grid, the last frame is a prediction, and a last frame that is longer than one and a
half frame intervals stops by the clock after the end of the part, so sound of the time after
that end can play.

### What ends a run

**Each end of a run before the end of its last part does the same three things.** It pauses
the playback. It drops the stop point of the part of the run, also when the store accepted
the part and the seek to its start still runs. And a request of the run that waits for the
attach of a clip becomes a seek to the start of its part with no play, as ADR 070 states for
each play that waits. So the clip that loads stays and finishes its load, and the pause does
not stop the first-frame prime of that clip (ADR 003). The three groups below say when a run
ends.

**The user takes the playback.** Each caller of one of the actions below first ends the run,
and only then plans its action against the state that results: the key layer, the transport
bar, the timeline, the timecode field of the preview, and the menu of a segment. When the
action is not available then, that end of the run is all that the press does. A seek of the
user takes the place of the seek that the end of the run left.

- `Space`, the Play button, and the Play Program button, with or without `Shift`: the playback
  stays paused where it is. That is also so between two parts and while a clip loads, when
  the store reports no playback. These are available while a run exists, whatever the state
  of the element is, and the Play button then has the label of Pause.
- A seek, a scrub, a step, a jump, Home, End, a move to an edit point, a time that the user
  types, and the start of a trim: the action then does what it does from a paused playback.
- Play Segment: it then plays the current segment from its In, as with no run. The stop point
  of the run does not make it a pause, and the menu of a segment shows Play Segment, and not
  Pause, while a run exists.
- A new request for Play Program or Play Joins by its key: the new run starts, by its own
  rules.

The seek actions and the transport actions of the playback of the sequence also end a run
when another caller than the run calls them. So a caller that this record does not name
cannot leave a run that goes on over its seek.

These do not end a run: the zoom of the timeline, a change of the selection, the volume and
the mute, and a menu that opens.

**The program changes.** A run ends, and the playback pauses, when a segment is made, changed
or removed, the export order changes, a clip joins or leaves the sequence, the placement of
the clips on the sequence changes, or a project opens. An Undo and a Redo that do one of these
end it too. The attach of a clip that the run asked for changes the clip on screen. That is no
change of the program.

(Changed on 2026-11-28.) A segment is changed when its In or its Out changes. A new name of a
segment (ADR 065) is no change of the program, and the run goes on.

**The run fails.** A run ends in each of these cases: a part makes no progress for 10
seconds (changed on 2026-11-28, see "How a program play runs"); the
stop point of the part goes and the store did not publish "reached"; the playback has an error
or a decode stall; the element is loaded again, as for another audio track (ADR 070) or a
recalibration (ADR 063). The new element of the clip that the run asked for is no such case.
(Changed on 2026-11-28.) A run also ends when the preview gives up the element of the clip of
its part, because the clip cannot be decoded. The store reports no error then, and the preview
tells the playback of the sequence.

A dialog that opens and an export that starts do not end a run.

### When the actions are available

Play Program and Play Joins need a list with one or more parts. So Play Joins needs a program
with two or more segments. They also need a clip on screen whose element is attached, as each
transport action. The clip of the first part can be another clip: it then loads.

Both do nothing while a drag trims a segment edge, and while a dialog of the window is open,
as the other actions of the key table.

### What the interface shows

The state of the playback of the sequence gets the run: its action, the number of the part
that plays or loads, from 1, and the count of the parts of its list. It is null with no run.

- The Play Program button shows as pressed from the start of a run to its end, also between
  two parts and while a clip loads.
- The status line of the transport bar says which part it is: "Playing part 2 of 5 of the
  program." or "Playing part 2 of 5 of the joins."

The playhead and the timecode show the position on the sequence, as in each other play. No
part of the interface gets a time axis of the program.

## Rejected alternatives

- **A file that FFmpeg renders for the preview.** It is an encode, which is the wait that this
  record removes. It can come later for a preview with no pause at a join.
- **A second media element that loads the next part.** The preview owns one element, and its
  calibration, its windows of a remux and its audio follow that element (ADR 003, ADR 046). Two
  elements change each of them.
- **A part that crosses a junction, as Play Segment does.** The first clip then plays to the
  end of its element with no stop point, and all the sound after the last video frame of the
  clip plays. A part for each piece has a stop point on each clip, with the limits of that
  stop.
- **A part with a boundary on the time base of the sequence.** Such a tick is not always a
  tick of the source of the clip, and the conversion then fails.
- **Read the end of a part from the phase of the stop point.** The stop point goes with no
  "stopped" phase after a seek back, in a hidden window and at the end of the media, and it
  also goes for each pause and seek. The fact "reached its stop" names the one event, for the
  one playback.
- **A time axis of the program**, with a playhead and a timecode in program time. The edit
  points are positions on the sequence, and the user corrects a join there.
- **A length of the joins that the user sets.** One value is enough to hear a join. A setting
  can come when a user needs another value.
- **The program of the selected segments.** An export of a selection (ADR 067) is one action
  of the segment menu. The key of Play Program must always play the same list.

## Consequences

- The user can watch the program, or only its joins, with no export.
- The preview is not the export. Between two parts the preview pauses for a seek, and for the
  load of the clip when the next part is on another clip. The sound stops and starts again
  there. The export has no pause. A segment that crosses a junction has such a pause at the
  junction too.
- The end of each part has the limits of the stop of Play Segment (see "How a program play
  runs").
- A join plays up to 2 seconds on each side. A short piece, or a piece that ends before its
  segment, gives less.
- A program play does not loop.
- The parts are made when the run starts. An edit during the run ends it.
- A clip whose first frame does not come in 10 seconds ends the run. The user can start the
  action again when the clip shows.
- When a run ends during the seek to the start of a part, that seek still ends. The playhead
  can then move to the start of that part, with no playback.
- A seek that the system makes on the element while a part plays, as from a media key, keeps
  the stop point (ADR 022). The part then plays from that position to its end, and the run
  goes on. Play Segment has the same limit.
- The preview of a native source can play another audio track than the export uses (ADR 070).
  A program play has that limit too.
- ADR 003 said that the Program preview "seeks across excluded source ranges". This record
  builds that, on the one element of the preview. ADR 052 said that the Program preview stays
  unbuilt.
- `README.md` and `docs/architecture.md` must describe the two actions when the code is in.
