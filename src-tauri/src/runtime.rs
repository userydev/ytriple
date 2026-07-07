use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;

const DELIVERY_FILENAMES: [&str; 4] = [
    "01-final-prd.md",
    "02-assumptions-and-open-questions.md",
    "03-research-notes.md",
    "04-specialist-review.md",
];

#[derive(Debug, Clone)]
struct ArkConfig {
    api_key: String,
    base_url: String,
    model: String,
    enable_web_search: bool,
    web_search_max_keyword: u64,
    web_search_limit: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPrdTaskRequest {
    user_input: String,
    workspace_root: Option<String>,
    output_root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPrdTaskResponse {
    task_id: String,
    status: String,
    artifacts_dir: String,
    files: Vec<String>,
    final_prd_markdown: String,
    assumptions_markdown: String,
    research_notes_markdown: String,
    specialist_review_markdown: String,
    researcher: ResearcherOutput,
    specialist: SpecialistOutput,
}

#[derive(Clone, Debug, Serialize)]
struct AgentActivityEvent<'a> {
    agent: &'a str,
    title: &'a str,
    detail: String,
    state: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConductorOutput {
    task_type: String,
    confidence: String,
    assumptions: Vec<String>,
    open_questions: Vec<String>,
    final_prd_markdown: String,
    artifact_manifest: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResearcherOutput {
    summary: String,
    key_findings: Vec<String>,
    concepts: Vec<NamedNote>,
    competitor_samples: Vec<NamedNote>,
    sources: Vec<SourceNote>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpecialistOutput {
    role: String,
    summary: String,
    strengths: Vec<String>,
    risks: Vec<String>,
    missing_sections: Vec<String>,
    recommendations: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NamedNote {
    name: String,
    note: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SourceNote {
    title: String,
    url: String,
    reason: String,
}

#[derive(Debug)]
struct DeliveryDocuments {
    final_prd: String,
    assumptions: String,
    research_notes: String,
    specialist_review: String,
}

#[derive(Debug)]
struct DeliveryPackage {
    artifacts_dir: PathBuf,
    files: Vec<String>,
}

#[tauri::command]
pub async fn run_prd_task(window: tauri::Window, request: RunPrdTaskRequest) -> Result<RunPrdTaskResponse, String> {
    if request.user_input.trim().len() < 8 {
        return Err("请输入至少 8 个字符的产品想法，便于判断产品对象和目标。".to_string());
    }

    emit_task_status(&window, "classifying");
    emit_agent_activity(
        &window,
        "conductor",
        "Classifying PRD task",
        "Checking whether the brief can enter the fixed PRD delivery workflow.",
        "active",
    );
    let config = load_ark_config().map_err(|error| error.to_string())?;
    let task_id = uuid::Uuid::new_v4().to_string();
    let workspace_root = request.workspace_root.as_deref().map(PathBuf::from);
    let output_root = resolve_output_root(request.output_root.as_deref(), workspace_root.as_deref())
        .map_err(|error| error.to_string())?;
    emit_task_status(&window, "preparing_context");
    emit_agent_activity(
        &window,
        "conductor",
        "Preparing context",
        "Reading only the selected workspace summary and preserving the user chat brief.",
        "active",
    );
    let workspace_context = collect_workspace_context(workspace_root.as_deref())
        .map_err(|error| format!("读取工作区失败：{error}"))?;

    let client = reqwest::Client::new();

    emit_task_status(&window, "running_researcher");
    emit_agent_activity(
        &window,
        "researcher",
        "Planning light research",
        "Defining what to verify: key concepts, public facts, terms, and lightweight competitor samples.",
        "active",
    );
    emit_agent_activity(
        &window,
        "researcher",
        "Running Ark web_search",
        "Calling Ark Responses with web_search enabled only for the Researcher slot.",
        "active",
    );
    let researcher: ResearcherOutput = call_ark_json(
        &client,
        &config,
        "researcher",
        &researcher_prompt(),
        &json!({
            "user_input": request.user_input,
            "workspace_context": workspace_context,
            "output_shape": "summary, key_findings, concepts, competitor_samples, sources"
        })
        .to_string(),
        researcher_schema(),
    )
    .await?;
    emit_agent_activity(
        &window,
        "researcher",
        "Research notes ready",
        format!(
            "Collected {} findings, {} concepts, and {} sources for 03-research-notes.md.",
            researcher.key_findings.len(),
            researcher.concepts.len(),
            researcher.sources.len()
        ),
        "done",
    );

    emit_task_status(&window, "running_specialist");
    emit_agent_activity(
        &window,
        "specialist",
        "Choosing review angle",
        "Using agency-agents Product Manager positioning: scope, target user, success metrics, non-goals, risks, and missing PRD sections.",
        "active",
    );
    let specialist: SpecialistOutput = call_ark_json(
        &client,
        &config,
        "specialist",
        &specialist_prompt(),
        &json!({
            "user_input": request.user_input,
            "workspace_context": workspace_context,
            "review_checklist": [
                "目标用户与场景是否清晰",
                "核心范围是否收束",
                "PRD 结构是否完整",
                "假设与未决问题是否显式记录"
            ],
            "output_shape": "role, summary, strengths, risks, missing_sections, recommendations"
        })
        .to_string(),
        specialist_schema(),
    )
    .await?;
    emit_agent_activity(
        &window,
        "specialist",
        "Specialist review ready",
        format!(
            "Identified {} risks, {} missing sections, and {} recommendations for 04-specialist-review.md.",
            specialist.risks.len(),
            specialist.missing_sections.len(),
            specialist.recommendations.len()
        ),
        "done",
    );

    emit_task_status(&window, "merging");
    emit_agent_activity(
        &window,
        "conductor",
        "Merging agent outputs",
        "Keeping PRD body clean while separating assumptions, research notes, and specialist review.",
        "active",
    );
    let conductor: ConductorOutput = call_ark_json(
        &client,
        &config,
        "conductor",
        &conductor_prompt(),
        &json!({
            "user_input": request.user_input,
            "workspace_context": workspace_context,
            "researcher": researcher,
            "specialist": specialist
        })
        .to_string(),
        conductor_schema(),
    )
    .await?;

    validate_conductor(&conductor)?;
    let documents = render_delivery_documents(&conductor, &researcher, &specialist);
    emit_task_status(&window, "writing_outputs");
    emit_agent_activity(
        &window,
        "conductor",
        "Writing delivery package",
        "Creating the fixed four-file V1 output package without modifying existing workspace files.",
        "active",
    );
    let package = write_delivery_package(&output_root, &task_id, &documents)
        .map_err(|error| format!("写出交付包失败：{error}"))?;
    emit_task_status(&window, "completed");
    emit_agent_activity(
        &window,
        "conductor",
        "Delivery package complete",
        "01-final-prd.md, assumptions, research notes, and specialist review are ready.",
        "done",
    );

    Ok(RunPrdTaskResponse {
        task_id,
        status: "completed".to_string(),
        artifacts_dir: package.artifacts_dir.to_string_lossy().to_string(),
        files: package.files,
        final_prd_markdown: documents.final_prd,
        assumptions_markdown: documents.assumptions,
        research_notes_markdown: documents.research_notes,
        specialist_review_markdown: documents.specialist_review,
        researcher,
        specialist,
    })
}

fn emit_task_status(window: &tauri::Window, status: &str) {
    let _ = window.emit("task_status", status);
}

fn emit_agent_activity(window: &tauri::Window, agent: &str, title: &str, detail: impl Into<String>, state: &str) {
    let _ = window.emit(
        "agent_activity",
        AgentActivityEvent {
            agent,
            title,
            detail: detail.into(),
            state,
        },
    );
}

async fn call_ark_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    config: &ArkConfig,
    role: &str,
    system: &str,
    user: &str,
    schema: Value,
) -> Result<T, String> {
    let response = client
        .post(format!("{}/responses", config.base_url.trim_end_matches('/')))
        .bearer_auth(&config.api_key)
        .json(&build_ark_request(role, system, user, schema, config))
        .send()
        .await
        .map_err(|error| format!("Ark 请求失败：{error}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Ark 响应不是有效 JSON：{error}"))?;

    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err(
                "Ark authentication failed. Check that ARK_API_KEY is a regular Ark API key for the configured ARK_BASE_URL, not an incompatible Agent Plan key."
                    .to_string(),
            );
        }
        return Err(format!("Ark 返回错误状态 {status}: {payload}"));
    }

    let output_text = extract_ark_output_text(&payload)?;
    serde_json::from_str::<T>(&strip_json_fence(&output_text))
        .map_err(|error| format!("Ark 结构化输出解析失败：{error}; output={output_text}"))
}

fn build_ark_request(role: &str, system: &str, user: &str, schema: Value, config: &ArkConfig) -> Value {
    let mut request = json!({
        "model": config.model,
        "stream": false,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": format!("{role}_output"),
                "strict": true,
                "schema": schema
            }
        }
    });

    if config.enable_web_search && role == "researcher" {
        request["tools"] = json!([{
            "type": "web_search",
            "max_keyword": config.web_search_max_keyword,
            "limit": config.web_search_limit
        }]);
    }

    request
}

fn extract_ark_output_text(payload: &Value) -> Result<String, String> {
    if let Some(text) = payload.get("output_text").and_then(Value::as_str) {
        return Ok(text.to_string());
    }

    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for output_item in output {
            if let Some(content) = output_item.get("content").and_then(Value::as_array) {
                for content_item in content {
                    if let Some(text) = content_item.get("text").and_then(Value::as_str) {
                        return Ok(text.to_string());
                    }
                }
            }
        }
    }

    Err("Ark 响应中没有 output_text。".to_string())
}

fn strip_json_fence(content: &str) -> String {
    content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string()
}

fn load_ark_config() -> Result<ArkConfig, Box<dyn std::error::Error>> {
    load_local_env();
    let api_key = std::env::var("ARK_API_KEY")?;
    Ok(ArkConfig {
        api_key,
        base_url: std::env::var("ARK_BASE_URL")
            .unwrap_or_else(|_| "https://ark.cn-beijing.volces.com/api/v3".to_string()),
        model: std::env::var("ARK_MODEL")
            .unwrap_or_else(|_| "doubao-seed-2-1-pro-260628".to_string()),
        enable_web_search: std::env::var("ARK_ENABLE_WEB_SEARCH")
            .map(|value| value != "false")
            .unwrap_or(true),
        web_search_max_keyword: std::env::var("ARK_WEB_SEARCH_MAX_KEYWORD")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(2),
        web_search_limit: std::env::var("ARK_WEB_SEARCH_LIMIT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5),
    })
}

fn load_local_env() {
    for env_path in candidate_env_paths() {
        let Ok(content) = fs::read_to_string(env_path) else {
            continue;
        };

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let Some((key, value)) = trimmed.split_once('=') else {
                continue;
            };

            if std::env::var(key.trim()).is_err() {
                std::env::set_var(
                    key.trim(),
                    value.trim().trim_matches('"').trim_matches('\''),
                );
            }
        }
    }
}

fn candidate_env_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        paths.push(current_dir.join(".env"));
        if let Some(parent) = current_dir.parent() {
            paths.push(parent.join(".env"));
        }
    }
    paths
}

fn resolve_output_root(
    requested_output_root: Option<&str>,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, std::io::Error> {
    if let Some(root) = requested_output_root.filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(root));
    }
    if let Some(root) = workspace_root {
        return Ok(root.to_path_buf());
    }

    let current_dir = std::env::current_dir()?;
    if current_dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        if let Some(parent) = current_dir.parent() {
            return Ok(parent.to_path_buf());
        }
    }
    Ok(current_dir)
}

fn collect_workspace_context(workspace_root: Option<&Path>) -> Result<Vec<Value>, std::io::Error> {
    let Some(root) = workspace_root else {
        return Ok(Vec::new());
    };

    let root = root.canonicalize()?;
    let mut files = Vec::new();
    collect_text_files(&root, &root, &mut files, 12)?;

    let mut context = Vec::new();
    for file in files {
        let content = fs::read_to_string(&file).unwrap_or_default();
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        context.push(json!({
            "path": relative,
            "excerpt": content.chars().take(2400).collect::<String>()
        }));
    }

    Ok(context)
}

fn collect_text_files(
    root: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
    max_files: usize,
) -> Result<(), std::io::Error> {
    if files.len() >= max_files {
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        if files.len() >= max_files {
            break;
        }

        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if should_exclude(&name) {
            continue;
        }

        if path.is_dir() {
            collect_text_files(root, &path, files, max_files)?;
        } else if path.is_file() && is_text_file(&path) && path.starts_with(root) {
            files.push(path);
        }
    }

    files.sort();
    Ok(())
}

fn should_exclude(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "dist" | "build" | ".next" | "coverage")
        || name.ends_with(".log")
}

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("md" | "txt" | "json" | "yaml" | "yml")
    )
}

fn write_delivery_package(
    output_root: &Path,
    task_id: &str,
    documents: &DeliveryDocuments,
) -> Result<DeliveryPackage, std::io::Error> {
    let artifacts_dir = output_root.join("ytriple-outputs").join(task_id);
    fs::create_dir_all(output_root.join("ytriple-outputs"))?;
    fs::create_dir(&artifacts_dir)?;

    let file_map = BTreeMap::from([
        (DELIVERY_FILENAMES[0], documents.final_prd.as_str()),
        (DELIVERY_FILENAMES[1], documents.assumptions.as_str()),
        (DELIVERY_FILENAMES[2], documents.research_notes.as_str()),
        (DELIVERY_FILENAMES[3], documents.specialist_review.as_str()),
    ]);

    for (filename, content) in &file_map {
        fs::write(artifacts_dir.join(filename), content)?;
    }

    Ok(DeliveryPackage {
        artifacts_dir,
        files: DELIVERY_FILENAMES
            .iter()
            .map(|filename| filename.to_string())
            .collect(),
    })
}

fn render_delivery_documents(
    conductor: &ConductorOutput,
    researcher: &ResearcherOutput,
    specialist: &SpecialistOutput,
) -> DeliveryDocuments {
    DeliveryDocuments {
        final_prd: conductor.final_prd_markdown.clone(),
        assumptions: markdown_sections(
            "Assumptions and Open Questions",
            &[
                ("Assumptions", conductor.assumptions.clone()),
                ("Open Questions", conductor.open_questions.clone()),
            ],
        ),
        research_notes: render_research_notes(researcher),
        specialist_review: render_specialist_review(specialist),
    }
}

fn markdown_sections(title: &str, sections: &[(&str, Vec<String>)]) -> String {
    let mut markdown = format!("# {title}\n\n");
    for (heading, items) in sections {
        markdown.push_str(&format!("## {heading}\n"));
        if items.is_empty() {
            markdown.push_str("- None recorded\n\n");
        } else {
            for item in items {
                markdown.push_str(&format!("- {item}\n"));
            }
            markdown.push('\n');
        }
    }
    markdown
}

fn render_research_notes(researcher: &ResearcherOutput) -> String {
    let mut markdown = format!("# Research Notes\n\n## Summary\n{}\n\n", researcher.summary);
    markdown.push_str("## Key Findings\n");
    for item in &researcher.key_findings {
        markdown.push_str(&format!("- {item}\n"));
    }
    markdown.push_str("\n## Concepts\n");
    for item in &researcher.concepts {
        markdown.push_str(&format!("- {}: {}\n", item.name, item.note));
    }
    markdown.push_str("\n## Competitor Samples\n");
    for item in &researcher.competitor_samples {
        markdown.push_str(&format!("- {}: {}\n", item.name, item.note));
    }
    markdown.push_str("\n## Sources\n");
    for source in &researcher.sources {
        markdown.push_str(&format!(
            "- [{}]({}) - {}\n",
            source.title, source.url, source.reason
        ));
    }
    markdown
}

fn render_specialist_review(specialist: &SpecialistOutput) -> String {
    markdown_sections(
        "Specialist Review",
        &[
            ("Strengths", specialist.strengths.clone()),
            ("Risks", specialist.risks.clone()),
            ("Missing Sections", specialist.missing_sections.clone()),
            ("Recommendations", specialist.recommendations.clone()),
        ],
    )
}

fn validate_conductor(conductor: &ConductorOutput) -> Result<(), String> {
    if conductor.task_type != "prd" {
        return Err("Conductor returned unsupported task type.".to_string());
    }
    if conductor.artifact_manifest != DELIVERY_FILENAMES {
        return Err("Conductor returned invalid artifact manifest.".to_string());
    }
    Ok(())
}

fn researcher_prompt() -> String {
    [
        "You are yTriple Researcher in a fixed three-agent PRD workflow.",
        "Role library source: msitarzewski/agency-agents (MIT). yTriple uses the upstream catalog only as role-positioning reference, not as user-composable workflow agents.",
        "Selected role profile: Product Trend Researcher from agency-agents/product/product-trend-researcher.md.",
        "Use Ark web_search when useful for light research only.",
        "Return concise structured research support, not a deep industry report.",
        "Keep research notes separate from the PRD body.",
        "Do not invent statistics, report names, citations, URLs, competitors, or source-backed claims. If not grounded in tool output or supplied context, label it as an inference or assumption.",
        "Use market signals, competitor samples, and actionable insights.",
    ]
    .join("\n")
}

fn specialist_prompt() -> String {
    [
        "You are yTriple Specialist in the PRD template.",
        "Role library source: msitarzewski/agency-agents (MIT). yTriple uses the upstream catalog only as role-positioning reference, not as user-composable workflow agents.",
        "Selected role profile: Product Manager from agency-agents/product/product-manager.md.",
        "Use product_lead role only.",
        "Review problem framing, target users, scope, success metrics, non-goals, risks, missing sections, and recommendations.",
        "Make trade-offs explicit and protect focus.",
    ]
    .join("\n")
}

fn conductor_prompt() -> String {
    [
        "You are yTriple Conductor in a fixed three-agent PRD workflow.",
        "Role library source: msitarzewski/agency-agents (MIT). yTriple uses the upstream catalog only as role-positioning reference, not as user-composable workflow agents.",
        "Selected role profile: Agents Orchestrator from agency-agents/specialized/agents-orchestrator.md.",
        "Only support PRD first-draft delivery.",
        "Merge Researcher and Specialist outputs into a clean final PRD.",
        "Keep research notes and specialist review out of the PRD body.",
        "Do not present unsupported statistics, report names, or citations as facts. Keep unverified claims in assumptions/open questions.",
        "The artifact_manifest must be exactly: 01-final-prd.md, 02-assumptions-and-open-questions.md, 03-research-notes.md, 04-specialist-review.md.",
        "Enforce phase boundaries and evidence-based output.",
    ]
    .join("\n")
}

fn researcher_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "key_findings": {"type": "array", "items": {"type": "string"}},
            "concepts": {"type": "array", "items": named_note_schema()},
            "competitor_samples": {"type": "array", "items": named_note_schema()},
            "sources": {"type": "array", "items": source_schema()}
        },
        "required": ["summary", "key_findings", "concepts", "competitor_samples", "sources"],
        "additionalProperties": false
    })
}

fn specialist_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "role": {"type": "string", "enum": ["product_lead"]},
            "summary": {"type": "string"},
            "strengths": {"type": "array", "items": {"type": "string"}},
            "risks": {"type": "array", "items": {"type": "string"}},
            "missing_sections": {"type": "array", "items": {"type": "string"}},
            "recommendations": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["role", "summary", "strengths", "risks", "missing_sections", "recommendations"],
        "additionalProperties": false
    })
}

fn conductor_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "task_type": {"type": "string", "enum": ["prd"]},
            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
            "assumptions": {"type": "array", "items": {"type": "string"}},
            "open_questions": {"type": "array", "items": {"type": "string"}},
            "final_prd_markdown": {"type": "string"},
            "artifact_manifest": {
                "type": "array",
                "items": {"type": "string", "enum": DELIVERY_FILENAMES}
            }
        },
        "required": ["task_type", "confidence", "assumptions", "open_questions", "final_prd_markdown", "artifact_manifest"],
        "additionalProperties": false
    })
}

fn named_note_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "note": {"type": "string"}
        },
        "required": ["name", "note"],
        "additionalProperties": false
    })
}

fn source_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "url": {"type": "string"},
            "reason": {"type": "string"}
        },
        "required": ["title", "url", "reason"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ark_request_enables_web_search_only_for_researcher() {
        let researcher = build_ark_request(
            "researcher",
            "system",
            "user",
            json!({"type": "object"}),
        &ArkConfig {
            api_key: "test-key".to_string(),
            base_url: "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            model: "doubao-seed-2-1-pro-260628".to_string(),
                enable_web_search: true,
                web_search_max_keyword: 2,
                web_search_limit: 5,
            },
        );
        let specialist = build_ark_request(
            "specialist",
            "system",
            "user",
            json!({"type": "object"}),
        &ArkConfig {
            api_key: "test-key".to_string(),
            base_url: "https://ark.cn-beijing.volces.com/api/v3".to_string(),
            model: "doubao-seed-2-1-pro-260628".to_string(),
                enable_web_search: true,
                web_search_max_keyword: 2,
                web_search_limit: 5,
            },
        );

        assert_eq!(
            researcher["tools"],
            json!([{"type": "web_search", "max_keyword": 2, "limit": 5}])
        );
        assert!(specialist.get("tools").is_none());
    }

    #[test]
    fn extracts_text_from_supported_ark_response_shapes() {
        assert_eq!(
            extract_ark_output_text(&json!({"output_text": "{\"ok\":true}"})).unwrap(),
            "{\"ok\":true}"
        );
        assert_eq!(
            extract_ark_output_text(&json!({
                "output": [{
                    "type": "message",
                    "content": [{"type": "output_text", "text": "{\"ok\":true}"}]
                }]
            }))
            .unwrap(),
            "{\"ok\":true}"
        );
    }

    #[test]
    fn delivery_writer_creates_fixed_files_and_refuses_overwrite() {
        let root = std::env::temp_dir().join(format!("ytriple-rust-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let package = DeliveryDocuments {
            final_prd: "# Final".to_string(),
            assumptions: "# Assumptions".to_string(),
            research_notes: "# Research".to_string(),
            specialist_review: "# Review".to_string(),
        };

        let first = write_delivery_package(&root, "task-001", &package).unwrap();

        assert!(first.artifacts_dir.ends_with("ytriple-outputs/task-001"));
        assert_eq!(first.files.len(), 4);
        assert_eq!(
            std::fs::read_to_string(first.artifacts_dir.join("01-final-prd.md")).unwrap(),
            "# Final"
        );
        assert!(write_delivery_package(&root, "task-001", &package).is_err());
    }
}
