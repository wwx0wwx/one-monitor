# E2E：主链路

`main-path.mjs` 在一个全新的 hub 上走完小白用户的主路径：公开页空状态 → 登录（错密码的中文报错、地址栏停留）→ 面板添加服务器 → 安装对话框按需读 token → **一个说真实 JSON-RPC 协议的假 agent**（`hello` + 完整契约的 `report`）上线 → 状态页出现该节点及其 CPU 数字 → 键盘排序（含分组筛选下跨隐藏行）→ 登出。

浏览器经一个自签证书的迷你 TLS 反代访问 `https://e2e.test:28443`（域名在浏览器内部映射到回环）——provisioning 闸门只认 https 域名，`Secure` cookie 也只在 https 下存活，这是与生产一致的形态，不碰 `/etc/hosts`。

```bash
cd hub
cargo build                      # 调试构建即可，面板与主题已内嵌
cd e2e
npm ci
npx playwright install chromium  # CI 里用 --with-deps
npm test
```

跑在 ci-e2e（`hub/**` 变更触发）。所有断言列出并逐项打勾，任何一项失败即退出非零；hub 进程、TLS 代理、临时目录在 finally 里清理。
