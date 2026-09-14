# yTriple V1 Technical Architecture

> **Superseded.** 本文档基于「固定三 Agent」的 V1 假设，已被「可配置 Agent 团队」模型取代，保留作为历史决策记录，不再作为实现依据。
>
> 现行契约：[Positioning](../product/positioning.md) · [Agent 团队契约](../contracts/agent-team-contract.md) · [Provider 契约](../contracts/provider-contract.md) · [运行时边界契约](../contracts/runtime-boundary-contract.md)
>
> 本文件中仍然有效的部分：桌面壳定位、工作区只读与输出边界、错误分级；单一 provider 策略与本地 runtime 分层已由新契约取代。

## Purpose

本文件定义 yTriple V1 的技术架构方向，确保后续实现围绕固定三 Agent PRD 工作流展开，而不是演化成通用 agent 平台。

## Architecture Goals

- 支持固定三 Agent 编排
- 支持工作区只读
- 支持 Web 轻调研
- 支持结构化交付包生成
- 保持桌面应用轻量

## High-Level Architecture

```text
Tauri Shell
  -> Frontend App (React recommended)
  -> Local Runtime Layer
       -> Task Orchestrator
       -> Workspace Access Layer
       -> Output Writer
       -> Provider Adapter
       -> Web Research Adapter
```

## Main Layers

### 1. Tauri Shell

职责：

- 提供桌面窗口和原生能力
- 处理工作区选择和本地文件系统授权
- 承载未来的全局快捷键能力

为什么适合：

- 包体轻
- 本地文件与桌面能力边界清楚
- 适合长期常驻的小工具定位

### 2. Frontend App

建议：

- V1 优先 React

职责：

- 渲染三舱布局
- 展示任务状态和交付包
- 承载输入、Quick Clarify 和历史任务

### 3. Local Runtime Layer

这是 V1 的核心，不应外包给现成 agent 产品。

职责：

- 维护任务状态机
- 组织三 Agent 执行
- 调用本地工具和模型 provider
- 写出最终交付包

## Runtime Components

### Task Orchestrator

职责：

- 创建任务对象
- 判断模板
- 执行 Quick Clarify
- 并行运行 Researcher 与 Specialist
- 触发 Conductor 合并

### Prompt / Role Builder

职责：

- 根据模板与角色库构造 agent 输入
- 为 Conductor、Researcher、Specialist 注入不同 instructions

### Workspace Access Layer

职责：

- 列文件
- 读文件
- 搜文本
- 应用只读边界和默认排除规则

### Web Research Adapter

职责：

- 为 Researcher 提供轻量搜索接口
- 统一收敛查询、结果和引用结构

### Output Writer

职责：

- 创建任务输出目录
- 写入单一默认交付文件 `prd.md`
- 保证不覆盖用户已有文档

### History Store

职责：

- 记录任务元数据
- 支撑任务历史列表
- 记录输出目录、状态、时间和模板

## Provider Strategy

### Primary Choice

- 使用 OpenRouter 作为统一模型入口

### Why

- 单一 API 可接入多模型
- 支持结构化输出和工具调用
- 后续可按模板或角色切换模型

### Constraint

- 不把产品工作流建立在 provider 原生 agent 产品之上
- 编排逻辑必须掌握在本地 runtime

## Model Assignment Direction

V1 建议先支持角色级模型配置，但保留合理默认值。

### Conductor

- 优先稳定、结构化能力强的模型

### Researcher

- 优先便宜、响应快、具备足够检索总结能力的模型

### Specialist

- 优先推理与结构判断能力较强的模型

## Data Model

建议至少保留以下本地数据对象：

### TaskRecord

- `task_id`
- `template_id`
- `status`
- `workspace_root`
- `specialist_role`
- `created_at`
- `updated_at`
- `artifacts_dir`

### TemplateRecord

- `template_id`
- `target_document`
- `default_specialist_role`
- `research_policy`
- `output_schema`

### RoleProfile

- `role_id`
- `name`
- `instructions`
- `review_focus`

## Execution Sequence

```text
1. User input received
2. Task record created
3. Template resolved
4. Optional Quick Clarify
5. Workspace context summarized
6. Researcher and Specialist run in parallel
7. Conductor merges structured outputs
8. Output Writer creates delivery package
9. Task record updated to completed
```

## File System Strategy

### Workspace

- 只读
- 用户显式授权
- 使用 allowlist + default excludes

### Output

- 独立输出目录
- 每个任务单独一个目录
- 固定文件命名

## Error Strategy

### Non-blocking Errors

- 个别来源读取失败
- 个别文件读取失败
- Web 搜索返回少量结果

处理：

- 任务继续
- 在参考资料中记录缺口

### Blocking Errors

- 无法访问 provider
- 无法写出输出目录
- Conductor 合并结构失败

处理：

- 任务失败
- UI 给出明确失败阶段

## Security And Boundary Rules

- 不修改工作区已有文件
- 不执行 Git 写操作
- 不默认扫描用户机器上的其他目录
- 输出写入只能落在受控输出目录

## Recommended Stack For V1

- Tauri
- React
- TypeScript
- 本地 lightweight orchestrator
- OpenRouter provider adapter
- 受控文件系统访问层

## Explicitly Deferred

- LangGraph 或其他可编排工作流框架
- Git 读写能力
- 多人协作与云同步
- 插件市场
- 可视化 agent builder
