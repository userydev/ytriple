# 工作与 AI 服务

此目录是可独立运行的单进程自部署服务，负责设备登录、管理员配置的模型权益与配额、OpenAI 兼容调用，以及接收明确提供材料的持久委托和例行工作。不包含支付或虚构订阅扣款。

需要 Node.js 24 和项目已安装依赖。只通过服务器环境配置上游，客户端只能选择公开模型 ID：

```sh
export WORK_DATA_DIR=/absolute/private/work-service-data
export WORK_MODELS_JSON='[{"id":"my-model","name":"我的模型","provider":"openai","model":"实际模型ID","apiKeyEnv":"WORK_UPSTREAM_KEY","tools":true}]'
# WORK_UPSTREAM_KEY 在宿主机的私密环境中提供，不放进仓库。
npx tsx services/work-service/main.ts
```

默认监听 `127.0.0.1:8788`。跨设备自部署时在 TLS 反向代理后运行；只在已配置网络边界内修改 `WORK_HOST`。不要把账号密码和设备 bearer token 经公网明文 HTTP 发送。数据目录权限为当前用户独有，SQLite/WAL/锁文件应放在同一本机持久卷上。部署必须保持单进程；启动锁会拒绝同目录双执行器。可用 launchd、systemd 或容器重启策略维持服务器，关闭桌面窗口不影响独立服务器进程。

首次建立账号或更新密码、权益，通过服务器管理员命令进行。密码仅从环境读取，更新密码会撤销该账号以前的设备 token；不输出密码：

```sh
export WORK_ENTITLEMENT_JSON='{"plan":"self-hosted","active":true,"modelIds":["my-model"],"tokenLimit":2000000,"maxConcurrent":2}'
# WORK_ADMIN_PASSWORD 在服务器私密环境中提供，至少 12 位。
npx tsx scripts/work-service-admin.ts my-user
```

Gemini 使用 `provider: "gemini"`，默认走 Google 官方 OpenAI 兼容入口；`model` 和 `apiKeyEnv` 同样来自服务器设置。OpenAI 默认使用官方 `/v1` 入口，也可由管理员配置可信 `baseURL`。上游地址不接受客户端覆盖，也不会跟随重定向。[Google 官方兼容说明](https://ai.google.dev/gemini-api/docs/openai)支持这种 HTTP 协议接入；资料核查不等于对具体账号、模型版本的真实调用验收。

公开请求和返回类型及路由见 `contract.ts`。`/v1/chat/completions` 保留实际模型工具调用及参数，并支持 `stream: true`。当前 SSE 在完整上游响应到达后发送真实内容和用量，公开标记 `streamingMode: buffered`；不是逐 token 低延迟流。服务不执行模型返回的工具，桌面继续按自己的权限边界执行。上游密钥不会进入模型列表、账号、任务或导出结果。

持久委托支持一次执行、每日/每周/间隔、上传内容变化及真实发布节点后的相对时间。变化调度只检测已上传的新材料快照，服务器不能监看客户端文件。无新输入只记录检查，不再次调用模型；错过多个时点只合并检查一轮。每轮锁定输入与方法正文哈希，运行中拒绝编辑。相同 `requestId` 幂等；模型请求可附 `Idempotency-Key`，已完成结果返回缓存，状态不明的旧请求拒绝自动重试。服务重启将运行中的委托标为需要核对，保留结果和记录。

配额在调用前保留预算，收到上游实际 `usage` 后按实际 token 结算；缺少用量、超时或取消的不确定请求保留预算并明确显示，不把零当成真实消费。例行次数/累计 token 上限在下一轮开始前检查，单次调用可能越过任务剩余额度。管理员权益控制账号的总额度。用户导出与清理仅作用于自己的数据；清理任务/模型正文后保留最少数值用量与去重记录，避免通过删数据重置配额。

清理开始时持久保存账号的数据代次和清理状态，阻止该账号新建、修改、推理与调度，等待已发出的调用结束。迟到响应只结算可确认的数值用量，不保存或返回正文；清理期间尚未读完的旧请求，即使在清理完成后到达，也会被拒绝。进程在清理期间中断时，下次启动先完成该账号的正文清理，不恢复旧委托或自动重试不确定调用。其他账号可继续使用。

验证：`npx tsx --test services/work-service/*.test.ts` 使用临时 SQLite 和本地合成 HTTP 上游。它验证认证、租户隔离、配额、工具/SSE 协议、版本锁、去重、重启与清理行为，不证明任何付费模型账号可用。真实服务探针应另行明确执行并记录模型与用量。
