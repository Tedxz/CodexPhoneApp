# 部署与维护

本文介绍通用部署配置、网络入口与故障排查。macOS 上使用 Funnel 和 LaunchAgent 的完整步骤见 [Funnel 服务指南](FUNNEL-SERVICE.md)。

## 配置

网关默认读取当前工作目录的 `config.local.json`；文件缺省时使用本机默认值。`CODEX_PHONE_CONFIG` 可指定另一份配置文件。所有 CLI 与网关必须指向同一配置和数据目录。

| 配置项           | 默认值 / 用途                                                            |
| ---------------- | ------------------------------------------------------------------------ |
| `host`           | `127.0.0.1`；局域网模式显式填电脑的局域网 IP                             |
| `port`           | `8787`                                                                   |
| `publicUrl`      | `http://127.0.0.1:8787`；浏览器实际访问的入口，不含配对凭据              |
| `allowedOrigins` | 额外允许的网页来源；通常只需使用 `publicUrl`                             |
| `projects`       | 当前工作目录；数组元素为 `{ "name": "名称", "path": "/绝对/目录" }`      |
| `socketPath`     | `~/.codex/app-server-control/app-server-control.sock` 对应的用户目录路径 |
| `dataDir`        | 当前工作目录下的 `.codex-phone`；存储设备认证与上传图片                  |
| `tls`            | 可选 `{ "cert": "/绝对/证书.pem", "key": "/绝对/私钥.pem" }`             |

SSH 目标通过 `sshTargets` 配置，字段及图片目录要求见[连接配置](MULTI-SERVER.md)。默认 socket 路径会使用 `CODEX_HOME` 指定的 Codex 目录（如有设置）。

建议所有文件路径使用绝对路径。`publicUrl` 和允许来源必须准确匹配浏览器的协议、主机和端口。更改配置后重启网关。项目列表限制新建会话可选择的工作目录，不是已有历史的访问控制列表；Codex 对文件和命令的实际权限仍使用电脑端策略。

## 局域网

1. 在电脑网络设置确认当前局域网 IP，将 `host` 与 `publicUrl` 配置为该地址。
2. 运行 `npm run build`、`npm run doctor` 和 `npm start`。
3. 手机使用同一 Wi-Fi 打开配置入口。不能连接时检查网关是否确实监听该 IP、系统防火墙，以及 Wi-Fi 是否开启客户端隔离。
4. 在电脑运行 `npm run pair`，手机扫码或打开输出链接进行配对。

长期使用 HTTPS 时，准备与访问名称匹配、受手机信任的证书，设置 `tls.cert`、`tls.key` 和 `https://...` 的 `publicUrl`。局域网 IP 证书须包含该 IP 的 SAN；自建 CA 须在手机端安装并信任。只放置服务器证书和私钥到电脑，不把 CA 私钥传到手机。证书工具的安装与设备信任需由使用者按其网络环境完成。

局域网和 Funnel 两种地址属于不同网站来源，需要分别登录。网关按 `publicUrl`/TLS 配置统一决定 cookie 的 Secure 属性：Funnel HTTPS 配置不能同时用于 HTTP 局域网登录。要兼用两种入口，请给局域网也配置 HTTPS；或者用分别匹配入口的配置运行两个网关，绑定不同监听地址或端口。同一用户可共用 `dataDir` 保留设备记录，两种来源的浏览器 cookie 仍分别管理。

## Tailscale Funnel

电脑须已登录 Tailscale，tailnet 已具备 MagicDNS、HTTPS 和使用 Funnel 的权限。初次执行命令可能打开 Tailscale 授权页面。网关继续监听 `127.0.0.1:8787`，只把网关端口交给 Funnel：

```sh
tailscale funnel --bg 8787
tailscale funnel status
```

将输出的 HTTPS 域名配置为 `publicUrl`，重启网关，生成新的配对链接。`--bg` 会保留 Funnel 配置，重启 Tailscale/电脑后可恢复转发。公网端口由 Funnel 提供 TLS；浏览器访问 HTTPS，Funnel 在本机转发到 HTTP 网关。命令行为以 [Tailscale CLI 官方文档](https://tailscale.com/docs/reference/tailscale-cli/funnel) 为准。

关闭本项目使用的默认 HTTPS 入口：

```sh
tailscale funnel --https=443 off
tailscale funnel status
```

若当前机器已有其他 Funnel 服务，先用 `status` 核对端口与路径；不要执行会清除所有服务的 `reset`。关闭 Funnel 不会停止本机网关或 Codex 任务。

## macOS 登录启动与保活

可使用当前用户的 LaunchAgent 托管网关，服务名称为 `local.codex-phone`。脚本读取当前配置并记录其路径；使用 Funnel 时，建议只监听 `127.0.0.1:8787`。Tailscale 的启动设置由使用者单独管理。即使 Codex 尚未打开，网关也可运行，Codex 启动后会自动重连共享后端。该方式从用户登录开始生效，不提供开机尚未登录时的访问。

先确认前台运行和诊断正常，再生成 plist：

```sh
node --import tsx scripts/launch-agent.ts --output /tmp/codex-phone.plist
plutil -lint /tmp/codex-phone.plist
```

脚本会记录当前 Node 可执行文件的绝对路径、项目目录、配置路径和 PATH，设置 `RunAtLoad=true`、`KeepAlive=true` 和 15 秒重启节流。服务加载后立即启动，正常结束和异常退出都由 launchd 自动重新拉起。标准输出和错误输出分别保存为数据目录下的 `logs/gateway.out.log`、`logs/gateway.err.log`；默认位于 `.codex-phone/logs/`。脚本不会启动 Codex 或 Funnel，也不会自动加载服务。确认配置后，先停止占用相同监听地址的旧网关，再安装并手动加载：

```sh
node --import tsx scripts/launch-agent.ts --install
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.codex-phone.plist"
launchctl print gui/$(id -u)/local.codex-phone
```

安装命令拒绝覆盖已有 plist。更新网关代码或配置后，先停止再加载：

```sh
launchctl bootout gui/$(id -u)/local.codex-phone
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.codex-phone.plist"
```

只需临时停止网关时执行 `bootout`，保留 plist 即会在下次登录时重新启动。`KeepAlive=true` 会重新拉起被结束的进程，因此不要使用 `kill` 代替停服务命令。

永久停用登录启动时，先停止服务，再移除 plist：

```sh
launchctl bootout gui/$(id -u)/local.codex-phone
rm "$HOME/Library/LaunchAgents/local.codex-phone.plist"
```

若服务已停止，`bootout` 会提示找不到服务，此时可直接移除 plist。升级 Node 或移动项目导致绝对路径改变时，按以上步骤移除旧配置后重新生成、安装并加载。脚本不负责日志轮转，长期运行时可按需清理旧日志。停止网关不会停止电脑端正在运行的 Codex 任务。

## 诊断

`npm run doctor` 返回码为 `0` 表示它检测的项目通过，为 `1` 表示至少一项失败。它不会发起生成任务，也不会读取或打印会话正文。

| 现象                                 | 检查与处理                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ENOENT` / 未找到 socket             | 检查电脑端 Codex 是否运行、配置是否指向同一用户的已有 control socket                                  |
| `EPERM` / `EACCES`                   | 当前进程被系统权限或执行沙箱阻止；在运行 Codex 的同一用户普通终端重试诊断                             |
| `ECONNREFUSED`                       | socket 路径存在，但没有可接受连接的后端进程；检查电脑端状态                                           |
| `RPC_*` / `RPC_TIMEOUT`              | 握手或协议与当前版本不匹配；保留错误码与 Codex 版本用于适配，勿另起后端充当共享成功                   |
| 能看历史，电脑当前任务不显示实时状态 | 历史可能来自共享存储，而运行任务属于另一 app-server；必须验证同一后端，不能据历史列表宣称完成跨端控制 |
| 页面能开、实时连接失败               | 检查 `publicUrl`、允许来源和反向代理 WebSocket Upgrade 支持；HTTPS 网页应使用 WSS                     |
| 配对链接失效                         | 凭据已使用或超过 5 分钟；在电脑重新运行配对命令                                                       |
| 切换网络后状态不确定                 | 等待重连并恢复会话快照；核对最近用户消息后再发送，避免重复执行                                        |
| `EADDRINUSE`                         | 已有网关或其他服务占用端口；检查现有进程后选择停旧网关或修改端口                                      |

不要在诊断截图中分享配对链接、浏览器登录令牌、设备认证文件或 Codex 凭据。问题报告只需版本、连接错误码、访问模式和复现步骤。
