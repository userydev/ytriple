use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::credentials;
use crate::error::ShellError;

/// Outbound HTTP.
///
/// Two reasons this is a command rather than `fetch` in the renderer: it is not
/// subject to CORS, and it is where credential placeholders are exchanged for
/// real keys. The renderer therefore never holds a key even though the provider
/// adapter running in it writes an Authorization header.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInit {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseData {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub async fn request(init: HttpRequestInit) -> Result<HttpResponseData, ShellError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(init.timeout_ms.unwrap_or(120_000)))
        .build()
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    let mut builder = match init.method.to_uppercase().as_str() {
        "GET" => client.get(&init.url),
        "POST" => client.post(&init.url),
        other => {
            return Err(ShellError::Network(format!("unsupported method {other}")));
        }
    };

    for (name, value) in &init.headers {
        // The swap happens here, at the last possible moment.
        builder = builder.header(name, credentials::resolve_placeholders(value)?);
    }
    if let Some(body) = init.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let body = response
        .text()
        .await
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    Ok(HttpResponseData {
        status,
        headers,
        body,
    })
}

/// Network errors echo the URL they failed on, and providers put credentials in
/// query strings under many spellings: `key`, `api_key`, `apiKey`, `access_token`.
///
/// Matching a couple of lowercase literals let `apiKey=` through and carried a
/// live credential into the renderer, which breaks the boundary the whole
/// placeholder scheme exists to hold. Any token that looks like a URL with a
/// query string is therefore redacted whole, case-insensitively.
fn redact(message: &str) -> String {
    const SENSITIVE: &[&str] = &[
        "key=",
        "token=",
        "secret=",
        "password=",
        "credential=",
        "signature=",
        "sig=",
        "auth=",
    ];

    let mut cleaned = String::with_capacity(message.len());
    for part in message.split_inclusive(char::is_whitespace) {
        let lowered = part.to_ascii_lowercase();
        let looks_like_url = lowered.contains("://");
        let carries_secret = SENSITIVE.iter().any(|marker| lowered.contains(marker));

        if carries_secret || (looks_like_url && lowered.contains('?')) {
            let trailing = part.strip_prefix(part.trim_end()).unwrap_or("");
            cleaned.push_str("[redacted url]");
            cleaned.push_str(trailing);
        } else {
            cleaned.push_str(part);
        }
    }
    cleaned
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub max_results: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
}

/// Whether a search backend is configured at all.
///
/// The host asks this before deciding to supply a SearchPort. Without it, an
/// unconfigured search looked like a successful search that found nothing,
/// which suppressed the degradation the runtime should have reported.
pub fn search_configured() -> bool {
    std::env::var("YTRIPLE_SEARCH_ENDPOINT")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// Standalone search, used when the bound model cannot ground itself.
pub async fn web_search(request: SearchRequest) -> Result<Vec<SearchResult>, ShellError> {
    let Ok(endpoint) = std::env::var("YTRIPLE_SEARCH_ENDPOINT") else {
        // An error, not an empty result: "no backend" and "nothing found" are
        // different facts and the runtime degrades differently for each.
        return Err(ShellError::Network(
            "no search backend configured; set YTRIPLE_SEARCH_ENDPOINT".into(),
        ));
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    let response = client
        .get(&endpoint)
        .query(&[
            ("q", request.query.as_str()),
            ("count", &request.max_results.to_string()),
        ])
        .send()
        .await
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| ShellError::Network(redact(&error.to_string())))?;

    Ok(payload
        .get("results")
        .and_then(serde_json::Value::as_array)
        .map(|results| {
            results
                .iter()
                .filter_map(|entry| {
                    Some(SearchResult {
                        title: entry.get("title")?.as_str()?.to_string(),
                        url: entry.get("url")?.as_str()?.to_string(),
                        snippet: entry
                            .get("snippet")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                    })
                })
                .take(request.max_results)
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_a_url_that_carries_a_key() {
        let message = redact("error sending request for url https://api.example/v1?key=sk-live-123");
        assert!(!message.contains("sk-live-123"));
        assert!(message.contains("[redacted url]"));
    }

    #[test]
    fn redacts_every_spelling_a_provider_uses_for_a_credential() {
        // A case-sensitive `key=` check let all but the first of these through.
        for query in [
            "key=sk-live-123",
            "apiKey=sk-live-123",
            "API_KEY=sk-live-123",
            "access_token=sk-live-123",
            "X-Token=sk-live-123",
            "Secret=sk-live-123",
            "signature=sk-live-123",
        ] {
            let message = redact(&format!("error for url https://api.example/v1?{query}"));
            assert!(
                !message.contains("sk-live-123"),
                "credential survived redaction in {query}"
            );
        }
    }

    #[test]
    fn redacts_any_url_with_a_query_string_even_under_an_unknown_parameter_name() {
        let message = redact("failed: https://api.example/v1?mystery=sk-live-123");
        assert!(!message.contains("sk-live-123"));
    }

    #[test]
    fn leaves_ordinary_error_text_readable() {
        let message = redact("connection refused while contacting https://api.example/v1");
        assert!(message.contains("connection refused"));
        assert!(message.contains("https://api.example/v1"));
    }
}
