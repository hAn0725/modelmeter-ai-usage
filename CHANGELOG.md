# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### � BYOK Provider Templates

- **Z.ai GLM Coding Plan** — New templates for Z.ai Global (`api.z.ai`) and Z.ai CN (`open.bigmodel.cn`), each in single-key and multi-key variants. 5 GLM models (GLM-5.2, 5.1, 5, 5-Turbo, 4.7) via OpenAI-compatible API
- **Kimi Coding Plan** — New templates for Kimi/Moonshot in single-key and multi-key variants. 5 models (Kimi K3, K2.7 Code, K2.7 Code Highspeed, K2.6, K2.5) via `api.kimi.com/coding/v1`
- **Baidu Token Plan (CN)** — New templates for Baidu Qianfan Token Plan 个人版 in single-key and multi-key variants. 6 models (ERNIE 5.1, GLM-5.2, GLM-5.1, DeepSeek-V4-Pro, DeepSeek-V4-Flash, Kimi-K2.6) via `qianfan.baidubce.com`

### 📊 Vendor Resolution & Dashboards

- **New vendor heuristics** — `kimi`/`moonshot` → `moonshot` and `ernie` → `baidu` in the vendor resolver for correct attribution of unprefixed model names
- **Dashboard vendor colors** — Added `moonshot` (teal) and `baidu` (red) to the color palette across the overview, vendor, and model dashboards
- **ERNIE 5.1 pricing & energy** — Added Baidu's ERNIE 5.1 to `pricing.json` (v1.4.0) and the energy estimate table

### 📚 Directory & Documentation

- **Baidu Token Plan directory entries** — Replaced the outdated "Baidu Cloud Lite/Pro" entries with all four Token Plan tiers (Mini/Lite/Pro/Max)
- **README template links** — Added Z.ai (Global/CN), Kimi, and Baidu rows to the BYOK templates table in `README.md` and the file listing in `byok-templates/README.md`
- **Updated provider count** — Extension README now reflects 13+ pre-configured providers

### �📣 Marketplace Metadata

- **Rebranded `displayName`/`description`** to lead with the extension's real differentiators — BYOK usage tracking, key management, and session history/analysis — matching the branding already used in `EXTENSION_README.md` and the repo README (`Copilot & BYOK Usage Tracker`). Extension `name`/id is unchanged.
- **Expanded `keywords`** with feature-intent terms (usage tracking, session history, session analysis, credits, dashboard, key management, etc.) and provider names (DeepSeek, Mistral, OpenRouter, Qwen, Kimi, GLM/Z.ai, MiniMax, MiMo, and more) so the extension surfaces for provider-specific searches like "deepseek byok" or "kimi usage tracking".
- **Added `Visualization` category** alongside `AI`/`Other` to reflect the chart-based dashboards.

## [0.4.0] — 2026-09-24

### 📊 状态栏（体验升级）

- **信息更全** — 一行显示：模型厂商 · 本轮对话 Tokens（本地统计）· Token 输出速度 · 等效 API 成本 · 官方余额；套餐账号无余额时回退显示额度进度条，任一段无数据时自动省略
- **切换模型立即更新** — 去掉原先的 20 秒缓存；新轮次一写入本地库即刻重解析当前模型/厂商（本地索引查询，零网络请求）
- **刷新永不丢失** — 修复“个别情况下状态栏停留在旧模型”的问题：刷新改为每次独立执行（移除单飞门闩，此前一次本地查询挂起会永久静默更新），单次查询 5 秒超时、失败写入日志；每 30 秒与每次窗口聚焦都会自动兜底重查
- **响应更快** — 模型识别不再等待回复完成：只要请求发出（新轮次写入），数秒内状态栏即跟随切换；本地查询并行化，锁竞争场景下延迟减半
- **更快出现** — 首次解析提前到激活后约 50ms 开始，并带短暂重试覆盖首次导入窗口
- **点击即达** — 点击状态栏打开左侧边栏“账户与套餐”；即使侧边栏从未打开过也能一次唤起
- **重绘周期 30 秒** — 仅重绘文本/悬停（相对时间），不发起任何请求
- **悬停新增“当前会话”块** — 轮数、输入/输出 Tokens、输出速度、等效 API 成本与口径说明

### 🔄 账户刷新策略

- 当前使用账户：10 → **5 分钟** TTL；其他已连接账户：30 → **15 分钟**

### 🧭 侧边栏布局

- “打开用量总览”由底部按钮行移到**顶部主按钮**（底部保留 重新统计 / 帮助）

### 🔒 安全加固

- 全部 Webview（侧边栏 + 4 个面板）统一 **Content Security Policy**：内联脚本携带一次性 nonce，其余资源一律禁止（`default-src 'none'`）
- 调整 Webview 初始化顺序（先注入内容再启用脚本），消除 VS Code “created a webview without a content security policy” 开发警告

### 🧪 质量

- 测试 182 → **187**（状态栏完整格式、会话段边界、tooltip 会话块、顶部按钮位置；Webview 语法门禁同步覆盖 CSP meta）

## [0.3.0] — 2026-09-23

### 🎯 官方账户额度（融合进既有侧边栏与状态栏）

- **DeepSeek** — 官方余额 API（`api.deepseek.com/user/balance`），API Key（Bearer）鉴权，展示余额与赠金/充值拆分
- **GLM / Z.ai** — Coding Plan 额度（5h / 周 / MCP 月窗口），API Key 鉴权；支持 Global（api.z.ai）与中国大陆（open.bigmodel.cn）双区域；国内站支持**预付余额**（无需额外凭据）：套餐账号余额与额度并存展示，按量账号自动回退为余额
- **Qwen / 百炼** — Token Plan 滚动 5h + 周额度，控制台 Cookie；支持中国大陆（百炼）与国际（Qwen Cloud）双区域；可选绑定**阿里云 AccessKey**（仅需只读权限）直接显示阿里云账户余额（百炼消耗的即是它），零依赖实现 POP 签名，AK 仅存 SecretStorage
- **MiMo / 小米** — 账户余额 + Token Plan 套餐/月窗口，控制台 Cookie
- **连接方式** — 浏览器登录自动获取 Cookie（零依赖 CDP，使用本机 Edge/Chrome 临时配置目录）或手动粘贴；API Key 为标准密码输入框
- **安全** — 所有密钥 / Cookie 仅存 VS Code SecretStorage；不写入设置、数据库、日志与导出文件；错误文本自动脱敏
- **状态栏** — 只显示“当前使用模型”所属账户：按量显示余额（`$(flame) DeepSeek ¥38.62`），套餐显示 6 格剩余进度条（`$(flame) GLM [████░░] 68%`）；悬停查看当前账户详情、其他账户一览与本地等效 API 成本
- **侧边栏** — 新增“账户与套餐”区块（融入既有 modelMeter.main 视图）：连接状态、模式标签（按量 / Coding Plan / Token Plan / 套餐）；展开后查看 10 格额度进度条、重置时间、本地 Token 与等效 API 成本
- **刷新策略** — 惰性触发 + TTL（当前账户 10 分钟 / 其他 30 分钟）、单飞去重（UI 重绘不触发请求）；失败保留上次快照；401 冻结至重连；429 冷却 15 分钟
- **口径说明** — 官方数据仅用于余额/额度；本地数据用于 Token / 会话 / 等效 API 成本；Token Plan 的“等效 API 成本”不代表实际扣款
- **按量账号与错误展示** — 未订阅套餐的账号（如 GLM / 千问按量计费）不会误报“刷新失败”，而显示中性的“按量计费 · 无套餐额度 / 未检测到套餐订阅”；官方接口错误原因（脱敏后）会显示在侧边栏详情与状态栏悬停提示中
- **新增命令** — “管理账户连接（官方额度）”、“打开账户与套餐”

## [0.2.0] — 2026-09-23

首个 ModelMeter 独立发布候选版本。

### 主要功能

- VS Code AI Chat 多模型 Token 用量统计
- DeepSeek / Qwen / GLM / MiMo 等模型统计
- 中国大陆官方 API 标准按量原价估算
- DeepSeek 北京时间峰谷 / 周末 / 法定节假日计价
- Overview / Vendor / Model / Session Analytics
- 会话级与单轮输入上下文构成
- Tool Calls / Files / 首次响应耗时 / 总耗时
- emptyWindowChatSessions 支持
- 本地 SQLite 统计
- ModelMeter Sidebar

### 限制说明

- VS Code 内部未写入 chatSessions 的 Utility Model 调用无法保证统计
- 无可靠缓存 Token 数据时按缓存未命中价估算
- 费用不考虑 TokenPlan / Coding Plan / 免费额度 / 优惠 / 第三方渠道

### 隐私

- 本地处理
- 不读取 API Key
- 不上传聊天内容
- 不上传统计数据

ModelMeter 基于 [feimacode/copilot-alternatives](https://github.com/feimacode/copilot-alternatives) 修改，为独立社区分支。

## [0.1.6] — 2026-07-20

### ✨ Copilot Credit Tracking

- **Monthly Credit Quota** — New tile on the overview and vendor dashboards showing your resolved Copilot plan, monthly allowance, and consumption percentage bar
- **AI credits (cr)** — Copilot usage now displays in AI credits instead of dollar estimates, matching how Copilot plans are actually billed
- **GitHub entitlement resolution** — `Sign in with GitHub to Detect Copilot Plan` command resolves your plan via GitHub auth + Copilot SKU endpoint; result is cached for 24 hours
- **Entitlement listener** — The extension now watches for GitHub authentication changes and re-resolves entitlement automatically when a new session appears
- **Clickable sign-in link** — When entitlement is unknown, the dashboard quota cards show a clickable "Sign in with GitHub" link instead of a plain-text message
- **Scope-friendly auth** — Interactive sign-in cascades through all scope candidates silently first, only prompting when no cached session matches
- **Status bar credits breakdown** — Hover tooltip shows rolling 24h / 7 day / 30 day credits alongside token usage

### 📊 Token Usage Dashboards

- **Chart.js-powered dashboards** — Overview, vendor, and model dashboards with stacked bar charts, donut charts, and cost/credit trend lines
- **Date range toggle** — Quick-switch between 7 Days, 30 Days, and a custom Since… date picker
- **Today's stats cards** — Token count, credits/cost, vendor count, and days tracked at a glance
- **Vendor filter** — Interactive vendor checkboxes on the overview dashboard to filter the breakdown view
- **My Yearly Budget** — Configurable yearly budget target with projected spend bar
- **Model+VM combo chart** — Combined vendor+model bar chart showing per-model token distribution

### 📝 Session History & Analytics

- **Session Stats in sidebar** — Recent sessions listed with turn count, vendor, model, and cost/credits
- **Session detail dashboard** — Full turn-by-turn view with input/output tokens, latency, TTFT, tool call counts, and prompt category breakdown
- **Session filters** — Filter by vendor, model name, or date range; clear filter command
- **Copy Session ID** — Quick-copy a session's unique identifier
- **Mixed credit/cost display** — Sessions list root node shows combined `cr + $` labels when both Copilot and other vendors are present

### 🔑 BYOK Provider Management

- **9+ provider templates** — DeepSeek, Mistral, OpenRouter, Alibaba Coding Plan, Alibaba Token Plan, Feima Code, BytePlus, ClinePass, OpenCode Go
- **Single & multi-key support** — Group multiple API keys into one provider entry
- **Webview editors** — Create and edit providers and models through form-based UI, not raw JSON
- **Inline sidebar actions** — Add, edit, delete providers and models directly from the tree view
- **`Open chatLanguageModels.json`** — Jump to the raw config file for manual edits
- **Auto-refresh** — Sidebar updates instantly when providers are added, edited, or removed externally

### 📚 Help System

- **Five comprehensive help pages** — Getting Started, Token Usage, BYOK Management, Session Analytics, Cost Estimates
- **Screenshot-driven guidance** — All help pages reference annotated screenshots from the running extension
- **In-product help commands** — Help menu in the sidebar opens the docs directly

### 🔧 Core & Performance

- **Migrate to `@vscode/sqlite3`** — Replaced `better-sqlite3` with the official VS Code SQLite binding for compatibility with the extension host runtime
- **Real-time chat session watcher** — Single `ChatSessionStoreWatcher` replaces old Copilot log + session watchers; debounced and efficient
- **WSL support** — File watching works correctly under WSL with polling fallback and debounce logic
- **Cross-platform packaging** — Separate `package:linux`, `package:win`, `package:mac-arm` npm scripts for platform-specific VSIX builds
- **Build robustness** — Automatic Electron version detection, `.node` binary validation, `tar` path fixes for Windows

### 🐛 Bug Fixes

- **Scope search order** — GitHub session lookup now tries `user:email`+`read:user` first to match the Copilot Chat session scope
- **Status bar refresh** — Tooltip and text now update consistently when new session data arrives
- **Dashboard SQL alignment** — All-time summary query matches rolling-window date cutoff logic
- **Webview command dispatch** — Added `runCommand` message handler to support dashboard-based command execution

## [0.1.5] — 2026-06-XX

### Added
- Token usage dashboard (overview, vendor, model views)
- Status bar indicator with today's tokens and cost
- SQLite-backed metrics database with quick and background import
- Chat session store file watcher for real-time tracking
- Vendor usage flags (copilot-only vs mixed)

### Changed
- Streamlined to single `ChatSessionStoreWatcher` — removed old Copilot log and session watchers
- Updated `@vscode/sqlite3` as the database driver
- Platform-specific packaging scripts (`package:linux`, `package:win`, `package:mac-arm`)

### Fixed
- `.node` binary inclusion in VSIX packaging
- Cross-platform file path handling in session data extraction

## [0.1.4] — 2026-06-XX

### Fixed
- GitHub authentication initialization for Copilot entitlement (first-turn error)

## [0.1.3] — 2026-06-XX

### Changed
- Dependency updates for packaging compatibility

## [0.1.2] — 2026-06-XX

### Fixed
- Build and packaging configuration

## [0.1.1] — 2026-06-XX

### Added
- BYOK provider templates (DeepSeek, Mistral, OpenRouter, Alibaba, BytePlus, ClinePass, OpenCode Go)
- Key management commands (`Add Provider`, `List Providers`, `Remove Provider`)
- Webview-based provider and model editors
- Alibaba Coding Plan and Token Plan templates
- Package as VS Code extension

## [0.1.0] — 2026-05-XX

### Added
- Initial release as VS Code extension
- Browse 100+ coding plans, IDEs, CLI agents, extensions, and BYOK tools
- Full marketplace listing with icon, badges, and keywords
- Rich webview rendering of README.md tables with search and dark-theme styling
- GitHub Actions: automated release (tag-triggered + manual) and marketplace publish (manual with confirmation)
