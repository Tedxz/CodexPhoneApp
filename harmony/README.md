# Codex 随行 · HarmonyOS

面向 HarmonyOS 7 的 ArkTS / ArkUI 原生手机应用，通过已有网关的 HTTP 和 WebSocket 接口访问电脑上的 Codex 会话。界面、图片选择和凭据存储使用鸿蒙原生能力。

应用图标沿用 Codex 的花形与终端标记，并适配本 App 的绿色系；图标来源、资源位置和真机验证见[图标说明](../docs/ICON-ASSETS.md)。

## 功能

- 保存多个 Server，分别命名、配对与管理；首页按 Server 分组展示本机和 SSH 远程机器。
- 输入局域网地址或 Tailscale Funnel HTTPS 地址，用一次性凭据配对；也可粘贴完整配对链接。
- 在「工作路径」与「全部会话」间切换，搜索目录或标题、加载更早的会话。
- 查看历史、流式回答、代码块与工具过程；支持文字、相册图片、运行中追加和停止。
- 选择项目新建会话，设置模型、推理强度与 Plan 模式；响应审批和交互式问题。
- 保存草稿、恢复登录、自动重连、查看和撤销已授权客户端。

每个 Server 的名称、地址和登录凭据使用独立系统 Asset Store SECRET 加密保存，不写入明文 Preferences；旧版连接自动迁移，不再限制为两个入口。草稿保存在应用私有 Preferences，历史图片经认证下载到应用私有缓存。只把认证头发送到当前网关。原生应用继续沿用电脑端的 Codex 权限与审批规则。

## 开发环境与构建

这台 Mac 已安装官方 DevEco Studio 26.0.0.851，内置 HarmonyOS SDK 26.0.0.105 Release（API 26）、Node 24.14.1、JBR 25.0.2、Hvigor 6.26.8 与 ohpm 26.0.0.630。官方下载 ZIP 的 SHA-256 和 macOS 签名、公证均已验证。工具路径：`/Applications/DevEco-Studio.app`。

在仓库根目录执行：

```sh
npm run harmony:doctor
npm run harmony:build
```

脚本使用 DevEco Studio 自带的 Node、JDK 和 SDK，仅修改本次构建进程的环境。自定义安装位置时设置 `HARMONY_STUDIO_HOME=/路径/DevEco-Studio.app`。另可在 DevEco Studio 中打开本目录进行调试。

默认产物：

```text
harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
```

默认无签名构建可供本地模拟器验收。真实手机需要与 `com.xiezheng.codexphone` 包名和目标设备匹配的开发者签名，不能直接把 unsigned HAP 当作真机可安装包。签名材料与私钥属于本地配置，不应提交到 Git。

本机的真机签名工程使用被 Git 忽略的 `tmp/harmony-phone/` 副本，已生成并安装签名 HAP：`tmp/harmony-phone/entry/build/default/outputs/default/entry-default-signed.hap`。这是开发调试包，安装范围由开发 profile 中登记的设备决定。更新代码时同步源文件到该副本，但保留其根目录的 `build-profile.json5`，然后在副本目录执行 `source ../../scripts/harmony-env.sh` 并运行 Hvigor `assembleHap`。仓库内的 `harmony/build-profile.json5` 保持无签名配置。

首次签名需在 `devecocli auth login` 完成工具登录，网站登录不能替代它。若刚完成华为开发者实名认证，已有工具会话仍可能保留旧状态；先 `devecocli auth logout`，再重新登录并生成签名。不要把签名配置、证书或私钥复制回源码目录。

可执行 `bash scripts/harmony-build.sh release` 构建 release 模式；发布分发还需相应签名与发布配置。本工程要求 HarmonyOS 7 / API 26，使用该版本的原生 WebSocket Origin 端口支持，不支持旧系统。

## 连接电脑

先确认电脑端网关已启动，手机可访问相同地址：

```sh
npm run doctor
npm start
npm run pair
```

手机应用中填写网关地址和电脑生成的一次性凭据。Funnel 地址使用 `https://`；局域网可使用 `http://电脑局域网IP:8787`。地址不要包含 `/api/v1` 等路径。不同地址的登录凭据分别保存，不会将一个入口的凭据转发给另一个入口。

首页在前台每 10 秒刷新机器目录，最多并发查询 4 个 Server；进入会话或退到后台后暂停目录轮询。选中机器后只建立该机器的实时连接。Server 离线或登录失效会单独标注，不影响其他连接。旧网关仅在机器目录接口返回 404 时作为单一本机目标显示。

修改已有 Server 的地址必须完成新地址配对后才能替换原连接；单独保存名称不影响登录。移除 Server 只删除手机连接，退出登录才请求网关撤销当前客户端授权。草稿、附件和历史图片按 Server、机器与会话隔离，机器名称会持续显示在会话页。

应用退到后台或网关重连不会停止电脑任务。命令发送后若连接断开，应用会提示结果尚未确认，不自动重发生成或审批操作；恢复后核对会话即可。退出登录会撤销当前客户端在该网关中的全部入口授权，并清理本机当前入口的凭据。

客户端身份使用 Crypto Architecture Kit 生成的 32 字节安全随机数，存放于独立 Asset Store SECRET，禁止同步。身份跨重启、退出登录和覆盖安装保持稳定；它不是硬件标识，也不能替代登录凭据。同一 App 的局域网与 Funnel 授权可归到同一客户端，但浏览器是独立客户端。旧版有效登录会在启动时认领身份，迁移失败保留登录并提示重试；旧网关没有识别接口时继续兼容。旧记录仅有同名标签时不能自动合并。列表显示客户端类型、首次配对时间、最近使用时间和多入口授权数量，最近使用时间不表示在线状态。

## 工程结构

| 路径                                    | 职责                                         |
| --------------------------------------- | -------------------------------------------- |
| `entry/src/main/ets/pages/Index.ets`    | 配对、工作路径、对话、新建与设备管理页面     |
| `entry/src/main/ets/components/`        | 消息、Markdown、模型选择及审批问题组件       |
| `entry/src/main/ets/state/AppStore.ets` | 页面状态、草稿、相册上传、图片缓存与会话控制 |
| `entry/src/main/ets/transport/`         | 原生 HTTP/WSS、连接校验与系统凭据存储        |
| `entry/src/main/ets/model/`             | 网关协议类型、事件游标与快照合并             |
| `../tests/harmony-model.test.ts`        | 执行实际 ArkTS 逻辑的协议与状态回归测试      |

网关协议见 [API 文档](../docs/API.md)，网页与原生应用共用同一后端。原生类型保留 `shared/protocol.ts` 的字段名，协议变更时须同步更新。

## 验证

```sh
npm run check
npm run harmony:build
```

`npm run check` 包含原有网页/网关测试和原生协议、状态测试；其中原生网络与安全存储通过系统 API 替身运行，以覆盖错误和竞态。真正的 ArkTS 类型检查、资源编译和 HAP 打包由 `harmony:build` 完成。

本机已创建独立 `CodexPhoneApi26` 模拟器（HarmonyOS 7.0.0.107），可在 DevEco 中启动，或使用已安装的 `~/.local/bin/devecocli`。最终运行证据和真机限制记录在 [原生验收记录](../docs/HARMONYOS-ACCEPTANCE.md)。

官方参考：[DevEco Studio 下载](https://developer.huawei.com/consumer/cn/download/)、[命令行工具](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-commandline-get)、[Network Kit HTTP](https://developer.huawei.com/consumer/en/doc/harmonyos-references-V5/js-apis-http-V5)、[Asset Store](https://developer.huawei.com/consumer/en/doc/harmonyos-references/js-apis-asset)。
