# yTriple V1 Product Contract

## Purpose

本文件定义 yTriple 第一阶段的产品执行边界。它不是泛介绍，而是后续设计、实现和验证都要遵守的固定 contract。

V1 目标只有一个：把模糊产品想法快速收束成一个可继续迭代的 `PRD 首稿交付包`。

## Core Contract

- 固定三 Agent 工作流
- 首个核心模板是 `PRD`
- 支持 Web 轻调研
- 支持工作区只读
- 允许新建输出文档
- 不修改已有文档
- 不做 Git
- 不做用户可编排工作流

## Agent Roles

### Conductor

职责：

- 判断当前任务是否属于 PRD 交付
- 决定是否发起 Quick Clarify
- 拆解任务并调度另外两个 Agent
- 审查、合并并产出最终交付

约束：

- 不把过程讨论直接等价为最终输出
- 不因信息不完整而默认无限追问
- 必须显式记录假设与未决问题

### Researcher

职责：

- 进行轻量 Web 调研
- 补足关键概念、公开事实、术语解释和少量竞品样本

约束：

- 不做深度行业研究
- 不把调研笔记写进 PRD 正文
- 不追求来源数量，追求方向支撑

### Specialist

职责：

- 按模板切换专业视角
- 对结构、范围、专业判断和质量提出建议

V1 角色库示例：

- 产品负责人
- 技术架构师
- 增长顾问
- 品牌顾问

约束：

- V1 仍只有一个 Specialist 槽位
- 多角色扩展通过模板绑定实现，而不是增加并行 Agent 数量

## Workflow Contract

```text
User Input
   |
   v
Conductor
   |
   +--> optional Quick Clarify (0-2 key questions)
   |
   +--> Researcher
   |
   +--> Specialist
   |
   v
Conductor Review + Merge
   |
   v
Delivery Package
```

### Quick Clarify Policy

- 默认先尝试直接执行
- 如果信息足以推断方向，不追问
- 如果信息模糊但仍能前进，带假设执行
- 只有在无法判断产品对象或目标时，才追问 1 到 2 个关键问题

### First Draft Policy

- 第一版以“给方向”为优先目标
- 第一版允许不完整，但必须结构清晰
- 第一版允许带假设，但必须显式暴露
- 第一版不假装是最终冻结稿

## Template Contract

V1 的模板不是单纯 prompt，而是结构化配置。每个模板至少需要：

- `template_id`
- `target_document`
- `default_specialist_role`
- `research_policy`
- `output_schema`
- `review_checklist`

### V1 PRD Template

- `template_id`: `prd`
- `target_document`: `product requirements document`
- `default_specialist_role`: `product_lead`
- `research_policy`: `light_web_research`
- `output_schema`: `final_prd + assumptions + research_notes + specialist_review`

## Workspace Policy

### Allowed

- 用户显式选择工作区
- 读取工作区文件
- 搜索工作区文本
- 基于工作区资料生成新文档

### Forbidden

- 修改已有文件
- 删除已有文件
- 隐式扫描未授权目录
- 访问 Git 写操作

## Tool Surface

V1 预期最小工具面：

- `list_workspace_files`
- `read_workspace_file`
- `search_workspace_text`
- `web_search`
- `create_output_document`

说明：

- `web_search` 只服务于轻量事实补足
- `create_output_document` 只写新文件，不覆盖旧文件

## Model and Runtime Direction

### Provider Layer

- 使用聚合模型 API，例如 OpenRouter
- 通过统一入口接入多个模型
- 优先使用结构化输出与工具调用能力

### Runtime Layer

- 采用轻量固定编排 runtime
- 不以 LangGraph 式图编排作为 V1 入口
- 编排核心固定为 `Conductor -> parallel(Researcher, Specialist) -> Conductor`

## Delivery Package

每次 PRD 任务默认输出：

- `01-final-prd.md`
- `02-assumptions-and-open-questions.md`
- `03-research-notes.md`
- `04-specialist-review.md`

### Output Rules

- `01-final-prd.md` 是唯一主产物
- 其余文件是参考资料
- 参考资料不混入 PRD 正文
- 交付物应作为一个目录或文件组被理解，而不是一条消息

## Success Criteria

若 V1 成立，应至少满足：

1. 用户能从模糊输入快速获得方向正确的 PRD 首稿。
2. 首稿不依赖长时间追问才能启动。
3. 交付结果天然区分主产物与参考资料。
4. 系统能利用工作区只读上下文和 Web 轻调研提升首稿质量。
5. 产品体验保持“固定工作流、低配置、快速成稿”。
