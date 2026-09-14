mod credentials;
mod error;
mod net;
mod outputs;
mod store;
mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;
use tauri::Manager;

use error::ShellError;

/// The shell.
///
/// Every command here is a capability: files, network, credentials, storage.
/// None of them knows what an agent is. All product behaviour lives in
/// `packages/core`, which runs in the renderer, so there is exactly one
/// implementation of it in the repository.
struct Paths {
    documents: PathBuf,
    data: PathBuf,
}

fn paths(app: &tauri::AppHandle) -> Result<Paths, ShellError> {
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| ShellError::Output(error.to_string()))?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| ShellError::Storage(error.to_string()))?;
    Ok(Paths { documents, data })
}

#[tauri::command]
async fn http_request(request: net::HttpRequestInit) -> Result<net::HttpResponseData, ShellError> {
    net::request(request).await
}

#[tauri::command]
async fn web_search(request: net::SearchRequest) -> Result<Vec<net::SearchResult>, ShellError> {
    net::web_search(request).await
}

#[tauri::command]
fn search_configured() -> bool {
    net::search_configured()
}

#[tauri::command]
fn credential_set(credential_ref: String, value: String) -> Result<(), ShellError> {
    credentials::set(&credential_ref, &value)
}

#[tauri::command]
fn credential_exists(credential_ref: String) -> bool {
    credentials::exists(&credential_ref)
}

#[tauri::command]
fn credential_status(credential_refs: Vec<String>) -> HashMap<String, bool> {
    credentials::status(&credential_refs)
}

#[tauri::command]
fn workspace_list(
    root: String,
    request: workspace::ListFilesRequest,
) -> Result<Vec<workspace::FileEntry>, ShellError> {
    workspace::list(&root, request)
}

#[tauri::command]
fn workspace_read(
    root: String,
    request: workspace::ReadFileRequest,
) -> Result<workspace::FileContent, ShellError> {
    workspace::read(&root, request)
}

#[tauri::command]
fn workspace_search(
    root: String,
    request: workspace::SearchTextRequest,
) -> Result<Vec<workspace::TextMatch>, ShellError> {
    workspace::search(&root, request)
}

#[tauri::command]
fn output_write(
    app: tauri::AppHandle,
    request: outputs::WriteDocumentRequest,
) -> Result<outputs::WrittenDocument, ShellError> {
    outputs::write_document(paths(&app)?.documents, request)
}

#[tauri::command]
fn output_reveal(app: tauri::AppHandle, task_id: String) -> Result<(), ShellError> {
    let directory = outputs::directory_for(paths(&app)?.documents, &task_id)?;
    tauri_plugin_opener::open_path(directory.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| ShellError::Output(error.to_string()))
}

#[tauri::command]
fn store_get(app: tauri::AppHandle, key: String) -> Result<Value, ShellError> {
    store::get(paths(&app)?.data, &key)
}

#[tauri::command]
fn store_put(app: tauri::AppHandle, key: String, value: Value) -> Result<(), ShellError> {
    store::put(paths(&app)?.data, &key, value)
}

#[tauri::command]
fn history_list(app: tauri::AppHandle) -> Result<Value, ShellError> {
    store::history_list(paths(&app)?.data)
}

#[tauri::command]
fn history_put(app: tauri::AppHandle, record: Value) -> Result<(), ShellError> {
    store::history_put(paths(&app)?.data, record)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            http_request,
            web_search,
            search_configured,
            credential_set,
            credential_exists,
            credential_status,
            workspace_list,
            workspace_read,
            workspace_search,
            output_write,
            output_reveal,
            store_get,
            store_put,
            history_list,
            history_put,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the yTriple shell");
}
