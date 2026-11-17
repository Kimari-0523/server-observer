# 验证范围

本版本为首次公开打包，源码来自已有平台后做中性化及独立运行环境改造。验证不能推导为所有真实系统、供应商和网络环境都已经验收。

本次实际完成：

- 本地账号登录、错误密码/节流、CSRF、维护门禁及退出回收；伪造旧边缘认证头不能登录。
- 飞书/OIDC 配置加密和遮罩；OIDC 使用测试签名密钥验证 state/nonce/PKCE/issuer/audience，并拒绝重放及错误 nonce。没有用真实用户完成新公开版的供应方回调。
- 自建版真实本机 HTTP 和反向 WebSocket；人工模式批准前没有派发，批准后 Bash 派发；自动模式直接 PowerShell 派发，撤销后 Bearer 失效。这里的联网 Agent 是模拟器。
- 纯 Cloudflare 版在 Miniflare 的真实 SQLite Durable Object 中运行登录、入网、独立心跳、两卷/两盘指标持久化、WSS、人工/自动 PowerShell 派发和撤权；不使用 Node 源站或 Tunnel。
- 本机真实 Windows PowerShell 的 Unicode stdout/stderr、退出码、超时结束进程树；PowerShell 5.1 安装包装器的文本/字节响应、空下载、checksum 和 Node 模块验证传参。
- 原有磁盘容量/吞吐、IP/代理出口、Docker 分组、365 天聚合、AI 人工/自动授权、模型协议、告警重试和身份快照的回归。
- Wrangler dry-run 打包；源码中旧品牌/原部署地址清理；已知真实密钥值的外部比对；安装包路径和内容清单检查。

本次没有做：

- 在空白 Ubuntu / Windows 新机器执行完整新品牌 Agent 安装及重启验证。
- 在新 Docker 主机运行完整安装、Caddy 证书申请及跨互联网 WebSocket 验收。
- 在新的 Cloudflare 账户真正部署纯云版，或以真人完成飞书/OIDC授权。
- 向真实飞书群发送本公开版本测试卡片，或模拟整机断电/供应商故障。
- 长期 Free 配额压测、全量历史灌入与独立安全审计。

首次部署请逐项验收：未登录拒绝数据；维护密码门禁；最新报告时间；多盘与容器实数；人工批准前不执行；自动模式仅限授权主机；退出后命令/终端关闭；测试群收到失联及恢复；业务进程启动时间不变。

实际本机测试数量及发布校验记录在包内 `release-validation.json`。测试中的账号、域名、API Key 与 Token 均为合成数据，不是默认运行凭据。
