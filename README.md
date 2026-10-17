# ripper-gift-bot

> **v2.0 — FlareSolverr 架构**：已移除 Playwright/Edge 浏览器依赖，改用 [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) 处理 Cloudflare 挑战。全程无窗口、无浏览器进程管理。

自动化发现 `forum.ripper.store` 礼物区新资源。

## 工作流（三阶段）

```
① discover（每天 12:30 自动，或手动）
   ↓ 礼物区翻页 → 隐藏链接解析 → 预览图（帖内优先 / booth 补）
② gallery（手动）
   ↓ 双击 state/gallery-YYYYMMDD.html，勾选想收的，保存 choices.json
③ pick（手动）
   ↓ 按 YY.MM.DD/01/ 目录结构整理，含资源文件 + 预览图 + 说明
```

### 1. Discover

```bash
npm run discover                 # 当天新帖（回看 3 页）
npm run discover -- --only 141874    # 单帖调试
npm run discover -- --all            # 强制刷新全部已知帖
npm run discover -- --no-resolve     # 跳过隐藏链接解析
```

产物：`state/gallery-YYYYMMDD.json`、`previews/*.jpg`

### 2. Gallery（HTML 画廊）

```bash
npm run gallery
```

双击 `state/gallery-YYYYMMDD.html`，勾选后保存 `choices-YYYY-MM-DD.json`。

### 3. Pick（整理目录 + 下载）

```bash
npm run pick                              # 自动读最新 choices
npm run pick -- --choices state/choices-2026-10-15.json
npm run pick -- --dry-run                 # 只整理目录不下载
```

输出目录：

```
downloads/
  26.10.15/
    01/
      preview-01.jpg
      Material_Leisure.zip
      README.md
      _pending-manual.txt
    02/
```

## 前置条件

| 条件 | 说明 |
|---|---|
| Windows 10/11（或 macOS/Linux） | FlareSolverr 支持多平台 |
| Node.js ≥ 20 LTS | |
| FlareSolverr v3 | 解压到 `tools/FlareSolverr/` 或手动运行 |
| 论坛账号 | 配置在 config.json 或环境变量 |

### 安装步骤

```bash
# 1. 克隆
git clone https://github.com/Brind235808/ripper-gift-bot.git
cd ripper-gift-bot

# 2. 安装 Node 依赖（现在无外部依赖）
npm install

# 3. 下载 FlareSolverr
#    Windows: 下载 FlareSolverr_win_x64.zip
#    解压到 tools/FlareSolverr/ 目录
#    下载地址: https://github.com/FlareSolverr/FlareSolverr/releases

# 4. 配置
copy config.example.json config.json
# 编辑 config.json：填入 giftCategoryId=44、username、password

# 5. 验证
npm run selftest          # 20/20 绿
npm run setup             # 测试 FlareSolverr + 自动登录

# 6.（可选）配置每日 12:30 自动 discover
schtasks /Create /TN "RipperGiftBot Daily" /TR "wscript.exe run-hidden.vbs" /SC DAILY /ST 12:30 /RL LIMITED /F
```

### 配置项（`config.json`）

```json
{
  "baseUrl": "https://forum.ripper.store",
  "giftCategoryId": 44,
  "lookbackPages": 3,
  "previewsPerTopic": 2,
  "maxFileMB": 200,
  "dailyBudgetMB": 500,
  "maxHidelinksPerTopic": 12,
  "onlyWithLinks": true,
  "flareSolverrUrl": "http://localhost:8191",
  "username": "你的用户名",
  "password": "你的密码"
}
```

也可用环境变量 `RIPPER_USERNAME` / `RIPPER_PASSWORD` 代替 config.json 中的账号密码。

## 架构（v2.0 FlareSolverr）

```
Node.js 进程
  │
  ├─ FlareSolverr client (src/flaresolverr.js)
  │    ├─ 自动检测/启动 FlareSolverr
  │    ├─ 管理持久 session（cookie 跨请求保持）
  │    └─ GET/POST 请求通过 FlareSolverr API
  │
  ├─ lib.js — 核心逻辑
  │    ├─ 自动登录（NodeBB /login + CSRF）
  │    ├─ NodeBB JSON API 访问
  │    ├─ 隐藏链接解析（302 跟随 + 密码门）
  │    ├─ booth.pm 画廊抓取（直接 HTTP，无 CF）
  │    └─ 纯函数：链接提取、密码识别、分类
  │
  ├─ discover.js — 每日发现
  ├─ download-selected.js — 按选择下载
  ├─ fetch.js — 旧版归档流程
  ├─ generate-gallery.js — HTML 画廊生成
  └─ selftest.js — 离线纯函数测试
```

FlareSolverr 负责：
- Cloudflare 托管验证挑战
- 浏览器环境模拟（JS 执行、cookie 管理）
- 302 重定向跟随

Node.js 负责：
- 业务逻辑（链接提取、密码识别、文件整理）
- 直接 HTTP 请求（booth.pm 无 CF、预览图下载、文件下载）

## 限流设计

| 环节 | 上限 | 可改 |
|---|---|---|
| discover 每帖隐藏链接解析 | 12 个 | `config.maxHidelinksPerTopic` |
| discover 每帖预览图 | 2 张，单张 5MB | `config.previewsPerTopic` |
| 单文件下载 | 200MB | `config.maxFileMB` |
| 每日直链流量 | 500MB | `config.dailyBudgetMB` |

## 目录结构

```
ripper-gift-bot/
├── package.json
├── config.example.json
├── config.json              ← 本地配置（不提交）
├── src/
│   ├── flaresolverr.js      ← FlareSolverr API 客户端
│   ├── lib.js               ← 核心逻辑 + 纯函数
│   ├── discover.js          ← 每日发现
│   ├── fetch.js             ← 旧版归档
│   ├── generate-gallery.js  ← HTML 画廊
│   ├── download-selected.js ← 按选择下载
│   ├── setup.js             ← 初始化验证
│   └── selftest.js          ← 离线测试
├── tools/
│   └── FlareSolverr/        ← FlareSolverr 二进制（不提交）
├── state/                   ← 运行时状态（不提交）
├── archive/                 ← fetch.js 产物
├── previews/                ← 预览图
├── downloads/               ← pick 产物
└── logs/
```

## 故障排查

| 现象 | 诊断 |
|---|---|
| "FlareSolverr 未运行且未找到二进制文件" | 下载 FlareSolverr 解压到 `tools/FlareSolverr/`，或手动启动 |
| "登录态失效且未配置自动登录" | 在 config.json 添加 username/password，或设环境变量 |
| "Cloudflare 挑战未通过" | FlareSolverr 日志 `logs/flaresolverr.log` 查看详情 |
| 隐藏链接解析失败 | token 可能过期，重新跑 discover |
| workupload 清单 0 个文件 | 被人机验证挡，真实 URL 已存档，手动打开 |

## 安全

- **绝不提交** `config.json`（含账号密码）、`state/`、`tools/`
- `.gitignore` 已屏蔽所有敏感目录
- 环境变量优先于 config.json 中的密码（避免明文写入文件）
