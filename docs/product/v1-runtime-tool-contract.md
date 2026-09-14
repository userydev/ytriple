# yTriple V1 Runtime And Tool Contract

> **Superseded.** 本文档基于「固定三 Agent」的 V1 假设，已被「可配置 Agent 团队」模型取代，保留作为历史决策记录，不再作为实现依据。
>
> 现行契约：[Positioning](positioning.md) · [Agent 团队契约](../contracts/agent-team-contract.md) · [Provider 契约](../contracts/provider-contract.md) · [运行时边界契约](../contracts/runtime-boundary-contract.md)
>
> 本文件中仍然有效的部分：工作区只读工具的输入输出形状与默认排除规则；固定管线、`quick_clarify` 状态和 artifact manifest 作废。

## Purpose

本文件定义 yTriple V1 的运行时边界与工具契约，服务于后续桌面端实现、agent 编排和工具层开发。

它回答四个问题：

1. 一次任务在运行时如何流转。
2. 三个 Agent 在什么阶段读取什么上下文。
3. 工具层暴露什么能力。
4. 输出文档如何落盘。

## Runtime Overview

V1 不实现通用 agent 图编排。运行时采用固定管线：

```text
Task Start
  -> Task Classification
  -> Optional Quick Clarify
  -> Context Preparation
  -> Parallel Agent Run
  -> Conductor Merge
  -> Output Materialization
  -> Task Complete
```

### Runtime Principles

- 固定流程优先于动态编排。
- 单次任务以“快速形成第一版交付包”为目标。
- 运行时必须允许信息不足但方向可推断的任务继续前进。
- 所有写入动作只允许发生在输出目录中。

## Task State Model

建议 V1 使用显式任务状态，便于 UI、日志和恢复逻辑统一理解。

### Task States

- `drafting_input`
  - 用户正在输入自然语言需求，尚未开始执行。
- `classifying`
  - Conductor 判断任务类型，当前只重点支持 `prd`。
- `quick_clarify`
  - 系统发起极轻量确认，最多补 0 到 2 个关键问题。
- `preparing_context`
  - 运行时整理工作区上下文、用户输入和模板配置。
- `running_researcher`
  - Researcher 执行轻量 Web 调研。
- `running_specialist`
  - Specialist 执行模板化专业审查。
- `merging`
  - Conductor 审查、合并并生成最终交付内容。
- `writing_outputs`
  - 将交付包写入输出目录。
- `completed`
  - 本次任务结束，交付物可供用户查看与继续迭代。
- `failed`
  - 本次任务失败，需要用户重试或调整输入。

### State Transitions

```text
drafting_input
  -> classifying
  -> quick_clarify | preparing_context
  -> preparing_context
  -> running_researcher + running_specialist
  -> merging
  -> writing_outputs
  -> completed | failed
```

## Task Object

V1 建议在运行时维护统一任务对象：

```json
{
  "task_id": "uuid",
  "template_id": "prd",
  "status": "preparing_context",
  "workspace_root": "/absolute/path",
  "user_input": "raw request",
  "clarify_answers": [],
  "assumptions": [],
  "selected_specialist_role": "product_lead",
  "artifacts_dir": "/absolute/path/to/output",
  "created_at": "iso8601",
  "updated_at": "iso8601"
}
```

### Required Fields

- `task_id`
- `template_id`
- `status`
- `user_input`
- `selected_specialist_role`
- `created_at`
- `updated_at`

### Optional Fields

- `workspace_root`
- `clarify_answers`
- `assumptions`
- `artifacts_dir`
- `web_sources`
- `workspace_files_used`

## Agent Input Contract

三个 Agent 不应直接读取所有系统内部状态，而应获得收敛后的上下文切片。

### Shared Input

所有 Agent 都可以拿到：

- 用户原始输入
- Quick Clarify 结果
- 当前模板配置
- 当前任务允许使用的工具列表

### Conductor Input

- Shared Input
- 工作区上下文摘要
- Researcher 输出
- Specialist 输出
- 当前假设列表

### Researcher Input

- Shared Input
- 工作区中与当前任务最相关的文件摘要
- Web 能力开关与调研范围约束

### Specialist Input

- Shared Input
- 工作区中与当前任务最相关的文件摘要
- 当前模板绑定的专业角色说明

## Agent Output Contract

V1 建议三个 Agent 都使用结构化输出，避免合并阶段过度依赖自由文本解析。

### Conductor Output

```json
{
  "task_type": "prd",
  "confidence": "medium",
  "assumptions": [
    "..."
  ],
  "open_questions": [
    "..."
  ],
  "final_prd_markdown": "...",
  "artifact_manifest": [
    "prd.md"
  ]
}
```

### Researcher Output

```json
{
  "summary": "...",
  "key_findings": [
    "..."
  ],
  "concepts": [
    {
      "name": "...",
      "note": "..."
    }
  ],
  "competitor_samples": [
    {
      "name": "...",
      "note": "..."
    }
  ],
  "sources": [
    {
      "title": "...",
      "url": "https://...",
      "reason": "..."
    }
  ]
}
```

### Specialist Output

```json
{
  "role": "product_lead",
  "summary": "...",
  "strengths": [
    "..."
  ],
  "risks": [
    "..."
  ],
  "missing_sections": [
    "..."
  ],
  "recommendations": [
    "..."
  ]
}
```

## Tool Contract

V1 最小工具集如下。

## `list_workspace_files`

### Purpose

列出工作区中允许暴露给运行时的文件。

### Input

```json
{
  "workspace_root": "/absolute/path",
  "include_globs": ["docs/**", "*.md"],
  "exclude_globs": ["node_modules/**", ".git/**", "dist/**"],
  "max_results": 500
}
```

### Output

```json
{
  "files": [
    {
      "path": "docs/product/prd-v1.md",
      "size_bytes": 1234,
      "mime_type": "text/markdown"
    }
  ]
}
```

### Rules

- 只返回相对 `workspace_root` 的路径。
- 默认排除隐藏系统目录和超大构建目录。
- V1 只需要覆盖文本类文件。

## `read_workspace_file`

### Purpose

读取工作区内单个文件内容。

### Input

```json
{
  "workspace_root": "/absolute/path",
  "path": "docs/product/prd-v1.md",
  "start_line": 1,
  "end_line": 200
}
```

### Output

```json
{
  "path": "docs/product/prd-v1.md",
  "content": "...",
  "truncated": false
}
```

### Rules

- 路径必须位于 `workspace_root` 内。
- 默认只读文本文件。
- V1 可按行段读取，避免一次性拉入超长上下文。

## `search_workspace_text`

### Purpose

在工作区文本文件中搜索关键词。

### Input

```json
{
  "workspace_root": "/absolute/path",
  "query": "PRD template",
  "include_globs": ["**/*.md", "**/*.txt"],
  "exclude_globs": ["node_modules/**", ".git/**"],
  "max_results": 50
}
```

### Output

```json
{
  "matches": [
    {
      "path": "docs/product/prd-v1.md",
      "line": 120,
      "snippet": "V1 的核心模板为 `PRD`..."
    }
  ]
}
```

### Rules

- 搜索结果必须可追溯到文件和行号。
- 只返回必要片段，不返回整个文件。

## `web_search`

### Purpose

执行轻量 Web 调研，为 Researcher 提供事实补足材料。

### Input

```json
{
  "query": "PRD best practices for early stage product teams",
  "max_results": 5,
  "search_mode": "light_research"
}
```

### Output

```json
{
  "results": [
    {
      "title": "...",
      "url": "https://...",
      "snippet": "...",
      "source_type": "article"
    }
  ]
}
```

### Rules

- V1 只支持轻调研，不做深挖。
- 结果数默认较小，强调速度而非覆盖率。
- 结果需要可引用，以便写入 `research notes`。

## `create_output_document`

### Purpose

在输出目录中新建交付文档。

### Input

```json
{
  "artifacts_dir": "/absolute/path/to/output",
  "filename": "prd.md",
  "content": "# ..."
}
```

### Output

```json
{
  "path": "/absolute/path/to/output/prd.md",
  "created": true
}
```

### Rules

- 只能写入 `artifacts_dir`。
- 不允许覆盖工作区已有文件。
- 如存在同名文件，运行时应生成新任务目录，而不是覆盖旧输出。

## Workspace Boundary Rules

### Allowed Inputs

- 用户显式选择的工作区目录
- 用户拖入或点选的补充文件
- 运行时生成的输出目录

### Forbidden Inputs

- 未经授权的系统目录
- 用户家目录下的任意隐式扫描
- Git 元数据写操作
- 工作区外任意目标路径写入

### Recommended Default Excludes

- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- `.next/**`
- `coverage/**`
- `*.log`

## Output Materialization

### Directory Layout

建议每次任务输出到独立目录：

```text
<workspace-or-app-output-root>/
  ytriple-outputs/
    <task-id>/
      prd.md
```

### Naming Rules

- 文件名固定，降低理解成本
- 目录名使用 `task_id` 或 `yyyy-mm-dd-hhmmss-task-id`
- 不使用用户原始输入直接做目录名

## Failure Handling

### Recoverable Failures

- Web 搜索失败
- 单个文件读取失败
- 单个来源无法访问

处理原则：

- 允许继续执行
- 在 `assumptions/open questions` 或 `research notes` 中记录缺失

### Blocking Failures

- 无法创建输出目录
- 模板加载失败
- 三个核心 agent 中任一返回不可解析结构

处理原则：

- 任务进入 `failed`
- UI 明确显示失败阶段和原因

## Logging And Trace Expectations

V1 不需要复杂观测平台，但至少应保留：

- 当前任务状态
- Quick Clarify 是否触发
- 使用了哪些工作区文件
- 使用了哪些 Web 来源
- 生成了哪些交付文件

这些信息应主要服务于：

- 侧舱过程展示
- 问题排查
- 后续质量评估
