# Server Observer

轻量服务器监测与维护平台，提供**自建服务器版**和**纯 Cloudflare 版**。两个版本独立部署，不需要互相连接；Cloudflare 版没有 Tunnel、自建后端或 D1 依赖。被监测的 Ubuntu / Windows 机器仍须安装 Agent。

| 方案 | 安装包 | 教程 |
| --- | --- | --- |
| 自建服务器 | [server-observer-self-hosted-v0.2.0.zip](server-observer-self-hosted-v0.2.0.zip) | [自建部署教程](SELF_HOSTED.md) |
| 纯 Cloudflare | [server-observer-cloudflare-v0.2.0.zip](server-observer-cloudflare-v0.2.0.zip) | [Cloudflare 部署教程](CLOUDFLARE.md) |

完整可修改源码、测试、依赖锁文件和部署配置直接保存在仓库目录中，可在线浏览或 clone 后使用。两个 ZIP 作为额外的安装下载保留；不包含任何现网密钥、账号、Webhook、SSH 私钥或数据库。

| 源码目录 | 用途 |
| --- | --- |
| `self-hosted/` | 自建版 Node 服务、Dockerfile、Compose 与安装脚本 |
| `cloudflare/` | 纯 Cloudflare Worker / SQLite Durable Object 与部署配置 |
| `shared/`、`backend/` | 共用存储、登录、告警、维护验证及 AI 命令逻辑 |
| `web/` | 看板、登录、配置及终端网页 |
| `agent/` | Ubuntu / Windows Agent 和安装脚本 |
| `scripts/`、`test/` | 初始化、构建、打包、扫描及测试 |
| `ai-client/`、`docs/AI_ACCESS.md` | 独立五文件接入包、人员教程及客户端确认协议 |
| `third-party/` | 第三方组件许可证 |

自建版和纯 Cloudflare 版共用代码，但部署入口分开；可以直接阅读 [自建服务入口](self-hosted/server.mjs) 或 [纯 Cloudflare 入口](cloudflare/worker.mjs)。

## 功能

- 卡片总览、醒目标签、手动公网/内网 IPv4、两种图标切换主题、可点暗区关闭的弹窗。
- CPU、内存、网络、Linux PSI、多本地卷容量及物理磁盘读写/IOPS；服务和 Docker Compose 容器分组。
- 带坐标及悬停值的性能曲线：最近 7 天原采样、7–30 天 5 分钟聚合、30–365 天小时聚合。
- 本地账号密码登录；维护模式下配置飞书登录和标准 OIDC 兼容登录。没有默认密码或公开抢占式注册。
- 独立维护密码，当前页面内存授权；手动退出/关闭页面时撤销，重开或服务重启后重新验证。
- Agent 反向 WebSocket Shell / PowerShell，不需要将 SSH 私钥交给平台，不需要新增服务器入站命令端口。
- 网页 AI 助手和外部 AI 操作 API，兼容 Responses / Chat Completions 模型接口；具名长期授权读取全部当前及未来服务器，命令逐条在客户端确认，持久记录审计。
- 飞书群 Webhook 失联/恢复卡片，支持签名、服务器身份快照及持久化失败重试队列。
- 网页内生成一次性 Ubuntu / Windows 安装命令并复制；TLS、主 Agent 和 Node 下载校验。

## 两个方案的边界

自建版使用 Node.js 24、SQLite 和 WebSocket，可接现有反向代理或选择 Caddy。纯 Cloudflare 版使用 Worker + 一个 SQLite Durable Object，数据、授权、命令中继及检查都在 Cloudflare；不要求额外服务器运行平台。

纯 Cloudflare 版支持 Free 账户的 SQLite Durable Objects，**不承诺所有使用都永久免费**。它使用普通 WebSocket accept，常驻连接会计费时长；默认指标间隔 120 秒，心跳 60 秒。11 台规模的保留策略和用量预算见教程，部署前核对账户总配额。

自建版所在整机故障时，同机告警进程也会停止；需要另外的独立探测才能覆盖监控主机自身故障。纯 Cloudflare 版的主机心跳/告警独立于被监控机器，但仍受 Cloudflare、飞书及网络自身可用性影响。

多盘最新容量/读写明细已经提供；365 天存储的是标量曲线，**不包含所有单盘明细的完整长期历史**。目前告警以主机失联/恢复为主，尚未提供 CPU/服务/容器阈值规则编辑器、Agent 凭据管理 UI 或自动异地灾备。

## 开发验证

```sh
npm ci
npm run build
npm test
npm run scan:release
```

`npm test` 在有 Cloudflare 适配器时先执行 Wrangler dry-run，再运行本机测试；需要本机回环网络权限。Windows 专属用例在其他系统跳过。验证范围和未演练事项见 [VALIDATION.md](VALIDATION.md)。

采用 MIT 许可证，第三方组件版权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安全与数据处理说明见 [SECURITY.md](SECURITY.md)。

## AI 接入更新（2026-11-19）

接口 2.2：长期授权、动态包含新增服务器、工具端逐条提问、确认错误保留待确认及持久审计。入口统一为 **AI操作接口**。详见 [人员接入教程](docs/AI_ACCESS.md)、[PDF](docs/AI-Access-Setup.pdf)和[给 AI 的独立配置包](ai-client/README.md)。旧版本安装包仅作为历史保留，当前安装使用表中 0.2.0。
