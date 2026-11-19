# 纯 Cloudflare 版部署教程

平台运行在 **Worker + 一个 SQLite Durable Object** 中：网页、账号登录、SSO、指标、命令中继、模型调用和告警均无自有后端依赖。无需 Tunnel / D1。被监控服务器安装 Agent，以 HTTPS / WSS 主动连入 Cloudflare。

## 1. 条件与用量

管理电脑需要 Node.js 24、npm；Cloudflare 账户支持 SQLite Durable Objects。域名可先使用 workers.dev，也可以绑定自己的域名。

当前官方 Free 配额包含 DO 每日 100,000 请求、13,000 GB-s、50M 行读取、100,000 行写入，Free 单个 SQLite DO 最多 1 GB、账户总存储 5 GB；限额可能变化，见 [计价](https://developers.cloudflare.com/durable-objects/platform/pricing/)及[限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。超出 Free 配额可能使服务请求失败，不能保证自动免费扩容。

本实现使用普通 WebSocket accept，**没有实现 hibernation**。一个 DO 常驻按 128 MB 计量，全天约 10,800 GB-s；其他 DO 用量也占账户配额。11 台默认每 60 秒心跳、每 120 秒指标，大约 15,840 次心跳更新、7,920 次指标上报/日；索引、聚合、删除、设置及命令还会增加 SQL 写入。上述是预算，不是额度保证。

365 天采用 7 天原采样、之后 5 分钟/小时聚合；单盘明细只保留最近快照。先在控制台观察实际 requests/duration/rowsWritten/storage，接近额度时调整采样或升级 Workers 付费方案。不要给每台机器另建常驻 DO；代码固定使用一个 `platform` 对象。

## 2. 安装依赖

下载校验 `server-observer-cloudflare-v0.2.0.zip`，解压：

```sh
unzip server-observer-cloudflare-v0.2.0.zip -d server-observer-cloudflare
cd server-observer-cloudflare
npm ci
npm run build
node node_modules/wrangler/bin/wrangler.js login
```

使用自己的账户完成 Wrangler 登录；也可按 Cloudflare 官方说明提供限权部署 Token，不把 Token 放入源码。选择正确账户；本项目不需要 Tunnel / D1 编辑权限。

## 3. 初始化与部署

先确定最终 origin，例如 `https://monitor.example.com`，或自己账户的 `https://server-observer.<subdomain>.workers.dev`。workers.dev 子域从 Cloudflare 控制台确认，不能使用教程占位值。

```sh
node scripts/setup.mjs cloudflare
```

向导询问域名、本地管理员账号、账号密码和独立维护密码，生成本部署的新 APP_KEY 与 scrypt 哈希。结果保存在被 Git 忽略的 `.runtime/worker-secrets.json` 和 `.runtime/wrangler.deploy.json`；文件不包含明文账号/维护密码，但仍需保密和加密备份。已有配置时拒绝重建，以免误换加密密钥。

检查生成的 deploy config：Worker 名默认 `server-observer`，仅当确实属于这个新项目时使用，不能覆盖已有同名重要 Worker。多个项目需要不同脚本名。纯 Cloudflare 包中 `main` 指向本包 `cloudflare/worker.mjs`。

```sh
node node_modules/wrangler/bin/wrangler.js deploy --config .runtime/wrangler.deploy.json
node node_modules/wrangler/bin/wrangler.js secret bulk .runtime/worker-secrets.json --config .runtime/wrangler.deploy.json
```

首次 deploy 创建 Worker 和 SQLite DO namespace；随后 bulk 上传运行凭据为加密 Secret。上传完成前访问初始化会失败关闭，不提供公开设置管理员的入口。`BOOTSTRAP_ADMIN_*` 只在数据库无用户时生效，以后重新部署不会重置已有账号密码。

部署配置包含 `nodejs_compat`、SQLite migration 和每分钟 Cron。不要删除已有 migration 或改变 DO class / namespace 绑定，否则可能连接到空数据。所有包内业务请求直达 DO，不配置 ORIGIN_URL、Tunnel Token 或旧源站认证头。

若用自定义域，在 Worker 设置 → Domains & Routes → 添加 Custom Domain；域名必须和 PUBLIC_ORIGIN 一致。此步骤只影响你为新平台选定的域名，不迁移其他业务。若改域名，还要改生成配置中的 PUBLIC_ORIGIN、重新发布，并调整飞书/OIDC 回调。

## 4. 配置登录、告警与 Agent

打开最终域名 → 前往登录 → 使用本地账号。维护验证后：

- 登录方式配置：飞书 App ID / Secret，回调 `/auth/callback/feishu`；或标准 OIDC issuer/client，回调 `/auth/callback/oidc`。OIDC 需授权码、PKCE S256、签名 ID Token。
- 飞书告警设置：群机器人 Webhook / 可选签名密钥。与飞书登录配置独立。
- AI 设置：HTTPS 模型接口、模型名、可选 API Key。密钥加密保存在 DO SQLite，只在服务端读取。
- 添加服务器：逐台复制 Ubuntu / Windows 一次性安装命令。每台使用不同 Token；不要复制已注册 Agent JSON。

普通完成 SSO 的用户可查看；服务器操作与配置仍需维护密码。登录方式的配置额外限定本地管理员。没有用户自注册，也没有默认密码。

每台机器分别取得指标/反向通道凭据和独立心跳凭据。命令按系统选择 Bash / PowerShell。SSH/Shell 入口使用 Agent 终端，不是上传 SSH 私钥。长期 AI 授权在客户端逐条向人员提问，明确同意后才执行，日常不需要回网页。网页 AI 对话也保留人工确认。

## 5. 为什么主机故障仍能告警

Worker Cron / DO alarm 检查 DO 中的心跳，至少 180 秒无心跳后产生失联事件，飞书卡片包含标签、主机名、IPv4、ID 与 UTC+8 时间。告警状态和 outbox 存储在 Cloudflare；任一被监测主机故障不会带走该队列。Webhook 失败会重试，发送成功但确认写回失败时仍可能重复，属于至少一次投递。

两种触发共用串行检查保护，避免同一对象中并发重复发送。Cloudflare 本身、Cron/额度、飞书或跨网访问异常仍可能阻止及时通知。若要求对平台供应商自身故障告警，另外部署不同供应商的外部探测。

## 6. 维护与备份

在 Cloudflare 控制台查看 Cron 执行、Worker 错误、DO duration / rowsWritten / storage。告警队列成功投递记录保留 90 天，AI 命令及审计持久保留（须自行规划容量）；未投递队列保留重试。升级会清空内存维护会话、临时授权及对话，Agent 自动重连，已派发但断线的命令不会自动重试。

备份 `.runtime` 中 APP_KEY 与 Secret 清单（离线加密）、Worker 版本/配置、数据库。不要依赖从 Cloudflare 界面读回 Secret 明文。Durable Object 的备份恢复与 D1 不同，可参考 [SQLite DO 恢复能力](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)；本包没有实现网页数据导出/一键恢复，正式长期运行前应制定并演练独立备份流程。不要直接删除 namespace 作为排错手段。

## 7. 验证范围

本机 Miniflare 实际运行了 SQLite DO、登录、接入、心跳、两盘报告、WSS、人工网页确认、客户端确认的 PowerShell 派发、未来主机读取及撤权，并通过 Wrangler dry-run。尚未在新 Cloudflare 账户执行云端部署、真人飞书/OIDC 回调或整机故障演练；协议测试不能替代这些验收。首次发布后先用测试主机和测试群验证，详见 [VALIDATION.md](VALIDATION.md)。

## AI 工具接入

部署后进入 **AI操作接口** 创建具名长期授权，按照 [AI 接入教程](docs/AI_ACCESS.md)配置 MCP、CLI 或 HTTP 适配器。[ai-client/](ai-client/README.md) 已随安装包包含；命令必须逐条取得人员答复，不需要日常回网页审批。
