# monitor-theme-komari-likely

[one-monitor](https://github.com/wwx0wwx/one-monitor) 的 komari 风格主题：由默认主题复制改造而来，同一套 React + Vite + shadcn/ui 骨架，借 komari 面板的观感，不搬它的臃肿。

## 这一版长什么样

- **汇总区**五张分离小卡：当前时间（秒级）、在线数、最忙服务器（CPU · 内存 · 磁盘占用与上下行合计网速两行，名称垫底）、今日/累计流量、实时网速走势
- **服务器卡片**：国旗（Twemoji）+ 系统品牌图标（simple-icons 内联单色）+ 名称；标签预留两行不截断；CPU / 内存 / 硬盘 / SWAP / 流量 五条三色用量条（<60% 绿、60–80% 橙、≥80% 红）；网速 ↓↑ 两行对齐；左下在线时长加粗，右下到期时间（≤7 天橙、已过期红）+ 续费价格；离线排到列表末尾
- **分组**：全部 / 即将到期（7 天窗口自动进出，计数警示色，含已过期）/ 手动分组 / 区域折叠选择器（国家码自动归集、带国旗、列表可滚动，多国 VPS 不撑爆筛选行）；选中写入 URL `?group=`，可刷新可分享
- **详情页**：Facts 按固定顺序（系统/架构/CPU/GPU/RAM/SWAP/硬盘/今日流量/总流量/价格/剩余价值/到期时间）；剩余价值 = 价格 × 剩余天数 ÷ 周期天数，按当日公开牌价折算人民币（jsdelivr currency-api 主源、ExchangeRate-API 备源，24h 缓存，悬停显示汇率日期与牌价；取不到汇率显示原币金额，不编造）；资源图表卡片化两列；延迟页六彩探测线、每条带 `平均延迟 | 丢包率` 标签（全超时显示 N/A）、平滑（5 桶滑动平均）与连接断点两个开关、1h/4h/1d/7d 时间档（7 天即 hub 匿名窗口上限，ping 默认保留也是 7 天）
- **周边**：进站时底部胶囊短暂展示访客 IP（ip.sb，ipinfo.io 备源，失败静默不显示）；卡片可 Tab+Enter 打开、Esc 返回；深浅色跟随系统并可切换，`theme-color` meta 同步

## 主题设置（hub ≥ v1.5.3）

状态页右上角的「主题设置」按钮（仅登录可见）与后台「主题」栏的背景图卡片，写的都是 hub
的服务端设置（`/api/me` 的 `theme` 对象匿名下发，全站访客同一份）。hub 未设置时按下表默认值渲染。

19 个显示键（`PUT /api/settings` 可写，值均为字符串）：

**背景图**

| 键 | 含义 | 取值 | 默认 |
|---|---|---|---|
| `bg_enabled` | 启用背景图 | on / off | off |
| `bg_desktop` | 桌面版图链 | https:// 开头，≤500 字符；可用「`亮|暗`」两段区分明暗 | 空 |
| `bg_mobile` | 移动版图链 | 同上；缺省回落桌面图 | 空 |
| `bg_opacity` | 背景不透明度 | 0–100 | 100 |
| `bg_blur` | 背景模糊 | 0–20（px） | 0 |
| `bg_fit` | 铺满方式 | cover（裁切铺满）/ contain（完整显示） | cover |
| `bg_position` | 裁切对齐 | center / top / bottom / left / right | center |
| `card_opacity` | 卡片浓度（磨砂玻璃不透明度） | 0–100 | 70 |
| `card_blur` | 卡片模糊 | 0–64（px） | 64 |

**布局**

| 键 | 含义 | 取值 | 默认 |
|---|---|---|---|
| `content_width` | 内容区最大宽度 | 1000–2560（px） | 1400 |
| `logo_url` | 标题栏 Logo 图链 | https:// 开头，≤500 字符；空则只显示站名 | 空 |

**显示 / 功能开关**

| 键 | 含义 | 默认 |
|---|---|---|
| `cost_public` | 汇总区每日成本卡对访客公开（关=仅登录可见） | off |
| `show_busiest` | 汇总区「最忙服务器」卡 | on |
| `show_swap` | 卡片 SWAP 用量条 | on |
| `show_speed` | 卡片实时网速 | on |
| `show_billing` | 卡片到期时间与续费价格 | on |
| `ip_capsule` | 进站时底部访客 IP 胶囊 | on |
| `expiring_group` | 「即将到期」筛选分组（7 天窗口自动进出） | on |
| `region_group` | 国家/区域折叠筛选器 | on |

开关类键取值均为 on / off。图链一律要求 https：主题页本身是 https，http 图片会被浏览器按
混合内容拦掉。hub 低于 v1.4.0 时这些键不存在，页面按默认值渲染、面板保存会被 hub 拒绝并提示。

## 相对默认主题的结构差异

新增 `src/components/Flag.tsx`、`OsIcon.tsx`、`RegionPicker.tsx`、`IpCapsule.tsx`、`ThemeSettings.tsx` 与 `src/lib/fx.ts`（汇率 hook）、`src/lib/display.ts`（主题设置解析）；其余改造集中在 `App` / `NodeCard` / `NodeDetail` / `Summary` / `Meter`。`country` 字段为 ISO 3166-1 alpha-2，国旗由此映射。

## 开发

启动一个 hub 实例：

```bash
monitor-hub --listen 127.0.0.1:9911 --db /tmp/monitor.db --site http://127.0.0.1:9911
```

启动开发服务器，Vite 将 `/api` 与 WebSocket 代理至 hub：

```bash
npm ci
npm run dev
```

构建产物位于 `dist/`。提交前运行 `npm run build && npm run lint && npm test`。

`npm test` 校验数字格式化和实时指标的输入边界。没有测试框架，Node 自己剥掉
类型，失败时退出码非零。

## 主题包

一个可安装主题是一个目录，名字必须与 `theme.json` 的 `short` 相同：

```text
<themes-dir>/<short>/
├── theme.json
├── preview.png        # 可选，面板上的预览图
└── dist/
    └── index.html
```

`theme.json` 的字段均为字符串：

| 字段 | 含义 |
|---|---|
| `name` | 显示名称 |
| `short` | 唯一短名，限字母、数字、`-`、`_`，取 `default` 则顶替 hub 内置的那份 |
| `description` | 简介 |
| `version` | 主题版本 |
| `author` | 作者 |
| `url` | 源码地址 |

每个 tag 的 release 里的 `theme.tar.gz` 解开就是这个目录——hub 构建时嵌入的是同一个包。

将目录复制到 hub 的 `--themes` 位置，在后台「主题」页切换，无需重启。

## 主题契约

主题是纯静态 SPA，只能依赖下列同源接口：

| 接口 | 用途 |
|---|---|
| `GET /api/me` | 站点名、登录状态、公开页开关 |
| `GET /api/nodes` | 节点列表、实时指标和累计流量 |
| `GET /api/nodes/{id}/metrics` | 历史指标和延迟记录 |
| `GET /api/ws` | 每 2 秒推送一次节点快照的 WebSocket |

`metrics` 的三个查询参数都可省：

- `hours=N` 窗口宽度。**匿名上限 168，登录后 2160**，超出静默 clamp——降采样限的是响应行数，这个
  上限限的是 hub 扫描多少行
- `points=W` 调用方画得下的点数，只会让 hub 抽得更稀，不会更密
- `series=metrics|ping` 只取要画的那一半，省掉的那半原本占响应的三分之一到三分之二

探测曲线的名字在响应的 `probes` 里随样本一起下发，匿名可读，所以画延迟图不需要第二个请求，也不
需要管理员身份。

整个窗口的丢包率在响应的 `loss` 里，按探测 id 给出百分比，没丢包的探测不出现。**不要拿样本行里
的 `loss` 自己平均**：那一个是所在桶的百分比，除数已经丢了，而各桶样本数天然不等——窗口首尾两桶
本来就是残缺的，探测启停、节点掉线、agent 跳过一轮都会再造几个。十三次里丢一次，平均桶百分比会
算出 50%。

匿名访问 `GET /api/nodes` 仅返回 `public=1` 的节点，响应中不含 `ip`、`hostname`、`remark`。字段定义以 hub 的 `src/api.rs` 为准。

未知路径回落到主题的 `dist/index.html`，客户端路由可用。`/admin/*` 由 hub 内置后台接管，不属于主题契约。

本主题用 `/node/{id}` 作为详情页。hub 的回落对它够用，但**hub 前面若有按路径做正向白名单的反代
或 WAF，得把这个前缀放行**：从列表点进去只是 pushState，边缘看不见，刷新详情页才会真的请求
`/node/{id}`，症状是「点进去正常，一刷新就被拦」。

## 许可

MIT
