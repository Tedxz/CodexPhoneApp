# 开发说明

## 从干净工作区开始

网关和网页使用 Node.js 22.13 或更新版本；`.nvmrc` 选择 Node 22，CI 使用同一版本文件。已安装 nvm 时可以运行 `nvm install`、`nvm use`。HarmonyOS 构建独立使用 DevEco Studio 自带的 Node、SDK 和 JDK，见 [原生工程说明](harmony/README.md)。

```sh
npm ci
test -f config.local.json || cp config.example.json config.local.json
npm run check
```

首次配置使用 `config.example.json`，本机已有配置时上面的命令会保留它。Funnel 部署可参考 `config.funnel.example.json`，把示例域名替换为实际域名；不要把模板直接覆盖到已部署的配置上。SSH 目标填写在 `sshTargets`，完整示例见 [多 Server 配置](docs/MULTI-SERVER.md)。路径相对于运行命令时的工作目录解析，日常从仓库根目录运行。

## 常用命令

| 命令                     | 用途                                      |
| ------------------------ | ----------------------------------------- |
| `npm run dev`            | 运行网关，读取本地配置                    |
| `npm run web:dev`        | 启动网页开发服务器                        |
| `npm run build`          | TypeScript 检查并构建网页                 |
| `npm run format:check`   | 检查格式                                  |
| `npm test`               | 运行隔离的自动测试，无需真实 Codex 或手机 |
| `npm run check`          | 格式、自动测试和网页构建                  |
| `npm run harmony:doctor` | 检查本机 DevEco 环境                      |
| `npm run harmony:build`  | 编译 unsigned HAP                         |

网页单独运行时，把其 origin 加入本机配置的 `allowedOrigins`，并使用该 origin 配对，详见 [README](README.md#开发与验证)。共享接口或行为变更需同时检查网页和原生客户端；TypeScript 与 ArkTS 协议分别位于 `shared/protocol.ts` 和 `harmony/entry/src/main/ets/model/Protocol.ets`。

`npm run doctor` 会连接本机配置中的真实 Codex 后端进行只读探测。`npm run test:live -- --run` 会创建隔离测试会话并发送真实任务，只在明确需要端到端验收时手动执行；CI 不执行这两类检查，也不启动 Codex、访问用户会话或进行手机配对。

## 应提交和应保留在本机的文件

- 提交源码、工程配置、无凭据的示例、`package-lock.json` 和必要文档。`npm ci` 依赖锁文件；修改 npm 依赖时同步更新它。
- 当前 Harmony 工程没有第三方包，因此未生成 `oh-package-lock.json5`。以后由 ohpm 生成时，确认不包含本机敏感信息后提交；不要手写锁文件。它不被 Git 忽略，只排除自动格式化。
- `.gitignore` 排除依赖、缓存、构建产物、日志、测试报告、本机配置、网关认证数据、签名材料及 HAP 等安装包。额外网关配置采用 `config.<name>.local.json`，额外数据目录采用 `.codex-phone-<name>/`；两者都已忽略。
- 真机签名保持在被忽略的本地副本或私有目录中，仓库的 `harmony/build-profile.json5` 保持无签名。原生源码与资源更新到签名副本时保留其私有签名配置。
- `docs/evidence/` 仅保留审查后的验收证据；原始调试日志、配对链接、Cookie、其他会话正文放在忽略目录 `tmp/`。`docs/evidence/` 中的归档证据不自动格式化。

## 持续集成

[Checks](.github/workflows/ci.yml) 在主分支推送、PR 和手动触发时，分别在 Linux 与 macOS 上执行 `npm ci` 和 `npm run check`。Linux 安装本地 SFTP 子系统以运行传输夹具；它不需要 SSH 服务器登录。原生逻辑测试使用系统接口替身，不要求 Harmony SDK；真实 ArkTS 编译、签名和真机操作仍在安装了 DevEco 的环境中验证。

工作流使用 GitHub 官方 [checkout](https://github.com/actions/checkout) 和 [setup-node](https://github.com/actions/setup-node)。当前仓库未配置远程地址时，新增工作流只是文件配置，不代表已在 GitHub 执行。
