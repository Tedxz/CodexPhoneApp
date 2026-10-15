# 2026-10-15 开发批次验收证据

这些文件是隔离测试与只读连通性检查产生的报告和截图的原样副本，已逐文件核对 SHA-256 一致。内容包括测试会话、汇总计数与公开 DNS 记录，不包含配对凭据、登录 cookie 或其他会话正文。

最终回归延续至当地时间 2026-10-16（Asia/Shanghai），目录保留本开发批次的起始日期。

| 文件 | 覆盖范围 | 原始位置 |
| --- | --- | --- |
| [smoke.json](smoke.json) | 10 月 16 日 LAN 服务启动后的配对、列表、模型、认证校验与撤销复测 | `tmp/browser-acceptance/smoke.json` |
| [mobile-report.json](mobile-report.json) | 本机 Chromium 移动视口的真实 LAN 网页检查 | `tmp/browser-acceptance/1792078412200/report.json` |
| [conversation-mobile.png](conversation-mobile.png) | 同次文字/图片测试对话截图 | `tmp/browser-acceptance/1792078412200/conversation-mobile.png` |
| [tui-cross-report.json](tui-cross-report.json) | 连接共享 socket 的交互式 CLI 接续 | `tmp/browser-acceptance/tui-cross-report.json` |
| [approval-report.json](approval-report.json) | 独立测试会话的真实文件变更审批 | `tmp/approval-acceptance/2026-10-15T15-41-43-828Z-0ddf52/report.json` |
| [live-report.json](live-report.json) | 最终真实双连接：持久化、流式历史、同轮次追加与停止 | `tmp/live-acceptance/report-2026-10-15T15-56-13-602Z-db3b49.json` |
| [controls-report.json](controls-report.json) | 10 月 16 日最终网页控制、网关重启恢复与缓存命令终态检查 | `tmp/browser-acceptance/controls-1792080394503/report.json` |
| [stopped-mobile.png](stopped-mobile.png) | 同次停止后的移动视口截图，命令卡与任务状态均为 interrupted | `tmp/browser-acceptance/controls-1792080394503/stopped-mobile.png` |
| [settings-report.json](settings-report.json) | 显式模型、推理强度与 Plan 模式创建 | `tmp/settings-acceptance/report.json` |
| [funnel-authoritative-dns.json](funnel-authoritative-dns.json) | 10 月 16 日经 SOCKS TCP 直询 4 个权威 DNS 的公网 A/AAAA 回答 | `tmp/funnel-authoritative-dns.json` |

各文件通过的范围及尚未完成的真机/Funnel 项目见 [验收记录](../../ACCEPTANCE.md)；这些证据不代表完整第一阶段验收。
