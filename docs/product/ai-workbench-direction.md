# ytriple AI Workbench 长期方向

## 定位

ytriple 的长期产品定位是：

> **一个以 Y（用户）为中心的 AI Workbench，通过 AI、Agent、Research、本地 Context、外部 Intelligence 和文档能力放大个人的思考、研究、判断和工作准备能力。**

`Y` 代表用户本人；`Triple` 代表能力放大，不代表固定三个 Agent。

多 Agent 是 ytriple 的核心特色能力之一，但不是所有任务的固定工作流。简单任务可以只使用一个 AI，复杂任务再根据需要动态组合 Researcher、Specialist、Critic、Analyst、Creator、Coordinator 等角色。

## 产品边界

ytriple 不接管用户的全部工作，也不替代专业工具。

### ytriple 重点负责

- Research、资料核查、比较、分析和综合；
- 多 Agent 协作、质疑、评审和收敛；
- PRD、研究报告、决策记录、技术 Brief、内容 Brief、脚本等正式文档和 Artifact；
- 读取和理解用户本地项目、文档、知识与规则；
- 组织 Web、Radar、Creator Intelligence 等外部信息；
- 根据本机 Policy 建立规范的项目底座；
- 为 Codex 等专业工具准备项目、文档和任务上下文；
- 在授权边界内读取项目状态并帮助用户继续工作。

### ytriple 不做

- 不做 IDE 或完整 Coding Agent；
- 不替代 Codex、Claude Code 等开发工具；
- 不替代剪辑、设计、图像和视频等专业软件；
- 不要求所有工作迁移到 ytriple；
- 不把用户锁定在单一模型、Agent 或 Provider。

核心原则：

> **ytriple 负责理解、研究、组织、判断、准备和交付；专业工具继续负责它们擅长的深度执行。**

## Workbench-first，而不是 Chat-first

聊天是输入方式之一，但 ytriple 的主要产品形态不是一个对话框。

Workbench 应围绕当前工作展示真正有价值的多个工作面，例如：

```text
Evidence / Context | Main Work | Analysis / Agents
```

这些工作面按任务动态变化：

- Research：Sources / Research / Analysts
- 产品讨论：Context / Main Work / Specialist + Critic
- 开发准备：Project / Brief / Handoff
- 创作者分析：Account Data / Analysis / Creator Agents
- 简单任务：只保留 Main Work

布局服务任务，不固定三栏，也不固定 Agent 数量。

## Multi-Agent：核心特色，不是固定拓扑

多 Agent 的价值不是展示多个“正在思考”的状态，而是让不同智能角色承担不同责任，并把研究、分析、反证、专业判断和创作收敛为一个更好的结果。

典型流程：

```text
Y
→ Work
→ 判断需要哪些能力
→ 组织 Agent / Tools / Sources
→ Research / Analyze / Critique / Create
→ Y 在关键节点参与
→ Synthesis
→ Artifact
```

原 V1 的 `Conductor / Researcher / Specialist` 是一个重要的 Multi-Agent Pattern，可以继续用于 PRD、产品讨论、复杂研究和方案评审，但不再作为整个 ytriple 的固定底座。

## 核心能力

### 1. Workbench

承载当前 Work、相关 Context、Evidence、Agent 协作、Working Artifact、关键结论、分歧和未决问题。

### 2. Research & Documents

Research 是一等能力：

```text
Question
→ Search / Retrieve
→ Sources
→ Compare
→ Multi-Agent Analysis
→ Verify / Critique
→ Conclusion
→ Artifact
```

结果应形成可继续使用的正式文档，而不是只留在聊天记录里。

### 3. Projects & Local Context

ytriple 负责创建和理解项目底座，不负责在内部完成项目开发。

根据用户本机 Policy，项目创建可以包含：

- stable project ID；
- 本地目录；
- Git / main / dev / worktree 基础；
- project manifest；
- 项目 `AGENTS.md` 或等价规则投影；
- 基础文档结构；
- GitHub 对应关系（在用户授权范围内）；
- 最小 validate / observe 状态。

底座完成后，真正的软件开发交给 Codex 等本地工具。

### 4. Intelligence

Intelligence 的目标不是提供更多原始信息，而是把外部变化转换成少量真正与用户工作相关的 Signal。

#### Radar

持续关注 AI、模型、工具、公司、产品、GitHub 项目、行业、技术、市场和用户关心的主题或实体。

主要输出：Signal、Change、Pattern、Why it matters，以及与 Project / Interest 的关系。

#### Creator Intelligence

面向自媒体创作者，包含两类对象：

**My Accounts**

- 管理自己的 YouTube、TikTok、抖音、小红书等账号；
- 在授权范围内读取账号 Analytics；
- 分析发布、播放、互动、增长、主题和异常变化；
- 发现内容表现模式，而不是只做数据仪表盘。

**Benchmark Accounts**

- 管理对标频道和创作者；
- 跟踪公开可观察数据；
- 分析内容主题、发布节奏、标题、封面、时长、公开表现、爆款与长期变化；
- 不假装拥有竞争对手的私有后台数据。

Creator Intelligence 应能直接进入 Workbench：

```text
Signal
→ Investigate
→ Multi-Agent Research / Analysis
→ Content Decision / Brief / Script
```

### 5. Library / Local Knowledge

本地文件和正式项目资料是事实层，AI Context 是动态理解层。

- 项目资料跟随项目；
- 跨项目知识进入统一 Knowledge 区；
- Skill、workflow、模板和可复用资源进入 Resources；
- AI 根据当前 Work 动态检索相关 Context；
- 来源、用户确认、AI 判断和假设应能区分。

具体目录和治理规则由安装到本机的 Policy 决定，不把某台机器的绝对路径写死到产品逻辑中。

## 与现有 V1 的关系

现有 V1 PRD 工具不是废弃方向，而是 ytriple 的第一个已实现能力样本：

- 桌面端 Workbench；
- 多 Agent 协作；
- Research；
- Specialist Review；
- 正式文档输出。

后续演进应从这些已验证能力扩展到更完整的 AI Workbench，而不是继续把“固定三个 Agent + PRD”当作长期产品定义。