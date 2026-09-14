use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
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

/// One directory or file name, nothing else.
///
/// Rejecting only `/` would be wrong on Windows, where `..\outside` traverses
/// while containing no forward slash. Trailing dots and spaces go too, because
/// Windows strips them and two different ids would resolve to one directory.
fn is_safe_segment(value: &str) -> bool {
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];

    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value == "." || value == ".." {
        return false;
    }
    if value.ends_with('.') || value.ends_with(' ') {
        return false;
    }
    if RESERVED.contains(&value.to_ascii_lowercase().as_str()) {
        return false;
    }
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

pub fn directory_for(base: PathBuf, task_id: &str) -> Result<PathBuf, ShellError> {
    if !is_safe_segment(task_id) {
        return Err(ShellError::Output(format!("invalid task id \"{task_id}\"")));
    }
    Ok(output_root(base).join(task_id))
}

pub fn write_document(
    base: PathBuf,
    request: WriteDocumentRequest,
) -> Result<WrittenDocument, ShellError> {
    if !is_safe_segment(&request.filename) {
        return Err(ShellError::Output(format!(
            "invalid filename \"{}\"",
            request.filename
        )));
    }

    let directory = directory_for(base, &request.task_id)?;
    let path = directory.join(&request.filename);

    std::fs::create_dir_all(&directory).map_err(|error| ShellError::Output(error.to_string()))?;

    // `create_new` makes "refuse to overwrite" atomic. Checking `exists()` first
    // left a window for another writer, and a dangling symlink passes `exists()`
    // as absent and is then followed on write, landing the file outside the
    // output directory.
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(ShellError::Output(format!(
                "{} already exists; yTriple never overwrites an output",
                path.display()
            )));
        }
        Err(error) => return Err(ShellError::Output(error.to_string())),
    };

    file.write_all(request.content.as_bytes())
        .map_err(|error| ShellError::Output(error.to_string()))?;

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
    fn refuses_windows_traversal_that_contains_no_forward_slash() {
        for task_id in ["..\\outside", "a\\b", "..\\..\\Windows"] {
            assert!(!task_id.contains('/'), "{task_id} should have no forward slash");
            assert!(
                directory_for(PathBuf::from("/tmp"), task_id).is_err(),
                "{task_id} must be rejected"
            );
        }
    }

    #[test]
    fn refuses_names_windows_would_rewrite_or_reserve() {
        for task_id in ["task.", "task ", "CON", "nul", "com1", "LPT9", "", "."] {
            assert!(
                directory_for(PathBuf::from("/tmp"), task_id).is_err(),
                "{task_id:?} must be rejected"
            );
        }
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

    #[test]
    fn refuses_to_overwrite_and_does_not_follow_a_dangling_symlink() {
        let base = std::env::temp_dir().join(format!("ytriple-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let request = || WriteDocumentRequest {
            task_id: "task-1".into(),
            filename: "prd.md".into(),
            content: "first".into(),
        };

        let written = write_document(base.clone(), request()).expect("first write");
        assert_eq!(std::fs::read_to_string(&written.path).unwrap(), "first");

        let again = write_document(base.clone(), request());
        assert!(again.is_err(), "an existing output must never be replaced");

        // A dangling symlink reports `exists() == false` but is followed on
        // write, which would have put the file outside the output directory.
        let escape = base.join("escaped.md");
        let link_dir = directory_for(base.clone(), "task-2").unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&escape, link_dir.join("prd.md")).unwrap();

        #[cfg(unix)]
        {
            let through_link = write_document(
                base.clone(),
                WriteDocumentRequest {
                    task_id: "task-2".into(),
                    filename: "prd.md".into(),
                    content: "escaped".into(),
                },
            );
            assert!(through_link.is_err(), "a symlink must not be followed");
            assert!(!escape.exists(), "nothing may be written through the link");
        }

        std::fs::remove_dir_all(&base).ok();
    }
}
