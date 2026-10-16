# 贡献指南

欢迎提交问题、文档改进和 Pull Request。请在 Issue 中说明复现步骤、预期与实际行为，并附上脱敏后的版本和错误信息。涉及协议或客户端交互的较大变更，建议先讨论兼容范围。

## 开发环境

网关与网页需要 Node.js 22.13 或更新版本；`.nvmrc` 选择 Node 22，CI 使用同一版本文件。已安装 nvm 时运行 `nvm install`、`nvm use`。HarmonyOS 构建独立使用 DevEco Studio 的 Node、SDK 和 JDK，见[原生工程说明](harmony/README.md)。

在项目根目录执行：

```sh
npm ci
test -f config.local.json || cp config.example.json config.local.json
npm run check
```

配置复制命令会保留已有文件。路径相对于运行命令的工作目录解析；日常从仓库根目录运行。网关直接使用开发依赖中的 `tsx`，部署时也需要安装开发依赖。

## 常用命令

| 命令                     | 用途                                    |
| ------------------------ | --------------------------------------- |
| `npm run dev`            | 运行开发网关，读取本地配置              |
| `npm run web:dev`        | 启动网页开发服务器                      |
| `npm run build`          | TypeScript 检查与网页生产构建           |
| `npm run format`         | 使用 Prettier 格式化受支持文件          |
| `npm run format:check`   | 检查格式                                |
| `npm test`               | 运行隔离自动测试，无需真实 Codex 或手机 |
| `npm run check`          | 依次检查格式、自动测试与网页构建        |
| `npm run harmony:doctor` | 检查本机 DevEco 环境                    |
| `npm run harmony:build`  | 编译未签名 HAP                          |

网页开发需要同时运行网关和 Vite。把 `http://127.0.0.1:5173` 加入本机配置的 `allowedOrigins`，重启网关，然后运行 `npm run pair -- --url http://127.0.0.1:5173`。

## 模块与验证

项目模块见 [README](README.md#架构与模块)。网关与网页共用 `shared/protocol.ts`，原生协议位于 `harmony/entry/src/main/ets/model/Protocol.ets`。接口变更需同步两种类型与 [API 文档](docs/API.md)，验证两种客户端的行为及旧接口兼容性。

按变更选择必要验证：文档应检查链接和命令；行为变更应补充能捕获回归的测试；原生源码和资源变更需执行真实 ArkTS 构建，界面变更还需在模拟器或设备上检查。`npm run check` 中的原生逻辑测试使用系统 API 替身，不能替代 SDK 编译与真机验证。

`npm run doctor` 连接配置中的真实后端进行只读探测。`npm run test:live -- --run` 会创建隔离会话并发送真实任务，只在需要端到端验收时手动执行。CI 不执行这两类检查，也不启动 Codex、访问用户会话或进行手机配对。完整方法见[验收清单](docs/ACCEPTANCE.md)。

## 提交约定

- 提交源码、工程配置、无凭据的示例、必要文档及依赖锁文件；修改 npm 依赖时同步 `package-lock.json`。
- 当前 Harmony 工程没有第三方包。以后由 ohpm 生成锁文件时，检查不含本机敏感信息后提交，不手写锁文件。
- 本机网关配置使用 `config.local.json` 或 `config.<name>.local.json`，数据目录使用 `.codex-phone/` 或 `.codex-phone-<name>/`；这些文件与目录均已忽略。
- 原始验收报告和截图放在被忽略的 `docs/evidence/` 或 `tmp/`。公开文档使用脱敏示例，不提交真实会话、设备标识、配对链接、Cookie 或私人部署信息。
- 真机签名在本地副本或私有目录完成；仓库内 `harmony/build-profile.json5` 保持无签名配置。忽略规则不能保护已经跟踪的文件，提交前仍应检查差异。

提交前运行 `npm run check` 并检查 `git diff --check` 与 `git diff --cached`。PR 描述说明问题、改动后的行为、验证结果和未覆盖范围；避免把特定机器上的验收结果写成所有环境的兼容承诺。

## 持续集成

[Checks](.github/workflows/ci.yml) 在主分支推送、PR 和手动触发时，分别在 Linux 与 macOS 上执行 `npm ci` 和 `npm run check`。Linux 安装本地 SFTP 子系统用于传输测试，无需 SSH 服务器登录。真实 ArkTS 编译、签名和手机操作在安装 DevEco 的环境中单独验证。

CI 是否通过以对应提交的 GitHub Actions 结果为准。本地检查通过不代表远程工作流已经执行。

## 许可与安全

贡献的原创代码和文档使用仓库的 [MIT License](LICENSE)。引入第三方资源时，记录来源与适用许可，更新[第三方声明](THIRD_PARTY_NOTICES.md)；不能将第三方品牌资源自动归入项目的 MIT 授权。

安全问题与敏感材料处理见 [SECURITY.md](SECURITY.md)。
