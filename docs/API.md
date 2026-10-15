# 网关接口 v1

网页与 HarmonyOS 原生客户端使用同一网关。接口类型以 [`shared/protocol.ts`](../shared/protocol.ts) 为准；客户端不直接连接 Codex control socket，也不接收电脑端 Codex 登录凭据。

## 身份与 HTTP

入口须与 `publicUrl` 或 `allowedOrigins` 匹配。所有非 GET/HEAD 请求带 `Origin`、`X-Codex-Phone: 1`；JSON 请求带 `Content-Type: application/json`。配对成功后网关写入 30 天有效的 `codex_phone` HttpOnly、SameSite=Strict cookie；HTTPS 入口还设 Secure。客户端保留 cookie，并使用相同来源访问 HTTP/WS。原生客户端需使用 cookie jar 并携带配置入口的 Origin。

一次性配对凭据由电脑 CLI 生成，二维码 URL 将它放在 `#pair=...` 中。浏览器提取后通过 POST 兑换，不把凭据放入 HTTP 查询参数。服务端限流配对尝试。客户端撤销/退出后，其所有入口的登录与实时连接都失效。

客户端安装身份使用 32 字节安全随机数的无填充 base64url 值（43 字符），与会话 Cookie 分开保存。`clientKey` 与 `clientType`（`harmony` 或 `browser`）必须同时提供或同时省略；省略时兼容旧客户端，但每次配对仍是独立旧版授权。原生身份保存在禁止同步的 Asset Store 中，浏览器身份保存在当前站点 localStorage 中。浏览器不同 origin、不同浏览器和原生 App 分别识别；名称和 IP 不用于判定是否同一客户端。清除存储或卸载可能产生新身份。

同一身份再次兑换一次性凭据会复用客户端 ID，并仅轮换该 Origin 的授权，其他入口保持有效。已有有效 Cookie 可调用 identify 原地认领未绑定的旧记录；若同一身份已有另一入口记录，则合并并返回最终客户端 ID，当前 Cookie 保持有效。已绑定的 Cookie 不能改绑到另一个身份（409）。仅有 clientKey 不能登录，也不能绕过配对码或 Cookie 验证；服务端只保存其哈希，不在公开响应中返回身份或凭据哈希。旧记录无法仅凭同名恢复安装身份，需原客户端访问后迁移或手动撤销。

`Device` 增加可选 `clientType`、`lastSeenAt`（毫秒时间戳）和 `authorizationCount`（当前有效授权数量）。最近使用由已认证请求、WS 命令与心跳更新，每个授权最多每分钟落盘一次，不代表实时在线；旧记录没有数据时显示未知。`expiresAt` 为客户端仍有效授权中的最晚到期时间，各 Cookie 仍独立过期。

| 方法与路径                                          | 请求 / 响应                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v1/health`                                | 无需配对；`{ ok: true }`，仅代表网关可响应                                                 |
| `POST /api/v1/pair`                                 | `{ token, name?, clientKey?, clientType? }` → `{ device }` + cookie；凭据 5 分钟、一次有效 |
| `GET /api/v1/bootstrap`                             | `Bootstrap`：设备、允许项目、后端连接、能力                                                |
| `GET /api/v1/threads?cursor=...&search=...&cwd=...` | `{ data: ThreadSummary[], nextCursor }`                                                    |
| `GET /api/v1/workspaces`                            | `{ data: WorkspaceSummary[] }`，全部会话分页按工作路径聚合                                 |
| `GET /api/v1/threads/:id?cursor=...`                | `ThreadSnapshot`：会话、消息、历史游标、待处理请求、设置、`eventCursor: { epoch, seq }`    |
| `GET /api/v1/models`                                | `{ data: ModelOption[] }`                                                                  |
| `POST /api/v1/devices/current/identify`             | `{ clientKey, clientType }` → `{ device }`；要求现有有效 Cookie，不轮换 Cookie             |
| `GET /api/v1/devices`                               | `{ data: Device[] }`，标记当前客户端                                                       |
| `DELETE /api/v1/devices/:id`                        | `{ ok: true }`，撤销客户端的全部入口授权                                                   |
| `POST /api/v1/logout`                               | `{ ok: true }`，撤销当前客户端全部入口并清理当前 cookie                                    |
| `POST /api/v1/uploads`                              | 原始图片字节，Content-Type 为实际图片 MIME → `201 { id, url }`                             |
| `GET /api/v1/uploads/:id`                           | 返回网关管理的图片，需要设备登录                                                           |

会话列表中的 `cwd` 为可选的完整工作路径精确筛选，可与标题搜索 `search` 和分页游标一起使用。省略表示全部路径，`cwd=` 表示没有记录路径的会话；切换筛选条件时从首页重新查询，不复用旧游标。`workspaces` 返回 `{ cwd, threadCount, activeCount, updatedAt }`，时间为毫秒时间戳，按最近更新时间倒序排列；汇总所有未归档、符合当前会话来源筛选的历史分页，同一会话去重计数。该接口需要配对，并且不限制在配置的新建项目列表中。

图片支持 PNG、JPEG、WebP，单张上限 10 MiB；服务端核对文件签名与 MIME。每次发送最多 8 张。API 不接受任意本地文件路径；上传返回的 ID 用于后续发送。未被消息引用的过期上传在网关启动时清理，已引用图片保留。

错误响应为 `{ error: { code, message } }`。常见状态码：`400` 无效输入、`401` 未配对或凭据失效、`403` 来源不允许、`409` 身份冲突、`413` 内容过大、`429` 限流、`503` 后端不可用。后端离线时页面仍可显示连接状态。

## WebSocket

地址 `/api/v1/ws`，使用相同 cookie 与 Origin；HTTPS 入口使用 `wss://`。每帧一个 JSON 对象。

命令：

```json
{
  "id": "客户端生成的唯一请求ID",
  "method": "turn.send",
  "params": { "threadId": "会话ID", "text": "继续完成测试", "imageIds": [], "mode": "default" }
}
```

回复为 `{ id, result }` 或 `{ id, error: { code, message } }`。

| method             | params                                                                   | 成功结果                                             |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `thread.subscribe` | `{ threadId }`                                                           | `ThreadSnapshot`，连接并同步会话                     |
| `thread.create`    | `{ projectId, model?, effort?, mode? }`                                  | `ThreadSnapshot`                                     |
| `turn.send`        | `{ threadId, text, imageIds?, expectedTurnId?, model?, effort?, mode? }` | 新轮次 `{ turnId, status }`；运行中追加 `{ turnId }` |
| `turn.interrupt`   | `{ threadId, turnId }`                                                   | Codex 停止结果                                       |
| `request.respond`  | `{ requestId, decision? , answers? }`                                    | 审批/交互结果                                        |

`mode` 为 `default` 或 `plan`。审批 decision 为 `accept`、`decline` 或 `cancel`；交互 answers 为 `{ [questionId]: string[] }`。客户端按 `PendingRequest.kind` 和允许选项绘制控件，不提交无法识别的审批。

运行中发送用 `expectedTurnId` 绑定当前轮次，通过后端追加指令；空闲时启动新轮次。发送结果仅返回网关规范化后的轮次标识与可选状态，不透传完整 Codex 轮次对象。两个并发发送不能悄悄覆盖。过期、已由其他端处理的审批应重新同步。

事件帧：

```json
{
  "type": "event",
  "epoch": "网关运行实例ID",
  "seq": 42,
  "event": { "type": "resync", "threadId": "会话ID" }
}
```

事件包含连接变化、会话变化、消息更新/增量、待审批/审批完成与 resync，具体字段见共享类型。`epoch` 随网关重启改变，`seq` 在当前实例中递增。会话快照附带 `eventCursor`，用于与正在接收的事件对齐。事件是实时通知，不是持久事件日志；客户端重连、发现序号缺口或收到 resync 时，重新获取会话快照与待处理请求。

## 恢复与兼容

每个操作使用随机唯一 ID。网关在当前进程内按设备和请求 ID 缓存一小时的操作结果；相同 ID 但不同参数会拒绝。这不提供跨网关重启的持久去重保证。发送后掉线且未收到确认时，客户端先核对历史，不自动重发生成操作。

手机断线不会停止电脑任务。WebSocket 重连后需重新订阅当前会话并同步快照。草稿由客户端保存；已发送消息以服务器历史和当前轮次为准。

`ConnectionState.connected` 只表示网关与后端连接状态；`sharedBackend: true` 表示使用既有 socket 的架构，不代表所有电脑客户端已经过共享控制验收。能力或版本不支持时，应保留明确限制。部署后的真实能力依照 [验收清单](ACCEPTANCE.md) 记录。
