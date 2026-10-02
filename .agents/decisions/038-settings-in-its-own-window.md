# 038. Open Settings in its own window

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 006, ADR 011, ADR 013, ADR 020, ADR 021, ADR 024, ADR 026, ADR 027, ADR 031, ADR 032
- Amended by: ADR 041

## Context

Settings was a modal Radix dialog in the main window. Its overlay covered the whole window,
the title bar too, and blurred it. While Settings was open, the user could not drag the main
window, and could not drag the dialog either. The user asked for a Settings window that pops
out on its own, so that each window can be moved and used by itself.

## Decision

### One modeless window

Settings is a second native window with the label `settings`. There is at most one. It has
the title bar of the system on both platforms: a standard titled window with the traffic lights
on macOS, and the native caption of Windows, which follows the theme of the application. The
user chose the system title bar over a drawn one, because the system then handles the drag, the
close and the minimize.

The window has no parent on either platform. On macOS a child window moves with its parent,
which the user did not want. On Windows an owned window always stays above its owner, so it
would cover the prompts of the main window. The cost is a second button on the Windows task bar.

The async command `open_settings_window(section, presetId)` opens it. A synchronous command that
builds a window deadlocks on Windows. The command stores the request, then:

- When the window exists, it restores a minimized window or focuses a visible one, and sends
  `settings-window:navigate`. A window whose page still loads stays hidden until its first
  render.
- Otherwise it builds the window from the same `index.html`: 760 by 640, at least 640 by 480,
  resizable, not maximizable, hidden until the page renders, centred on the main window and
  kept on the work area of its monitor.

The page takes the request with `take_settings_window_request` when it mounts and on each
navigate event, so no request is lost while the page loads. The macOS menu item Settings… opens
the window from Rust, in every state of the main window. Open Media… and Export… bring the main
window forward before they send their actions. Every other opener calls the same command: the
`primary` with `,` key, the gear and the FFmpeg item of the status bar, the notice of the
preview, and Manage Presets… and Open Settings… of the export dialog.

### One chunk, two roots

`main.tsx` reads the label of the window and renders `SettingsWindowRoot` or `App`. An unknown
label renders `App`. Both come from the one chunk of ADR 032. The settings root mounts the
tooltip provider, the context menu policy, the sync of the settings and of the preferences, a
guard against dropped files, and one unforced capability probe. It mounts none of the parts of
the main window: the keyboard layer, the quit guard, the menu listener, the status bar, the
export interface, the file drop and the syncs of the title, the task bar and the attention. A
test walks the imports of the settings root and fails when one of these parts is reached.

### Closing Settings

Every close request of the Settings window is cancelled, and the page decides. With no unsaved
preset draft, the page closes the window. With a draft, the footer shows Save, Don't Save and
Cancel, and a second close request keeps that prompt. The red button, `Cmd+W`, `Alt+F4` and the
close of the caption all take this path. `Escape` does not close the window, as in the settings
windows of the system. When the main window is destroyed, Rust destroys the Settings window.

### The quit

The quit request goes only to the main window. A Settings window alone never blocks an exit and
never confirms one. The Settings window sends `settings-window:draft` with the name of an unsaved
preset, or with no name, to the main window, and Rust sends no name when the Settings window is
destroyed. The quit guard of ADR 027 reads that mirror. The quit prompt brings the main window
forward.

### Two windows that write one file

Each successful save, restore or reset of the settings file sends `settings:changed` with the
document and the label of the window that wrote it. A window ignores its own events. A window
takes a document only when its revision is newer, and it holds the document back while a request
of its own is in flight. A draft that was built on an older revision than another window's write
goes out with its old revision, so Rust refuses it with `settingsConflict` (ADR 013) and does not
overwrite the other write.

The theme, the language and the timecode format send `preferences:changed` with the key and the
value. The receiver applies the value and writes no storage, so the event does not come back.
The mute of the preview and the height of the timeline stay with the main window.

A forced capability probe sends `ffmpeg:capability-probe-forced` before its worker starts. The
other window takes that run over, so a new probe after a change of the FFmpeg path shows in the
export setup of the main window. A failed discovery sends the failure too. An unforced probe of
one window does not change the other window.

### What each window may call

The build now declares an app manifest with every command. Tauri then checks each command of
the application against the capability of the window that calls it. Before this record, no
manifest existed, so every page could call every command.

- The main window may call `start_capability_probe`, `start_export`, `cancel_export`,
  `cancel_active_export`, `reveal_export_output`, `import_media`, `read_source_revision`,
  `confirm_quit`, `load_settings`, `save_settings` and `open_settings_window`, and (added on
2026-10-02) `set_window_border_theme` of ADR 020. It keeps
  `core:default` and its window, dialog and progress permissions.
- The Settings window may call `load_settings`, `save_settings`, `restore_default_presets`,
  `reset_settings`, `start_capability_probe`, `take_settings_window_request` and
  `close_settings_window`, and (added on 2026-10-02) `test_preset` and `preset_test_results` of
  ADR 041, which the main window may call too. It holds `core:event:default`, four window
  permissions (set the title, set the theme, show, set the focus) and `dialog:allow-open` for
  the FFmpeg path. It holds no
  menu permission, so it cannot replace the macOS menu that holds Quit.
- `load_project` and `save_project` are granted to no window, because version 1 keeps no project
  file.

(Changed on 2026-10-02.) The Settings window holds `core:event:allow-listen` and
`core:event:allow-unlisten` only, not `core:event:default`, so its page cannot send an event,
such as a false `app:quit-requested` to the main window. What the page must send goes through
two synchronous commands that check their input and send the event from Rust:
`report_settings_draft`, which only the Settings window may call and which cuts the name to 120
characters, and `broadcast_preference`, which accepts only the theme, the language and the
timecode format with their allowed values. A synchronous command keeps two reports in the order
of the calls. The main window sends neither event.

A window permission of Tauri takes the label of its target from the caller. The Settings window
therefore has no permission to destroy a window. `close_settings_window` destroys only the window
that calls it, and only when that window is the Settings window. It is `async`, as the destroy
command of Tauri is, so the destroy does not run inside the IPC callback of the web view that it
destroys. Tests pin both lists, and a test fails when a command is registered without a decision.

### Events of one window

A listener of `listen` hears every event, also one that Rust sends to another window. The main
window listens for `app:quit-requested`, `app:menu-action` and `settings-window:draft`, and the
Settings window for `settings-window:navigate`, through the listener of the current window.

### Files dropped on Settings

The Settings window turns off the native drop handler, so a drop on it never imports into the
main window. The page cancels `dragover` and `drop` of every drag, files, links and images
included, so a drop never replaces the page and its draft. Text dragged over a text field keeps
its normal behaviour.

### The export dialog

The export dialog stays open when Settings opens from it. Its list of presets follows
`settings:changed`. The return to the setup step of ADR 024 is removed. A preset that the user
selects in Settings no longer becomes the choice of the setup step, and a visit to Settings no
longer runs the source check again.

## Consequences

- Both windows can be moved and used at the same time.
- A second web view runs while Settings is open.
- On Windows, Settings has a button on the task bar.
- When the cache of capabilities misses, the Settings window starts a second probe behind the
  probe of the main window. The smoke lock of ADR 006 keeps the tests serial, but the total time
  doubles.
- A new Settings window that is still hidden 5 seconds after its build is shown by Rust, so a page
  that fails to render does not leave a hidden window for good. Each build has a number, and a
  timer of an earlier window does not act on a newer one.
- The export and quit dialogs of the main window covered its title bar. (Changed on 2026-10-02:
  their scrim now starts below the title bar, and the main window moves while they are open, ADR
  020.)
- The built application must confirm: the placement on a second monitor with another scale, the
  native caption in each theme on Windows, the close prompt from each way to close, the quit with
  a draft open in Settings, and that every command of each window still answers under the
  grants.
