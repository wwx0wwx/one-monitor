# one-monitor

极简探针监控面板。hub、agent、主题同仓发布，各自独立构建，互不共享代码。

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```

| 目录 | 组件 | 说明 |
|---|---|---|
| [`hub/`](hub/) | monitor-hub | Rust + axum + SQLite。后台、API、公开页宿主，默认主题 vendor 内嵌 |
| [`agent/`](agent/) | monitor-agent | Rust 单文件静态链接，直读 /proc 上报 hub |
| [`themes/default/`](themes/default/) | 默认主题 | React + Vite，黑白配色；后续主题 a/b/c 各占 `themes/<short>/`，均为完整独立包 |
| [`themes/komari-likely/`](themes/komari-likely/) | komari 风格主题 | 默认主题的完整独立副本改造：三色用量条、国旗与系统图标、即将到期/区域折叠分组、剩余价值（实时汇率）、访客 IP 胶囊等，详见其 README |

## 部署

三步起一整套（详见 [hub/README.md](hub/README.md) 的「全新部署」，含反向代理与常见坑）：

```bash
# 1. hub：装在一台 VPS 上（只监听 127.0.0.1:28080，按安装器输出的说明配反代）
curl -fsSL https://raw.githubusercontent.com/wwx0wwx/one-monitor/main/hub/install-hub.sh -o install-hub.sh
sudo sh install-hub.sh
journalctl -u monitor-hub --no-pager | grep Password   # 首启一次性密码

# 2. 节点：面板「服务器」→ 添加，复制生成的命令到目标 VPS 执行
curl -fsSL https://hub.example.com/install.sh | sh -s -- --server https://hub.example.com --token <TOKEN>

# 3. 主题：后台「主题」上传 release 里的 theme.tar.gz 并启用（也可命令行，见 hub/README）
```

升级同样一条命令：`sudo sh install-hub.sh --version vX.Y.Z --yes`（没写的参数沿用上一次的）。

## tag 纪律

一个仓库的 release 列表混着三个组件，全靠 tag 前缀路由，谁也不许占别人的道：

| tag 形如 | 发布 | CI workflow |
|---|---|---|
| `vX.Y.Z` | hub（双架构二进制 + sha256sums + 容器镜像） | `release-hub` |
| `pio` / `voy` / `cas` / `new` | agent（版本代号按深空探测器发射序递增） | `release-agent` |
| `theme-<short>-<版本>` | `themes/<short>/` 对应主题（theme.tar.gz + sha256） | `release-theme` |

因此 `releases/latest` 不再属于任何组件，所有下载都走定向 tag：

- `install-hub.sh` 默认装 `VERSION` 常量指名的 tag（发版同 PR 内更新它），`--version` 可指定或传 `latest`
- hub 中转 agent 二进制走 `AGENT_TAG` 常量（agent 发新代号时同 PR bump）
- hub 的主题更新按钮列 releases、按 `theme-<short>-` 前缀过滤取最新；tag 尾部与 theme.json 的 `version` 对齐（`theme-default-v1.2.3` ↔ `1.2.3`）

## 发版节奏

- **hub**：`hub/` 有实质变更时发 `vX.Y.Z`。切 tag 的同一个提交里：bump `hub/Cargo.toml` 版本、bump `hub/install-hub.sh` 的 `VERSION`；若默认主题发了新版，还要挪 `hub/web-theme.pin`（tag + sha256）并刷新 `hub/vendor/theme/`
- **agent**：`agent/` 有实质变更时发下一个代号（pio → voy → cas → new），hub 侧同 PR bump `AGENT_TAG`
- **主题**：`themes/<short>/` 有实质变更时发 `theme-<short>-v<版本>`，版本号与 theme.json 对齐；hub 通过 vendor pin 内嵌，升级 hub 即更新内置主题
- 顺序约束：主题先发（hub 的 pin 指向它的 release 资产 sha），再发 hub

CI 按 paths 过滤：`hub/**` 变更只跑 hub 的检查，`agent/**`、`themes/**` 同理；tag 触发的 release workflow 不受 paths 影响。
