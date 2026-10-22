# 变更日志

本文件记录 `dsh-budget-handoff` 的每个发布版本。版本号遵循语义化版本；对应 npm 上的同名包与 GitHub 上的 `vX.Y.Z` tag。

## 0.4.0 — 2026-10-22

两件事：**账不再随重启蒸发**，**缓存命中的 Token 不再按原价算**。

- **新增 `src/persist.ts`**：把每个会话的累计消费、四个 Token 桶、折算后 Token、未计价调用次数、
  以及用户设的金额/Token 上限写到 `$DSH_HOME/storages/dsh-budget-handoff/sessions.json`。
  启动时回填，**插件卸载时把每个记过账的会话再补写一次**（不受节流限制）；记账后 2 秒节流批量落盘；
  原子写（temp + rename），写失败只告警不崩。
  保留最近 30 天、最多 50 个会话（`pruneSessions` 纯函数，可单测；**每次落盘都裁**，不只在启动时）。
- **缓存读取按 0.1 权重折算**（`ledger.ts` 的 `CACHE_READ_WEIGHT`）：命中价是未命中价的 1/50，
  按原样计数会让长对话把 Token 额度迅速顶满。`SessionUsage` 新增 `effectiveTokens`，
  `restore()` 会重算而不信盘上的旧值。**原始 Token 照旧累计、照旧展示**，只是闸门看折算值。
- **回执/通知/快照同时报两个数**：`/budget` 与 80% 预警、拦停通知、交接快照都写成
  「折算后 X（原始 Y，缓存读取按 0.1 计）」，避免用户对账时以为插件少算了。
- **`renderReceipt` 增加第 6 个可选参 `effectiveTokens`**，与原始值不等时才追加折算说明。
- 新增 `src/persist.test.ts`；`snapshot.test.ts` 补折算双数渲染断言（35 → 38 条）。
- README：新增「重启之后 —— 账不会清零」一节；「已知限制」第 4 条从「重启即归零」改为
  「按会话隔离、重启恢复、只留 30 天 / 50 个会话」。

## 0.3.0 — 2026-10-22

> 此版本**未单独发布**：它和 0.4.0 改在同一批文件里，随 `v0.4.0` 一起发出（npm 与 GitHub tag
> 中间没有 `0.3.0`）。装 0.2.2 的人升级到 0.4.0 会同时拿到下面这一节和上面那一节。

**修一个会让预算保护整段失效的洞**：会话切到价目表没收录的 provider/model 后，金额不再累计，
闸门既不预警也不拦停，而用户以为自己有保护。现在改由 Token 兜底。

- **新增 Token 口径**：`src/gate.ts` 是新的纯函数模块，`judge(state, limits)` 同时看金额与 Token，
  返回「哪个口径在管 / 比例 / 超没超」。80% 预警与拦停都问它，两者不会再分叉。
- **Token 闸门按证据点火**：只有本会话真的出现过「算不出价」的调用（`unpricedCalls > 0`）才启用。
  全程有价的会话行为完全不变 —— 不会因为这条规则被提前掐断。
- **新增 `/budget tokens <数量>`**：每会话 Token 上限，默认 500 万（`config.tokenBudget`）。
  低于 1000 拒绝（一次调用就超了，等于坏掉）。裸 `/budget tokens` 等同查询。
- **`/budget` 回执改为两行**：金额一行、Token 一行；拦停与快照只报**真正卡住的那个口径**，
  另一个作背景 —— 报错口径的后果是用户照做一遍还是被拦。
- **失效通知改写**：原来「预算保护已失效」的说法不再准确，改为说明「金额停止累计、Token 照记、
  当前 Token 上限与已用量、怎么调」。
- **快照新增三行**：触发口径、累计 Token、未计价调用次数；「怎么接着干」按口径给对应指令。
- 新增 `src/gate.test.ts`（28 条）；`command.test.ts` 补 token 子命令与回执断言；
  `snapshot.test.ts` 补 Token 口径渲染断言。

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
