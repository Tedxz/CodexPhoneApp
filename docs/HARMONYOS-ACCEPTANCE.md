# HarmonyOS 原生应用验收

日期：2026-10-16（Asia/Shanghai）。分支：`feat/harmonyos-app`。客户端使用 ArkTS / ArkUI，包名 `com.xiezheng.codexphone`，要求 HarmonyOS 7 / API 26。

## 环境与产物

- 官方 DevEco Studio 26.0.0.851 已安装到 `/Applications/DevEco-Studio.app`，安装归档 SHA-256 与官方公布值一致，macOS 签名与公证检查通过。
- 内置 SDK 26.0.0.105 Release、Node 24.14.1、JBR 25.0.2、Hvigor 6.26.8、ohpm 26.0.0.630；构建脚本只设置当前进程环境。
- 使用独立 `CodexPhoneApi26` 模拟器，系统 HarmonyOS 7.0.0.107，API 26。没有改动原有模拟器。
- `npm run harmony:build` 完成真实 ArkTS 编译、资源处理与 HAP 打包；生成 `harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。
- unsigned HAP 已在模拟器实际安装并启动。它不是可直接安装到真实手机的签名包。
- 首次模拟器验收 unsigned HAP SHA-256：`91666b2876fe74bca286c968bb37a5f90226f0bfbb3b957e65388c6c649f4bca`。具体版本与校验信息见 [环境和构建记录](evidence/2026-10-16-harmonyos/environment.json)。后续界面修复的当前产物记录见文末。

`npm run check` 当前通过格式检查、114 项测试（0 失败、0 跳过）、TypeScript 检查与网页生产构建。其中 25 项原生源码测试覆盖网络与安全存储、事件合并、断线、登录切换及在途请求竞态。

## 验证方法

原生界面由 `devecocli ui` 和 HDC 操作，证据来自已安装 HAP 的系统界面树和截图。固定数据网关使用生产 `createGateway`，复用真实 HTTP 配对、认证、Origin 校验、WebSocket 与图片上传流程，仅替换 Codex 适配器的数据和任务响应。

固定数据有 50 个会话、5 个工作路径，包括同名项目、相邻路径、空路径及包含 45 个会话的目录。单元测试另外执行实际 `.ets` 协议与状态代码，替换系统网络和安全存储接口以注入错误及迟到响应；这类测试与模拟器实测分别记录。

## 已通过的原生模拟器检查

- HTTP 配对后展示工作路径；同名目录显示完整路径。
- 按路径搜索、进入目录、目录内标题搜索；同目录会话分页从 40 条加载到 45 条。
- 切换全部会话，显示独立的第一页 40 条。
- 强制停止并重新启动 App，系统 Asset Store 中的登录状态恢复。
- 设备管理显示当前设备。
- 原生 WebSocket 订阅与发送，界面收到分段回复 `HARMONY_NATIVE_OK`。
- 运行中追加使用原轮次 ID，随后停止并显示 interrupted 终态。
- 命令审批提交 accept；交互问题选择「原生方案」并成功提交。
- 选择项目新建会话；模型、high 推理强度和 Plan 模式按所选值到达网关。
- 未发送草稿在会话之间隔离，返回原会话后恢复。
- 工具过程折叠与展开，流式更新时保持展开状态。
- 新消息跟随最新位置；上翻阅读时保持位置，点击向下按钮返回最新。
- 系统相册选择测试截图，上传 1 张图片，历史通过认证下载并原生回显。

上述固定数据检查共 21 项，均通过。[完整报告](evidence/2026-10-16-harmonyos/native-ui-report.json) 引用实际界面截图和 [网关动作记录](evidence/2026-10-16-harmonyos/fixture-actions.json)。代表截图：[工作路径](evidence/2026-10-16-harmonyos/fixture-workspaces.png)、[审批](evidence/2026-10-16-harmonyos/fixture-approval.png)、[图片回显](evidence/2026-10-16-harmonyos/fixture-image-sent.png)。截图均使用测试数据。

## 真实 Codex 后端

原生 HAP 通过局域网入口完成配对，显示 33 个真实工作路径并建立 WebSocket。只新建了一条自有测试会话，要求返回 `HARMONY_NATIVE_REAL_OK`，明确不执行工具或修改文件。原生界面收到目标回复并回到空闲状态；独立只读观察连接记录 6 次文本增量、active → idle、目标标记存在、工具执行数为 0。没有向原有用户工作会话发送消息。

安全的最终界面见 [真实原生对话](evidence/2026-10-16-harmonyos/real-lan-success.png)，事件计数见 [真实后端观察记录](evidence/2026-10-16-harmonyos/real-backend-report.json)。真实目录列表、其他会话正文和配对页面的中间记录不纳入归档。

随后使用 `https://xz-macbookair.tail9ddfa1.ts.net` 完成原生 HTTPS 配对与 WSS 连接，重新订阅并读取同一条测试会话及回复；没有再创建会话或发送消息。TLS 使用系统默认证书验证，没有跳过校验。这里验证的是模拟器访问 Funnel 域名的 HTTPS/WSS 行为，没有据此断言已覆盖独立公网路径或实体手机蜂窝网络。

覆盖安装和重启后，Funnel 登录仍可恢复，同一会话的正文、标题与工作路径正确显示；随后退出测试设备并回到空凭据的配对页。详见 [原生真实验收报告](evidence/2026-10-16-harmonyos/native-real-ui-report.json) 和 [Funnel 会话截图](evidence/2026-10-16-harmonyos/final-funnel-thread-settled.png)。只读观察设备也已撤销，独立测试网关已停止，原有局域网/Funnel 网关与用户设备保留。

## 实测发现与修复

NetworkKit 会自动生成 WebSocket `Origin`；手动添加同名头会产生两个值，网关按精确来源校验拒绝连接。现在只传 Cookie 并启用 API 26 新增的 `supportOriginPort: true`，带端口的局域网地址可正确握手。网关的来源校验未放宽。这也是本工程最低要求 API 26 的实际依赖。

真实界面验收同时修复了固定宽按钮裁剪图标、新消息滚动误判、旧操作提示残留。已保存登录首次遇到网络故障时，可以在配对页重试连接。状态层通过版本检查阻止旧网关的迟到响应覆盖新登录，发送确认也不会清除用户刚输入的新草稿。

真实后端首次发送时，曾出现新 rollout 文件已创建但元数据尚未写入的瞬态读取错误；当时任务实际完成，原生界面收到回复。修复只针对该明确错误重试 `thread.subscribe` 读取，最多两次，间隔 500/1000ms，并检查登录、会话及连接是否仍一致。发送命令绝不自动重发；即使后续读取仍失败，也明确显示已发送及重新同步提示。新增回归覆盖重试次数、单次发送及切换时取消。另修复了较慢 WSS 读取后标题与提示文本未随状态刷新的问题。

凭据使用 Asset Store 的加密 SECRET、设备解锁访问及禁止同步设置。HTTP 禁止重定向，图片仅从当前认证网关的合法上传路径下载，再通过应用私有缓存显示。配对凭据、会话 Cookie、用户真实会话正文及签名材料不归档到证据目录。

## 真实手机安装与验收

已通过 USB 识别真机 CMM-AL10，系统 `7.0.0.109(SP11C00E108R6P4)`、API 26，HDC 调试连接正常。用户完成华为开发者实名认证后，退出并重新登录 DevEco CLI 刷新会话，签名生成成功。已完成签名 HAP 的实际 ArkTS 编译和打包，并由 HDC 确认安装成功。设备序列号和身份资料不纳入记录；当前状态见 [真机准备记录](evidence/2026-10-16-harmonyos/physical-device-setup.json)。

真机签名使用被 Git 忽略的实体工程副本 `tmp/harmony-phone/`，原始 `harmony/build-profile.json5` 保持不含签名材料，其 SHA-256 与签名前完全一致。签名产物位于 `tmp/harmony-phone/entry/build/default/outputs/default/entry-default-signed.hap`。首次启动时手机处于锁屏状态，系统拒绝自动解锁；用户自行解锁后，`aa start` 已确认启动成功，随后继续界面验收。

官方 `hap-sign-tool` 的应用签名及 profile 校验均通过，ZIP 完整，首次真机验收签名包 SHA-256 为 `c48132f071eeb930fb9f2e12374c75a1f6918422a9e877969970c0d99e6e14b5`，开发 profile 有效期至 2027-10-15 22:43:57 UTC。报告仅保存安全元数据，见 [签名产物校验](evidence/2026-10-16-harmonyos/signed-artifact.json)。该包是登记设备使用的开发调试包。

真机已通过 Funnel 域名完成 HTTPS 配对并显示 WSS「电脑已连接」，设备名称按用户要求设置为「Mate 90 Pro Max」。原生工作路径显示 33 组、全部会话首批显示 40 条。只新建了一条自有测试会话，发送一次要求精确回复 `HARMONY_PHONE_REAL_OK` 且不使用工具的提示，手机收到精确回复并回到「就绪」。独立读取 Funnel 网关快照确认：1 条用户消息、1 条助手消息、状态 idle、工具数 0。见 [真机真实后端核验](evidence/2026-10-16-harmonyos/phone-real-backend-report.json)。

强制停止并重新启动 App 后，无须再次输入凭据即可恢复登录和 WSS 连接；设备管理中「Mate 90 Pro Max」与「当前设备」位于同一行。再次搜索并打开同一条测试会话，回复和就绪状态均保留。真机保持配对，临时观察设备已全部撤销，使用过的明文配对文件及包含其他用户数据的中间界面树已删除。详见 [真机界面验收报告](evidence/2026-10-16-harmonyos/native-phone-ui-report.json)、[自有测试会话界面证据](evidence/2026-10-16-harmonyos/phone-owned-conversation-safe.json) 与 [清理结果](evidence/2026-10-16-harmonyos/phone-cleanup.json)。

首次真机对话验收未取得最终截图：捕获前应用窗口枚举返回 `No windows found`，随后停止设备操作，未据此断言手机处于锁屏。真机界面证据为实际系统 UI 树和安全摘要，不使用模拟器截图代替真机截图。

本次独立实时观察连接误连到单独的局域网网关进程，未采集到 Funnel 会话的增量事件，因此真机报告不提供流式增量次数；没有为补计数重复发送消息，而是对同一条已完成会话进行只读核验。

当前真机验证覆盖 Funnel 域名的 HTTPS/WSS；未切换手机网络，不将其等同于蜂窝公网验收。系统相册、锁屏/后台恢复、Wi-Fi 与蜂窝切换仍需分别验证。

本轮发现原 Node 网关进程已退出，已按原配置恢复两个独立后台进程。回环、局域网和两处公网 Funnel ingress 的健康页均返回 200；其中一个公网 ingress 还确认网页根路径返回 200、未认证接口返回 401，公网 TLS 校验通过；原设备与配对记录未修改。恢复结果见 [网关恢复记录](evidence/2026-10-16-harmonyos/gateway-restored.json)。PID 保存在 `.codex-phone/run/gateway-{funnel,lan}.pid`，日志在 `.codex-phone/logs/gateway-{funnel,lan}.log`。未安装开机自启动，机器重启后需要重新启动网关。

华为网站登录不等于 `devecocli auth` 登录。签名时需开发者账号完成工具登录，并生成与包名及设备匹配的调试证书和 profile。签名工具可能改写 `harmony/build-profile.json5`，其中本机路径及签名配置不能提交；仅依靠 `.gitignore` 无法保护已跟踪的配置文件。没有创建 AppGallery 上架应用或发布到应用市场。

开发和构建命令见 [原生应用说明](../harmony/README.md)。本文件中的模拟器通过项不能替代真实手机验收。

## 状态栏配色修复

2026-10-16，用户反馈状态栏与页面背景存在色差。实际截图确认旧版状态栏为 `#FFFFFF`，正文为 `#F6F7F2`；启动背景另为 `#F6F8F2`。

采用 [华为官方沉浸式指南的背景扩展方案](https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-arkui-1089)：根组件使用 API 20 起支持的 `background(ResourceColor)` 将背景绘制到安全区，系统状态栏设为透明、文字图标使用深色 `INK`，关闭颜色变化动画。顶部提示条只向上扩展自身背景，出现和关闭时均与状态栏衔接。启动背景统一为 `#F6F7F2`，窗口加载及恢复前台时重新应用系统栏样式。

内容仍保留系统安全区。键盘实测发现默认 `OFFSET` 会整体上移页面，使标题与透明状态栏下的时钟重叠；已设置 `KeyboardAvoidMode.RESIZE`，改为调整可用布局高度。没有启用全屏内容布局，也没有隐藏系统状态栏。HarmonyOS SDK 26 的手机设备支持清单不包含 `setWindowBackgroundColor`，因此不使用该接口，最终签名构建无 API 兼容性警告。

`npm run check` 的 78 项测试、格式检查、TypeScript 与网页构建通过；默认 unsigned HAP 和真机 signed HAP 均重新编译。该轮 signed HAP SHA-256 为 `7df148d4048b517515d72cf79e76b3a2ace778fd5d889115ace2ac4fcfd6d0bc`，ZIP 与官方应用签名校验通过。见 [该轮构建验证](evidence/2026-10-16-harmonyos/statusbar/validation.json) 与 [该轮签名产物](evidence/2026-10-16-harmonyos/statusbar/signed-artifact.json)。

模拟器最终 7 项检查全部通过，覆盖本地错误提示、状态栏颜色衔接、关闭提示、键盘避让及冷启动。真机已覆盖安装最终 signed HAP：会话、新建和设置页顶部均为 `#F6F7F2`；键盘打开后顶部返回、输入框和发送按钮仍可见；收起键盘、切页和冷启动后配色保持一致，登录及「Mate 90 Pro Max」配对保留。本轮未创建会话或发送消息。详见 [真机配色与键盘复验报告](evidence/2026-10-16-harmonyos/statusbar/phone-statusbar-report.json)。

真机原始截图对比：[修复前](evidence/2026-10-16-harmonyos/statusbar/phone-before.png)、[最终修复后](evidence/2026-10-16-harmonyos/statusbar/phone-final.png)。像素采样中，状态栏 `(20,20)` 从 `(255,255,255)` 改为 `(246,247,242)`，与页面 `(20,200)` 一致。另有 [真机键盘打开时的顶部局部](evidence/2026-10-16-harmonyos/statusbar/phone-keyboard-after-top.png)，仅裁取原始像素前 400px，不包含个人输入法区域。模拟器 [键盘避让](evidence/2026-10-16-harmonyos/statusbar/emulator-fixed-keyboard.png)、[错误提示衔接](evidence/2026-10-16-harmonyos/statusbar/emulator-fixed-local-url-error.png) 和 [完整复验记录](evidence/2026-10-16-harmonyos/statusbar/emulator-statusbar-qa-report.json) 分别记录，不混作真机证据。

## 客户端身份与重复配对修复

2026-10-16，修复每次兑换配对码都新建一个“设备”的问题。HarmonyOS App 在独立、禁止同步的 Asset Store SECRET 中保存 32 字节安全随机安装身份；浏览器使用当前站点的 localStorage。两者均只在兑换有效一次性凭据或已有 Cookie 已通过认证后提交身份。服务端保存哈希并对白名单字段做公开投影，身份本身不能登录，也不通过名称或 IP 合并。

同一 App 安装在局域网和 Funnel 的授权归入一个客户端，Cookie 仍按入口隔离、独立过期；再次配对只轮换当前入口的授权。网页的不同浏览器及不同 origin 分别识别。退出和撤销会使客户端全部入口失效。旧记录可通过原 Cookie 原地迁移，跨入口旧授权在证明属于同一安装后合并；退出按当前 Cookie 在锁内定位，防止与归并同时发生时漏撤销。

两处生产网关已更新，继续使用原有共享 Codex socket。真实 HTTP/WS 验收确认：两个后端 connected、两入口配对得到同一 ID 和两项授权、两路 WS 连续通过两次心跳、Funnel 重配仅关闭旧 Funnel WS（4001）且 LAN 保持连接、退出后两路 WS 关闭且两路 Cookie 均返回 401。临时验收客户端已清理，没有发送任何 Codex 任务。见 [双网关验收报告](evidence/2026-10-16-harmonyos/device-identity/live-gateway-report.json)。

真机已覆盖安装最终 signed HAP，原“Mate 90 Pro Max”记录在不重新输入凭据的情况下迁移为 HarmonyOS App，原 ID 保留。随后强制停止/启动、再次覆盖安装和启动，身份及记录数量均保持不变，HTTPS/WSS 登录恢复；列表显示当前客户端、首次配对和最近使用。当前为 1 条已识别的 App 记录及 2 条旧版授权，旧授权没有足够证据自动归并，保持有效并可逐项撤销。见 [真机验收报告](evidence/2026-10-16-harmonyos/device-identity/phone-report.json) 与 [迁移后的设置页](evidence/2026-10-16-harmonyos/device-identity/phone-client-settings.png)。本轮没有新建会话或发送消息。

部署重启网关时，手机曾显示等待连接，重启 App 后恢复。本轮最终验证的是 App 重启和覆盖安装后的恢复；不以此宣称网关重启时的原有 WSS 自动恢复已稳定通过。

最终 114 项自动测试（含 25 项原生源码执行测试）、格式、TypeScript、网页生产构建及 signed/unsigned ArkTS 构建均通过。新增回归覆盖持久身份、多入口轮换、旧 Cookie 迁移、同名隔离、不泄露密钥、鉴权与 CSRF、并发配对、活跃时间节流及锁故障恢复。SDK 对安全随机接口提示并非所有设备都有相应系统能力，目标手机已实际成功生成并保存身份。见 [构建与测试结果](evidence/2026-10-16-harmonyos/device-identity/validation.json)。

当前 signed HAP SHA-256 为 `349230d41456631e81b5290b17207671887507fca0147d09718c8c271198cdee`，官方应用签名、profile 验证及 ZIP 完整性检查通过；原始未签名工程的 build-profile 未改变。见 [签名产物验证](evidence/2026-10-16-harmonyos/device-identity/signed-artifact.json)。
