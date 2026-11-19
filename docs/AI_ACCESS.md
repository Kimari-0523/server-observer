# Server Observer AI 接入教程

适用于 AI API 2.2。Windows、Linux 和 macOS 客户端需要 Python 3.10 或更新版本。接入前请准备监控平台的 HTTPS 首页地址，并确认已有服务器上报。

## 1. 下载完整包

下载并解压[完整接入 ZIP](../server-observer-ai-access-v2.2.zip)。先阅读 [人员版 PDF](AI-Access-Setup.pdf)，再把解压后的整个目录交给 AI，指定它读取 [ai-client/README.md](../ai-client/README.md)。该子目录里的四个脚本需要放在一起。平台管理员可在仓库首页选择相应的部署教程。

## 2. 创建个人授权

1. 登录监控平台，进入维护模式。
2. 打开 **AI操作接口**，输入可识别的名称，例如「张三 / 办公电脑」，点击 **创建长期 AI 授权**。
3. 点击 **复制 AI 访问令牌**。完整令牌只在创建时显示一次。自己在本机授权窗口粘贴，并点击 **保存授权**。
4. 令牌可读取该平台当前及以后新增的所有服务器。每次执行命令前仍需在工具端确认。退出维护和关闭网页后授权仍有效。停止使用时，在同一页面按名称点击 **撤销授权**。

可把未配置的接入包交给别人。接收者使用自己获准访问的平台地址和本人专用令牌。请把运行时生成的 `.secrets/client.json` 留在本机，避免通过聊天、截图或仓库传递令牌。维护密码只在网页输。

## 3. 让 AI 配置客户端

把下文交给能访问解压文件夹的 AI，把示例地址换成自己平台的 HTTPS 首页地址：

> 请阅读本目录的 ai-client/README.md，配置我当前使用的 AI 客户端。平台地址是 https://monitor.example.com 。需要令牌时打开本机填写窗口，由我亲自粘贴。配置后请列出服务器并读取一台的状态与近期历史。

若已有本地配置，先核对保存的地址是否就是此次指定的平台。地址不同或想与旧配置并用时，让 AI 为新平台保留单独的脚本目录。

### 手动配置

- **Windows**：先把四个脚本复制到固定目录。在该目录打开 PowerShell，下面的 URL 换成实际平台地址。出现授权窗口后粘贴并保存。若没有 `python.exe`，把 `$python` 指向实际 Python 3.10+ 的可执行文件。

```powershell
$python = (Get-Command python.exe -ErrorAction Stop).Source
& $python --version
.\open-authorization-window.ps1 -PythonExecutable $python -PlatformUrl 'https://monitor.example.com'
```

保存授权并关闭填写窗口后，再执行：

```powershell
& $python .\monitorctl.py status
& $python .\monitorctl.py servers
```

- **Linux/macOS**：在人员可操作的终端进入固定脚本目录，将示例 URL 换成实际地址。在隐藏输入提示处粘贴授权令牌。

```sh
python3 --version
python3 monitorctl.py configure --url https://monitor.example.com
python3 monitorctl.py status
python3 monitorctl.py servers
```

`status` 只读取本机配置的地址等信息。`servers` 会访问平台并验证令牌。接通后，应能看到列表和采样时间。

## 4. 在客户端注册工具

支持本地 MCP 的客户端选择 **stdio**，将 `command` 填为 Python 可执行文件的绝对路径，`args` 依次填 `monitorctl.py` 的绝对路径、`mcp`。如提供工具超时设置，填写 660 秒。保存后重载 MCP 或新建会话，并试用列表、详情和历史工具。

Windows 默认使用本机确认窗口。已验证支持 MCP 原生提问的客户端可把参数改为 `[脚本绝对路径, "--confirmation", "native", "mcp"]`。Linux/macOS 在无原生提问能力时，可把 CLI 放到人员能操作的终端。支持 HTTP 整合的客户端需由可信适配器管理令牌和实际人员确认。HTTP API 的路径是平台地址加 `/api/ai/v1`。更多配置见 AI 说明。

## 5. 验收与排错

1. 先读取服务器列表、详情和一段近期历史，核对服务器、采样时间及 `metrics_stale`。
2. 需要验证命令时，选择测试主机并让 AI 提交 `hostname`。核对工具端显示的目标和完整命令，再亲自确认。正常情况下能查询到退出码 0、输出和审计记录。
3. **待确认**表示尚未取得有效答复。关闭窗口、表单不支持或超时也可能出现此状态。恢复确认时使用原请求编号和原命令。若结果未知，先查原任务。
4. **401** 检查平台地址和令牌是否匹配，确认令牌未撤销。**403 / 1010** 核对平台的边缘访问规则、客户端版本和 User-Agent。客户端无工具列表时检查路径及 stdio 设置并重载。

兼容性取决于客户端版本提供的工具和交互能力。上线运行及新装平台的验收请参阅所在版本的部署教程。
