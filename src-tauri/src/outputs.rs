use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::ShellError;

/// The only write channel in the shell. Documents land in
/// `<documents>/ytriple-outputs/<task-id>/` and an existing file is never
/// replaced.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentRequest {
    pub task_id: String,
    pub filename: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenDocument {
    pub path: String,
}

pub fn output_root(base: PathBuf) -> PathBuf {
    base.join("ytriple-outputs")
}

pub fn directory_for(base: PathBuf, task_id: &str) -> Result<PathBuf, ShellError> {
    if task_id.is_empty() || task_id.contains('/') || task_id.contains("..") {
        return Err(ShellError::Output(format!("invalid task id \"{task_id}\"")));
    }
    Ok(output_root(base).join(task_id))
}

pub fn write_document(
    base: PathBuf,
    request: WriteDocumentRequest,
) -> Result<WrittenDocument, ShellError> {
    if request.filename.contains('/') || request.filename.contains("..") {
        return Err(ShellError::Output(format!(
            "invalid filename \"{}\"",
            request.filename
        )));
    }

    let directory = directory_for(base, &request.task_id)?;
    let path = directory.join(&request.filename);

    if path.exists() {
        return Err(ShellError::Output(format!(
            "{} already exists; yTriple never overwrites an output",
            path.display()
        )));
    }

    std::fs::create_dir_all(&directory).map_err(|error| ShellError::Output(error.to_string()))?;
    std::fs::write(&path, &request.content).map_err(|error| ShellError::Output(error.to_string()))?;

    Ok(WrittenDocument {
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_task_id_that_could_escape_the_output_root() {
        assert!(directory_for(PathBuf::from("/tmp"), "../etc").is_err());
        assert!(directory_for(PathBuf::from("/tmp"), "a/b").is_err());
        assert!(directory_for(PathBuf::from("/tmp"), "task-1").is_ok());
    }

    #[test]
    fn refuses_a_filename_with_a_path_in_it() {
        let outcome = write_document(
            PathBuf::from("/tmp"),
            WriteDocumentRequest {
                task_id: "task-1".into(),
                filename: "../prd.md".into(),
                content: "x".into(),
            },
        );
        assert!(outcome.is_err());
    }
}
