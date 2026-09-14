# Mobile Readiness Checklist

## Status

Design only。手机端在重建计划里排最后，代码不在本轮范围内。本文件的作用是**现在就把接口和前提定下来**，让手机端开工时不需要服务端返工。

前提定位见 [Positioning](../product/positioning.md)。接口见 [API 契约](../server/api-contract.md)。运行边界见 [运行时边界契约](../contracts/runtime-boundary-contract.md)。

## What Mobile Is And Is Not

手机端不是桌面工作台的移植。它是 **thin client**：不跑 `packages/core`，全部经 `apps/server` 的 HTTP + SSE。

### 手机端做什么

1. **雷达消费**（主场景）。碎片时间刷 feed、看每日 digest、收高分条目推送。这是手机端存在的主要理由——尤其对个人自媒体工作者，选题输入天然发生在手机上。
2. **任务旁观**。桌面派发的任务，在手机上看进度和结果。
3. **轻量输入**。回答 orchestrator 的提问、从 story 一键起任务。灵感来的时候先把任务起起来。
4. **只读结果**。查看 `prd.md`。

### 手机端不做什么

- 不读工作区。`workspaceRead` 在服务端恒为 false，工作区入口在手机端**必须整个不存在**。
- 不编辑 `prd.md`。移动端不是文档编辑环境。
- 不编辑团队定义。查看可以，编辑留给桌面。
- 不录入 provider 凭据。在手机上贴 API key 体验差且不安全；显示已配置状态即可。
- 不跑本地模型。
- 不在设备上跑 `core`。因此不需要为手机端做 React Native / Flutter 的 TS 运行时适配。

最后一条是这份清单最重要的取舍：一旦手机端要跑 `core`，技术选型立刻被锁死在 JS 生态，且要为移动端补一整套 port 实现。thin client 让选型保持自由。

## Readiness Checklist

手机端开工前，下面每一项都要能勾上。带 ✅ 的是本轮设计已经定下的。

### A. 契约就绪

- ✅ 事件信封（`seq` / `runId` / `ts` / `event`）已定义，见 [API 契约](../server/api-contract.md) 的 Event Stream。
- ✅ 事件类型按 `agentId` 寻址，不含固定三 agent 字段，见 [Agent 团队契约](../contracts/agent-team-contract.md)。
- ✅ 统一错误信封与错误码表已定义，含 `capability_unavailable`。
- ✅ 全列表端点为游标分页，无 offset。
- ✅ 兼容性策略为 additive-only；客户端必须忽略未知事件类型与未知枚举值。
- ⬜ `packages/shared` 提供可被非 TS 客户端消费的 schema（OpenAPI 或 JSON Schema 导出）。选 Flutter 或原生时必需。
- ⬜ 类型导出在 CI 里校验，防止服务端改了类型忘了同步。

### B. 服务端就绪

- ✅ SSE 断线重连语义已定（`Last-Event-ID` + `?after=<seq>` 补齐 + 快照冷启动）。
- ✅ 事件持久化窗口等于任务数据保留期，不是几分钟。手机端后台恢复靠这条。
- ✅ `GET /v1/runs/{runId}` 返回完整可渲染快照，供冷启动一次性渲染。
- ✅ `GET /v1/radar/feed?since=` 支持增量拉取，供离线缓存与后台刷新。
- ⬜ 图片 / favicon 代理端点。直接从第三方站点加载会漏 IP 且经常失败。
- ⬜ 弱网友好的响应体积（feed 条目支持精简字段集）。
- ⬜ 后台刷新窗口内的批量拉取上限已定。

### C. 认证就绪

- ✅ device flow 已定（`/v1/auth/device/start` + `poll`），不需要在客户端嵌 OAuth 回调。
- ✅ 多设备支持，每设备独立 token 可单独吊销。
- ✅ token 刷新端点已定。
- ⬜ token 存储方案：iOS Keychain / Android Keystore。
- ⬜ 登出与远端吊销后的客户端行为（清缓存、回登录页）。

### D. 能力协商就绪

- ✅ `GET /v1/capabilities` 返回 `runtime` / `limits` / `quota` / `features`。
- ✅ 字段与 `RuntimeCapabilities` 一一对应。
- ⬜ 手机端启动流程强制先取 capabilities 再渲染主界面。
- ⬜ 有一条自动化检查：capabilities 里为 false 的能力，UI 上没有对应入口。这是防止「能点但会失败」的按钮回归的唯一可靠办法。

### E. 推送就绪

- ✅ `POST /v1/devices` 注册 push token 与时区。
- ✅ payload 只带 id 与一行标题，正文由客户端拉取，敏感内容不进第三方推送通道。
- ✅ deep link 形式已定（`ytriple://story/{id}`、`ytriple://run/{id}`）。
- ✅ 静默窗与每日推送上限在服务端 `delivery/preferences` 里，不在客户端。
- ⬜ APNs / FCM 凭据与投递失败重试策略。
- ⬜ token 失效清理（推送被拒后自动移除失效 device）。
- ⬜ 系统级通知权限被拒时的降级路径（退回应用内 badge）。

### F. 产品就绪

- ⬜ 雷达在真实使用中被证明是每天回来的理由。**这是最重要的一条**：如果雷达在桌面和邮件 digest 上都没人每天看，手机端不该开工。
- ⬜ 每日活跃的 feed 消费量足以支撑一个独立客户端的维护成本。
- ⬜ 「从 story 起任务」这条路径在桌面端已验证有效。
- ⬜ 明确的手机端首屏：feed，而不是任务列表。

### G. 技术选型待定

- ⬜ 框架：React Native / Expo（团队是 TS 单人，复用心智成本最低）vs Flutter vs 原生。倾向 Expo，因为单人维护两个平台是硬约束。
- ⬜ 离线缓存层选型（feed 需要可离线阅读）。
- ⬜ Markdown 渲染方案（`prd.md` 只读展示）。
- ⬜ SSE 在移动端的实现与后台限制应对（iOS 后台不保连接，靠推送唤醒 + 快照补齐）。

## Interfaces Fixed In This Round

本轮设计已经为手机端定死的东西，后续不应因手机端而改动：

1. **能力协商端点**。手机端隐藏工作区入口的依据。
2. **事件信封与 `seq` 单调性**。断线重连与补齐的依据。
3. **快照 + 增量的双通道模型**。冷启动与后台恢复的依据。
4. **feed 的 `since` 游标与 `degradations` 字段**。离线缓存与降级可见性的依据。
5. **推送注册与 deep link 形状**。
6. **错误码表含 `capability_unavailable`**。
7. **手机端 MVP 端点子集**，见 [API 契约](../server/api-contract.md) 的 Mobile MVP Subset。

## Exit Criteria

手机端可以开工的判定条件：

1. A 组与 D 组全部勾上（契约与能力协商是硬前置，缺了必然返工）。
2. B 组的 SSE 重连与增量拉取已在桌面端或 CLI 上被真实验证过，不只是文档写着。
3. F 组第一条成立：雷达已被证明是留存理由。
4. 技术选型已定，且确认手机端不需要在设备上跑 `core`。
5. `packages/shared` 的 schema 能被目标框架消费。

任一条不满足就不开工。手机端是三条链路里最容易做成「有但没人用」的那条，前置门槛应该定得高。
