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
