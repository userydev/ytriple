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
        .map_err(|error| ShellError::Network(error.to_string()))?;

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

/// Network errors sometimes echo a URL with a key in the query string.
fn redact(message: &str) -> String {
    let mut cleaned = String::with_capacity(message.len());
    for part in message.split_inclusive(|character: char| character.is_whitespace()) {
        if part.contains("key=") || part.contains("token=") {
            cleaned.push_str("[redacted url] ");
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

/// Standalone search, used when the bound model cannot ground itself. Returning
/// an empty list is honest here: the runtime reports the gap as a degradation
/// rather than inventing sources.
pub async fn web_search(request: SearchRequest) -> Result<Vec<SearchResult>, ShellError> {
    let Ok(endpoint) = std::env::var("YTRIPLE_SEARCH_ENDPOINT") else {
        return Ok(vec![]);
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| ShellError::Network(error.to_string()))?;

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
        .map_err(|error| ShellError::Network(error.to_string()))?;

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
}
