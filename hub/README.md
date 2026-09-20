# monitor

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook

## 组成

三个组件同仓发布在 [one-monitor](https://github.com/wwx0wwx/one-monitor)：

| 目录 | 说明 |
|---|---|
| `hub/`（本目录） | hub：后台、API、公开页宿主 |
| [`agent/`](../agent) | Linux agent（版本代号制，pio → voy → cas → new） |
| [`themes/default/`](../themes/default) | 内置默认主题 |

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```

发版与 tag 纪律见[仓库根 README](../README.md)。
