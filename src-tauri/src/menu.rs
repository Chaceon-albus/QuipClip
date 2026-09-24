//! The macOS application menu (ADR 027).
//!
//! Tauri builds a default macOS menu when the application supplies none. Its Quit item sends
//! `terminate:`, and with tauri 2.11 and tao 0.35 that raises only `RunEvent::Exit`, which no
//! handler can prevent. `Cmd+Q` would then skip the quit confirmation, and it would skip the
//! export cancel of ADR 017, which acts on `RunEvent::ExitRequested`.
//!
//! This menu is the default menu with three changes. The Quit item is an ordinary item on
//! `Cmd+Q`, and [`handle_menu_event`] answers it with `exit(0)`. That call raises
//! `ExitRequested`, so the quit goes through the gate in `commands::quit` and the dialog of
//! the frontend. The application submenu also gets Show All, which the default menu omits and
//! the standard macOS application menu has. And the menu holds the commands of the
//! application: Settings in the application submenu, and Open Media and Export in the File
//! submenu.
//!
//! # The command items
//!
//! A command item is an ordinary item. It sends [`MENU_ACTION_EVENT`] with the name of its
//! action, and Rust decides nothing else. The frontend runs that action with the conditions of
//! the window keyboard layer (ADR 026), and it does nothing while a dialog or a menu of the
//! page is open. The items stay enabled, as the Quit item does, because only the frontend knows
//! whether the action can run.
//!
//! Each item carries the accelerator of its row in the key table of ADR 026. The key press
//! goes to the page first. `WKWebView` takes every key equivalent while it is the first
//! responder, and it sends the key press to the page. It gives the key press back to AppKit,
//! and so to this menu, only when the page did not cancel it. The keyboard layer cancels every
//! key press that it acts on. One key press therefore runs the action once: through the layer
//! when the page cancels it, and through this menu when the page does not. If a later AppKit,
//! WebKit or wry gave the menu the key press first, the page would not get it, and the action
//! would still run once.
//!
//! # Language
//!
//! The labels are English, as the labels of the default menu are. The macOS menu does not
//! follow the language of the interface (ADR 011).
//!
//! Windows has no application menu. Tauri builds the default menu only on macOS, and this
//! module is compiled only there.

use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Runtime};

/// The identifier of the Quit item. [`handle_menu_event`] matches events on it.
const QUIT_MENU_ITEM_ID: &str = "quipclip.quit";

/// The accelerator of the Quit item. It is the accelerator of the default Quit item.
const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

/// The event that a command item sends to the frontend. Its payload is the name of the action,
/// one of the `action` values of [`COMMAND_ITEMS`].
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.MENU_ACTION`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const MENU_ACTION_EVENT: &str = "app:menu-action";

/// One menu item that runs a command of the frontend.
struct CommandItem {
    /// The identifier of the item. [`handle_menu_event`] matches events on it.
    id: &'static str,
    /// The label. It is the label of the same action in the File menu of the title bar, in
    /// English.
    label: &'static str,
    /// The accelerator. It is the key of the same action in the key table of ADR 026.
    accelerator: &'static str,
    /// The name of the action in the payload of [`MENU_ACTION_EVENT`]. It is the name of the
    /// action in `src/components/layout/shortcutBindings.ts`.
    action: &'static str,
}

/// Settings, in the application submenu.
const SETTINGS_ITEM: CommandItem = CommandItem {
    id: "quipclip.settings",
    label: "Settings...",
    accelerator: "CmdOrCtrl+,",
    action: "openSettings",
};

/// Open Media, in the File submenu.
const OPEN_MEDIA_ITEM: CommandItem = CommandItem {
    id: "quipclip.open-media",
    label: "Open Media...",
    accelerator: "CmdOrCtrl+O",
    action: "openMedia",
};

/// Export, in the File submenu.
const EXPORT_ITEM: CommandItem = CommandItem {
    id: "quipclip.export",
    label: "Export...",
    accelerator: "CmdOrCtrl+E",
    action: "export",
};

/// Every command item. [`menu_action_for`] reads this list.
const COMMAND_ITEMS: [&CommandItem; 3] = [&SETTINGS_ITEM, &OPEN_MEDIA_ITEM, &EXPORT_ITEM];

/// Builds the menu item of one command. The item is always enabled (see the module comment).
fn command_menu_item<R: Runtime>(
    handle: &AppHandle<R>,
    item: &CommandItem,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(handle, item.id, item.label, true, Some(item.accelerator))
}

/// Builds the application menu. It is the menu that `tauri::menu::Menu::default` builds on
/// macOS, with the Quit item replaced, Show All added, and the command items added.
///
/// The application submenu has the standard macOS order: About, Settings, Services, the Hide
/// and Show items, and Quit. The File submenu has Open Media, Export, and Close Window. Close
/// Window is the predefined item of the default File submenu. It raises the close request of
/// the window, so the quit decision of ADR 027 still runs.
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
            &command_menu_item(handle, &SETTINGS_ITEM)?,
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
        &[
            &command_menu_item(handle, &OPEN_MEDIA_ITEM)?,
            &command_menu_item(handle, &EXPORT_ITEM)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
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

/// Answers a menu event. The Quit item asks for an exit, which raises `ExitRequested`. A
/// command item sends [`MENU_ACTION_EVENT`] with the name of its action.
///
/// A click and a key equivalent raise the same event, so this function cannot tell them apart.
/// It does not need to, because the frontend applies the same conditions to both.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if is_quit_item(id) {
        app.exit(0);
        return;
    }
    if let Some(action) = menu_action_for(id) {
        // The event goes to the main window only, because its frontend runs the commands. An
        // event that cannot be sent loses one click or one key press. The user can do it
        // again, so the failure goes to the log only.
        if let Err(error) = app.emit_to(crate::MAIN_WINDOW_LABEL, MENU_ACTION_EVENT, action) {
            eprintln!("menu: the {action} action was not sent: {error}");
        }
    }
}

/// True for the identifier of the Quit item.
fn is_quit_item(id: &str) -> bool {
    id == QUIT_MENU_ITEM_ID
}

/// The action name of the command item with this identifier, or `None` for every other item.
fn menu_action_for(id: &str) -> Option<&'static str> {
    COMMAND_ITEMS
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.action)
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
        // A command item runs a command of the frontend. It must not end the application.
        for item in COMMAND_ITEMS {
            assert!(!is_quit_item(item.id));
        }
    }

    #[test]
    fn each_command_item_sends_the_action_of_its_key() {
        // The names are the actions of the key table in `shortcutBindings.ts`, so the frontend
        // runs the same command for the item as for the key.
        assert_eq!(menu_action_for(OPEN_MEDIA_ITEM.id), Some("openMedia"));
        assert_eq!(menu_action_for(EXPORT_ITEM.id), Some("export"));
        assert_eq!(menu_action_for(SETTINGS_ITEM.id), Some("openSettings"));
    }

    #[test]
    fn no_other_item_sends_an_action() {
        assert_eq!(menu_action_for(QUIT_MENU_ITEM_ID), None);
        assert_eq!(menu_action_for(WINDOW_SUBMENU_ID), None);
        assert_eq!(menu_action_for(HELP_SUBMENU_ID), None);
        assert_eq!(menu_action_for(""), None);
        // An action name is not an identifier.
        assert_eq!(menu_action_for("openMedia"), None);
    }

    #[test]
    fn the_command_items_are_distinct() {
        for (index, item) in COMMAND_ITEMS.iter().enumerate() {
            assert_ne!(item.id, QUIT_MENU_ITEM_ID);
            assert_ne!(item.accelerator, QUIT_ACCELERATOR);
            for other in &COMMAND_ITEMS[index + 1..] {
                assert_ne!(item.id, other.id);
                assert_ne!(item.action, other.action);
                assert_ne!(item.accelerator, other.accelerator);
            }
        }
    }

    #[test]
    fn the_accelerators_are_the_keys_of_adr_026() {
        // `primary` is Cmd on macOS, and `CmdOrCtrl` names it. The key table binds O, E and
        // the comma with `primary` and with no other modifier.
        assert_eq!(OPEN_MEDIA_ITEM.accelerator, "CmdOrCtrl+O");
        assert_eq!(EXPORT_ITEM.accelerator, "CmdOrCtrl+E");
        assert_eq!(SETTINGS_ITEM.accelerator, "CmdOrCtrl+,");
    }

    #[test]
    fn the_labels_are_the_labels_of_the_title_bar_menu() {
        // `titleBar.menu.openMedia` and `titleBar.menu.export` in `src/i18n/locales/en.ts`.
        // The settings item has no title bar entry, and its label is the standard one.
        assert_eq!(OPEN_MEDIA_ITEM.label, "Open Media...");
        assert_eq!(EXPORT_ITEM.label, "Export...");
        assert_eq!(SETTINGS_ITEM.label, "Settings...");
    }
}
