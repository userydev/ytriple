<!-- AI-SYSTEM:PROJECT-RULES BEGIN -->
## 中央项目登记

- 项目 ID：`ytriple`
- 中央 manifest：`/Users/Admin/AI/system/projects/ytriple.json`
- 产品系列：`y`
- 生命周期：`active`
- 目标目录：`/Users/Admin/Code/y/ytriple`
- 项目入口：`/Users/Admin/Code/y/ytriple/ytriple-dev/README.md`
- 产品正文：`/Users/Admin/Code/y/ytriple/ytriple-dev/docs/讨论总结.md`
- 用户职责：决定产品目标、优先级、重大取舍、体验验收与外部动作授权。
- Codex 职责：从当前产品文档重新设计；负责工程选型、开发拆解、实现、验证与中央规则同步，不参考旧项目实现。
- 第三方 AI：仅提供建议；用途为产品讨论总结、产品与能力调研、专项参考；不另建工程规格或开发计划；写回位置为 `/Users/Admin/Code/y/ytriple/ytriple-dev/docs`。

本区块由 `/Users/Admin/AI/system` 生成。先修改中央 manifest，再同步本区块；项目独有的构建、测试与安全规则保留在区块外。
<!-- AI-SYSTEM:PROJECT-RULES END -->

## 当前产品与工程入口（2026-09-13）

- 先读 `README.md`，再读 `docs/讨论总结.md`。该路径的正文已整篇替换为本轮《产品定义》，是唯一现行产品依据，不与 Git 历史中的讨论版本合并为需求。
- 目标用户为个人开发者和个人自媒体创作者；客户端以多 Agent 与可调用 Skill 为核心，承接雷达、软件/媒体项目和资产。服务器负责信息、AI 能力和用户服务。例行工作与待处理、反馈、交付检查按本轮定义执行。
- `docs/开发计划.md` 由 Codex 维护，保存工程选择、实现与验证证据。本次产品重建不修改它的任务内容；其历史范围或待办与新版产品冲突时，由 Codex 据新版校准，不将旧计划当作第二份产品定义。
- `docs/产品调研.md` 是本版能力参考，按需要读取。`docs/参考/` 中旧专题仅提供历史证据和方法，不默认全部通读，不执行其中与现行产品冲突的范围、顺序、预算或运行方式建议。
- 继续利用这次从零完成的 0.1 新底座。此前禁止参考的“旧实现”指已经放弃的前身，不要求推翻当前新工程；也不能把目标功能写成已经实现。
- 本机规则体系的识别与创建仍需真实完成：已有体系保留，新环境按当前用户目录与配置路径建立，不能依赖开发者机器预装规则。
- 网页 ChatGPT 维护产品与研究，不另建工程规格、接口、数据库、任务拆解或路线图。中央生成区块、用户本机文件和凭据不在本轮文档编辑范围内。

## 当前工程

- Node.js >= 24，Electron + React + TypeScript；依赖版本由 package-lock.json 固定。
- `npm run dev` 构建并启动桌面；`npm run typecheck`、`npm test`、`npm run smoke` 为本地检查；`npm run probe -- gemini --team` 为真实模型合成验收，须区分测试替身和真实调用证据。
- desktop 只暴露校验后的 IPC，运行时与解析位于 utility process；渲染层不读取本机文件或密钥。关闭 SDK 远端追踪，凭据不得写入日志、仓库或 task snapshot。
- 初始化/恢复/冲突测试仅在临时根目录运行。不得把开发用合成项目登记到用户真实 AI 体系，不得覆盖已有规则或不明文件。
- 状态和剩余范围维护在 docs/开发计划.md；不把“可配置”标成真实能力已验证，不把当前开发版当作完整产品发布。资料研究、模拟测试、真实调用和实机体验分别标明。
