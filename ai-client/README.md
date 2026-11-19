# 给 AI：配置通用服务器操作接口（2.2）

用户要求按本说明配置后，AI 完成环境准备与工具配置，人员只填写授权并回答每次执行问题。平台：由安装者提供 HTTPS 地址，下文 `https://monitor.example.com` 为示例，必须替换。本目录仅 1 份说明、4 个脚本，不引用旧包。

## 授权和执行规则

- 人员在网页按管理员配置使用账号密码、飞书或 OIDC 登录，然后维护验证 → **AI操作接口**，填写名称创建长期授权；自动记录当前登录姓名和创建时间。手动撤销前有效，日常不依赖网页、维护会话或 SSH 私钥。
- 可读取全部当前和未来新增服务器、CPU/内存/多磁盘/服务/Docker 与最多 365 天历史。先检查 `last_seen`、`metrics_stale`，缓存不能说成实时。
- 有效授权内的 Bash / PowerShell 命令不另设关键词拒绝策略；每条先向人员展示目标和完整命令，取得本次明确同意后才执行。人员明确选择不执行时停止；关闭、超时、缺少交互或协议失败保留待确认并解释原因，不冒充人员拒绝。
- 不允许模型代填同意、代点确认或启用自动批准。客户端本身的安全政策仍适用，本包无法替第三方关闭政策限制。
- 服务端持久保存命令、目标、结果与确认来源，区分授权创建人和 `client_reported`。服务器信任持有令牌的适配器，不能独立证明第三方实际点击人；令牌仅交可信客户端后台保管。

## 先安装到固定目录

1. 检查 Python 3.10+ 的真实可执行文件路径；缺少时从官方来源安装，优先当前用户，不需要 pip 或虚拟环境。
2. 复制本目录 4 个脚本到 Windows `%LOCALAPPDATA%\ServerObserverAI`，Linux/macOS `~/.local/share/server-observer-ai`。已有 `.secrets` 不读取、不覆盖；更新代码前备份代码。
3. 已有配置时运行 `monitorctl.py status`、`servers` 验证后复用。需填令牌时，Windows 启动 `open-authorization-window.ps1 -PythonExecutable <真实Python路径> -PlatformUrl <平台HTTPS地址>`，让人员粘贴并保存；必要时仅为启动进程设置 RemoteSigned。Linux/macOS 在人员可操作的终端运行 `monitorctl.py configure --url https://monitor.example.com` 隐藏输入。禁止通过聊天、模型 stdin 或命令行参数传令牌。

## 按工具能力选择接入，不按品牌硬编码

Codex、Antigravity、DeepSeek Harness、其他第一方/第三方工具均按以下能力接入；不是所有产品版本都支持同一种确认方式。

| 工具能力 | 接入方式 | 人员确认方式 |
| --- | --- | --- |
| 本地 stdio MCP | 推荐，启动下列 Python 进程 | Windows 默认本机问题窗口；其他系统按实际 MCP form 能力 |
| MCP 原生问题表单已验证可用 | 显式 `--confirmation native mcp` | 客户端 `elicitation/create` 表单 |
| 仅支持本地命令/插件 | CLI `execute` | Windows 本机问题窗口；Linux/macOS 人员可操作的终端 |
| 自定义 HTTP / OpenAPI 工具 | 可信后台适配器接 REST | 工具自身的问题按钮，按下述协议提交决定 |
| 只有聊天、没有工具或人员交互 | 先补充适配器 | 不能执行；保留待确认，不自动拒绝 |

### MCP 配置

```text
type = stdio（本地进程）
command = Python 可执行文件的绝对路径
args = [monitorctl.py 的绝对路径, "mcp"]
tool_timeout_sec = 660（客户端有此设置时）
```

Windows `auto` 默认使用本机问题窗口，不依赖客户端原生表单策略。需要强制本机交互可用 `args = [脚本路径, "--confirmation", "local", "mcp"]`；已验证原生提问可用时改为 `native`。Linux/macOS 的 MCP 进程没有真实终端且不支持原生提问时，需增加客户端适配器。

Codex 可先核对 `codex mcp add --help`，再运行 `codex mcp add server_observer -- <Python路径> <脚本路径> mcp`。其他工具使用其实际 MCP 设置格式，不能照搬 Codex 命令。只增量修改本接口，不放宽全局安全策略。更新后重载 MCP，不能热加载时新建会话，不强制结束用户客户端。REST 地址不能当作 MCP URL，也不需要 `codex mcp login`。

如有工具白名单，允许以下六项：

```text
list_authorized_servers / get_server_status / get_metric_history
submit_server_command / get_server_command / cancel_server_command
```

确认提交接口不会暴露成模型可直接调用的“自批”工具。先调用前三项只读工具验收；首次配置不发送 Shell 命令。后续 `submit_server_command` 会排队并询问人员，不需回网页。

### 只有 CLI 的工具

```text
<Python> <脚本> execute --server-id <ID> --command-file <UTF-8命令文件> --request-id <唯一编号>
<Python> <脚本> get <命令ID>
```

`execute` 由连接器提问；`run` 只排队，不代表执行。不提供 `--yes` 或跳过确认。相同任务保持相同 `request_id`；超时或 unknown 先查原任务，不换编号盲目重提。人员要求继续待确认任务时复用原内容、原编号重新询问。

### HTTP / OpenAPI 适配器协议

规范：`https://monitor.example.com/ai-api.json`，API 基址：`https://monitor.example.com/api/ai/v1`。所有请求用后台保存的 `Authorization: Bearer <长期授权>`；设置明确的应用 User-Agent（例如 `ServerObserverAdapter/2.2`），不把令牌或确认接口交给模型。

1. 读取：`GET /servers`、`GET /servers/{server_id}`、`GET /servers/{server_id}/history?days=1..365`。
2. `POST /commands`：JSON 含 `server_id`、`command`、`request_id`、`timeout_seconds`（1–300）；返回 `id` 和 `pending`。Shell 根据服务器系统选择，命令最多 16384 UTF-8 字节。
3. 适配器向人员提问，展示原始目标和完整命令。只能使用本次真实人员答复，不能让模型生成批准字段。
4. `POST /commands/{id}/confirm`：含 `decision`、原始命令 UTF-8 字节的 SHA-256 小写十六进制 `command_hash`、`client_name`、`client_version`、`confirmation`。
5. `confirmation` 含 `state`、`source`、`reason_code`、`message`，可选 `details`。明确同意用 `approve` + `approved`；明确不执行用 `reject` + `rejected`；其他用 `defer` + `deferred/cancelled/timeout/unavailable/error/native_declined`，保留 pending。诊断不得包含令牌。
6. `GET /commands/{id}` 查询真实状态、输出和退出码；`POST /commands/{id}/cancel` 取消任务。未知结果不自动重跑。

这是通用接口契约；仅导入 OpenAPI 不会自动产生真实人员确认 UI，适配器必须实现第 3 步。HTTP 确认权限属于可信程序，不属于模型。

## 保存和验收

令牌在脚本旁 `.secrets/client.json`：Windows 当前用户 DPAPI；Linux/macOS 0600 文件存明文。不得打印或上传。`clear` 只删除本机配置，不撤销服务器授权；默认长期保留，用户要求结束时在网页撤销相应名称。

交付时分别报告安装目录、Python 路径、所用接入/确认方式、真实读取结果和仍需人员完成的步骤。模拟协议测试不等于所有品牌实机验证；只有返回真实成功状态和退出码才能报告命令执行成功。
