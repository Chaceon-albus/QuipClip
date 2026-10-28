# 050. Bound the preparation of an export

- Status: Accepted
- Date: 2026-10-27
- Deciders: capric98
- Amends: ADR 016, ADR 017, ADR 049
- Amended by: ADR 053

## Context

An export prepares before ffmpeg starts (ADR 016). Preparation finds ffmpeg, checks the
revision of the source, re-probes the source, reads its audio, locates the slices of an FLV
source, checks the source and the destination, and reserves the temporary output.

The child processes of preparation have a time limit (`PROBE_TIMEOUT`, 30 seconds). The calls to
the file system that run in the process have none. A share that stopped answering can hold such a
call for a long time, and nothing can interrupt a blocked call. The run holds the single export
slot while it prepares. Since ADR 049, every export that waits in the queue waits behind it, and
a Stop takes effect only when the blocked call returns.

The user asked for a time limit, and for a Stop that does not wait for a blocked call.

## Decision

### Preparation runs on a helper thread that the export thread watches

The export thread starts a helper thread for the preparation and gives it a stop flag of its own.
The flag starts set when the user stopped the run before it began, and then no helper starts.
The export thread waits for the answer with a time limit, and checks the cancel flag of the run
every 50 ms.

- **An answer comes.** The run goes on as before. An error that comes after a Stop reports
  `canceled`, because the Stop caused it or raced it.
- **The user stops the run.** The export thread sets the stop flag of the helper and waits up to
  2 seconds for its answer. Then it reports `canceled`, whatever the helper answered, and gives
  up the helper if it did not answer.
- **Preparation takes more than 180 seconds.** That is 6 × `PROBE_TIMEOUT`, more than the
  bounded steps can take together. (Changed on 2026-10-28.) Preparation runs those steps once
  for each source of the pieces (ADR 053). One limit then covers the whole preparation: 180
  seconds multiplied by the number of those sources. The export thread sets the stop flag, waits
  up to 2 seconds,
  and reports `preparationTimedOut`. The detail names the stage of preparation that ran, such as
  `discovery` or `reservation`. A Stop that comes in those 2 seconds reports `canceled`.

The report comes before the slot is released, as for every other end of a run (ADR 016). So the
next export of the queue starts right after the report.

The 2 seconds and one poll fit inside the 5 seconds that an exit waits for the slot (ADR 017). A
test holds that sum.

### What a helper that the export thread gave up may still do

The helper stays blocked in its call until the call returns. Then it reads its stop flag and
stops at its next check. It starts no new child process after its stop. A child process that
was already running stops at its next poll, unless the system cannot end it.

- It never starts ffmpeg. Only the export thread runs the export, and only with an answer that
  it received.
- Its answer has nowhere to go: the channel has no buffer, and the export thread no longer
  receives. A temporary file that it reserved late is deleted on the helper thread.
- It does not write the head of an FLV source into the cache after its stop. It can still save
  the keyframe table of the source, which is only a cache.

### No shorter limit for discovery

On Windows, one `PATH` entry on a share that does not answer can cost about 21 seconds for one
call. A short limit for discovery alone would turn a slow start into a failure. The one limit for
the whole preparation covers discovery too.

## Consequences

- A Stop during preparation takes effect within about 2 seconds, also when a call is blocked.
- A preparation that hangs blocks the queue for at most about 3 minutes. Then the run fails with
  `preparationTimedOut`, and the next export starts.
- A helper that the export thread gave up can outlive the release of the slot. During that time
  it can hold a reserved temporary file until its blocked call returns. An exit that comes then
  can leave that file behind, as an exit that runs out of its wait can today (ADR 017).
- Each run that times out on a share that never answers leaves one more blocked thread until
  the application quits.
- The child processes of preparation now stop on the stop flag of the helper. The re-probe stops
  on it too.
- The run stage itself is not bounded. ffmpeg can run for an hour, and a Stop ends it (ADR 016).
