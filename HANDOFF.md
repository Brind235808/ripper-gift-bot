# HANDOFF — 交接文档（v2.0 FlareSolverr 迁移完成）

> 最后更新：2026-10-17。v2.0 已完成 Playwright → FlareSolverr 迁移。

---

## 1. v2.0 完成了什么

HANDOFF v1 第 5 节规划的 FlareSolverr 迁移已全部实现：

### 已完成的改动

1. **新增 `src/flaresolverr.js`**：FlareSolverr API 客户端
   - 自动检测 `localhost:8191` 是否运行
   - 自动从 `tools/FlareSolverr/` 启动（detached、无窗口）
   - 持久 session 管理（cookie 跨请求保持）
   - `fsGet` / `fsPost` 高层 API
   - 90s 客户端超时（防连接挂死）

2. **重构 `src/lib.js`**：移除所有 Playwright 依赖
   - `launchBrowser()` → 移除（FlareSolverr 管理浏览器）
   - `api(page, baseUrl, path)` → `api(baseUrl, path)`（通过 FlareSolverr session）
   - `whoami(page, baseUrl)` → `whoami(baseUrl)`
   - `waitCloudflare(page)` → 移除（FlareSolverr 自动处理 CF）
   - `resolveHiddenLink(ctx, url, candidates)` → `resolveHiddenLink(url, candidates)`（FlareSolverr 跟 302）
   - `scrapeBoothImages(ctx, url, max)` → `scrapeBoothImages(url, max)`（直接 HTTP，booth 无 CF）
   - `collectPreviewsForTopic(ctx, ...)` → `collectPreviewsForTopic(...)`
   - 新增 `initSession(cfg)` / `closeSession()`：自动登录 + session 管理
   - 新增 `autoLogin(baseUrl, username, password)`：NodeBB CSRF + POST /login
   - **所有纯函数保持不变**（htmlToText, extractLinks, extractPasswords, classifyLink 等）

3. **更新 `src/discover.js`**：
   - 移除 `launchBrowser` / `waitCloudflare` / `whoami` 的浏览器参数
   - 使用 `initSession(CONFIG)` 初始化
   - 不再需要 `--headed` 参数（全程无窗口）

4. **更新 `src/download-selected.js`**：
   - 同样使用 `initSession` / `closeSession`
   - 移除浏览器上下文参数

5. **更新 `src/fetch.js`**：
   - 移除 Playwright 相关代码
   - 移除 headless → headed 自动降级逻辑（不再需要）

6. **更新 `src/setup.js`**：
   - 改为验证 FlareSolverr + 自动登录
   - 不再需要手动浏览器登录交互

7. **更新 `config.example.json`**：
   - 新增 `flareSolverrUrl`（默认 `http://localhost:8191`）
   - 新增 `username` / `password`（自动登录凭据）
   - 移除 `headless`（不再需要）

8. **更新 `package.json`**：
   - 移除 `playwright-core` 依赖（零外部依赖）
   - 版本号升至 2.0.0

9. **`npm run selftest` 仍 20/20 绿**

### 架构变化

```
v1 (Playwright):
  Node.js → Playwright → 系统 Edge → 论坛
  问题：无头模式不过 CF、有头模式需要 off-screen 窗口、page.evaluate 可能卡死

v2 (FlareSolverr):
  Node.js → FlareSolverr API → FlareSolverr 内置浏览器 → 论坛
  优势：无窗口、CF 自动处理、服务端超时不会卡死、零 Node 依赖
```

### 登录方案（采用 HANDOFF v1 方案 A）

- FlareSolverr 持久 session 内自动登录
- 流程：GET /api/config → 提取 csrf_token → POST /login → session 保持 cookie
- 凭据来源：config.json 的 username/password 或环境变量 RIPPER_USERNAME/RIPPER_PASSWORD
- 每次 discover 启动时检查 /api/me，未登录则自动登录
- session 重启后需重新登录（FlareSolverr session 内存态），已做成常规自愈步骤

### 隐藏链接解析

- FlareSolverr `request.get` 跟随 302 重定向，`solution.url` 返回最终地址
- 密码门：检测 HTML 中的 `<input type=password>`，自动 POST 密码（最多尝试 4 个候选）
- workupload 清单：从返回 HTML 正则提取文件列表

### 已解决的 HANDOFF v1 坑

| 坑 | v1 状态 | v2 状态 |
|---|---|---|
| 无头模式 exit code 21 | workaround: off-screen 窗口 | **已解决**：无浏览器进程 |
| page.evaluate 卡死 | 未实现看门狗 | **已解决**：FlareSolverr 服务端超时 |
| PowerShell BOM | 已修复 | 保持 |
| blockHeavy 误伤预览图 | 已修复 | 保持（不再需要路由拦截） |
| hidelink token 失效 | 已存档 | 保持 |

---

## 2. 待验证/后续优化

### 需要实际站点验证的（首次运行时）

1. **FlareSolverr 302 跟随**：实测 `/hidelinks/r/<token>` 是否完整跟随跨域 302 到 workupload
   - 如果 `solution.url` 是最终外链 → 完美
   - 如果 `solution.url` 仍是论坛域名 → 需要用返回的 cookies + Node fetch 手动跟随

2. **自动登录稳定性**：NodeBB 登录表单字段名、CSRF 提取方式
   - `/api/config` 返回的 `csrf_token` 字段
   - POST /login 的表单字段：username, password, csrf_token, remember, returnTo

3. **FlareSolverr session 内存**：长时间运行后 session 是否稳定
   - 如果 session 偶尔丢失，initSession 会自动重新登录

### 可选优化

- [ ] FlareSolverr 进程健康检查：discover 中途如果 FlareSolverr 崩溃，自动重启
- [ ] 多 session 支持：不同论坛用不同 session
- [ ] 代理支持：FlareSolverr 的 `--proxy` 参数配置
- [ ] 并发解析：多个 hidelink 并行解析（当前串行）

---

## 3. 部署变更（v1 → v2）

### 新增步骤

```bash
# 下载 FlareSolverr（每台机器）
# Windows: 下载 FlareSolverr_win_x64.zip
# 解压到 tools/FlareSolverr/（自动启动）
# 或手动运行: tools/FlareSolverr/flaresolverr.exe

# 配置自动登录
# config.json 添加:
{
  "username": "你的用户名",
  "password": "你的密码"
}
# 或环境变量:
set RIPPER_USERNAME=xxx
set RIPPER_PASSWORD=xxx
```

### 移除步骤

- ~~`npm run setup` 手动浏览器登录~~ → 改为自动验证
- ~~headless/headed 模式选择~~ → 全程无窗口
- ~~Playwright/Edge 相关故障排查~~

### 不再需要

- `playwright-core` npm 依赖
- `state/browser-profile/` Edge 持久化 profile
- off-screen 窗口 workaround
- `run-hidden.vbs` 仍保留（用于计划任务静默启动 node）

---

## 4. 用户约束（不变）

- 流量计费网络：默认每帖 2 张预览图、单张 5MB、单文件 200MB、每日 500MB
- 全程无窗口后台运行
- 网盘类永远不自动下载
- 目录规范：`downloads/YY.MM.DD/两位序号/`
- selftest 20/20 必须保持
