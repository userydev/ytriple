# ytriple

面向个人开发者与创作者的 AI 工作台。首页、雷达与项目承接不同入口；同一工作保留草稿、材料、团队过程与成果版本。

当前阶段、源码/安装/部署的差异与下一步统一见 [当前状态与计划](docs/PLAN.md)。产品长期目标不等于已交付功能。

## 本机开发

Apple Silicon macOS、Node.js 26；Electron、React、TypeScript 与 SQLite。完整检查需要 Docker 中的专用测试数据库。

```sh
npm run setup
npm run test:db
npm run check
npm run build
npm start
```

完整环境、数据位置、签名配置与 `npm run package:mac` 的使用见 [开发与安装](docs/DEVELOPMENT.md)。

## 代码入口

- `apps/desktop/src/core`：领域对象、持久化、团队执行与 ycore 适配。
- `apps/desktop/src/main`：桌面壳、安全存储、文件对话框与受限 IPC。
- `apps/desktop/src/ui`：业务页面、轻对话和三工作面。
- `apps/desktop/tests`：领域、执行、恢复与同步测试。
- `apps/service`：私有空间服务；`supabase/migrations` 只管理 ytriple 私有 schema。

公共信息与私有工作分开，阅读和布局切换不调用模型。实际执行由明确发送、整理动作或已启用的委托触发。

### 团队模板与订阅基础

设置 → 团队与流程 → 管理团队与流程，可从八个 [agency-agents](https://github.com/msitarzewski/agency-agents) 角色模板创建成员，预览职责和 MIT 许可，编辑后保存并应用。模板固定来源版本，后续更新不覆盖用户修改或历史任务。

设置 → 账号 展示当前套餐、价格、到期与今日用量。套餐版本、不可变价格与授权周期由 ycore 运维入口维护，尚未接入购买、扣款或自动续费。本包仍在隔离工作树，未合并/部署/安装。
