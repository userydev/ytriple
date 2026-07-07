# yTriple

Three Agents, One Perfect Output.

yTriple 是一款轻量、垂直的桌面端 PRD 首稿工具。它通过一个主 Agent 与两个固定副 Agent 的协作，把模糊产品想法快速收束成正式 PRD 和独立参考资料。

V1 只聚焦一个场景：把模糊产品想法生成 `PRD 首稿交付包`。工作流固定为 `Conductor / Researcher / Specialist` 三个 Agent，不提供用户自定义编排，不修改工作区已有文件。

## 本地使用

### 1. 配置模型

在项目根目录创建 `.env`：

```bash
ARK_API_KEY=your_api_key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-2-1-pro-260628
ARK_ENABLE_WEB_SEARCH=true
```

如果使用 Agent Plan key，需要改为该 key 支持的 endpoint 和模型，例如：

```bash
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
ARK_MODEL=doubao-seed-2.0-mini
```

### 2. 启动桌面应用

```bash
npm install
npm run tauri dev
```

在中间的 Conductor 聊天区写产品想法。你可以先发送模糊想法，再继续补充目标用户、核心场景、功能边界或成功标准；信息足够后点击 `Generate PRD`。

按需填写：

- `Workspace path`：只读工作区绝对路径，可留空。
- `Output root`：交付包输出根目录，可留空。留空时优先写到工作区，否则写到应用运行目录。

点击 `Generate PRD` 后会调用火山方舟，生成：

- `01-final-prd.md`
- `02-assumptions-and-open-questions.md`
- `03-research-notes.md`
- `04-specialist-review.md`

生成完成后可以在界面里打开输出目录。

### 3. 命令行运行

```bash
npm run run:prd -- --input "你的产品想法" --output-root ./local-output
```

也可以附加只读工作区：

```bash
npm run run:prd -- --input-file ./brief.md --workspace-root /absolute/workspace --output-root ./local-output
```

## 文档入口

- 产品 PRD V1：[docs/product/prd-v1.md](docs/product/prd-v1.md)
- V1 产品契约：[docs/product/v1-product-contract.md](docs/product/v1-product-contract.md)
- V1 Runtime And Tool Contract：[docs/product/v1-runtime-tool-contract.md](docs/product/v1-runtime-tool-contract.md)
- V1 Information Architecture：[docs/product/v1-information-architecture.md](docs/product/v1-information-architecture.md)
- V1 UI And Interaction Spec：[docs/design/v1-ui-and-interaction-spec.md](docs/design/v1-ui-and-interaction-spec.md)
- V1 Technical Architecture：[docs/technical/v1-technical-architecture.md](docs/technical/v1-technical-architecture.md)
- V1 Implementation Roadmap：[docs/project/v1-implementation-roadmap.md](docs/project/v1-implementation-roadmap.md)

## 当前阶段

当前仓库已经具备 V1 最短闭环：桌面壳、三舱 UI、Conductor 多轮聊天收集、只读工作区摘要、火山方舟 Responses 调用、Researcher Web Search 配置、固定三 Agent 编排、四文件交付包写出。

## Role Library Reference

V1 引入 [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents) 作为外部角色库参考，按 MIT license 标记来源。当前本地 catalog 覆盖 17 个 division、220 个 agent role 文件。

yTriple 仍只运行固定三 Agent：

- `Conductor` 参考 `specialized/agents-orchestrator.md`
- `Researcher` 参考 `product/product-trend-researcher.md`
- `Specialist` 参考 `product/product-manager.md`

这些角色只用于定位、工作原则和审查视角，不向最终用户开放自定义 agent 编排。
