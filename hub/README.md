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

## 全新部署（新 VPS）

目标拓扑：一台 VPS 跑 hub，一个 https 域名指向它，若干节点机跑 agent。
hub 只监听 `127.0.0.1:28080`，公网访问全部经过反向代理——这是设计如此，凭证不在链路上裸奔。
下面每条命令都可以原样复制执行（把 `hub.example.com` 换成你的域名）。

### 1. 安装 hub

在一台 systemd 发行版的 Linux VPS 上（x86_64 / aarch64，需要 root）：

```bash
curl -fsSL https://raw.githubusercontent.com/wwx0wwx/one-monitor/main/hub/install-hub.sh -o install-hub.sh
sudo sh install-hub.sh
```

有终端时给交互菜单，回车即默认值（端口 28080）；`curl | sh` 无终端时按默认安装。
脚本从 GitHub release 下载二进制并校验 sha256，装成 systemd 服务 `monitor-hub`，
数据全部落在 `/opt/monitor/data/`（SQLite 数据库 + 已安装主题目录）。

### 2. 取一次性密码，配反向代理

首启的管理员密码只显示一次，在安装完成的输出里；错过了这样取：

```bash
journalctl -u monitor-hub --no-pager | grep Password
```

然后按[「反向代理」](#反向代理)一节把域名指到 `127.0.0.1:28080`。
配好后**用 https 域名**打开 `https://hub.example.com/admin` 登录，到「安全」里改掉密码并绑定两步验证。

### 3. 添加节点（agent）

后台「服务器」→ 添加，面板生成该节点的安装命令，整条复制到目标 VPS 上执行：

```bash
curl -fsSL https://hub.example.com/install.sh | sh -s -- --server https://hub.example.com --token <TOKEN>
```

批量装机用注册窗（一小时内有效，最多 100 台）：后台点开注册窗拿到 KEY，每台机器：

```bash
curl -fsSL https://hub.example.com/install.sh | sh -s -- --server https://hub.example.com --register <KEY>
```

agent 装在节点的 `/opt/monitor/monitor-agent`，token 写在 0600 的 `/opt/monitor/agent.env`，
同样由 systemd 管理（服务名 `monitor-agent`）。日志：`journalctl -u monitor-agent -f`。

### 4. 上传并激活主题

后台「主题」→ 上传主题包 → 点击启用。主题包从对应 tag 的 release 下载，例如 komari-likely：

```text
https://github.com/wwx0wwx/one-monitor/releases/download/theme-komari-likely-v1.2.4/theme.tar.gz
```

也可以纯命令行（CI / AI 助手场景），四条依次执行：

```bash
curl -s -c cj -H 'content-type: application/json' \
  -d '{"password":"<管理员密码>"}' https://hub.example.com/api/auth/login
curl -fSL -o theme.tar.gz \
  https://github.com/wwx0wwx/one-monitor/releases/download/theme-komari-likely-v1.2.4/theme.tar.gz
size=$(stat -c%s theme.tar.gz)
curl -s -b cj -X POST --data-binary @theme.tar.gz \
  "https://hub.example.com/api/themes?offset=0&total=$size"
curl -s -b cj -X PUT -H 'content-type: application/json' \
  -d '{"theme":"komari-likely"}' https://hub.example.com/api/settings
```

单片上传上限 8 MiB，theme.tar.gz 远小于此；更大的文件按 `offset` 递增分片。
主题的显示设置（背景图、19 个显示键）在后台「主题」栏或状态页右上角「主题设置」里调，
每个键的含义与默认值见主题自己的 README（如 [komari-likely](../themes/komari-likely/README.md)）。

### 容器方式（可选）

```bash
docker run -d --name monitor -p 28080:28080 -v monitor-data:/data \
  ghcr.io/wwx0wwx/one-monitor:1.5.3
```

数据在卷 `monitor-data` 的 `/data`（数据库 + 主题目录）；一次性密码看 `docker logs monitor`。
镜像与同版本二进制来自同一次 release 构建。容器监听所有地址，请只映射到本机或防火墙后面，仍走反向代理。

## 升级

重跑安装器即升级；没写的参数（端口、`--site`）沿用上一次的，校验不过不替换二进制，新版本起不来会自动回滚：

```bash
sudo sh install-hub.sh --version v1.5.3 --yes     # 平时省略 --version，装脚本内置的最新 hub tag
```

主题升级：后台「主题」页对该主题点检查更新（走 GitHub releases），或重新上传新包；都不需要重启 hub。

## 卸载与数据

```bash
sudo sh install-hub.sh --uninstall   # 卸服务，保留 /opt/monitor/data 下的数据库
sudo sh install-hub.sh --purge       # 连数据库一起删，不可撤销
```

日常备份：后台「数据」页下载备份（导入也是这里），或直接拷 `/opt/monitor/data/monitor.db`（hub 在线时建议用前者）。

## 反向代理

hub 只监听 `127.0.0.1:28080`，把它接到你的 https 域名上任选一种（`hub.example.com` 换成你的域名）：

**caddy**（自动签证书，Caddyfile）：

```text
hub.example.com {
    reverse_proxy 127.0.0.1:28080
}
```

**nginx**（/etc/nginx/sites-available/hub.example.com，证书自备）：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name hub.example.com;
    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:28080;
        proxy_http_version 1.1;
        # 导入备份与上传主题是分片传的，单片 4 MiB；这个数不随数据库增长。
        client_max_body_size 8m;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # /api/agent/ws 与 /api/ws 是长连接。
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

**cloudflare 隧道**（不用开任何入站端口，config.yml）：

```yaml
ingress:
  - hostname: hub.example.com
    service: http://127.0.0.1:28080
  - service: http_status:404
```

四点注意：

1. **Host 与 `X-Forwarded-Proto: https` 必须透传**（nginx 用上面的 `proxy_set_header`，Apache 用 `ProxyPreserveHost On`）。少一样，面板添加/安装节点就会 403，报错会提示「请通过 HTTPS 域名访问面板」。
2. **`client_max_body_size` 至少 8m**：备份导入和主题上传按 4 MiB 分片传输，请求体上限不够会传一半失败。
3. **WebSocket 升级头要放行**（上面的 `Upgrade`/`Connection` 两行）：实时推送和 agent 上报都是长连接。
4. **反代或 WAF 按路径正向白名单时**，除 `/` 与 `/api/` 外还要放行 `/install.sh`、`/agent/{arch}`（节点安装）和 `/node/{id}`（状态页详情页直链刷新）。Cloudflare 代理（橙云）场景可在后台「设置」打开 `cf_connecting_ip`，节点国家识别才不会被边缘地址冲掉。

## 常见坑

- **添加节点被 403 拒绝**：正常部署不需要 `--site`——配好反代、用 https 域名进面板就自动对了。仍被拒按序检查：浏览器地址是不是 https 域名（IP 直连不行）→ 反代是否透传 Host 与 `X-Forwarded-Proto` → hub 启动参数 `--site` 是否被误设（必须是 `https://域名`，不能是 IP、不能带路径，配错时启动日志有警告）。
- **端口**：默认 28080，且只听本机回环。换端口用 `--port`，升级不会冲掉。
- **主题图片必须 https**：背景图与 Logo 的链接必须以 `https://` 开头（http 图在 https 页面会被浏览器拦掉，保存时 hub 也会拒绝）。
- **一次性密码**只在数据库首次创建时显示一次，改密入口在后台「安全」。
- **延迟探测的默认任务**：首启自动建了三条——浙江移动/联通/电信 v4（TCP 443、60 秒间隔），后台「延迟」里可改目标、调间隔或删除；「设置」里的「新添加的服务器自动加入全部延迟检测任务」默认关。

## 命令行参数

`install-hub.sh` 覆盖了绝大多数场景；直接跑二进制时（`monitor-hub --help`）：

```text
--listen [::]:28080   监听地址；安装器固定为 127.0.0.1:28080
--db monitor.db       数据库路径；主题目录默认取它旁边的 themes/
--themes <dir>        主题目录
--site https://…      面板对外的公网地址，仅反代后地址与浏览器地址不一致时需要（如 SSH 隧道进面板）
```
