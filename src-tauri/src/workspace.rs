use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::ShellError;

/// Read-only view of one folder the user picked. There is no write command in
/// this module by design: the only write channel in the app is `outputs`.
const ALWAYS_SKIPPED: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
    "target",
    ".venv",
    "__pycache__",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesRequest {
    pub include_globs: Option<Vec<String>>,
    pub exclude_globs: Option<Vec<String>>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileRequest {
    pub path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub start_line: usize,
    pub end_line: usize,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextRequest {
    pub query: String,
    pub include_globs: Option<Vec<String>>,
    pub exclude_globs: Option<Vec<String>>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub path: String,
    pub line: usize,
    pub snippet: String,
}

/// Resolves a relative path and proves it stays inside the root even after
/// symlinks are followed.
fn resolve_inside(root: &str, relative: &str) -> Result<PathBuf, ShellError> {
    if relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
        return Err(ShellError::Workspace(format!(
            "path \"{relative}\" must be relative to the workspace root"
        )));
    }

    let real_root = Path::new(root)
        .canonicalize()
        .map_err(|error| ShellError::Workspace(error.to_string()))?;
    let target = real_root
        .join(relative)
        .canonicalize()
        .map_err(|error| ShellError::Workspace(format!("{relative}: {error}")))?;

    if !target.starts_with(&real_root) {
        return Err(ShellError::Workspace(format!(
            "path \"{relative}\" resolves outside the workspace root"
        )));
    }
    Ok(target)
}

/// Same glob subset the TypeScript side uses: `**`, `*` and `?`.
pub fn matches_glob(pattern: &str, path: &str) -> bool {
    fn walk(pattern: &[u8], path: &[u8]) -> bool {
        if pattern.is_empty() {
            return path.is_empty();
        }

        if pattern.starts_with(b"**/") {
            if walk(&pattern[3..], path) {
                return true;
            }
            let mut index = 0;
            while index < path.len() {
                if path[index] == b'/' && walk(&pattern[3..], &path[index + 1..]) {
                    return true;
                }
                index += 1;
            }
            return false;
        }

        if pattern.starts_with(b"**") {
            return (0..=path.len()).any(|index| walk(&pattern[2..], &path[index..]));
        }

        if pattern[0] == b'*' {
            let mut index = 0;
            loop {
                if walk(&pattern[1..], &path[index..]) {
                    return true;
                }
                if index >= path.len() || path[index] == b'/' {
                    return false;
                }
                index += 1;
            }
        }

        if pattern[0] == b'?' {
            return !path.is_empty() && path[0] != b'/' && walk(&pattern[1..], &path[1..]);
        }

        !path.is_empty() && pattern[0] == path[0] && walk(&pattern[1..], &path[1..])
    }

    walk(pattern.as_bytes(), path.as_bytes())
}

fn visible(path: &str, include: &Option<Vec<String>>, exclude: &Option<Vec<String>>) -> bool {
    if let Some(patterns) = exclude {
        if patterns.iter().any(|pattern| matches_glob(pattern, path)) {
            return false;
        }
    }
    match include {
        Some(patterns) if !patterns.is_empty() => {
            patterns.iter().any(|pattern| matches_glob(pattern, path))
        }
        _ => true,
    }
}

fn relative_path(root: &Path, entry: &Path) -> Option<String> {
    entry
        .strip_prefix(root)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

pub fn list(root: &str, request: ListFilesRequest) -> Result<Vec<FileEntry>, ShellError> {
    let real_root = Path::new(root)
        .canonicalize()
        .map_err(|error| ShellError::Workspace(error.to_string()))?;
    let limit = request.max_results.unwrap_or(500);
    let mut entries = Vec::new();

    for entry in WalkDir::new(&real_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !entry
                .file_name()
                .to_str()
                .map(|name| entry.depth() > 0 && ALWAYS_SKIPPED.contains(&name))
                .unwrap_or(false)
        })
        .filter_map(Result::ok)
    {
        if entries.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(path) = relative_path(&real_root, entry.path()) else {
            continue;
        };
        if !visible(&path, &request.include_globs, &request.exclude_globs) {
            continue;
        }
        let size_bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        entries.push(FileEntry { path, size_bytes });
    }

    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub fn read(root: &str, request: ReadFileRequest) -> Result<FileContent, ShellError> {
    let target = resolve_inside(root, &request.path)?;
    let raw = std::fs::read_to_string(&target)
        .map_err(|error| ShellError::Workspace(format!("{}: {error}", request.path)))?;

    let lines: Vec<&str> = raw.split('\n').collect();
    let start_line = request.start_line.unwrap_or(1).max(1);
    let end_line = request.end_line.unwrap_or(lines.len()).min(lines.len());

    let mut content = if start_line <= end_line {
        lines[start_line - 1..end_line].join("\n")
    } else {
        String::new()
    };
    let mut truncated = start_line > 1 || end_line < lines.len();

    let max_bytes = request.max_bytes.unwrap_or(200_000);
    if content.len() > max_bytes {
        content.truncate(
            content
                .char_indices()
                .take_while(|(index, _)| *index <= max_bytes)
                .last()
                .map(|(index, _)| index)
                .unwrap_or(0),
        );
        truncated = true;
    }

    Ok(FileContent {
        path: request.path,
        content,
        start_line,
        end_line,
        truncated,
    })
}

pub fn search(root: &str, request: SearchTextRequest) -> Result<Vec<TextMatch>, ShellError> {
    let limit = request.max_results.unwrap_or(50);
    let needle = request.query.to_lowercase();
    let mut matches = Vec::new();

    let files = list(
        root,
        ListFilesRequest {
            include_globs: request.include_globs,
            exclude_globs: request.exclude_globs,
            max_results: Some(500),
        },
    )?;

    let real_root = Path::new(root)
        .canonicalize()
        .map_err(|error| ShellError::Workspace(error.to_string()))?;

    for file in files {
        if matches.len() >= limit {
            break;
        }
        let Ok(raw) = std::fs::read_to_string(real_root.join(&file.path)) else {
            continue;
        };
        for (index, line) in raw.split('\n').enumerate() {
            if matches.len() >= limit {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                matches.push(TextMatch {
                    path: file.path.clone(),
                    line: index + 1,
                    snippet: line.chars().take(300).collect(),
                });
            }
        }
    }

    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_the_same_shapes_as_the_typescript_matcher() {
        assert!(matches_glob("**/*.md", "README.md"));
        assert!(matches_glob("**/*.md", "docs/product/prd.md"));
        assert!(!matches_glob("**/*.md", "docs/product/prd.txt"));
        assert!(matches_glob("node_modules/**", "node_modules/react/index.js"));
        assert!(!matches_glob("node_modules/**", "src/node_modules_helper.ts"));
        assert!(matches_glob("src/*.ts", "src/index.ts"));
        assert!(!matches_glob("src/*.ts", "src/nested/index.ts"));
        assert!(matches_glob("v?.md", "v1.md"));
        assert!(!matches_glob("v?.md", "v10.md"));
    }

    #[test]
    fn refuses_a_path_that_climbs_out_of_the_root() {
        let outcome = resolve_inside(".", "../escape.md");
        assert!(outcome.is_err());
    }

    #[test]
    fn refuses_an_absolute_path() {
        assert!(resolve_inside(".", "/etc/passwd").is_err());
    }
}
