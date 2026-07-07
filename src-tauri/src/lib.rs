mod runtime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![runtime::run_prd_task])
        .run(tauri::generate_context!())
        .expect("failed to run yTriple");
}
