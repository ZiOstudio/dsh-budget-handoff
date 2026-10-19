# 变更日志

本文件记录 `dsh-budget-handoff` 的每个发布版本。版本号遵循语义化版本；对应 npm 上的同名包与 GitHub 上的 `vX.Y.Z` tag。

## 0.2.2 — 2026-10-19

两处修正，行为不变（`dist/` 重新构建过）。

- **修正价格表路径指引**：拦停通知与 README 原本让人「把价格补进 `src/pricing.json`」，但发到 npm 的包里只有 `dist/`，装市场版的人根本找不到 `src/`。改为指向 `dist/pricing.json`，并说明改 `src/pricing.json` 需重新构建才生效（`src/index.ts`、`README.md`）。
- **写快照失败不再连累拦停**：`writeHandoffOut` 里两次落盘（工作目录 / `$DSH_HOME`）各自包 try。此前工作目录不可写时异常会从 `agent/pre-step` 逃出去，导致 `return { kind: 'reject' }` 执行不到 —— **预算超了却放行**，闸门 fail-open。现在写失败只降级通知文案（说明哪一处失败、原因是什么），拦停照旧。

## 0.2.1 — 2026-10-11

发布与配套整备，插件行为不变（`dist/` 与 0.2.0 一致）。

- **修复重复发布**：`.github/workflows/publish.yml` 的 Publish 步骤改为幂等 —— 先查 npm 上该版本是否已存在，已存在则跳过。之前 v0.2.0 之后的每次 tag 推送都会以 `E403 You cannot publish over the previously published versions` 失败，看起来像 token 坏了，实际只是重发同一版本。
- **补声明 peer**：`peerDependencies` 现在显式列出 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-tools` / `schemastery` / `cordis`，全部标为 `optional`（这些包由 DSH 宿主提供）。预发布版本用显式区间 `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`，避免 semver 对预发布号的静默不匹配。
- **新增 CI**：`.github/workflows/ci.yml` 在 push / PR 上跑零安装自检（跑 `dist/*.test.js`、`node --check` 全部 dist 文件、校验 `package.json` 的 `dsh.bundle.patch` 与 `files[]`）。
- **新增本文件**，补上 0.2.0 / 0.1.1 / 0.1.0 的历史记录。
- README 补 npm 安装方式（预构建，免 `allowBuilds` 批准）。

## 0.2.0 — 2026-10-08

- 交接单（handoff snapshot）语义化：快照包含任务痕迹、未发通知与最近事件，落到工作目录的 `BUDGET-STOPPED-handoff-snapshot.md` 与 `$DSH_HOME/storages/dsh-budget-handoff/last-stop.md`。
- 新增 `/budget` 口令：`/budget` 查看、`/budget 5` 设 5 元、`/budget 20` 设 20 元；默认 10 元。
- 新增 80% 预警（`agent/pre-step` + `agent/turn-stopping` 兜底）。
- 账户余额耗尽时走同一套收尾（`agent/request-error`）。
- `package.json` 补 `engines` 并把发布文件收窄到 `files[]`。

## 0.1.1 — 2026-10-08

- 静音模板噪音。
- 快照的 `recentEvents` 填充真实事件。

## 0.1.0 — 2026-10-08

- 首个版本：会话预算闸门 + 交接快照。
