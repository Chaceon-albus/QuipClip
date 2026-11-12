# 057. Keep the files that the application can make again in subdirectories of its cache directory

- Status: Accepted
- Date: 2026-11-01
- Deciders: capric98
- Amends: ADR 041, ADR 046, ADR 055, ADR 056
- Amended by: ADR 059

## Context

Tauri gives the application two directories. Both end in the identifier
`io.github.capric98.quipclip` (`<id>` below).

| Directory         | Windows                                   | macOS                                |
| ----------------- | ----------------------------------------- | ------------------------------------ |
| `app_data_dir()`  | `%APPDATA%\<id>`, in the roaming profile  | `~/Library/Application Support/<id>` |
| `app_cache_dir()` | `%LOCALAPPDATA%\<id>`                     | `~/Library/Caches/<id>`              |

Before this record, QuipClip kept these files in them:

| File                         | Directory             | Record  | Content                                       |
| ---------------------------- | --------------------- | ------- | --------------------------------------------- |
| `settings.json`              | data                  | ADR 013 | The settings of the user                      |
| `settings.invalid.json`      | data                  | ADR 013 | The copy of a settings file that was damaged  |
| `bin/`                       | data                  | ADR 005 | An `ffmpeg` that the user put there           |
| `capabilities.json`          | data                  | ADR 006 | The encoders that a probe found               |
| `preset-tests.json`          | data                  | ADR 041 | The results of the tests that the user ran    |
| `flv-cache/<key>/`           | data                  | ADR 046 | The keyframe table of an FLV source           |
| `waveform/`                  | cache                 | ADR 056 | The audio envelopes                           |
| `export-<pid>-<n>/`          | cache, at the top     | ADR 055 | The work directory of an export               |
| `preset-test-<pid>-<n>.tmp`  | cache, at the top     | ADR 041 | The output of a preset test                   |

These points caused problems:

- The application can make the keyframe table again from the source. But the table was in the
  data directory, and on Windows that directory is in the roaming profile. The table names the
  source by its local path, so it has no use on another computer.
- ADR 055 stopped the write of `head.flv` into the FLV cache. An old `head.flv` stays until the
  eviction removes its directory. On the development computer on 2026-11-01, 3 of the 5 source
  directories still held one.
- On Windows, the user data folder of WebView2, `EBWebView`, is in the cache directory. The page
  keeps its preferences there, in `localStorage`. The work directories and the test outputs were
  at the top of the cache directory, beside `EBWebView`. A later command that clears the cache
  could delete the data of the web view by mistake. On macOS, WebKit can keep its own caches in
  `~/Library/Caches/<id>/` too. No measurement on macOS confirms this.

The user chose these points:

- The data directory keeps the files that the user made, and the files that the user must make
  again by hand. The cache directory keeps the files that the application can make again with no
  action of the user.
- `capabilities.json` stays in the data directory. It is small (3.6 KB on the development
  computer), and its loss costs one more probe.
- Each kind of file gets its own subdirectory of the cache directory. No file goes to the top of
  the cache directory.
- A cleanup after each start removes the files in the old places. It runs on a background thread.

## Decision

### The layout

| Path                                     | Content                              | Removed by                                          |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| `<cache>/waveform/`                      | The audio envelopes                  | The cleanup and the Clear of ADR 056, as before     |
| `<cache>/flv/<key>/keyframes.json`       | The keyframe table of an FLV source  | The eviction of ADR 046, as before                  |
| `<cache>/work/export-<pid>-<n>/`         | The work directory of an export      | The export and the sweep of ADR 055, as before      |
| `<cache>/work/preset-test-<pid>-<n>.tmp` | The output of a preset test          | The test and its cleanup of ADR 041, as before      |

The data directory keeps `settings.json`, `settings.invalid.json`, `bin/`, `capabilities.json`
and `preset-tests.json`. Their records do not change.

- No code deletes the cache directory itself. No code deletes a name at the top of the cache
  directory that this record does not list. The web view owns the other names.
- (Added on 2026-11-05.) On Windows the cache directory is also `app_local_data_dir()`. Its
  `bin` directory holds the `ffmpeg` that QuipClip downloads (ADR 059). That directory is not a
  cache, and no cleanup removes it. ADR 059 also adds the install work directory to `work`,
  and two steps to the cleanup at start.
- Each cache module keeps the name of its subdirectory as a constant and takes the cache
  directory as its root, as the envelope cache of ADR 056 does. The FLV cache does the same with
  the name `flv`.
- The directory `work` belongs to no single module. The module `src-tauri/src/app_cache/`
  declares only the name `work`. Its documentation states the whole layout and refers to the
  constants of the other names.
- The export creates `work` when it creates its work directory. The preset test creates `work`
  before it writes its output. No other step creates it.
- The preview gets the root of the FLV cache from `app_cache_dir()`. When that call fails, the
  preview fails with `appDataUnavailable`, as when `app_data_dir()` fails. Both paths come from
  the folders of the user profile, so a failure of only one of the two calls is not expected.
  The error codes of the preview do not change.
- The FLV input of an export takes the root of the FLV cache from `app_cache_dir()`, which the
  export command already reads for the work directory. When that call fails, the export fails
  with `workDirectoryUnavailable`, as before (ADR 055).

### The cleanup at start

After each start, one background thread runs these steps in this order. A failure in one step
writes a log line and does not stop the next step.

1. The cleanup of the envelope cache of ADR 056. Before this record, it ran on a thread of its
   own. Its rules do not change.
2. In `<cache>/work/`, the sweep of ADR 055 and the cleanup of ADR 041:
   - The sweep removes each work directory of at least 24 hours that this process does not use.
   - The cleanup deletes each test output of another process of at least 60 seconds.
3. At the top of the cache directory, the same sweep and the same cleanup. They remove only the
   names `export-<digits>-<digits>` and `preset-test-<digits>-<digits>.tmp`, which an older build
   left there. The ages stay, because an older build can run at the same time and use such a
   file.
4. The directory `flv-cache` in the data directory, with all its content. A directory that does
   not exist counts as removed.

Steps 1 to 3 need the cache directory. Step 4 needs the data directory. When Tauri gives no path
for a directory, the steps that need it do not run.

The steps run after each start, with no marker file. A second run finds no files from older
builds, and each step reads one directory. A later record can remove steps 3 and 4.

The export and the preset test still run their own sweep before each run. Those sweeps read only
`work`. Only the cleanup at start reads the top of the cache directory. Step 2 adds a cleanup for
a user who does not export or test after a crash.

## Consequences

- The keyframe tables no longer go to other computers with a Windows roaming profile.
- After the first start of this version, no FLV source has a keyframe table. The preview and the
  export find the keyframes again. Each FLV source therefore reads more of its file at its first
  seeks, as at its first open (ADR 046).
- An older build that runs after this version writes `flv-cache` again. The next start of this
  version deletes it again.
- Step 4 does not have the rule of ADR 046 that keeps a source in use. It can delete a keyframe
  table, or a `head.flv`, that an older build uses at the same time. Only a build from before
  ADR 055 reads `head.flv`. That build then finds its keyframes again, or its export fails.
- A command that clears all the caches is now possible. It can clear `waveform`, `flv` and `work`
  with the rules of each, and leave all other names. This record adds no such command.
- The path of a work directory gets 5 characters longer. The processes that run in the work
  directory name its files by their names alone (ADR 055), so their commands do not get longer.
  The `ffprobe` runs of preparation name a head by its full path. Each of those commands gets 5
  characters longer, and stays far below the limit of 32,767 characters (ADR 055).
