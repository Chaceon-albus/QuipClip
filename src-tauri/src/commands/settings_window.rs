//! The Settings window.
//!
//! Settings is a window of its own, not a dialog in the main window. It has the system title
//! bar on both platforms, there is at most one of it, and the user can move and use it and the
//! main window at the same time. It loads the same page as the main window, and the page reads
//! the window label to render the settings view.
//!
//! # Opening
//!
//! [`open_settings_window`] opens the window, or brings the open one forward. A caller can name
//! a tab and a preset. The request goes into [`SettingsWindowState`], and the page takes it
//! with [`take_settings_window_request`] when it mounts and on each [`NAVIGATE_EVENT`]. A
//! request is therefore never lost while the page loads: the event of a page that is not yet
//! listening goes nowhere, and the page takes the request when it mounts.
//!
//! A new request replaces a request that the page did not take yet, so the latest opening wins.
//!
//! An opening while the page still loads leaves the window hidden: the first render of the
//! page shows and focuses it ([`step_for_existing_window`]), so the window never shows a blank
//! web view.
//!
//! The command is `async`. Tauri runs a synchronous command on the main thread, and on Windows
//! a window build on that thread waits for the event loop that the command blocks. The macOS
//! menu item reaches the same code through [`open_from_menu`], which runs it on the async
//! runtime for the same reason.
//!
//! # The window
//!
//! The window has no parent on either platform. A macOS child window moves with its parent,
//! and a Windows owned window stays above its owner, where it would cover the prompts of the
//! main window. It starts hidden, and the page shows it after its first render, so the window
//! never shows an empty web view. It opens centred on the main window and inside the work area
//! of that monitor ([`centred_position`]).
//!
//! The page closes the window through [`close_settings_window`] and not through the window
//! commands of Tauri. Those commands act on any label that the caller names, so a capability
//! that let the page destroy its own window would also let it destroy the main window, and the
//! application would end with no quit decision (ADR 027).

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Runtime, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// The label of the Settings window. `capabilities/settings.json` grants its permissions to
/// this label, and no configuration file names it, because Rust builds the window on request.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// The event that tells the page of the Settings window to take the pending request. Its
/// payload is empty.
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.SETTINGS_WINDOW_NAVIGATE`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const NAVIGATE_EVENT: &str = "settings-window:navigate";

/// The event that carries the name of the unsaved preset draft of the Settings window to the
/// main window, whose quit guard names it (ADR 027). Its payload is [`SettingsWindowDraft`].
/// Rust sends it for each report of the page ([`report_settings_draft`]), and with no name
/// when the window is destroyed ([`report_draft_cleared`]), so the main window never names
/// the draft of a window that is gone.
///
/// The page holds no emit permission: an emit could send any event to the main window, such
/// as the quit request of ADR 027. It reports through the command, and Rust sends the event.
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.SETTINGS_WINDOW_DRAFT`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const DRAFT_EVENT: &str = "settings-window:draft";

/// The longest draft name that a report carries, in characters: the longest preset name that
/// the settings file takes (ADR 013). A longer name, such as one that the user is still typing,
/// is cut to this length, so the quit prompt still names the draft.
const MAX_DRAFT_NAME_CHARS: usize = crate::settings::MAX_PRESET_NAME_CHARS;

/// The name that a draft report carries: the name of the page, cut to
/// [`MAX_DRAFT_NAME_CHARS`] characters.
fn bounded_draft_name(name: Option<String>) -> Option<String> {
    name.map(|name| name.chars().take(MAX_DRAFT_NAME_CHARS).collect())
}

/// The payload of [`DRAFT_EVENT`]. `src/features/settings/settingsWindowDraft.ts` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWindowDraft<'a> {
    /// The name of the unsaved draft, or `None` when no draft holds an unsaved edit.
    pub name: Option<&'a str>,
    /// The label of the window that the report is about.
    pub origin: &'a str,
}

/// Tells the main window that the Settings window holds no unsaved draft, because it was
/// destroyed. A destroy runs no page code, so the page cannot send this itself. A failed emit
/// leaves the main window naming a draft that is gone, which costs one question at a quit.
pub fn report_draft_cleared<R: Runtime>(app: &AppHandle<R>) {
    let payload = SettingsWindowDraft {
        name: None,
        origin: SETTINGS_WINDOW_LABEL,
    };
    if let Err(error) = app.emit_to(crate::MAIN_WINDOW_LABEL, DRAFT_EVENT, payload) {
        eprintln!("settings window: the cleared draft was not reported: {error}");
    }
}

/// Sends the name of the unsaved preset draft of the Settings window, or `None`, to the main
/// window. Only the page of the Settings window reports a draft, so a call from another window
/// sends nothing.
///
/// The command is synchronous on purpose. Tauri runs each `async` command as its own task on a
/// runtime with several threads, so two reports close together could reach the main window in
/// the wrong order, and a late `None` would hide an unsaved draft from the quit guard. An emit
/// only queues the event, so it is safe inside the IPC callback, unlike the destroy of
/// [`close_settings_window`].
#[tauri::command]
pub fn report_settings_draft(app: AppHandle, window: WebviewWindow, name: Option<String>) {
    if !is_settings_window(window.label()) {
        return;
    }
    let name = bounded_draft_name(name);
    let payload = SettingsWindowDraft {
        name: name.as_deref(),
        origin: SETTINGS_WINDOW_LABEL,
    };
    if let Err(error) = app.emit_to(crate::MAIN_WINDOW_LABEL, DRAFT_EVENT, payload) {
        eprintln!("settings window: the draft was not reported: {error}");
    }
}

/// How long a new Settings window may stay hidden before Rust shows it. The page shows the
/// window after its first render, which takes a fraction of a second. A page that never
/// renders, for example after a script error, would otherwise leave a hidden window for good,
/// and every later opening would find it and do nothing.
const REVEAL_FALLBACK_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether the fallback shows the window: it is still hidden and not minimized, and it is the
/// window that the fallback was started for, not a later window with the same label.
fn should_reveal_after_delay(
    started_for_build: u64,
    current_build: u64,
    visible: bool,
    minimized: bool,
) -> bool {
    started_for_build == current_build && !visible && !minimized
}

/// Shows the new window after [`REVEAL_FALLBACK_DELAY`] if its page did not show it. It runs
/// on a thread of its own, because it only waits and then makes two window calls.
fn start_reveal_fallback<R: Runtime>(app: &AppHandle<R>, build: u64) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("settings-window-reveal".to_owned())
        .spawn(move || {
            std::thread::sleep(REVEAL_FALLBACK_DELAY);
            let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) else {
                return;
            };
            let current_build = app.state::<SettingsWindowState>().current_build();
            if should_reveal_after_delay(
                build,
                current_build,
                window.is_visible().unwrap_or(true),
                window.is_minimized().unwrap_or(false),
            ) {
                eprintln!("settings window: the page did not show the window; showing it");
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    if let Err(error) = spawned {
        eprintln!("settings window: the reveal fallback did not start: {error}");
    }
}

/// The title until the page sets the localized one. It is the English catalog text of
/// `settings.title`.
const INITIAL_TITLE: &str = "Settings";

/// The size of the web view when the window opens, in logical pixels.
const INITIAL_INNER_SIZE: LogicalSize<f64> = LogicalSize {
    width: 760.0,
    height: 640.0,
};

/// The smallest size of the web view, in logical pixels. The preset tab needs this width for
/// its list and its editor side by side.
const MIN_INNER_SIZE: LogicalSize<f64> = LogicalSize {
    width: 640.0,
    height: 480.0,
};

/// The tabs of the Settings window. `src/features/settings/panelStore.ts` lists the same
/// names in `SETTINGS_SECTIONS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSection {
    General,
    Ffmpeg,
    Presets,
}

impl SettingsSection {
    /// Reads a section name that the frontend sent, or `None` for any other text.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "general" => Some(Self::General),
            "ffmpeg" => Some(Self::Ffmpeg),
            "presets" => Some(Self::Presets),
            _ => None,
        }
    }
}

/// What the page of the Settings window shows when it takes the request: a tab, a preset of
/// the Presets tab, both, or neither. A request with neither only brings the window forward.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWindowRequest {
    pub section: Option<SettingsSection>,
    pub preset_id: Option<String>,
}

impl SettingsWindowRequest {
    /// Builds a request from the arguments of [`open_settings_window`]. An unknown section
    /// name is an error, so a fault in a caller shows instead of opening the wrong tab.
    pub fn from_arguments(
        section: Option<&str>,
        preset_id: Option<String>,
    ) -> Result<Self, SettingsWindowError> {
        let section = match section {
            None => None,
            Some(name) => Some(SettingsSection::parse(name).ok_or_else(|| {
                SettingsWindowError::new(SettingsWindowErrorCode::InvalidSection)
            })?),
        };
        Ok(Self { section, preset_id })
    }
}

/// Managed state: the request that the page did not take yet, and the lock that serializes
/// the openings.
#[derive(Debug, Default)]
pub struct SettingsWindowState {
    pending: Mutex<Option<SettingsWindowRequest>>,
    /// Held for one whole opening. Two openings at the same time would otherwise both find no
    /// window and both build one, and the second build fails on the label. The opening has no
    /// await point, so a plain mutex is correct, and the main thread never takes it.
    opening: Mutex<()>,
    /// Counts the windows that an opening built, so a reveal fallback acts only on the window
    /// that it was started for.
    builds: AtomicU64,
}

impl SettingsWindowState {
    /// Counts one more built window, and returns its number.
    fn next_build(&self) -> u64 {
        self.builds.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The number of the last built window.
    fn current_build(&self) -> u64 {
        self.builds.load(Ordering::SeqCst)
    }

    /// Replaces the pending request.
    pub fn store(&self, request: SettingsWindowRequest) {
        *lock(&self.pending) = Some(request);
    }

    /// Returns the pending request and clears it, so the page applies each request once.
    pub fn take(&self) -> Option<SettingsWindowRequest> {
        lock(&self.pending).take()
    }
}

/// Locks a mutex, and keeps its value when a thread panicked while it held the lock. The
/// values here are plain data that a panic cannot leave half written.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Stable error codes of the Settings window commands (ADR 011). The frontend logs them; the
/// window has no message of its own to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsWindowErrorCode {
    /// The section is not one of the names of [`SettingsSection`].
    InvalidSection,
    /// Tauri could not build the window.
    WindowUnavailable,
}

/// The rejection of [`open_settings_window`]. `detail` is the untranslated diagnostic of a
/// failed build, which can fail in ways that are not worth a code each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWindowError {
    pub code: SettingsWindowErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl SettingsWindowError {
    fn new(code: SettingsWindowErrorCode) -> Self {
        Self { code, detail: None }
    }
}

/// Opens the Settings window on `section` and `preset_id`, or brings the open window forward
/// and sends it the request. See the module comment.
#[tauri::command]
pub async fn open_settings_window(
    app: AppHandle,
    section: Option<String>,
    preset_id: Option<String>,
) -> Result<(), SettingsWindowError> {
    let request = SettingsWindowRequest::from_arguments(section.as_deref(), preset_id)?;
    open(&app, request)
}

/// Returns the pending request and clears it. Only the page of the Settings window takes the
/// request, so a call from another window returns nothing and leaves the request in place.
#[tauri::command]
pub fn take_settings_window_request(
    window: WebviewWindow,
    state: State<'_, SettingsWindowState>,
) -> Option<SettingsWindowRequest> {
    if !is_settings_window(window.label()) {
        return None;
    }
    state.take()
}

/// Closes the window that calls it, with no close request, when that window is the Settings
/// window, and does nothing for any other window. The page calls it after its close decision:
/// the draft holds no unsaved edit, or the user answered the unsaved-changes prompt. It takes
/// no label, so no page can name the main window here (see the module comment).
///
/// The command is `async`, as the destroy command of the window plugin is. A synchronous
/// command runs on the main thread, inside the IPC callback of the web view that it destroys,
/// and on that thread the runtime can act on the window at once. On the async runtime the
/// destroy reaches the event loop as a message, after the callback has returned.
#[tauri::command]
pub async fn close_settings_window(window: WebviewWindow) {
    if !is_settings_window(window.label()) {
        return;
    }
    if let Err(error) = window.destroy() {
        eprintln!("settings window: the window was not closed: {error}");
    }
}

/// True for the label of the Settings window.
fn is_settings_window(label: &str) -> bool {
    label == SETTINGS_WINDOW_LABEL
}

/// What an opening does to a Settings window that already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingWindowStep {
    /// The window is minimized: restore it and give it the focus.
    Restore,
    /// The window shows: give it the focus.
    Raise,
    /// The window is still hidden, because its page has not rendered yet. The first render
    /// shows it and gives it the focus, and a show now would show a blank web view.
    LeaveToPage,
}

/// The step for a window in this state. A minimized window counts first, because macOS reports
/// a minimized window as not visible.
fn step_for_existing_window(minimized: bool, visible: bool) -> ExistingWindowStep {
    if minimized {
        ExistingWindowStep::Restore
    } else if visible {
        ExistingWindowStep::Raise
    } else {
        ExistingWindowStep::LeaveToPage
    }
}

/// Opens the window for the Settings item of the macOS menu, with no tab and no preset. The
/// menu handler runs on the main thread, so the opening runs on the async runtime, as the
/// command does. A failure goes to the log only: the user can choose the item again.
#[cfg(target_os = "macos")]
pub fn open_from_menu<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open(&app, SettingsWindowRequest::default()) {
            eprintln!("settings window: the window did not open: {error:?}");
        }
    });
}

/// The body of [`open_settings_window`] and [`open_from_menu`]. It must not run on the main
/// thread (see the module comment).
fn open<R: Runtime>(
    app: &AppHandle<R>,
    request: SettingsWindowRequest,
) -> Result<(), SettingsWindowError> {
    let state = app.state::<SettingsWindowState>();
    let _opening = lock(&state.opening);
    state.store(request);

    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        // Each step is best effort. A window that does not come forward is still open, and
        // the user can find it in the Window menu or the task bar. A state that cannot be read
        // counts as a window that shows.
        match step_for_existing_window(
            window.is_minimized().unwrap_or(false),
            window.is_visible().unwrap_or(true),
        ) {
            ExistingWindowStep::Restore => {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            ExistingWindowStep::Raise => {
                let _ = window.set_focus();
            }
            ExistingWindowStep::LeaveToPage => {}
        }
        // A page that is still loading takes the request when it mounts instead.
        if let Err(error) = app.emit_to(SETTINGS_WINDOW_LABEL, NAVIGATE_EVENT, ()) {
            eprintln!("settings window: the navigate event was not sent: {error}");
        }
        return Ok(());
    }

    // The number of this build is taken before the build, so the timer of an earlier window
    // that fires while this one is built already sees a newer number and leaves it alone.
    let build = state.next_build();
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(INITIAL_TITLE)
    .inner_size(INITIAL_INNER_SIZE.width, INITIAL_INNER_SIZE.height)
    .min_inner_size(MIN_INNER_SIZE.width, MIN_INNER_SIZE.height)
    .resizable(true)
    .maximizable(false)
    // The page shows the window after its first render.
    .visible(false)
    // The page takes no file drops. With the handler on, a drop would reach no listener, and
    // on Windows the handler also turns off the drag and drop of the page.
    .disable_drag_drop_handler()
    // The fallback when the main window cannot be measured. `place_over_main_window` moves
    // the window before it shows.
    .center()
    .build()
    .map_err(|error| SettingsWindowError {
        code: SettingsWindowErrorCode::WindowUnavailable,
        detail: Some(error.to_string()),
    })?;

    place_over_main_window(app, &window);
    start_reveal_fallback(app, build);
    Ok(())
}

/// Moves a new Settings window to the centre of the main window, inside the work area of the
/// monitor of the main window. It leaves the window where the builder put it when the main
/// window is missing or minimized, or when a measurement fails.
fn place_over_main_window<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return;
    };
    if main.is_minimized().unwrap_or(true) {
        return;
    }
    let placement = match measure_placement(&main, window) {
        Ok(Some(placement)) => placement,
        Ok(None) => return,
        Err(error) => {
            eprintln!("settings window: the main window was not measured: {error}");
            return;
        }
    };
    let (x, y) = centred_position(placement.owner, placement.size, placement.work_area);
    if let Err(error) = window.set_position(platform_position(x, y, placement.monitor_scale)) {
        eprintln!("settings window: the window was not moved: {error}");
    }
}

/// What [`centred_position`] needs, in pixels of the monitor of the main window.
struct Placement {
    owner: PixelRect,
    size: PixelSize,
    work_area: PixelRect,
    monitor_scale: f64,
}

/// Measures the main window, its monitor, and the new window. Returns `None` when the main
/// window is on no monitor that the system reports.
fn measure_placement<R: Runtime>(
    main: &WebviewWindow<R>,
    window: &WebviewWindow<R>,
) -> tauri::Result<Option<Placement>> {
    let Some(monitor) = main.current_monitor()? else {
        return Ok(None);
    };
    let monitor_scale = monitor.scale_factor();
    let owner_position = main.outer_position()?;
    let owner_size = main.outer_size()?;
    // The new window can be on another monitor than the main window, with another scale. Its
    // size in pixels of the monitor of the main window is the size that it will have there.
    let size = window
        .outer_size()?
        .to_logical::<f64>(window.scale_factor()?)
        .to_physical::<u32>(monitor_scale);
    let work_area = monitor.work_area();
    Ok(Some(Placement {
        owner: PixelRect {
            x: owner_position.x,
            y: owner_position.y,
            width: owner_size.width,
            height: owner_size.height,
        },
        size: PixelSize {
            width: size.width,
            height: size.height,
        },
        work_area: PixelRect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        monitor_scale,
    }))
}

/// Converts a position in pixels of the monitor of the main window into the position that
/// this platform places correctly.
///
/// Windows places a window in one space of pixels for every monitor, so the pixels go as they
/// are. macOS places it in one space of points, and tao converts a position in pixels with the
/// scale of the window that it moves, which can differ from the scale of the monitor that the
/// numbers came from. The position therefore goes as points, converted with that monitor's
/// scale.
fn platform_position(x: i32, y: i32, monitor_scale: f64) -> Position {
    let position = PhysicalPosition::new(x, y);
    if cfg!(target_os = "macos") {
        Position::Logical(position.to_logical(monitor_scale))
    } else {
        Position::Physical(position)
    }
}

/// A rectangle in pixels of one monitor: a window frame or a work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PixelRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// A size in pixels of one monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PixelSize {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// The top left corner of a window of `size` that is centred on `owner`, moved as little as
/// possible to stay inside `work_area`.
///
/// On each axis the window first centres on the owner. When that puts an edge outside the work
/// area, the window moves back inside it. A window larger than the work area keeps its top
/// left corner at the corner of the work area, so its title bar stays on the screen.
pub(crate) fn centred_position(
    owner: PixelRect,
    size: PixelSize,
    work_area: PixelRect,
) -> (i32, i32) {
    let axis = |owner_start: i32,
                owner_length: u32,
                length: u32,
                area_start: i32,
                area_length: u32|
     -> i32 {
        // i64, so no sum of an i32 and a u32 can overflow.
        let centred = i64::from(owner_start) + (i64::from(owner_length) - i64::from(length)) / 2;
        let lowest = i64::from(area_start);
        let highest = lowest + i64::from(area_length) - i64::from(length);
        let placed = if highest < lowest {
            lowest
        } else {
            centred.clamp(lowest, highest)
        };
        // The result lies between two values that came from an i32, except for `centred`,
        // which the clamp bounded.
        i32::try_from(placed).unwrap_or(area_start)
    };
    (
        axis(
            owner.x,
            owner.width,
            size.width,
            work_area.x,
            work_area.width,
        ),
        axis(
            owner.y,
            owner.height,
            size.height,
            work_area.y,
            work_area.height,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_AREA: PixelRect = PixelRect {
        x: 0,
        y: 25,
        width: 1920,
        height: 1055,
    };

    const SETTINGS_SIZE: PixelSize = PixelSize {
        width: 760,
        height: 668,
    };

    #[test]
    fn the_three_section_names_parse_and_nothing_else_does() {
        assert_eq!(
            SettingsSection::parse("general"),
            Some(SettingsSection::General)
        );
        assert_eq!(
            SettingsSection::parse("ffmpeg"),
            Some(SettingsSection::Ffmpeg)
        );
        assert_eq!(
            SettingsSection::parse("presets"),
            Some(SettingsSection::Presets)
        );
        for name in ["", "General", "FFmpeg", "preset", " presets", "about"] {
            assert_eq!(SettingsSection::parse(name), None, "{name:?}");
        }
    }

    #[test]
    fn a_section_serializes_to_the_name_it_parses_from() {
        for section in [
            SettingsSection::General,
            SettingsSection::Ffmpeg,
            SettingsSection::Presets,
        ] {
            let wire = serde_json::to_value(section).expect("a section serializes");
            let name = wire.as_str().expect("a section is a string");
            assert_eq!(SettingsSection::parse(name), Some(section));
        }
    }

    #[test]
    fn a_request_is_built_from_the_arguments_and_refuses_an_unknown_section() {
        assert_eq!(
            SettingsWindowRequest::from_arguments(Some("presets"), Some("p2".to_owned())),
            Ok(SettingsWindowRequest {
                section: Some(SettingsSection::Presets),
                preset_id: Some("p2".to_owned()),
            })
        );
        assert_eq!(
            SettingsWindowRequest::from_arguments(None, None),
            Ok(SettingsWindowRequest::default())
        );
        assert_eq!(
            SettingsWindowRequest::from_arguments(Some("export"), None),
            Err(SettingsWindowError::new(
                SettingsWindowErrorCode::InvalidSection
            ))
        );
    }

    #[test]
    fn a_request_serializes_in_camel_case_with_null_for_an_absent_value() {
        let request = SettingsWindowRequest {
            section: Some(SettingsSection::Ffmpeg),
            preset_id: None,
        };
        assert_eq!(
            serde_json::to_value(request).expect("a request serializes"),
            serde_json::json!({ "section": "ffmpeg", "presetId": null })
        );
    }

    #[test]
    fn the_error_codes_serialize_to_stable_camel_case_strings() {
        assert_eq!(
            serde_json::to_value(SettingsWindowError::new(
                SettingsWindowErrorCode::InvalidSection
            ))
            .expect("an error serializes"),
            serde_json::json!({ "code": "invalidSection" })
        );
        assert_eq!(
            serde_json::to_value(SettingsWindowError {
                code: SettingsWindowErrorCode::WindowUnavailable,
                detail: Some("no event loop".to_owned()),
            })
            .expect("an error serializes"),
            serde_json::json!({ "code": "windowUnavailable", "detail": "no event loop" })
        );
    }

    #[test]
    fn a_cleared_draft_names_no_preset_and_the_settings_window() {
        // `validateSettingsWindowDraftPayload` in the frontend reads exactly these two keys.
        let payload = SettingsWindowDraft {
            name: None,
            origin: SETTINGS_WINDOW_LABEL,
        };
        assert_eq!(
            serde_json::to_value(payload).expect("a draft report serializes"),
            serde_json::json!({ "name": null, "origin": "settings" })
        );
    }

    #[test]
    fn only_the_settings_window_may_take_a_request_or_close_itself() {
        assert!(is_settings_window(SETTINGS_WINDOW_LABEL));
        assert!(!is_settings_window(crate::MAIN_WINDOW_LABEL));
        assert!(!is_settings_window(""));
        assert!(!is_settings_window("Settings"));
    }

    #[test]
    fn an_opening_restores_a_minimized_window_and_raises_a_shown_one() {
        assert_eq!(
            step_for_existing_window(true, false),
            ExistingWindowStep::Restore
        );
        assert_eq!(
            step_for_existing_window(true, true),
            ExistingWindowStep::Restore
        );
        assert_eq!(
            step_for_existing_window(false, true),
            ExistingWindowStep::Raise
        );
    }

    #[test]
    fn an_opening_leaves_a_window_whose_page_has_not_rendered_to_that_page() {
        // A show now would show a blank web view. The first render shows and focuses it.
        assert_eq!(
            step_for_existing_window(false, false),
            ExistingWindowStep::LeaveToPage
        );
    }

    #[test]
    fn a_draft_name_is_cut_to_the_longest_preset_name() {
        assert_eq!(bounded_draft_name(None), None);
        assert_eq!(bounded_draft_name(Some(String::new())), Some(String::new()));
        assert_eq!(
            bounded_draft_name(Some("Web 1080p".to_owned())),
            Some("Web 1080p".to_owned())
        );
        // Characters, not bytes, so a name in another script is cut on a character.
        let long = "\u{9884}".repeat(MAX_DRAFT_NAME_CHARS + 50);
        let cut = bounded_draft_name(Some(long)).expect("a name stays a name");
        assert_eq!(cut.chars().count(), MAX_DRAFT_NAME_CHARS);
    }

    #[test]
    fn a_draft_report_names_the_preset_and_the_settings_window() {
        let payload = SettingsWindowDraft {
            name: Some("Archive"),
            origin: SETTINGS_WINDOW_LABEL,
        };
        assert_eq!(
            serde_json::to_value(payload).expect("a draft report serializes"),
            serde_json::json!({ "name": "Archive", "origin": "settings" })
        );
    }

    #[test]
    fn the_fallback_shows_only_a_window_that_is_still_hidden() {
        assert!(should_reveal_after_delay(1, 1, false, false));
        // The page showed it, or the user minimized it.
        assert!(!should_reveal_after_delay(1, 1, true, false));
        assert!(!should_reveal_after_delay(1, 1, false, true));
    }

    #[test]
    fn the_fallback_leaves_a_later_window_alone() {
        // The window was closed and opened again within the delay. The new window has a
        // fallback of its own.
        assert!(!should_reveal_after_delay(1, 2, false, false));
    }

    #[test]
    fn the_build_counter_numbers_each_window() {
        let state = SettingsWindowState::default();
        assert_eq!(state.current_build(), 0);
        assert_eq!(state.next_build(), 1);
        assert_eq!(state.next_build(), 2);
        assert_eq!(state.current_build(), 2);
    }

    #[test]
    fn take_returns_the_request_once_and_then_nothing() {
        let state = SettingsWindowState::default();
        assert_eq!(state.take(), None);

        let request = SettingsWindowRequest {
            section: Some(SettingsSection::Presets),
            preset_id: Some("p1".to_owned()),
        };
        state.store(request.clone());
        assert_eq!(state.take(), Some(request));
        assert_eq!(state.take(), None);
    }

    #[test]
    fn a_new_request_replaces_one_that_was_not_taken() {
        let state = SettingsWindowState::default();
        state.store(SettingsWindowRequest {
            section: Some(SettingsSection::Presets),
            preset_id: Some("p1".to_owned()),
        });
        state.store(SettingsWindowRequest::default());
        assert_eq!(state.take(), Some(SettingsWindowRequest::default()));
        assert_eq!(state.take(), None);
    }

    #[test]
    fn the_window_centres_on_the_main_window() {
        let owner = PixelRect {
            x: 200,
            y: 100,
            width: 1440,
            height: 900,
        };
        // (1440 - 760) / 2 = 340, and (900 - 668) / 2 = 116.
        assert_eq!(
            centred_position(owner, SETTINGS_SIZE, WORK_AREA),
            (540, 216)
        );
    }

    #[test]
    fn a_window_that_would_leave_the_work_area_moves_back_inside_it() {
        // The main window hangs over the right and the bottom edges.
        let owner = PixelRect {
            x: 1500,
            y: 800,
            width: 1440,
            height: 900,
        };
        assert_eq!(
            centred_position(owner, SETTINGS_SIZE, WORK_AREA),
            (1920 - 760, 25 + 1055 - 668)
        );

        // The main window hangs over the left edge and above the work area, for example
        // under the macOS menu bar.
        let owner = PixelRect {
            x: -1300,
            y: -500,
            width: 1440,
            height: 900,
        };
        assert_eq!(centred_position(owner, SETTINGS_SIZE, WORK_AREA), (0, 25));
    }

    #[test]
    fn a_small_main_window_still_gets_the_centred_settings_window() {
        // The settings window is larger than the main window, so it centres around it.
        let owner = PixelRect {
            x: 600,
            y: 300,
            width: 400,
            height: 300,
        };
        assert_eq!(
            centred_position(owner, SETTINGS_SIZE, WORK_AREA),
            (600 - 180, 300 - 184)
        );
    }

    #[test]
    fn a_window_larger_than_the_work_area_keeps_its_top_left_corner_inside() {
        let owner = PixelRect {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        let work_area = PixelRect {
            x: 1920,
            y: 0,
            width: 700,
            height: 500,
        };
        assert_eq!(centred_position(owner, SETTINGS_SIZE, work_area), (1920, 0));
    }

    #[test]
    fn a_work_area_on_a_monitor_left_of_the_primary_one_is_respected() {
        // A monitor at negative coordinates, as Windows places a monitor left of the primary.
        let work_area = PixelRect {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1400,
        };
        let owner = PixelRect {
            x: -2400,
            y: 100,
            width: 1440,
            height: 900,
        };
        assert_eq!(
            centred_position(owner, SETTINGS_SIZE, work_area),
            (-2060, 216)
        );

        // The main window hangs over the left edge of that monitor.
        let owner = PixelRect { x: -3000, ..owner };
        assert_eq!(
            centred_position(owner, SETTINGS_SIZE, work_area),
            (-2560, 216)
        );
    }

    #[test]
    fn extreme_values_do_not_overflow() {
        let owner = PixelRect {
            x: i32::MAX,
            y: i32::MIN,
            width: u32::MAX,
            height: u32::MAX,
        };
        let work_area = PixelRect {
            x: i32::MAX - 100,
            y: i32::MIN,
            width: u32::MAX,
            height: 10,
        };
        let (x, y) = centred_position(owner, SETTINGS_SIZE, work_area);
        assert!(x >= i32::MAX - 100);
        assert_eq!(y, i32::MIN);
    }

    #[test]
    fn a_position_goes_to_macos_as_points_and_to_windows_as_pixels() {
        let position = platform_position(1000, 500, 2.0);
        if cfg!(target_os = "macos") {
            assert_eq!(
                position,
                Position::Logical(tauri::LogicalPosition::new(500.0, 250.0))
            );
        } else {
            assert_eq!(
                position,
                Position::Physical(PhysicalPosition::new(1000, 500))
            );
        }
    }
}
