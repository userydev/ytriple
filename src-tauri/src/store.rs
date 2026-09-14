use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::error::ShellError;

/// A small JSON document for settings and task history. Deliberately not a
/// database: the shell stores what the user changed and nothing else.
fn store_path(base: PathBuf) -> PathBuf {
    base.join("ytriple-store.json")
}

fn load(base: PathBuf) -> Result<Map<String, Value>, ShellError> {
    let path = store_path(base);
    if !path.exists() {
        return Ok(Map::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| ShellError::Storage(error.to_string()))?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Ok(Map::new()),
    }
}

fn save(base: PathBuf, map: &Map<String, Value>) -> Result<(), ShellError> {
    let path = store_path(base.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ShellError::Storage(error.to_string()))?;
    }
    let body = serde_json::to_string_pretty(map)
        .map_err(|error| ShellError::Storage(error.to_string()))?;
    std::fs::write(&path, body).map_err(|error| ShellError::Storage(error.to_string()))
}

pub fn get(base: PathBuf, key: &str) -> Result<Value, ShellError> {
    Ok(load(base)?.get(key).cloned().unwrap_or(Value::Null))
}

pub fn put(base: PathBuf, key: &str, value: Value) -> Result<(), ShellError> {
    let mut map = load(base.clone())?;
    map.insert(key.to_string(), value);
    save(base, &map)
}

const HISTORY_KEY: &str = "history";
const HISTORY_LIMIT: usize = 100;

pub fn history_list(base: PathBuf) -> Result<Value, ShellError> {
    Ok(match get(base, HISTORY_KEY)? {
        Value::Array(entries) => Value::Array(entries),
        _ => Value::Array(vec![]),
    })
}

/// Newest first, de-duplicated by task id, capped so the file cannot grow
/// without bound.
pub fn history_put(base: PathBuf, record: Value) -> Result<(), ShellError> {
    let task_id = record.get("taskId").and_then(Value::as_str).unwrap_or("");
    let existing = match history_list(base.clone())? {
        Value::Array(entries) => entries,
        _ => vec![],
    };

    let mut next = vec![record.clone()];
    next.extend(
        existing
            .into_iter()
            .filter(|entry| entry.get("taskId").and_then(Value::as_str) != Some(task_id)),
    );
    next.truncate(HISTORY_LIMIT);

    put(base, HISTORY_KEY, Value::Array(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_the_newest_entry_per_task() {
        let base = std::env::temp_dir().join(format!("ytriple-store-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();

        history_put(base.clone(), serde_json::json!({ "taskId": "a", "status": "completed" })).unwrap();
        history_put(base.clone(), serde_json::json!({ "taskId": "b", "status": "completed" })).unwrap();
        history_put(base.clone(), serde_json::json!({ "taskId": "a", "status": "failed" })).unwrap();

        let listed = history_list(base.clone()).unwrap();
        let entries = listed.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["taskId"], "a");
        assert_eq!(entries[0]["status"], "failed");

        std::fs::remove_dir_all(&base).ok();
    }
}
