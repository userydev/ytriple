use std::collections::HashMap;

use keyring::Entry;

use crate::error::ShellError;

/// Credentials live in the OS keychain and are read exactly once, on the way
/// out to a provider. The renderer can ask whether one exists and can store a
/// new one; it can never read a value back.
const SERVICE: &str = "dev.ytriple.desktop";

/// What the renderer receives instead of a key. The HTTP command swaps it for
/// the real value immediately before the request leaves the process.
pub const SECRET_PLACEHOLDER_PREFIX: &str = "ytriple-secret-ref:";

fn entry(credential_ref: &str) -> Result<Entry, ShellError> {
    Entry::new(SERVICE, credential_ref).map_err(|error| ShellError::Credential(error.to_string()))
}

pub fn set(credential_ref: &str, value: &str) -> Result<(), ShellError> {
    entry(credential_ref)?
        .set_password(value)
        .map_err(|error| ShellError::Credential(error.to_string()))
}

pub fn read(credential_ref: &str) -> Result<String, ShellError> {
    entry(credential_ref)?
        .get_password()
        .map_err(|error| ShellError::Credential(format!("{credential_ref}: {error}")))
}

pub fn exists(credential_ref: &str) -> bool {
    entry(credential_ref)
        .map(|entry| entry.get_password().is_ok())
        .unwrap_or(false)
}

pub fn status(credential_refs: &[String]) -> HashMap<String, bool> {
    credential_refs
        .iter()
        .map(|credential_ref| (credential_ref.clone(), exists(credential_ref)))
        .collect()
}

/// Replaces every `ytriple-secret-ref:NAME` placeholder with the stored value.
/// Returns an error rather than sending a request with an unresolved reference.
pub fn resolve_placeholders(value: &str) -> Result<String, ShellError> {
    let mut resolved = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(start) = rest.find(SECRET_PLACEHOLDER_PREFIX) {
        resolved.push_str(&rest[..start]);
        let after = &rest[start + SECRET_PLACEHOLDER_PREFIX.len()..];
        let end = after
            .find(|character: char| character.is_whitespace() || character == '"')
            .unwrap_or(after.len());
        let credential_ref = &after[..end];

        resolved.push_str(&read(credential_ref)?);
        rest = &after[end..];
    }

    resolved.push_str(rest);
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_plain_values_untouched() {
        assert_eq!(resolve_placeholders("Bearer plain").unwrap(), "Bearer plain");
    }

    #[test]
    fn fails_loudly_on_an_unknown_reference() {
        let outcome = resolve_placeholders(&format!("Bearer {SECRET_PLACEHOLDER_PREFIX}NO_SUCH_KEY"));
        assert!(outcome.is_err(), "an unresolved reference must not be sent");
    }
}
