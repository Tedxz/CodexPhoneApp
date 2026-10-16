# Codex Phone

从手机浏览器访问电脑上已有的 Codex 会话。第一阶段为移动端网页，React + TypeScript 前端通过本地 Node.js 网关连接同一台电脑的 Codex app-server control socket。HarmonyOS 原生手机应用与网页共用 `/api/v1` HTTP 与 WebSocket 接口。

网页提供会话列表、按工作路径浏览和历史、文字与图片输入、流式回复、工具过程、新建和继续会话、运行中追加指令、停止、审批与交互问题，以及项目、模型、推理强度和 Plan 模式选择。电脑端权限策略继续由 Codex 管理。

**接入前提：电脑正在运行的 Codex 必须提供可连接的共享 control socket，并支持所需协议。** 不同 Codex 版本和客户端可能不共享同一个运行后端；能读取历史不代表能控制另一个进程中的运行任务。本项目不会另起独立 app-server 来替代共享接入。共享会话与真机验收方法见 [验收清单](docs/ACCEPTANCE.md)。

## HarmonyOS 原生应用

HarmonyOS 7 原生客户端位于 [`harmony/`](harmony/README.md)，使用 ArkTS / ArkUI 与同一个网关连接。环境检查运行 `npm run harmony:doctor`，实际 HAP 构建运行 `npm run harmony:build`；构建、模拟器与签名说明见原生目录文档。

## 按工作路径浏览

会话列表上方可切换「全部会话」和「工作路径」。选择工作路径后，只显示该目录的会话，可以继续搜索标题、加载更早的会话并打开接续；点击「全部工作路径」可重新选择目录。目录卡片显示完整路径、会话数量和运行中的数量，同名文件夹也能区分。

目录按最近会话更新时间排序，统计覆盖历史列表的全部分页，不受新建会话的 `projects` 配置限制。目录按会话记录的完整路径精确分组，父子目录分别显示；新建会话仍只能选择配置允许的项目。

## 本机启动

需要 Node.js 22.13 或更新版本，以及已登录、正在运行的电脑端 Codex。

```sh
npm install
npm run build
npm run doctor
npm start
```

另开终端生成一次性配对二维码：

```sh
npm run pair
```

默认入口 `http://127.0.0.1:8787` 只能在这台电脑访问。配对凭据有效期 5 分钟，只能使用一次；设备登录有效期 30 天。手机使用前请按下面选择局域网或 Funnel 入口。

本机当前公网入口（2026-10-16）为 [https://xz-macbookair.tail9ddfa1.ts.net](https://xz-macbookair.tail9ddfa1.ts.net)。本机部署只保留监听 `127.0.0.1:8787` 的 Funnel 网关，由 macOS LaunchAgent 在用户登录后启动并持续保活，局域网网关停用。Tailscale 使用已有的登录启动配置；Codex 由用户手动打开，网关会自动重连共享后端。安装、启停、更新和排查步骤见 [本机 Funnel 网关配置与维护](docs/FUNNEL-SERVICE.md)。此前已通过公网 HTTPS 健康检查与 TLS 验证，HarmonyOS 原生客户端已在实体手机完成该域名的 HTTPS 配对、WSS 连接与真实对话；手机蜂窝网络切换仍待验收。

`doctor` 只检查配置、构建产物、Codex 版本和共享 socket 握手/列表查询，不创建或继续任务，不修改系统设置。失败时先处理它给出的具体连接原因。

## 手机入口

项目根目录的 `config.local.json` 为本机配置，不要提交到 Git。也可用 `CODEX_PHONE_CONFIG=/绝对路径/config.json` 指定配置；启动、配对及设备管理命令须使用同一配置。

局域网示例（将地址和项目目录替换为本机实际值）：

```json
{
  "host": "192.168.1.20",
  "port": 8787,
  "publicUrl": "http://192.168.1.20:8787",
  "projects": [{ "name": "我的项目", "path": "/Users/me/Code/my-project" }]
}
```

手机和电脑接入同一网络，重启网关，再运行 `npm run pair` 并用手机扫码。局域网 HTTP 适合可信网络上的初次验证；长期使用请配置手机信任的 HTTPS 证书，步骤见 [部署说明](docs/DEPLOYMENT.md)。

Funnel 模式保持 `host` 为 `127.0.0.1`，启动网关后在电脑终端运行：

```sh
tailscale funnel --bg 8787
tailscale funnel status
```

把输出中的 `https://电脑名称.网络名称.ts.net` 设置为配置的 `publicUrl`，重启网关，再运行 `npm run pair`。Funnel 将网关端口通过 HTTPS 提供给公网，访问会话仍需要配对。官方命令及前提见 [Tailscale Funnel 文档](https://tailscale.com/docs/reference/tailscale-cli/funnel)。

## 设备与运行管理

```sh
npm run devices
npm run revoke -- 设备ID
```

客户端列表按同一 App 安装或同一浏览器站点实例识别，重复配对复用记录，并显示客户端类型、首次配对和最近使用时间。原生 App 的局域网与 Funnel 授权可归入同一记录；浏览器不同来源分别识别。旧记录会在原客户端访问后迁移，无法确认来源的历史记录标为「旧版授权」，可逐项撤销。撤销或退出一个客户端会使其全部入口授权及现有连接失效。前台网关按 `Ctrl+C` 停止；手机断开或网关停止不等同于停止正在电脑端运行的 Codex 任务，需要时先在对话中点击停止。

生成 macOS 登录启动配置：

```sh
node --import tsx scripts/launch-agent.ts
```

默认仅输出 plist 供检查。使用 `--install` 会将 `local.codex-phone.plist` 保存到当前用户的 LaunchAgents 目录，但不会加载服务。加载后网关正常退出或异常退出都会重新启动；主动停止请使用 `launchctl bootout`，不能仅结束进程。具体启停和永久停用命令见 [部署说明](docs/DEPLOYMENT.md)。服务随当前用户登录启动，不提供开机未登录时的访问；本项目不会自动开启 Funnel、启动 Codex 或修改全局 Codex 配置。

## 开发与验证

截至 2026-10-16，本分支 114 项自动测试（网页/网关 89 项、原生客户端 25 项）、构建及真实后端诊断通过；另已验证双连接、网页文字/图片与追加/停止、运行中网关重启恢复、显式会话设置、共享 socket 交互式 CLI 接续、文件变更审批和 Funnel 公网 HTTPS。完整网页测试使用本机 Chromium 移动视口；独立 `codex exec resume` 路径、网页在实体手机上的完整操作和蜂窝网络下的公网 WSS 流程仍未通过全部验收，整体保持部分验收。原生手机的安装、配对、真实对话和重启恢复见 [HarmonyOS 验收](docs/HARMONYOS-ACCEPTANCE.md)。持久证据与剩余项目见 [验收记录](docs/ACCEPTANCE.md)。

代码统一使用 Prettier 格式化；提交前运行完整检查，依次验证格式、自动测试和生产构建：

```sh
npm run format
npm run check
```

也可以单独执行 `npm run format:check`、`npm test` 或 `npm run build`。本机配置、设备认证、上传图片、临时验收目录和构建产物均不进入 Git；`docs/evidence` 保留已核验的原始证据，不参与自动格式化。

在可访问电脑现有共享后端的终端执行真实后端自动检查：

```sh
npm run test:live -- --run
```

不带 `--run` 时仅显示说明。连接成功后，脚本只操作本次新建的隔离测试会话，检查文字、第二连接实时事件、运行中追加与停止；测试会请求执行一次 `/bin/sleep 20`。报告保存到 `tmp/live-acceptance/report-*.json`。共享 socket 被 `EPERM` 阻止时记为 `blocked`，不算通过；Desktop/CLI 同步、审批和真机局域网/Funnel 仍按 [验收清单](docs/ACCEPTANCE.md) 人工确认。

前端开发可同时运行 `npm run dev` 和 `npm run web:dev`，并在配置的 `allowedOrigins` 中加入 `http://127.0.0.1:5173`，使用 `npm run pair -- --url http://127.0.0.1:5173` 配对。日常手机访问使用 `npm run build` 后由网关统一提供网页。

- [本机 Funnel 网关配置与维护](docs/FUNNEL-SERVICE.md)
- [部署、HTTPS、故障排查](docs/DEPLOYMENT.md)
- [接口与重连约定](docs/API.md)
- [真实共享后端与手机验收](docs/ACCEPTANCE.md)

Codex 适配器根据本机协议隔离版本差异；官方接口参考 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。官方将 WebSocket transport 标注为实验性能力，升级 Codex 后应重新运行诊断与共享后端验收。
