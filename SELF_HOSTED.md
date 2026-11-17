# 自建服务器版部署教程

此包单独运行完整平台，不依赖 Cloudflare。Ubuntu / Windows Agent 连接你自己的 HTTPS 域名。

## 1. 准备

- Linux 主机，已安装 Docker Engine 和 Compose；已有域名解析。
- 预算建议：独立 1 vCPU / 1 GB RAM 起步、10 GB 以上可用盘；复用业务服务器时先看实际余量，给平台容器预留约 384 MB 上限及构建余量。这里是部署预算，不是长期负载实测承诺。
- 一般无需开放新的远程命令端口。公网 HTTPS 用 443；只有选用 Caddy 自动证书时额外使用 80。
- 若已有宝塔/Nginx/Caddy 等业务代理，保留原代理并新增专用站点，不让安装脚本接管其端口。

下载 `server-observer-self-hosted-v0.1.0.zip` 和 `SHA256SUMS`，核对压缩包 SHA-256，解压到新目录。不要解压覆盖现有应用。

```sh
unzip server-observer-self-hosted-v0.1.0.zip -d server-observer
cd server-observer
bash self-hosted/install.sh
```

安装器需要现有 Docker 权限；缺 Docker 时会停下，不修改 Docker daemon 或业务服务。它使用独立 Node 容器运行向导，不替换宿主机 Node。

也可在已准备 Docker、curl、unzip、sha256sum 的交互终端使用：

```sh
curl -fsSL https://raw.githubusercontent.com/Kimari-0523/server-observer/main/install-self-hosted.sh | bash
```

该命令在新目录下载同版本 ZIP 和校验清单后进入向导。校验清单与包来自同一仓库，不代替独立发布签名。

## 2. 初始化

向导依次询问：

1. 最终访问地址，例如 `https://monitor.example.com`，不带尾部路径。
2. 本地管理员账号。
3. 账号密码与确认，至少 12 字符。
4. 独立维护密码与确认，至少 12 字符。

密码只显示星号。初始化为每次部署生成新的 APP_KEY，并将密码的 scrypt 哈希保存到权限受限的 `.env`。没有内置默认密码。已存在 `.env` 时向导拒绝覆盖加密密钥。

脚本构建镜像并启动 `observer`，默认仅映射 `127.0.0.1:8788`。Compose 项目名 `server-observer`，使用独立 named volume，应用容器只读、非 root、384 MB 内存上限。运行过程中原业务服务不被脚本重启；镜像构建会消耗网络、CPU 和内存，忙时择时操作。

## 3. HTTPS 与 WebSocket

已有 Nginx/宝塔时添加新站点，HTTPS 反代到 `http://127.0.0.1:8788`，开启 WebSocket，保持长连接。基本 location 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

不要把源站 8788 直接暴露公网。外部 HTTPS origin 必须与 `.env` 中 PUBLIC_ORIGIN 完全一致，否则维护和登录 POST 会拒绝来源。新站点上线前先检查代理配置，不能覆盖现有站点。

若 80/443 没有被其他程序使用，也可选择包内 Caddy：

```sh
docker compose --project-name server-observer --env-file .env -f self-hosted/compose.yaml --profile tls up -d caddy
```

DNS 指向此主机；向导已写入 SITE_ADDRESS。Caddy 自动申请证书并反代到 observer。证书和配置使用独立卷。不要在现有宝塔/Nginx 已占用端口时执行该步骤。

## 4. 登录与接入

打开域名，点击“前往登录”，使用初始化的账号密码。进入维护模式后：

- **登录方式配置**：启用飞书或 OIDC。飞书填写 App ID / Secret，回调登记为 `https://monitor.example.com/auth/callback/feishu`。OIDC 填 issuer、client ID / secret；回调为 `/auth/callback/oidc`，供应方必须支持授权码、PKCE S256 和签名 ID Token。可选 client_secret_basic/post。
- **飞书告警设置**：填写群自定义机器人 Webhook；机器人启用签名时填写签名密钥。通知与登录应用是两套独立配置。
- **AI 设置**：填写最终 HTTPS 模型接口（一般 `/v1`）、模型和可选 API Key，留空保留已有 Key。
- **添加服务器**：为每台主机生成新的一次性 Token，分别复制 Ubuntu / Windows 命令，在 root / 管理员 PowerShell 运行。

普通 SSO 用户可查看，输入维护密码后才能维护；只有本地管理员还可配置登录方式。先验证新的 SSO 再保留本地账号作为回退。登录策略不是完整 RBAC，不要把共享维护密码分发给不应操作服务器的人。

Ubuntu 需要 systemd、curl/tar/xz/sha256sum 及用于 node-pty 构建的 python3/make/g++；缺少时安装器会明确停止，请先安排安装依赖。运行时支持 x64 / ARM64 检测；Windows 使用管理员 Windows PowerShell 5.1，运行时独立安装至 `C:\Program Files\ServerObserverAgent`。Ubuntu 默认 `/opt/server-observer-agent`、systemd `server-observer-agent`。脚本下载来源是当前平台域名，不能从其他用户的安装命令复制 Token。

## 5. 运维

```sh
docker compose --project-name server-observer --env-file .env -f self-hosted/compose.yaml ps
docker compose --project-name server-observer --env-file .env -f self-hosted/compose.yaml logs --tail 100 observer
curl -fsS http://127.0.0.1:8788/healthz
```

成功启动不等于 Agent 已报告；查看卡片的报告时间、采集错误、心跳与反向连接。多卷容量和物理盘 IO 分开核对。Docker 查询不扫描可写层；本机服务在 Agent JSON 的 services 数组中配置，具体名称使用对应操作系统真实服务名。

默认指标和心跳 60 秒，失联阈值 180 秒，每分钟检查。告警队列持久化失败重试。**整台监控服务器离线时，同机进程不能通知**；若需要这种告警，另设其他主机/外部 uptime 服务探测域名及 healthz。这不构成默认 Cloudflare 混合依赖。

数据在 observer-data 卷的 `/data/observer.sqlite`。备份应使用 SQLite online backup，或仅停止 observer 后复制静止数据库，不能只复制运行中 WAL 的主文件。一起加密备份 `.env` / APP_KEY；没有原 APP_KEY 不能解密已保存的 SSO/AI/Webhook。恢复前停止监控容器、核对卷名和权限，勿删业务卷。

升级前备份数据/配置及旧镜像，解压到新目录，保持原项目名与同一数据卷。先看发行说明和 schema 兼容，再 `up -d --build observer`，只更新监控服务。已有 Agent 更新仅重启 Agent，不能重启 Docker/Windows 或业务服务。当前没有自动迁移旧品牌系统的工具；此包用于新部署，旧部署请先做单独迁移设计。

## 6. 手动 Node 方式

已安装 Node.js 24 / npm 时可不使用 Docker：`npm ci --omit=dev`、`npm run build`、`node scripts/setup.mjs self-hosted`。将 `.env` 的 DATA_DIR 改为实际可写目录、LISTEN_HOST 改为 `127.0.0.1`，再 `npm start`，用自己的服务管理器守护进程并配置 HTTPS 反代。账号和维护密码初始化流程相同。

本次已验证源码、真实本机 HTTP/WebSocket 与 Windows 命令执行组件；未在新空白 Linux/Docker 主机实际执行完整安装和证书申请，请按 [VALIDATION.md](VALIDATION.md) 做首次部署验收。
