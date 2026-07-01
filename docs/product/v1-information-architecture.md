# yTriple V1 Information Architecture

## Purpose

本文件定义 yTriple V1 的信息架构，回答三个问题：

1. 用户在产品里会看到哪些一级对象。
2. 一次 PRD 任务由哪些信息单元组成。
3. 三舱界面各自承载什么内容。

V1 目标不是做复杂工作台，而是围绕 `PRD 首稿交付` 建立最小但完整的信息结构。

## IA Principles

- 以任务为核心，而不是以聊天消息为核心。
- 以交付包为结果，而不是以单条回答为结果。
- 以固定三 Agent 分工为过程视图，而不是开放式线程树。
- 以低配置、低学习成本为优先。

## Primary Objects

V1 的一级对象只保留以下几类：

### Workspace

- 用户显式选择的工作区
- 提供只读上下文来源
- 不是任务结果容器

### Task

- 一次从输入到交付的完整运行单元
- 绑定一个模板
- 绑定一个输出目录
- 拥有明确状态流

### Template

- 定义任务类型、默认 Specialist 角色、调研策略和输出结构
- V1 首个核心模板为 `PRD`

### Role Profile

- Specialist 的专业视角配置
- 例如：产品负责人、技术架构师、增长顾问、品牌顾问
- 在 V1 中作为模板内部配置存在，不单独暴露为复杂管理系统

### Artifact Package

- 一次任务最终生成的文件组
- 是用户实际消费和继续修改的结果

## Main Navigation Model

V1 建议只保留最少的主导航层级：

### 1. New Task

- 默认入口
- 用户输入模糊需求
- 系统识别模板并发起任务

### 2. Current Task

- 当前正在运行或刚完成的任务
- 展示三舱过程与交付包

### 3. History

- 展示历史任务列表
- 可重新打开交付包
- V1 只需要轻量列表，不需要复杂筛选和协作能力

### 4. Settings

- 模型入口配置
- Web 能力开关
- 默认输出路径
- 工作区选择策略

## Task Structure

一次 V1 PRD 任务由以下信息单元组成：

### A. User Input Block

- 原始自然语言描述
- 可选工作区引用
- 可选补充文件

### B. Quick Clarify Block

- 0 到 2 个关键问题
- 用户回答
- 系统形成的执行假设

### C. Runtime Context Block

- 模板配置
- 当前 Specialist 角色
- 工作区文件摘要
- Web 轻调研开关

### D. Agent Output Block

- Researcher 输出
- Specialist 输出
- Conductor 收敛结果

### E. Artifact Package Block

- 最终 PRD
- 假设与未决问题
- 调研笔记
- 专业审查意见

## Delivery Package IA

V1 的交付包结构固定为：

```text
Task
  -> 01-final-prd.md
  -> 02-assumptions-and-open-questions.md
  -> 03-research-notes.md
  -> 04-specialist-review.md
```

### Artifact Roles

#### `01-final-prd.md`

- 唯一主产物
- 用户最先打开
- 必须尽可能干净，不混入过程噪音

#### `02-assumptions-and-open-questions.md`

- 用于承接首稿阶段不可避免的假设
- 让用户快速知道哪些地方还要确认

#### `03-research-notes.md`

- 存放轻量 Web 调研内容
- 保留关键概念、事实和少量竞品样本

#### `04-specialist-review.md`

- 存放 Specialist 的结构和专业判断
- 作为修订时的高价值参考

## Screen-Level IA

### Home / New Task

信息单元：

- 顶部品牌和当前工作区信息
- 主输入区
- 模板识别或模板选择提示
- 最近任务入口

### Active Task

信息单元：

- 当前任务标题和状态
- 三舱主体
- 交付包侧栏或底部入口
- 重新生成 / 继续修订入口

### Task History

信息单元：

- 历史任务列表
- 每个任务的模板、状态、时间、输出目录
- 点击后打开交付包

### Settings

信息单元：

- Model provider 配置
- 默认模型设置
- 输出目录设置
- Web 能力设置
- 工作区读取设置

## Tri-Panel Content Model

### Left Panel: Research

只展示：

- 当前调研问题
- 已发现的关键概念
- 来源卡片
- 调研简要结论

不展示：

- 无关长文本
- 过深的逐步推理

### Center Panel: Conductor

只展示：

- 用户输入
- Quick Clarify
- Conductor 的任务分派与收敛摘要
- 最终交付入口

不展示：

- 大量低价值中间日志

### Right Panel: Specialist

只展示：

- 当前专业角色
- 结构建议
- 风险点
- 缺失项
- 修订建议

不展示：

- 与当前模板无关的自由发挥

## Future-Safe Extensions

为后续扩展预留但 V1 不实现：

- 多模板首页
- Specialist 角色切换器
- 交付包比较视图
- 同一任务的多轮迭代树
- Git / 代码审查型任务
