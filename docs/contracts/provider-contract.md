# yTriple Provider Contract

## Status

Active。本文件取代 [V1 Technical Architecture](../technical/v1-technical-architecture.md) 的 Provider Strategy（OpenRouter 单入口）与 [V1 Product Contract](../product/v1-product-contract.md) 的 Model and Runtime Direction（Ark 单 provider）。

前提定位见 [Positioning](../product/positioning.md)。槽位概念见 [Agent 团队契约](agent-team-contract.md)。

## Core Proposition

**编排层只依赖能力标记，不依赖 provider 品牌。**

旧文档先后押注 OpenRouter 和 Ark，两次都把 provider 的具体形态泄漏进了业务流程（例如「Ark web_search 只允许在 Researcher slot 使用」）。目标用户普遍已经手里有某家的 key（见 [Positioning](../product/positioning.md) 的 BYOK 假设），产品不能替他们选。

三条硬规则：

1. 每个 adapter 声明一张 `ProviderCapabilities`，编排层只读这张表做决策。
2. 能力缺失走**声明式降级**，不是每家写一套 if。
3. 模型按 Agent 槽位绑定，不是全局单一模型。

## Adapter Families

只维护三个 adapter 家族，其余厂商通过兼容端点接入：

| adapterId | 覆盖对象 | 说明 |
| --- | --- | --- |
| `google` | Gemini | 原生 search grounding、原生 JSON schema |
| `openai_compatible` | DeepSeek、Ark 的 OpenAI 兼容端点、OpenRouter、本地 Ollama、其他兼容服务 | 靠 `baseUrl` + `modelId` + 能力覆写区分 |
| `ark` | 火山方舟 Responses API | 原生 `web_search` 工具，非 OpenAI 形状，单独实现 |

新增厂商的默认动作是**加一条 provider 配置**，不是加一个 adapter。只有 API 形状不兼容时才允许新增 adapter 家族。

```ts
interface ProviderConfig {
  providerId: string;          // 用户可见的实例 id，例如 "deepseek-personal"
  adapterId: "google" | "openai_compatible" | "ark";
  displayName: string;
  baseUrl?: string;
  models: ModelConfig[];
  credentialRef: string;       // 指向 SecretPort 里的凭据，绝不内联明文
}

interface ModelConfig {
  modelId: string;
  displayName: string;
  capabilities: ProviderCapabilities;   // 可被自检结果覆写
  pricing?: { inputPerMTokens: number; outputPerMTokens: number; currency: "USD" | "CNY" };
}
```

## Capability Table

### Schema

```ts
interface ProviderCapabilities {
  structuredOutput: "json_schema" | "json_mode" | "none";
  toolCalling: "parallel" | "sequential" | "none";
  nativeWebSearch: boolean;
  streaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  reasoningEffort: boolean;      // 是否支持推理强度档位
  visionInput: boolean;          // 预留，当前流程不用
  costTier: "cheap" | "standard" | "premium";
}
```

能力值来源优先级：**运行时自检结果 > 用户手工覆写 > adapter 内置默认**。自检不可用时降到内置默认，并在 UI 标注「未验证」。

### 已知基线

下表是 adapter 内置默认值的基线，具体模型可能不同，因此实际能力必须以自检为准。

| 目标 | structuredOutput | toolCalling | nativeWebSearch | streaming | context |
| --- | --- | --- | --- | --- | --- |
| Gemini（`google`） | `json_schema` | `parallel` | 是（search grounding） | 是 | 大 |
| DeepSeek（`openai_compatible`） | `json_mode` | `sequential` | 否 | 是 | 中 |
| Ark Responses（`ark`） | `json_schema` | `sequential` | 是（原生 `web_search`） | 是 | 中 |
| OpenRouter（`openai_compatible`） | 随上游模型 | 随上游模型 | 否 | 是 | 随上游模型 |
| Ollama 本地（`openai_compatible`） | `json_mode` 或 `none` | 多为 `none` | 否 | 是 | 小 |

「随上游模型」的情况必须靠自检确定，不允许乐观假设。

## Adapter Interface

```ts
interface ProviderAdapter {
  adapterId: string;

  describe(model: ModelConfig): ProviderCapabilities;

  healthCheck(model: ModelConfig): Promise<HealthCheckResult>;

  generate(req: GenerateRequest): Promise<GenerateResult>;

  stream?(req: GenerateRequest): AsyncIterable<GenerateChunk>;
}

interface GenerateRequest {
  model: ModelConfig;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: JsonSchema;
  maxOutputTokens?: number;
  nativeWebSearch?: boolean;     // 仅在 capabilities.nativeWebSearch 为 true 时允许
  abortSignal?: AbortSignal;
}

interface GenerateResult {
  text: string;
  parsed?: unknown;              // responseSchema 命中时的结构化结果
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  degradations: Degradation[];   // 本次调用发生的降级，必须回报
}
```

`degradations` 是契约的一部分：任何降级都必须冒泡到事件流，让用户知道「这次结构化输出是靠重试拿到的」或「这次调研走的是外部搜索而不是原生联网」。静默降级视为缺陷。

## Degradation Policy

降级是声明式的：编排层读能力表，选定策略链，adapter 不自行发明兜底。

### 结构化输出

```text
json_schema  -> 直接下发 schema，一次成功
json_mode    -> 下发 JSON mode + schema 描述进 prompt
                -> 本地校验 -> 失败则带校验错误重试，最多 2 次
                -> 仍失败则本次调用失败
none         -> 分隔符包裹的 JSON + 宽松解析 + 本地校验 + 最多 2 次重试
                -> orchestrator 槽位禁止使用 none 级模型
```

理由：orchestrator 要产出 `TaskBrief` 和最终合并结果，结构可靠性直接决定任务成败。普通成员的贡献可以靠重试兜住。

### 原生联网

```text
nativeWebSearch = true   -> 直接用 provider 原生搜索，来源由 provider 返回
nativeWebSearch = false  -> 回退到独立 SearchPort（见运行时边界契约）
SearchPort 也不可用      -> web_search 工具在本次任务注册为 unavailable
                            TaskBrief.contextAvailability.webSearch = false
                            orchestrator 必须在 prd.md 的假设一节声明「无外部来源支撑」
```

关键变化：联网能力不再绑定在某个具名槽位上。任何持有 `web_search` 工具的成员都能联网，能力来源由 provider 与 port 共同决定。

### Tool calling

```text
parallel / sequential -> 正常派发工具
none                  -> 校验期拒绝：该模型不能绑定到 tools 非空的成员
```

不做「用 prompt 模拟工具调用」的兜底。对单人用户来说，这种兜底的失败率和调试成本都不划算。

### 流式

```text
streaming = true  -> 逐块转成 agent_stage / agent_message 事件
streaming = false -> 一次性返回后发单个完成事件，UI 显示「进行中」但不伪造逐字输出
```

### 上下文超限

估算 prompt 超过 `maxContextTokens` 时按固定优先级裁剪，高优先级最后被裁：

1. `TaskBrief` 与成员的 `memberTasks`（永不裁剪，超限直接失败）
2. 角色 profile 与工具定义
3. 最近若干轮共享聊天
4. 工作区文件摘要（按相关度从低到高裁）
5. 早期共享聊天转录
6. 原始搜索结果全文（只留摘要与来源）

裁剪必须产出一条 `degradations` 记录。

## Model Binding Per Slot

```ts
interface ModelBinding {
  providerId: string;
  modelId: string;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  costCeiling?: { maxTokens: number };
}
```

### 继承规则

```text
子 Agent            -> 继承父 Agent 的 ModelBinding（可下调到更便宜模型，不可换出父模型之外）
成员 AgentDefinition -> member.model ?? team.defaultModel
团队 defaultModel    -> 用户全局默认 provider/model
```

### 推荐默认

只是默认，不是限制：

- **orchestrator**：结构化能力最强的那个（`structuredOutput = json_schema`，`costTier` 允许 premium）。这里省钱最不划算。
- **调研型成员**：`nativeWebSearch = true` 且 `costTier = cheap` 优先。调研调用次数最多。
- **审查型成员**：`reasoningEffort` 可用、推理较强的 standard 档。

配置界面必须在绑定时显示该模型的能力表和单价，让成本在选择当时就可见。

## Credentials

- 凭据只存宿主提供的 `SecretPort` 后端：桌面走系统 keyring / Tauri store，服务端走托管 secret store。
- **凭据绝不进 renderer 进程，绝不进 core，绝不写日志，绝不进事件流。** core 只见到 `credentialRef`。
- 本地 provider（Ollama 等）允许无凭据。
- 托管模式下用户可以选择上传自己的 key（BYOK），此时该 provider 的用量不计托管额度，见 [托管运行时与订阅](../server/hosted-runtime-and-subscription.md)。
- 删除 provider 配置必须同时删除凭据。

## Self-Check

新增或修改 provider 后必须能一键自检，结果落到配置界面：

```ts
interface HealthCheckResult {
  reachable: boolean;
  latencyMs?: number;
  detected: Partial<ProviderCapabilities>;   // 探测到的实际能力
  mismatches: string[];                      // 与声明能力不符的项
  error?: { code: ProviderErrorCode; message: string };
}
```

自检步骤：连通性 → 最小 completion → 结构化输出探测（下发一个小 schema）→ tool calling 探测（下发一个假工具）→ 原生联网探测（可跳过）。探测结果覆写能力表并标记为「已验证」。

自检失败不阻止保存配置，但该 provider 在任务启动前的能力检查中会被标为不可用。

## Error Taxonomy

```ts
type ProviderErrorCode =
  | "auth_failed"          // 阻塞：凭据无效
  | "rate_limited"         // 可恢复：指数退避重试
  | "quota_exceeded"       // 阻塞：换 provider 或等额度
  | "context_overflow"     // 可恢复：触发上下文裁剪后重试一次
  | "schema_violation"     // 可恢复：带校验错误重试，最多 2 次
  | "content_filtered"     // 可恢复：记录并跳过该子任务
  | "network"              // 可恢复：退避重试最多 3 次
  | "timeout"              // 可恢复：退避重试最多 2 次
  | "unsupported"          // 阻塞：能力不足，配置期就该拦住
  | "unknown";             // 阻塞
```

- 可恢复错误由 adapter 内部处理并回报到 `degradations`；重试次数耗尽后升级为阻塞错误。
- 成员级阻塞错误不必然导致任务失败：orchestrator 可以只带其余成员的贡献继续合并，并在 `prd.md` 的未决问题里记录缺口。
- orchestrator 自身的阻塞错误直接让任务进入 `failed`，UI 显示失败阶段与 provider 错误码。

## Acceptance Criteria

1. 新增一个 OpenAI 兼容厂商只需要加配置，不改 core 与编排代码。
2. 把某成员的模型从支持原生联网换成不支持，任务照样跑通，来源改由 `SearchPort` 提供，并出现一条 `degradations` 记录。
3. 把 orchestrator 绑到 `structuredOutput = none` 的模型时，配置校验期就报错，而不是运行到一半失败。
4. `json_mode` 模型的 schema 违规重试路径有测试覆盖。
5. 不同成员绑不同 provider 的组合能在一次任务里并行跑通。
6. 任何日志、事件、错误信息里都搜不到明文 API key。
7. 自检能检出「声明支持 tool calling 但实际不支持」的情况。

## Review Gate

出现以下情况应直接驳回实现：

- 编排层里出现 `if (provider === "ark")` 之类的品牌分支。
- 能力缺失时静默降级且没有 `degradations` 记录。
- 联网能力绑定在具名槽位上。
- 凭据出现在 renderer、core、日志或事件里。
- 新增一家厂商需要改动 `packages/core`。
- 用 prompt 模拟 tool calling 作为兜底。
