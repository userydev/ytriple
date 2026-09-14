use serde::{Serialize, Serializer};

/// Errors the renderer is allowed to see. None of these ever carries a
/// credential value: the credential variant holds a reference name at most.
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("credential error: {0}")]
    Credential(String),

    #[error("workspace error: {0}")]
    Workspace(String),

    #[error("output error: {0}")]
    Output(String),

    #[error("network error: {0}")]
    Network(String),

    #[error("storage error: {0}")]
    Storage(String),
}

impl Serialize for ShellError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
