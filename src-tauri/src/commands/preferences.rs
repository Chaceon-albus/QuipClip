//! The preferences that live in web view storage, relayed from one window to the others.
//!
//! The theme, the interface language and the timecode format are not part of the settings
//! file: each window reads them from web view storage when it loads. When the Settings window
//! changes one, the other windows must apply it too. The page could emit an event itself, but
//! the emit permission of Tauri lets a page send any event to any window, including the quit
//! request of ADR 027 and the menu actions. So the Settings window holds no emit permission,
//! and it calls [`broadcast_preference`] instead. Rust checks the key and the value and sends
//! [`PREFERENCES_CHANGED_EVENT`] to every window, with the label of the calling window as the
//! origin, so a receiver can ignore its own change.

use serde::Serialize;
use tauri::{AppHandle, Emitter, WebviewWindow};

/// The event that carries one changed preference to every window. Its payload is
/// [`PreferenceChanged`].
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.PREFERENCES_CHANGED`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const PREFERENCES_CHANGED_EVENT: &str = "preferences:changed";

/// The values of the theme preference. `src/lib/theme.ts` lists the same values in
/// `THEME_PREFERENCES`, and `preferenceSync.test.ts` compares the two.
const THEME_VALUES: &[&str] = &["system", "light", "dark"];

/// The values of the language preference (ADR 011). `src/i18n/types.ts` lists the same values
/// in `LANGUAGE_PREFERENCES`.
const LANGUAGE_VALUES: &[&str] = &["system", "en", "zh-CN"];

/// The values of the timecode format (ADR 028). `src/lib/timecode.ts` lists the same values
/// in `TIMECODE_FORMATS`.
const TIMECODE_FORMAT_VALUES: &[&str] = &["frames", "milliseconds"];

/// The payload of [`PREFERENCES_CHANGED_EVENT`]. `validatePreferenceChangedPayload` in
/// `src/features/settings/preferenceSync.ts` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceChanged<'a> {
    /// `theme`, `language` or `timecodeFormat`.
    pub key: &'a str,
    /// One of the values of that key.
    pub value: &'a str,
    /// The label of the window that changed the preference.
    pub origin: &'a str,
}

/// Stable error codes of [`broadcast_preference`] (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreferenceErrorCode {
    /// The key is not a relayed preference, or the value is not one of its values.
    InvalidPreference,
}

/// The rejection of [`broadcast_preference`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceError {
    pub code: PreferenceErrorCode,
}

/// The values that `key` takes, or `None` for a key that is not relayed. The preview mute and
/// the timeline height belong to the main window alone and are not relayed.
fn values_of(key: &str) -> Option<&'static [&'static str]> {
    match key {
        "theme" => Some(THEME_VALUES),
        "language" => Some(LANGUAGE_VALUES),
        "timecodeFormat" => Some(TIMECODE_FORMAT_VALUES),
        _ => None,
    }
}

/// Accepts a relayed key with one of its values, and refuses every other pair.
pub fn validate_preference(key: &str, value: &str) -> Result<(), PreferenceError> {
    match values_of(key) {
        Some(values) if values.contains(&value) => Ok(()),
        _ => Err(PreferenceError {
            code: PreferenceErrorCode::InvalidPreference,
        }),
    }
}

/// Sends a preference that the calling window stored to every window, after it checked the
/// key and the value. The calling window ignores its own event.
///
/// The command is synchronous on purpose, so two changes close together reach every window in
/// the order of the calls. An `async` command runs as its own task on a runtime with several
/// threads and could reorder them. An emit only queues the event, so it is safe inside the IPC
/// callback.
#[tauri::command]
pub fn broadcast_preference(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    value: String,
) -> Result<(), PreferenceError> {
    validate_preference(&key, &value)?;
    let payload = PreferenceChanged {
        key: &key,
        value: &value,
        origin: window.label(),
    };
    // A failed emit leaves the other windows on their old value until they load again, which
    // the caller cannot repair, so it goes to the log only.
    if let Err(error) = app.emit(PREFERENCES_CHANGED_EVENT, payload) {
        eprintln!("preferences: the change was not sent: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_relayed_key_takes_exactly_its_values() {
        for (key, values) in [
            ("theme", THEME_VALUES),
            ("language", LANGUAGE_VALUES),
            ("timecodeFormat", TIMECODE_FORMAT_VALUES),
        ] {
            for value in values {
                assert_eq!(validate_preference(key, value), Ok(()), "{key} {value}");
            }
        }
        for (key, value) in [
            ("theme", "blue"),
            ("theme", "Dark"),
            ("language", "fr"),
            ("language", "zh"),
            ("timecodeFormat", "seconds"),
            // A value of another key is not a value of this key.
            ("theme", "frames"),
            ("language", "dark"),
        ] {
            assert_eq!(
                validate_preference(key, value),
                Err(PreferenceError {
                    code: PreferenceErrorCode::InvalidPreference
                }),
                "{key} {value}"
            );
        }
    }

    #[test]
    fn a_key_that_is_not_relayed_is_refused() {
        // The preview mute and the timeline height stay with the main window.
        for key in ["previewMuted", "timelineHeight", "", "Theme"] {
            assert!(validate_preference(key, "system").is_err(), "{key}");
        }
    }

    #[test]
    fn the_payload_carries_the_key_the_value_and_the_calling_window() {
        let value = serde_json::to_value(PreferenceChanged {
            key: "theme",
            value: "dark",
            origin: "settings",
        })
        .expect("a payload serializes");
        assert_eq!(
            value,
            serde_json::json!({ "key": "theme", "value": "dark", "origin": "settings" })
        );
        assert_eq!(
            serde_json::to_value(PreferenceError {
                code: PreferenceErrorCode::InvalidPreference
            })
            .expect("an error serializes"),
            serde_json::json!({ "code": "invalidPreference" })
        );
    }
}
