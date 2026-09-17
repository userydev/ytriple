# 服务工作空间

`apps/service` 是 ytriple 的产品模块，维护私有空间、项目、工作与成果的产品关系。ycore 仍只通过其 HTTP 契约提供身份、权益、公共信息与模型能力。当前实现已接通私有空间及非执行类命令；远端团队、后台委托、桌面空间切换及生产部署尚未完成，不把本接口当作完整服务模式。

## 当前接口

服务默认绑定 loopback 4320，响应带 `X-Ytriple-Contract: 0.1.0` 和 `Cache-Control: no-store`。除健康检查外，每个请求都用用户 Bearer token 向配置的 ycore `/v1/identity` 重新验证，要求 `authentication=supabase`、`product_id=ytriple`、有效 user_id 及 `product:access`。独立运维令牌不能访问私有产品空间；用户提供的 owner/subject 请求字段不能授权。身份验证失败不会改用其他凭据。客户端不需要知道产品数据库或直接访问表。

| 接口 | 结果 |
| --- | --- |
| `GET /v1/workspaces` | 当前服务身份拥有的空间列表 |
| `POST /v1/workspaces` | `{ key: UUID, name }` 创建空间；同一创建标识和内容返回同一空间 |
| `GET /v1/workspaces/:id` | `{ workspace, data }`，含空间版本和既有领域 Snapshot |
| `POST /v1/workspaces/:id/commands` | `{ key: UUID, expectedRevision, command }`，提交后返回空间版本及领域结果 |
| `GET /v1/workspaces/:id/commands/:key` | 查询已提交命令的原结果，不重新执行命令 |

命令目前为创建项目/交付、更新项目目标/标准、明确上传文本、保存团队/流程版本和选择配置，定义在 `apps/service/src/commands.ts`。这些路径直接调用同仓库现有 Store/Projects/Skills；没有另建一套产品规则。服务空间开始时只有默认配置与内置方法，不读取、搬运或自动上传本机 AI/Code。`add-text-material` 只接收明确提供的标题与正文，标记 `uploaded_text`，不接受客户端自行宣称全文覆盖或验证来源。

服务器不直接派发桌面 IPC。目录、任意路径、文件读取/写入、配置凭据、安装、导入整个数据库和执行初始化等没有远端入口。当前 `submit` 也不接受，避免制造无人执行的运行；接入真正远端运行时后才开放。

## 持久化、冲突与恢复

Postgres 的 `ytriple.workspaces` 为权威状态，保存独立所有者、元信息、单调版本号和版本化领域状态。SQLite `:memory:` 作为一次命令或一个持有执行租约的运行宿主的领域工作副本，不写服务器文件，也不承担服务数据备份。当前采用有界工作空间 JSONB 状态；这是首阶段的存储粒度，不宣称海量工作空间性能。

一次命令在 Postgres 行锁事务内读取空间、核对版本、执行同步领域修改、保存完整新状态和不可变命令结果，全部提交后才返回成功。不同请求使用同一旧版本时只会成功一份，其他收到 `REVISION_CONFLICT` 与 currentRevision，原输入应由客户端保留并重新核对。当前冲突粒度为整个空间，尚未实现对象级并行编辑或自动合并。

同 key 的重复请求先查原结果；内容或 expectedRevision 改变则为 `IDEMPOTENCY_CONFLICT`。一个被明确拒绝且回滚的请求不占用成功标识。连接中断时先查原结果；没有记录仍不等于某个外部动作已取消。当前命令只修改内部状态，不存在模型付费或文件外部动作。未来执行请求必须在调用前持久化身份、归属和请求记录，并独立处理未知结果。

当前操作上限：请求体 256 KiB、空间状态 60 MiB（数据库另有 64 MiB 防线）、每个账号 50 个空间；超限明确失败，不截断或暗中删除记录。文本 NUL/不完整 Unicode 在入库前拒绝。命令结果单条数据库上限 1 MiB。空间和命令记录没有自动清理策略，长期容量与保留策略需在对外提供服务前验收。

## 账号与数据库权限

所有者采用 ycore 返回的稳定用户/产品主体；客户端不能选择 owner，刷新 token 不重建空间。每次数据库事务用 `SET LOCAL` 设置已验证主体，查询显式带 owner，并由 RLS 再次限制。事务提交、异常回滚后上下文不留在连接池。另一个账号读取存在或不存在的空间均返回 404；不可读取对方的命令结果。

迁移使用 owner 连接，运行服务必须使用独立 `ytriple_runtime`，启动拒绝 owner/superuser/BYPASSRLS/CREATEROLE 身份。角色不能更新 owner 列、删除空间或篡改/删除命令结果；两表均开启并强制 RLS，PUBLIC/anon/authenticated/service_role 不获表或 schema 权限。迁移显式撤销实际对象的权限，覆盖部署环境可能存在的全局默认授权；不通过修改全库默认权限影响其他产品。迁移记录也不向这些角色开放。subject 上下文是受信产品进程设置的防错边界，不是允许不可信 SQL 客户端自行设置身份的安全机制。认证 token 只在请求期间使用，不存入空间或结果表。

`supabase/migrations` 只管理 ytriple 私有 schema，迁移由 `apps/service/scripts/migrate.ts` 顺序、事务性执行并记录名称。不要把该目录交给 ycore 的迁移脚本，也不要为了复用 Supabase 而授予产品运行角色访问 ycore/Auth 表。上线可以复用现有主机与托管数据库，但仍需单独配置产品角色、路由、备份和运行权限；本轮未部署新服务或修改托管库。

## 执行归属与调用前保存

`ExecutionLeases` 用同一空间行上的随机 token、递增 bigint 代次和数据库时钟租期，限定一个可写运行宿主。默认 30 秒，宿主每 10 秒续期；过期后不能直接续期复活，必须重新取得新代次并读取权威状态。保存同时核对所有者、token、代次、有效期和空间版本；旧进程无法保存输出、释放新进程的租约或覆盖其他提交。领域/模型调用期间不持有数据库事务或行锁。

`DurableRuntime` 复用桌面的 Runtime/DelegationRunner。每次模型请求之前保存完整当前状态，包括提交、成员贡献、原服务请求键和捕获的输入；事件与最终成果继续保存。数据库保存失败或执行归属丢失时停止后续调用，并中止本地等待；已发出的远端请求不因此宣称取消成功。进程接管把中断运行保留为待核对，待发暂停，不自动重试付费调用。通过原请求查询确定结果后，明确继续才跳过已完成步骤、执行剩余步骤；待决和已提交答复也沿用原身份。

租约与宿主是内部能力，HTTP 不接受 lease/owner/任意状态。HTTP 非执行命令在有有效运行宿主时返回 `SPACE_EXECUTING`；已经完成的命令仍可读回或幂等重放。运行宿主内的提交、停止、核对、继续、回答待决已接入持久化边界，但尚未作为公开命令开放。对外开放前还需把请求路由到持有者并处理版本冲突，避免用户因团队执行而长期不能操作空间。

模型测试替身验证了固定三阶段、按需委派及待决重启链路。尚未配置后台模型授权、部署运行宿主或接入远端调度。内部宿主必须使用稳定模型 scope 和原键查询能力；这不等于获得用户授权，不能用桌面 refresh token 或共享运维令牌代替可撤销的后台执行授权。

## 验证与后续执行接入

`npm run test:db` 启动独立 loopback 55441 的临时 Postgres；`npm run check:service` 只访问硬编码的 `ytriple_test`，不接受生产数据库环境变量。测试使用真实受限角色验证 HTTP 两账号隔离、旧版本冲突、幂等结果、服务重建、领域版本规则、异常回滚及连接池 RLS 上下文；身份接口在常规套件中是明确替身。另有本机真实 Auth/ycore/产品服务进程链路证据，见 DELIVERY。

测试还覆盖两个进程竞争租约、过期接管、迟到结果、版本冲突、提交保存失败时零模型调用、成果恢复不重发、按原记录继续剩余步骤，以及待决回答幂等。普通 Postgres 最初因没有 anon 角色不能运行平台 advisors；补充用于默认授权测试的 NOLOGIN 平台角色后，本地 CLI security advisors 返回无发现。此结果仅属于独立本机数据库，托管迁移和 advisors 要在实际部署时再次核验。

下一步接入有期限、范围和撤销机制的后台模型授权、实际工作提交/控制路由、真实模型记录恢复和远端调度。客户端离线后的工作不能依赖其内存 JWT 或窗口进程。然后接入桌面的服务空间选择、保留冲突输入和原工作返回路径；不把本机整库上传当作跨设备接续。

权限与事务依据：[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)、[默认权限与实际对象权限](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html)、[node-postgres transactions](https://node-postgres.com/features/transactions)。
