# Client-Server API Contract

## Status

Design only。本文件对应重建计划阶段 6。手机端后置，但接口现在就定——因为接口定晚了，手机端开工时会逼着服务端返工。

前提定位见 [Positioning](../product/positioning.md)。能力协商见 [运行时边界契约](../contracts/runtime-boundary-contract.md)。托管形态见 [托管运行时与订阅](hosted-runtime-and-subscription.md)。

## Principles

1. **REST + SSE。** 状态变更走 REST，运行过程走 SSE。不引入 WebSocket：任务事件是单向的，SSE 的重连语义（`Last-Event-ID`）正好够用，且穿透代理更省心。
2. **类型同源。** 请求响应类型与事件信封定义在 `packages/shared`，服务端与所有客户端 import 同一份。不手写两遍。
3. **版本化路径。** 全部端点前缀 `/v1`。
4. **加法优先。** 兼容性策略是 additive-only，见文末。
5. **客户端不做业务判断。** 能力开关、额度、可用工具一律由服务端下发，客户端只渲染。

## Authentication

```text
POST /v1/auth/device/start        -> { deviceCode, userCode, verificationUrl, expiresIn }
POST /v1/auth/device/poll         -> { accessToken, refreshToken, expiresIn } | { status: "pending" }
POST /v1/auth/refresh             -> { accessToken, expiresIn }
POST /v1/auth/tokens              -> 创建长期 API token（CLI / 自动化用）
GET  /v1/auth/tokens              -> 列出 token（只回 metadata 与后四位）
DELETE /v1/auth/tokens/{tokenId}  -> 吊销
GET  /v1/me                       -> { userId, email, plan, quota }
DELETE /v1/me                     -> 删除账号与全部私有数据
```

- 所有业务端点用 `Authorization: Bearer <accessToken>`。
- device flow 服务桌面端与手机端：不在客户端里嵌 OAuth 回调。
- token 吊销立即生效（不靠过期）。

## Capability Negotiation

```text
GET /v1/capabilities
```

```json
{
  "runtime": {
    "workspaceRead": false,
    "outputWrite": true,
    "webSearch": true,
    "localModels": false,
    "persistentBackgroundRuns": true,
    "streaming": true
  },
  "limits": {
    "maxConcurrentRuns": 3,
    "maxTeamMembers": 6,
    "maxSubAgentDepth": 2,
    "maxRadarSources": 50
  },
  "quota": { "creditsRemaining": 820, "creditsTotal": 2000, "resetAt": 1760000000 },
  "features": ["radar", "digest", "byok"]
}
```

这是整份 API 里客户端最先该调的端点。它让「哪些能力只在桌面可用」在协议层可表达：托管返回 `workspaceRead: false`，手机端据此**必须**隐藏工作区入口，而不是显示一个点了会失败的按钮。`runtime` 的字段与 `RuntimeCapabilities` 一一对应。

## Providers And Teams

```text
GET    /v1/providers                        -> 已配置的 provider 实例 + 能力表
POST   /v1/providers                        -> 新增（凭据以字段传入，落 secret store，不回显）
PATCH  /v1/providers/{providerId}
DELETE /v1/providers/{providerId}           -> 同时删除凭据
POST   /v1/providers/{providerId}/healthcheck -> HealthCheckResult（含探测到的能力与 mismatches）
GET    /v1/providers/catalog                -> 平台已知的 adapter 与推荐模型清单

GET    /v1/teams                            -> 用户的团队定义列表
GET    /v1/teams/presets                    -> 内置预设（含 prd.default），只读
POST   /v1/teams                            -> 创建（通常是复制预设后修改）
GET    /v1/teams/{teamId}
PATCH  /v1/teams/{teamId}                   -> 需 If-Match（ETag 乐观并发）
DELETE /v1/teams/{teamId}
POST   /v1/teams/{teamId}/validate           -> 返回校验错误列表，不落库

GET    /v1/roles/catalog?compatibleWith=research  -> curated 角色库条目
```

- provider 响应里**永远不含明文凭据**，只回 `configured: true` 与 `keyHint: "…a4f2"`。
- `POST /v1/teams/{teamId}/validate` 存在的理由：团队校验规则定义在 `packages/core`（见 [Agent 团队契约](../contracts/agent-team-contract.md) 的 Validation Rules），客户端不该重新实现一遍。编辑器边改边调这个端点。
- `PATCH` 用 ETag 防多设备并发覆盖。

## Runs

```text
POST   /v1/runs                        -> 创建任务
GET    /v1/runs?cursor=&limit=&status= -> 历史列表（游标分页）
GET    /v1/runs/{runId}                -> 任务快照（状态 + brief + 成员进度 + 用量）
POST   /v1/runs/{runId}/messages       -> 用户在共享聊天里发言 / 回答提问
POST   /v1/runs/{runId}/dispatch       -> 用户确认 brief，触发派发
POST   /v1/runs/{runId}/cancel
DELETE /v1/runs/{runId}                -> 删除任务及其数据
GET    /v1/runs/{runId}/events         -> SSE 事件流
GET    /v1/runs/{runId}/events?after=<seq>  -> 补齐历史事件（非 SSE，JSON 数组）
GET    /v1/runs/{runId}/outputs        -> 输出清单
GET    /v1/runs/{runId}/outputs/prd.md -> 下载主交付物
```

创建请求：

```json
{
  "teamId": "prd.default",
  "initialMessage": "我想做一个把模糊想法变成 PRD 的工具",
  "mode": "hosted",
  "modelOverrides": { "researcher": { "providerId": "deepseek-personal", "modelId": "deepseek-chat" } },
  "seedFrom": { "type": "radar_story", "storyId": "st_123" }
}
```

- `Idempotency-Key` 必需。重复提交同一 key 返回同一个 run。
- `mode` 只接受 `hosted` 与 `hybrid`；`local-only` 不经服务端。
- `seedFrom` 是雷达与工作台的连接点：由 story 起任务时服务端负责把 `summary` / `whyItMatters` / 来源注入首条消息（见 [雷达服务设计](radar-service-design.md)）。
- 派发前服务端做额度与能力预检；不足则 400/402 立即失败，不创建半成品任务。

`GET /v1/runs/{runId}` 返回快照而不是只返回状态字符串：客户端冷启动（尤其手机端切回前台）需要一次拿到完整可渲染状态，然后再接 SSE 增量。

## Event Stream

### 信封

```ts
interface EventEnvelope<T = RuntimeEvent> {
  seq: number;          // 单调递增，同一 run 内唯一
  runId: string;
  ts: number;
  event: T;             // 见 Agent 团队契约的 RuntimeEvent
}
```

`RuntimeEvent` 的具体类型定义在 [Agent 团队契约](../contracts/agent-team-contract.md) 的 Event Stream 一节，按 `agentId` 寻址，含 `subagent_*` 事件。API 层不重新定义事件类型，只定义传输。

### SSE 帧

```text
id: 42
event: runtime
data: {"seq":42,"runId":"run_abc","ts":1760000000,"event":{"type":"agent_stage","agentId":"researcher","stage":"searching","detail":"..."}}

event: heartbeat
data: {"ts":1760000015}
```

- `id` 即 `seq`。断线重连带 `Last-Event-ID: 42`，服务端从 43 开始补发。
- 心跳每 15 秒一次，用于穿透代理超时和客户端探活。
- 终止帧：`event: terminal`，`data` 含最终状态。收到终止帧后客户端应关闭连接，不再重连。
- 事件保留至任务数据保留期结束，所以重连窗口不是几分钟而是几十天——这对手机端后台恢复是必要的。
- 单个 run 的并发 SSE 连接数有上限（多设备同看一个任务）。

### 客户端消费规则

1. 先 `GET /v1/runs/{runId}` 拿快照，记下 `lastSeq`。
2. 用 `Last-Event-ID: lastSeq` 接 SSE。
3. 按 `seq` 去重与排序；发现空洞则调 `GET /v1/runs/{runId}/events?after=<lastGoodSeq>` 补齐。
4. 不推断状态。状态只来自 `task_status` 事件与快照。

## Radar

```text
GET    /v1/radar/sources                    -> 用户订阅的源 + 健康状态
POST   /v1/radar/sources                    -> 添加自定义源
PATCH  /v1/radar/sources/{sourceId}
DELETE /v1/radar/sources/{sourceId}
GET    /v1/radar/sources/catalog?topic=     -> 内置 curated 源
POST   /v1/radar/sources/{sourceId}/verify  -> 试抓一次，返回样例条目

GET    /v1/radar/feed?cursor=&since=&topics=&audience=
GET    /v1/radar/feed/{storyId}             -> story 详情 + 全部来源 + enrichment
POST   /v1/radar/feed/{storyId}/feedback    -> { kind: "useful"|"irrelevant"|"mute_topic"|"mute_source" }
POST   /v1/radar/feed/{storyId}/enrich      -> 请求 Tier 3 深度加工（计入 credit）

GET    /v1/radar/preferences
PUT    /v1/radar/preferences                -> 画像显式部分 + 投递偏好
GET    /v1/radar/digests?cursor=            -> 历史 digest
GET    /v1/radar/digests/{digestId}
```

feed 条目响应形状（与 `Enrichment` 对齐）：

```json
{
  "items": [
    {
      "storyId": "st_123",
      "title": "...",
      "primaryUrl": "https://...",
      "sourceCount": 4,
      "publishedAt": 1760000000,
      "topics": ["typescript", "tooling"],
      "summary": "...",
      "whyItMatters": "...",
      "importance": 78,
      "confidence": "medium",
      "enrichmentTier": 2,
      "developerView": { "impact": "...", "actionability": "watch", "relatedStack": ["vite"] },
      "creatorView": null,
      "degradations": ["enrichment_budget_exhausted"]
    }
  ],
  "nextCursor": "eyJ..."
}
```

- `degradations` 在 feed 条目上是必需字段：加工降级必须对用户可见（预算耗尽、只有廉价档聚簇、无 `whyItMatters`），不允许静默。
- `since` 参数支持增量拉取，这是手机端离线缓存与后台刷新的基础。
- `audience` 参数决定返回 `developerView` 还是 `creatorView`；不传则按用户画像。

## Push Registration

```text
POST   /v1/devices                     -> { platform: "ios"|"android"|"desktop", pushToken, timezone }
PATCH  /v1/devices/{deviceId}          -> 更新 token 或时区
DELETE /v1/devices/{deviceId}
GET    /v1/devices
PUT    /v1/delivery/preferences        -> 渠道开关、静默窗、每日推送上限
POST   /v1/delivery/webhooks           -> IM webhook（用户自己的 Bot）
POST   /v1/delivery/test               -> 发一条测试投递
```

推送 payload 只带 `storyId` / `runId` 与一行标题，正文由客户端拉取。理由：推送通道不可靠也不适合承载正文，且避免敏感内容进第三方推送服务。deep link 形如 `ytriple://story/st_123` 与 `ytriple://run/run_abc`。

## Errors

统一错误信封：

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "本月 credit 已用完",
    "retryable": false,
    "details": { "creditsRemaining": 0, "resetAt": 1760000000 },
    "requestId": "req_abc123"
  }
}
```

| code | HTTP | retryable | 说明 |
| --- | --- | --- | --- |
| `unauthenticated` | 401 | 否 | token 缺失或失效 |
| `forbidden` | 403 | 否 | 访问不属于自己的资源 |
| `not_found` | 404 | 否 | |
| `validation_failed` | 400 | 否 | `details` 含逐字段错误 |
| `conflict` | 409 | 否 | ETag 不匹配 |
| `quota_exceeded` | 402 | 否 | credit 耗尽 |
| `plan_limit` | 402 | 否 | 触达 plan 限制（并发、源数、成员数） |
| `capability_unavailable` | 409 | 否 | 请求了当前宿主不支持的能力，例如托管模式的工作区 |
| `rate_limited` | 429 | 是 | 带 `Retry-After` |
| `provider_error` | 502 | 视情况 | `details.providerCode` 为 `ProviderErrorCode` |
| `internal` | 500 | 是 | |

- `capability_unavailable` 是刻意独立的错误码：它让客户端能区分「我要的功能这里没有」和「我请求写错了」，也是手机端排查隐藏入口遗漏的抓手。
- `provider_error` 的 `details.providerCode` 复用 [Provider 契约](../contracts/provider-contract.md) 的错误分类，不另造一套。
- `requestId` 必须在所有错误里返回，用于用户报障时定位。

## Cross-Cutting Conventions

- **分页**：全部列表端点用不透明游标 `cursor` + `limit`，返回 `nextCursor`。不用 offset。
- **限流**：按 token 和按 IP 双重限流，429 带 `Retry-After`。SSE 连接单独计额。
- **幂等**：所有可能产生副作用重复的 POST 接 `Idempotency-Key`（`/v1/runs`、`/v1/runs/{id}/messages`、`/v1/radar/*/feedback`）。
- **乐观并发**：`/v1/teams/{teamId}` 与 `/v1/radar/preferences` 返回 ETag，`PATCH` / `PUT` 要求 `If-Match`。
- **时间**：一律 Unix 毫秒整数，不用本地化字符串。时区只在投递偏好里出现。
- **字段命名**：`camelCase`，与 `packages/shared` 的 TS 类型一致。

## Compatibility Policy

- 加字段可以，删字段和改语义不行。
- 枚举值只能新增；客户端必须容忍未知枚举值（降级为「未知」显示，不崩）。
- 字段弃用流程：标记 deprecated → 文档写明替代字段与移除窗口 → 至少一个次版本后移除。
- 破坏性变更走新路径前缀 `/v2`，`/v1` 保留。
- 事件类型只能新增；客户端必须忽略未知 `event.type` 并继续处理后续事件。这条对手机端尤其关键，因为移动端更新滞后。

## Mobile MVP Subset

手机端 MVP 只需要下面这些端点。其余端点手机端不实现（详见 [手机端就绪度检查清单](../mobile/readiness-checklist.md)）：

| 端点 | 用途 |
| --- | --- |
| `/v1/auth/device/*`、`/v1/auth/refresh`、`/v1/me` | 登录与账号 |
| `/v1/capabilities` | 能力协商，决定隐藏哪些入口 |
| `/v1/radar/feed`、`/v1/radar/feed/{storyId}` | 雷达消费（手机端主场景） |
| `/v1/radar/feed/{storyId}/feedback` | 反馈 |
| `/v1/radar/preferences`、`/v1/delivery/preferences` | 偏好与静默窗 |
| `/v1/devices` | 推送注册 |
| `/v1/radar/digests` | 每日 digest |
| `/v1/runs`（POST + GET 列表 + GET 快照） | 从 story 起任务、看任务列表 |
| `/v1/runs/{runId}/events` | 旁观任务过程 |
| `/v1/runs/{runId}/messages` | 轻量回答 orchestrator 的提问 |
| `/v1/runs/{runId}/outputs/prd.md` | 只读查看结果 |

## Design Exit Criteria

1. `packages/shared` 能同时导出这些请求响应类型与事件信封，服务端与客户端零手写重复。
2. 事件信封 + `Last-Event-ID` + 快照补齐三者组合能覆盖手机端后台恢复场景。
3. 每个错误码都能对应到服务端一个具体检查点。
4. `GET /v1/capabilities` 的 `runtime` 字段与 `RuntimeCapabilities` 逐字段对齐。
5. feed 响应字段与 `Enrichment` schema 对齐，含 `degradations`。
6. 手机端 MVP 子集内的端点全部具备增量拉取或幂等语义。
