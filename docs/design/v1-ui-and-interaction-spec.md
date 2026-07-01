# yTriple V1 UI And Interaction Spec

## Purpose

本文件定义 yTriple V1 的界面与交互规范，目标是把此前的产品和运行时 contract 落成可设计、可实现的桌面交互。

V1 的核心体验是：

- 快速输入模糊想法
- 轻量确认
- 看见三 Agent 各司其职
- 最终拿到结构化交付包

## Design Principles

- 结果导向，不做“会动但没价值”的过程表演。
- 中间舱永远是主舞台，左右舱是高价值过程辅助。
- 视觉层级必须明确区分“输入”“过程”“结果”。
- 界面要像桌面工作台，而不是网页聊天壳。

## Layout Overview

V1 采用固定三舱布局：

```text
+----------------+---------------------------+----------------+
| Research       | Conductor Nexus           | Specialist     |
| Workshop       | Main conversation + input | Workshop       |
+----------------+---------------------------+----------------+
```

### Width Guidance

- 左舱：24% 到 28%
- 中舱：44% 到 52%
- 右舱：24% 到 28%

### Responsive Rule

- 桌面宽屏保留三舱
- 中等宽度下允许左右舱折叠为抽屉
- V1 不优先追求手机体验

## Screen 1: New Task

### Goal

让用户在最少阻力下开始一次 PRD 任务。

### Main Components

- 顶部栏
  - 产品名
  - 当前工作区
  - 设置入口
- 中间主输入区
  - 大输入框
  - 支持粘贴、自然语言描述、拖入补充文件
- 辅助提示区
  - 示例输入
  - 当前默认模板提示
- 底部动作区
  - `Start Draft`
  - 可选 `Attach Workspace`

### Interaction Rules

- 用户输入后，系统优先自动识别 PRD 任务
- 不先强制展示复杂模板表单
- 如果当前未选工作区，应给出轻量提示，而不是阻塞

## Screen 2: Active Task

### Goal

让用户一边感知三 Agent 在工作，一边保持对最终结果的聚焦。

### Shared Header

- 当前任务标题
- 模板标签：`PRD`
- 当前状态标签：`Quick Clarify` / `Researching` / `Merging` / `Completed`
- 交付包入口

### Left Panel: Research Workshop

模块：

- 状态头部
  - `Researcher`
  - Web 图标
  - 状态指示
- 当前调研问题
- 来源列表
- 关键概念卡片
- 调研简结

交互：

- 来源支持展开查看标题和链接
- 不要求用户在此面板里编辑内容

### Center Panel: Conductor Nexus

模块：

- 任务概览条
  - 模板
  - 工作区
  - 当前 Specialist
- 用户输入块
- Quick Clarify 块
- Conductor 分派块
- 收敛摘要块
- 最终交付块
- 底部输入区

交互：

- Quick Clarify 只允许非常短的后续确认
- 任务完成后，底部输入区可以变成“继续修订这份 PRD”入口

### Right Panel: Specialist Workshop

模块：

- 状态头部
  - `Specialist`
  - 当前角色名，例如 `Product Lead`
- 风险点列表
- 缺失项列表
- 结构建议列表
- 审查结论摘要

交互：

- 每条建议可点击高亮，但不在右舱直接改稿

## Screen 3: Completed Task

### Goal

让用户第一时间进入最终产物，而不是迷失在过程里。

### Primary Focus

- 默认自动打开 `01-final-prd.md`
- 同时展示交付包文件清单

### Secondary Actions

- `Open Output Folder`
- `Continue Refining`
- `Regenerate Draft`
- `Change Specialist`

## Interaction Flows

## Flow A: Quick Start

1. 用户输入模糊需求
2. 点击 `Start Draft`
3. 系统识别 `PRD`
4. 如果必要，发起 0 到 2 个 Quick Clarify
5. 进入三 Agent 运行
6. 输出交付包

## Flow B: Start With Workspace

1. 用户先选择工作区
2. 输入需求
3. 系统在只读边界内使用工作区上下文
4. 输出交付包

## Flow C: Refine Existing Draft

1. 用户打开历史任务
2. 查看 `01-final-prd.md`
3. 在中心输入区提出修订意图
4. 系统基于已有交付包和原始上下文再生成下一版

## State Presentation Rules

### Waiting

- 低动效
- 输入区域保持主导

### Quick Clarify

- 中心面板浮出极少量问题
- 左右舱保持弱化或占位

### Running

- 左右舱显示内容流
- 中间舱显示当前阶段与收敛说明

### Completed

- 结果卡片优先
- 左右舱降为辅助参考

### Failed

- 显示失败阶段
- 提供重试或调整输入入口

## Content Hierarchy

优先级从高到低：

1. 最终 PRD
2. Conductor 当前结论
3. Quick Clarify
4. Specialist 关键建议
5. Researcher 关键来源
6. 过程细节

## Motion Guidance

- 动效只用于状态切换和信息出现，不做连续炫技流光
- 左右舱可用轻量流式 reveal 表示 agent 正在工作
- 完成态应有明确的结果着陆动画，强调“交付已生成”

## Empty States

### No Workspace

- 提示“可选附加工作区以增强文档质量”
- 不阻塞启动

### No History

- 引导用户开始第一份 PRD 任务

### No Web Results

- 明确提示调研不足，但任务可以继续

## UI Risks To Avoid

- 把三舱做成三个同质聊天窗
- 把过程日志做得比结果更抢眼
- 用过多表单和配置淹没首次体验
- 让用户在左右舱直接编辑正式交付文档
