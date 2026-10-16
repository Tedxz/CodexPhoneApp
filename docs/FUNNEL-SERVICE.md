# Funnel 网关配置与维护

本文介绍如何在自己的 macOS 电脑上使用 Tailscale Funnel 提供 HTTPS 入口，并通过 LaunchAgent 托管网关。请将示例域名和路径替换为实际值。已安装服务时按日常操作维护，不重复安装或运行前台网关。

## 运行方式

手机通过 Tailscale Funnel 的 HTTPS 地址访问网关，Funnel 转发到本机 `127.0.0.1:8787`，网关再连接当前用户的 Codex 共享后端。

| 项目         | 示例配置                                               |
| ------------ | ------------------------------------------------------ |
| 公网地址     | <https://your-server.your-tailnet.ts.net>              |
| 项目目录     | `/absolute/path/to/CodexPhoneApp`                      |
| 网关配置     | 项目根目录的 `config.local.json`                       |
| 监听地址     | `127.0.0.1:8787`                                       |
| 服务名称     | `local.codex-phone`                                    |
| 登录启动文件 | `~/Library/LaunchAgents/local.codex-phone.plist`       |
| 数据目录     | 项目根目录的 `.codex-phone`                            |
| 日志         | `.codex-phone/logs/gateway.out.log`、`gateway.err.log` |

macOS LaunchAgent 在当前用户登录后启动网关，并在进程正常退出或异常退出后自动恢复。配置使用 `RunAtLoad=true`、`KeepAlive=true` 和 `ThrottleInterval=15`；15 秒是重启节流设置，不是恢复时间保证。

Tailscale 的登录启动需另行配置。Codex 由用户启动，网关会自动重连其共享后端。本例仅配置一个回环监听的网关。

重启 Mac 后，先登录该用户，网关和 Tailscale 才能恢复访问；使用会话功能还需手动打开 Codex。电脑须联网并保持系统唤醒，锁屏不等同于系统睡眠；睡眠或关机期间无法访问。此配置不提供开机未登录时的访问。

## 首次安装或迁移到其他电脑

首次安装时按以下顺序操作；迁移时保留所需的配置与数据，并替换项目路径和 Funnel 域名。

### 1. 准备项目与配置

安装 Node.js 22.13 或更新版本，在项目目录执行：

```sh
cd /absolute/path/to/CodexPhoneApp
npm ci
npm run build
```

网关直接运行 TypeScript，依赖开发依赖中的 `tsx`，不要使用 `npm ci --omit=dev`；若环境设置了仅安装生产依赖，改用 `npm ci --include=dev`。

首次配置可复制 `config.funnel.example.json` 为 `config.local.json`。编辑 `config.local.json`，Funnel 模式的关键字段如下。已有配置应只修改对应字段，保留其他项目和来源设置；迁移时保留原来的数据目录才能保留设备授权。

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicUrl": "https://your-server.your-tailnet.ts.net",
  "dataDir": "/absolute/path/to/CodexPhoneApp/.codex-phone",
  "projects": [{ "name": "CodexPhoneApp", "path": "/absolute/path/to/CodexPhoneApp" }]
}
```

HTTPS 由 Funnel 提供，此配置的网关使用本机 HTTP，无需设置 `tls`。`publicUrl` 必须与实际访问域名一致，不带路径或配对凭据。配置与 `.codex-phone` 数据不提交到 Git。

确认配置文件确实存在：程序在文件不存在时会使用默认配置。本文命令显式指定 `CODEX_PHONE_CONFIG`，避免终端继承了其他入口的配置；相对路径按工作目录解析，建议在配置中使用绝对路径。若使用自定义 Codex socket，将绝对路径写入 `socketPath`，不要依赖终端环境变量传入后台服务。

### 2. 确认 Funnel 转发

确保 Tailscale 已登录并设置为随用户登录启动，先查看已有转发：

```sh
tailscale funnel status
```

应看到公网 HTTPS 地址转发到 `http://127.0.0.1:8787`。如果尚未配置本项目入口，在确认没有冲突的转发后执行：

```sh
tailscale funnel --bg 8787
tailscale funnel status
```

首次使用可能需要完成 Tailscale 授权。将实际输出的 HTTPS 地址写入 `publicUrl`。`--bg` 保存后台转发配置；不要使用会清除全部转发的 `reset`。要求与命令说明见 [Tailscale 官方文档](https://tailscale.com/docs/reference/tailscale-cli/funnel)。

### 3. 安装并加载 LaunchAgent

先检查端口，若有旧网关，确认进程身份后停止它，避免新服务因端口占用而反复退出：

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

从项目目录安装，并显式指定要读取的配置：

```sh
CODEX_PHONE_CONFIG="$PWD/config.local.json" node --import tsx scripts/launch-agent.ts --install
plutil -lint "$HOME/Library/LaunchAgents/local.codex-phone.plist"
launchctl enable gui/$(id -u)/local.codex-phone
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.codex-phone.plist"
launchctl print gui/$(id -u)/local.codex-phone
```

`--install` 只生成文件，不加载服务，且拒绝覆盖已有文件；`bootstrap` 才会加载并启动。以上命令在当前用户终端运行，不需要 `sudo`。已加载的服务不要重复 `bootstrap`，应按下节重新加载。

生成脚本会固定当前 Node 可执行文件、项目目录、配置文件和日志的绝对路径，以及当时的 `PATH`，不依赖登录终端的初始化脚本。plist 权限为 `0600`。更新 Node 后若记录的路径仍有效，无需重新生成；若路径失效，按下文重新生成服务配置。

### 4. 检查访问与配对

```sh
curl --noproxy '*' --fail --show-error http://127.0.0.1:8787/api/v1/health
curl --noproxy '*' --fail --show-error https://your-server.your-tailnet.ts.net/api/v1/health
CODEX_PHONE_CONFIG="$PWD/config.local.json" npm run doctor
```

两次健康检查成功只证明网关本机与公网 HTTP 可用。手动打开 Codex 后，`doctor` 应确认共享后端连接正常；它不会创建会话或发送任务。

首次连接或登录失效时，从同一项目目录生成配对凭据：

```sh
CODEX_PHONE_CONFIG="$PWD/config.local.json" npm run pair
```

在手机中使用公网地址及生成的凭据完成配对。已登录的手机无需因网关重启重新配对。不要把配对链接、设备认证文件或令牌写入文档。

## 日常操作

### 查看服务和日志

```sh
cd /absolute/path/to/CodexPhoneApp
launchctl print gui/$(id -u)/local.codex-phone
tailscale funnel status
lsof -nP -iTCP:8787 -sTCP:LISTEN
tail -n 100 .codex-phone/logs/gateway.out.log
tail -n 100 .codex-phone/logs/gateway.err.log
```

服务应为 `running`，网关只监听 `127.0.0.1:8787`。PID 随自动恢复变化，以 `launchctl print` 为准。日志没有自动轮转。

### 临时停止与恢复

停止网关：

```sh
launchctl bootout gui/$(id -u)/local.codex-phone
```

恢复已停止的网关：

```sh
launchctl enable gui/$(id -u)/local.codex-phone
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.codex-phone.plist"
```

`bootout` 停止本次登录期间的服务；保留 plist，下次登录仍会启动。不要用 `kill` 作为停服务方式，`KeepAlive` 会将进程重新拉起。停止网关会断开手机连接，电脑端正在执行的 Codex 任务继续运行。

### 更新代码或配置后重新加载

只改 `config.local.json` 时，直接重新加载服务即可。如果更新代码，先在项目目录完成必要的依赖安装和 `npm run build`，成功后再重新加载：

```sh
launchctl bootout gui/$(id -u)/local.codex-phone
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.codex-phone.plist"
```

随后重复健康检查与 `npm run doctor`。重新加载期间手机会短暂断开并自动重连。

若移动了项目、改变配置文件位置或日志目录，或 Node 可执行文件路径失效，需要重新生成 plist：先 `bootout`，备份并移走旧 plist，再按首次安装步骤生成、校验和加载。保留 `config.local.json` 与 `.codex-phone` 数据，不要删除设备授权。

### 永久取消网关登录启动

```sh
launchctl bootout gui/$(id -u)/local.codex-phone
rm "$HOME/Library/LaunchAgents/local.codex-phone.plist"
```

若服务已停止，第一条命令可能提示找不到服务，仍可移除 plist。这保留项目、配置和设备授权。若还需关闭本项目的公网转发，先核对 Funnel 状态，再关闭默认 HTTPS 入口：

```sh
tailscale funnel status
tailscale funnel --https=443 off
```

## 故障排查

| 现象                         | 检查与处理                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 安装报 `EEXIST`              | 已有 plist；正常启停不必重新安装，需要重新生成时先备份并移走旧文件。                                   |
| 加载失败                     | 用 `launchctl print` 检查是否已经加载；再用 `plutil -lint` 检查 plist，确认 Node、项目和配置路径存在。 |
| 服务反复退出                 | 查看 `gateway.err.log`；常见原因是 `EADDRINUSE`、Node 路径失效、依赖缺失或配置中的项目目录不存在。     |
| 本机健康检查失败             | 检查服务状态、日志及 `127.0.0.1:8787` 监听；不重复执行 `npm start` 抢占端口。                          |
| 本机正常，公网失败或返回 502 | 检查 Tailscale 是否运行、网络是否可用、`funnel status` 是否指向本机端口，再重试公网健康检查。          |
| 网页可开，会话功能不可用     | 手动打开 Codex，运行 `npm run doctor`；健康接口成功不代表共享后端已连接。                              |
| 页面可开，WSS 连接失败       | 检查 `publicUrl` 与手机访问域名一致，再核对允许来源和 Funnel 转发。                                    |
| 重启后无法访问               | 确认已登录对应 macOS 用户，Tailscale 已启动，网关已加载；会话功能还需要手动打开 Codex。                |
| 锁屏后或放置一段时间无法访问 | 检查系统是否进入睡眠；本配置不修改电源设置，也不阻止系统睡眠。                                         |

更多共享 socket、权限与配对问题见 [部署与维护](DEPLOYMENT.md#诊断)。

## 部署后验证

分别检查本机健康接口、公网 HTTPS、TLS 校验、配对后的会话访问与 WSS 实时连接。健康接口成功仅证明网关可响应，不能证明共享后端或手机实时控制可用。

如需验证保活，在测试环境中检查进程退出后恢复与服务重新加载；登录启动需另行验证电脑注销或重启后的访问。记录实际完成的步骤及未验证范围，按[验收清单](ACCEPTANCE.md)补齐端到端检查。
