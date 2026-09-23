//! The macOS application menu (ADR 027).
//!
//! Tauri builds a default macOS menu when the application supplies none. Its Quit item sends
//! `terminate:`, and with tauri 2.11 and tao 0.35 that raises only `RunEvent::Exit`, which no
//! handler can prevent. `Cmd+Q` would then skip the quit confirmation, and it would skip the
//! export cancel of ADR 017, which acts on `RunEvent::ExitRequested`.
//!
//! This menu is the default menu with two changes. The Quit item is an ordinary item on
//! `Cmd+Q`, and [`handle_menu_event`] answers it with `exit(0)`. That call raises
//! `ExitRequested`, so the quit goes through the gate in `commands::quit` and the dialog of
//! the frontend. The application submenu also gets Show All, which the default menu omits and
//! the standard macOS application menu has.
//!
//! Windows has no application menu. Tauri builds the default menu only on macOS, and this
//! module is compiled only there.

use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// The identifier of the Quit item. [`handle_menu_event`] matches events on it.
const QUIT_MENU_ITEM_ID: &str = "quipclip.quit";

/// The accelerator of the Quit item. It is the accelerator of the default Quit item.
const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

/// Builds the application menu. It is the menu that `tauri::menu::Menu::default` builds on
/// macOS, with the Quit item replaced and Show All added.
///
/// The Window and Help submenus keep the identifiers of the default menu. Tauri registers the
/// submenus with those identifiers as the Window menu and the Help menu of the application,
/// and macOS then adds the open windows and the help search to them.
pub fn build_app_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = handle.package_info();
    let config = handle.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    // The same label as the default Quit item: "Quit" and the application name.
    let quit = MenuItem::with_id(
        handle,
        QUIT_MENU_ITEM_ID,
        format!("Quit {}", package.name),
        true,
        Some(QUIT_ACCELERATOR),
    )?;

    let application_menu = Submenu::with_items(
        handle,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(handle, None)?],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(handle, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        handle,
        &[
            &application_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Answers a menu event. The Quit item asks for an exit, which raises `ExitRequested`.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if is_quit_item(event.id().as_ref()) {
        app.exit(0);
    }
}

/// True for the identifier of the Quit item.
fn is_quit_item(id: &str) -> bool {
    id == QUIT_MENU_ITEM_ID
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_quit_item_asks_for_an_exit() {
        assert!(is_quit_item(QUIT_MENU_ITEM_ID));
        // The predefined items carry identifiers that muda generates, and the submenus carry
        // the identifiers of tauri. None of them may end the application.
        assert!(!is_quit_item(WINDOW_SUBMENU_ID));
        assert!(!is_quit_item(HELP_SUBMENU_ID));
        assert!(!is_quit_item(""));
        assert!(!is_quit_item("quit"));
    }
}
