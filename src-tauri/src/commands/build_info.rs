//! The version and the source of this build, for the About tab of Settings (ADR 047).

use serde::Serialize;

use crate::build_info::BuildSource;

/// What the About tab shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    /// The application version, as the macOS About panel shows it (ADR 034).
    pub version: String,
    /// The source of the build, or `None` when the build had no git checkout.
    pub source: Option<BuildSource>,
}

/// Returns the version and the source of this build. The values are fixed when the crate is
/// compiled, so the command reads nothing.
#[tauri::command]
pub fn build_info(app: tauri::AppHandle) -> BuildInfo {
    BuildInfo {
        version: app.package_info().version.to_string(),
        source: BuildSource::current(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_info_serializes_with_camel_case_fields_and_a_null_source() {
        let info = BuildInfo {
            version: "0.1.1".to_owned(),
            source: None,
        };
        assert_eq!(
            serde_json::to_value(info).expect("the info serializes"),
            serde_json::json!({ "version": "0.1.1", "source": null })
        );
    }
}
