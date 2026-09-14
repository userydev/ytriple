# ytriple main 临时版本维护

## 项目依据

- 项目 ID：`ytriple`；中央 manifest：`/Users/Admin/AI/system/projects/ytriple.json`。
- 本机规则入口：`/Users/Admin/Code/AGENTS.md`。中央项目登记和当前用户授权优先于历史文档。
- 当前产品方向以本分支 `docs/PRODUCT.md` 为准；其内容和 `assets/branch-icon.png`、`assets/branch-icon.svg` 在本次恢复中原样保留。

## 当前分支的用途

- 用户于 2026-09-14 授权仅将本次对话最后确认的可运行版本保留到 main。来源提交：`7a95e3bec8dd36f40e0a03d0560478a77499a797`。
- main 是该 0.1 版本的临时可运行快照。恢复代码不代表按最新 PRODUCT 完成重建，也不授权继续开发旧方案。
- 本次操作仅在 `/Users/Admin/Code/y/ytriple/ytriple-main` 修改和提交；不得改动 dev、其他分支及它们的工作目录，不修改中央 manifest。
- `docs/讨论总结.md`、`docs/产品调研.md`、`docs/开发计划.md` 和 `docs/参考/` 是此快照的历史背景与验证记录。新开发必须按最新用户目标和 PRODUCT 另行判断，不把历史范围、架构或验收记录当作新产品约束。

## 构建与验证

- Node.js >= 24，Electron + React + TypeScript；依赖由 package-lock.json 固定。
- 在本 main 工作目录执行 `npm ci`、`npm run build`；`npm start` 启动已构建应用，`npm run dev` 构建并启动。
- `npm run typecheck`、`npm test`、`npm run smoke` 为本地检查。初始化、恢复、冲突等测试仅写临时目录，不登记到用户真实 AI 体系。
- `npm run probe -- gemini --team` 会调用真实模型；历史模型探针不等于本次重新验证，恢复提交不需要重新调用付费模型。
- desktop 只暴露校验后的 IPC，运行时与解析位于 utility process；渲染层不读取本机文件或密钥。保持 SDK 远端追踪关闭，凭据不得进入日志、仓库或 task snapshot。
- 不覆盖用户已有规则、项目修改、数据库或成果文件。提交与推送必须遵循当前用户授权的目标分支。
