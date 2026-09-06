pub mod commands;
pub mod ffmpeg;
pub mod fsutil;
pub mod project;
pub mod settings;
pub mod time;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The one export slot for the whole application (ADR 016). `ExportRegistry::begin`
        // takes `self: &Arc<Self>`, because the `ExportSlot` it hands out owns a reference to
        // the registry and outlives the command that claimed it, so the managed value is the
        // `Arc` itself rather than the registry.
        .manage(std::sync::Arc::new(
            ffmpeg::export::ExportRegistry::default(),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::capabilities::start_capability_probe,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::media::import_media,
            commands::project::load_project,
            commands::project::save_project,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::restore_default_presets,
            commands::settings::reset_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
