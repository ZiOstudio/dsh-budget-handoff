import z from '@deepseek-ai/schemastery';
import { COMMAND_PREFIX, findBudgetCommand, renderReceipt } from './command.js';
import { judge } from './gate.js';
import { emptyTrace, harvest } from './harvest.js';
import { CACHE_READ_WEIGHT, Ledger } from './ledger.js';
import { loadState, pruneSessions, saveState } from './persist.js';
import { calculateCost, isPeakHour } from './pricing.js';
import { buildSnapshot, writeSnapshot, writeSnapshotToDshHome, MAX_RECENT_EVENTS } from './snapshot.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const Config = z.object({
    budgetCNY: z.number().min(0.0001).default(10.0),
    tokenBudget: z.number().min(1000).default(5_000_000),
    verbose: z.boolean().default(false),
});
// Plugin display name, shown in loader diagnostics.
export const name = 'dsh-budget-handoff';
// ── Recent-event ring buffer for the hand-off snapshot ───────────────────────
// 上限常量由 snapshot.ts 导出、在此导入：环缓冲与渲染器必须认同同一个界，
// 各写一份 10 只会在某次改动后静默分叉。
/**
 * 把一条会话事件压成一行短摘要；不关心的事件返回 null。
 *
 * 字段名全部实测查证（不靠猜）：
 * - `@deepseek-ai/dsh-session\lib\types\types.d.ts:255-388`：`step/end{turn,step}`、
 *   `tool/call{turn,step,callId,name,arguments}`、`tool/result{turn,step,message,error?}`
 *   （**没有** name/isError 顶层字段）、`assistant/message{…,usage?:TokenUsage}`、
 *   `turn/start{turn}`、`turn/end{turn,reason}`。
 * - `@deepseek-ai/dsh-llm\lib\types\message.d.ts:153-160`：`ToolResultMessage` 上才有
 *   `toolCallId` 与 `isError?`（工具名不在结果消息里，故用 callId 关联）。
 * - `@deepseek-ai/dsh-llm\lib\types\types.d.ts:160-174`：`TokenUsage.totalTokens?` 可选。
 */
function summarizeEvent(event) {
    switch (event.type) {
        case 'step/end':
            return `step/end turn=${event.data.turn} step=${event.data.step}`;
        case 'tool/call':
            return `tool/call name=${event.data.name}`;
        case 'tool/result':
            return `tool/result callId=${event.data.message.toolCallId} isError=${event.data.message.isError ?? false}`;
        case 'assistant/message':
            return `assistant/message total=${event.data.usage?.totalTokens ?? '?'} tokens`;
        case 'turn/start':
            return `turn/start turn=${event.data.turn}`;
        case 'turn/end':
            return `turn/end reason=${event.data.reason?.kind ?? '?'}`;
        default:
            return null;
    }
}
/** 预警阈值：累计消费达到本会话预算的这个比例时，提示一次（只提示，不拦截）。 */
const WARN_AT_FRACTION = 0.8;
/**
 * 一条「插件在说话」的会话消息。
 *
 * `source.kind` 必须是 `'user'`：桌面端客户端只渲染这一种（2026-10-08 实测 —— 同一轮里
 * 的 agent-instructions / runtime-context / skill-catalog / time-context 全都**不显示**）。
 * 署名只能靠正文的 `[预算]` 前缀承担。
 */
function noticeMessage(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
/**
 * 一份交给模型的上下文（交接单本体）。
 *
 * 与上面相反：这条用自定义 `kind` 且**不该**显示给用户 —— 它只需要在用户下一次开口时
 * 进入模型上下文，让人和模型都能从同一个断点接着干。
 */
function recallMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'budget-handoff', form: 'recall' },
    });
}
export function apply(ctx, config) {
    // Cumulative token accounting, one record per session.
    const ledger = new Ledger();
    // Cumulative CNY spend, one total per session.
    const sessionCosts = new Map();
    // 每会话「价目表算不出来的调用」计数。> 0 表示金额这个数已经不可信，
    // 于是 Token 闸门接管（见 gate.ts 的模块头注释）。
    const unpricedCallsBySession = new Map();
    // 每会话的最近事件摘要（环缓冲），供交接快照的 recentEvents 使用。
    const recentEventsBySession = new Map();
    // 每会话的结构化任务痕迹：快照真正需要的字段（任务目标 / 工作目录 / 最近动作 /
    // 涉及文件），供 P5-2 的语义化渲染使用。与环缓冲并存，互不影响。
    const taskTracesBySession = new Map();
    // 每会话单独设定的预算（`/budget <金额>`）。没有条目时回退到 config 的默认值。
    // 这既是「每个会话各自设上限」的实现，也是被拦之后唯一能自救的入口。
    const sessionBudgets = new Map();
    // 每会话单独设定的 Token 上限（`/budget tokens <数量>`）。没有条目时回退到 config 默认值。
    // 存在的理由同上，但专门服务「价目表没收录这个模型」的会话。
    const sessionTokenBudgets = new Map();
    // 已经就「价目表里没有这个模型」警告过的 `会话|provider/model`，避免每一步都刷一条。
    const uncoveredWarned = new Set();
    // 已经为哪个会话做过「余额耗尽」收尾。配额错误会连续触发（之后每一步都失败），只抢救一次。
    const quotaHandoffDone = new Set();
    // 已经提示过 80% 预警的会话。只提示一次 —— 每一步都提醒等于噪音。
    const warnedAt80 = new Set();
    // ── 跨重启的会话状态 ────────────────────────────────────────────────────────
    // 上面所有 Map 都只活在进程里：DSH 一重启（含桌面版自动更新），本会话已经花掉的
    // 钱和 Token 就归零，闸门等于被悄悄调高到「无限」。用户要的是「跟会话走，不跟
    // 进程走」，所以启动时把上一进程写下的数字读回来，之后每记一笔再写回去。
    const persisted = loadState();
    for (const entry of Object.values(persisted.sessions)) {
        if (entry.usage !== undefined && entry.usage !== null)
            ledger.restore(entry.usage);
        if (typeof entry.spentCNY === 'number' && entry.spentCNY > 0) {
            sessionCosts.set(entry.sessionId, entry.spentCNY);
        }
        if (typeof entry.unpricedCalls === 'number' && entry.unpricedCalls > 0) {
            unpricedCallsBySession.set(entry.sessionId, entry.unpricedCalls);
        }
        if (typeof entry.budgetCNY === 'number')
            sessionBudgets.set(entry.sessionId, entry.budgetCNY);
        if (typeof entry.tokenBudget === 'number')
            sessionTokenBudgets.set(entry.sessionId, entry.tokenBudget);
    }
    const restoredCount = Object.keys(persisted.sessions).length;
    /** 上次落盘的时刻，用于把高频写入压成低频（见 {@link persistSession}）。 */
    let lastPersistAt = 0;
    /** 两次自动落盘之间的最小间隔（毫秒）。命令与拦停不受此限。 */
    const PERSIST_INTERVAL_MS = 2_000;
    /**
     * 把一个会话的当前数字搬进内存里的 `persisted`（不落盘）。
     *
     * 抽出来是为了让「卸载前一次性写盘」复用同一套字段拼装：两处各写一遍，
     * 迟早会漏掉某个字段，而漏掉的字段在重启后表现为「这个数莫名其妙变小了」。
     *
     * @param sessionId - 要同步的会话。
     * @param now - 写进 `updatedAt` 的时刻，裁剪按它排序。
     * @returns 是否真的写入了（没记过账的会话返回 false）。
     */
    function mergePersisted(sessionId, now = Date.now()) {
        const usage = ledger.get(sessionId);
        if (usage === null)
            return false;
        persisted.sessions[sessionId] = {
            sessionId,
            updatedAt: now,
            usage,
            spentCNY: sessionCosts.get(sessionId) ?? 0,
            unpricedCalls: unpricedCallsBySession.get(sessionId) ?? 0,
            ...(sessionBudgets.has(sessionId) ? { budgetCNY: sessionBudgets.get(sessionId) } : {}),
            ...(sessionTokenBudgets.has(sessionId)
                ? { tokenBudget: sessionTokenBudgets.get(sessionId) }
                : {}),
        };
        return true;
    }
    /**
     * 把一个会话的当前数字写回状态文件。
     *
     * 为什么要有节流：`session/event` 每来一条 assistant 消息就会调一次，而一次
     * 同步写盘在一个长任务里可能被调几百次。丢 2 秒的计数是可恢复的，卡住主线程不是。
     * 用户主动改上限、或闸门真的拦停时传 `force`，那两处必须立刻落盘。
     */
    function persistSession(sessionId, force = false) {
        const now = Date.now();
        if (!force && now - lastPersistAt < PERSIST_INTERVAL_MS)
            return;
        lastPersistAt = now;
        if (!mergePersisted(sessionId, now))
            return;
        // 写盘前顺手裁剪：只在启动时裁，一个长跑进程会把所有见过的会话都留在文件里，
        // 上限就成了「每次重启检查一次」。裁剪是纯函数，同一套规则两个入口。
        persisted.sessions = pruneSessions(persisted.sessions, now);
        saveState(persisted);
    }
    /**
     * 待发送的会话通知，按会话排队。
     *
     * 为什么需要队列：有些观察只能发生在 `session/event` 里（例如「这次调用用的是价目表里
     * 没有的模型」），但**在那个回调里调 `session.append()` 是发不出去的**。
     *
     * 实测（2026-10-08，桌面版 GUI）：
     * - 同一个 `session.append('user/message', …)` 在 `agent/pre-step` 里能插进会话
     *   （拦截通知、`/budget` 回执都正常落地）；
     * - 在 `session/event` 里则**静默失败** —— 会话日志里找不到那条事件，
     *   而外层 `catch` 只把错误写进 stderr（GUI 用户看不到）。
     *
     * 所以规矩是：**`session/event` 只记录，插消息一律放到 `agent/pre-step`。**
     */
    const pendingNoticesBySession = new Map();
    /**
     * 本会话生效的预算：单独设过就用单独设的（`/budget`），否则用全局默认。
     *
     * 抽成函数是因为它有三个调用点（预警 / 闸门 / 余额收尾），而「同一个东西写两遍」
     * 在本项目已经出过两次事故（`MAX_RECENT_EVENTS`、`budgetCNY` 默认值）。
     */
    function budgetFor(sessionId) {
        return sessionBudgets.get(sessionId) ?? config.budgetCNY;
    }
    /**
     * 本会话生效的 Token 上限：单独设过就用单独设的，否则用全局默认。
     * 与 {@link budgetFor} 同形，理由同上（同一个东西只写一遍）。
     */
    function tokenBudgetFor(sessionId) {
        return sessionTokenBudgets.get(sessionId) ?? config.tokenBudget;
    }
    /**
     * 把三处散落的累计量收成一个闸门输入。
     *
     * 抽出来是为了让「预警」和「拦停」问同一个函数 —— 它们曾经各自算一遍比例，
     * 迟早会分叉成「预警说还剩一点、闸门说已经超了」。
     */
    function gateStateFor(sessionId) {
        return {
            spentCNY: sessionCosts.get(sessionId) ?? 0,
            // 闸门判的是**折算后**的 Token：缓存命中按 CACHE_READ_WEIGHT 打折（见
            // ledger.ts 的模块注释）。原始计数照旧记着，回执里会一起报出来。
            tokens: ledger.get(sessionId)?.effectiveTokens ?? 0,
            unpricedCalls: unpricedCallsBySession.get(sessionId) ?? 0,
        };
    }
    /**
     * 80% 预警：累计到这个比例就插一条通知（每会话一次），只提示、不拦截。
     *
     * 为什么要有两个调用点 ——「哪一刻算到 80%」取决于任务的形状：
     * - `agent/pre-step`：多步任务在中途就跨过阈值，当场提示；
     * - `agent/turn-stopping`：单步任务、或恰好停在最后一步时，`pre-step` 不会再来。
     *   没有这个兜底，预警就只能等用户下次开口才弹出来（实测 2026-10-08）。
     *
     * 标记只在通知真的插进去之后才落，插失败下次还会再试。
     *
     * @param append - 插消息的通道；传回调而不是传 `Session`，避免这里依赖包级类型。
     */
    function warnAt80IfNeeded(sessionId, append) {
        const verdict = judge(gateStateFor(sessionId), {
            budgetCNY: budgetFor(sessionId),
            tokenBudget: tokenBudgetFor(sessionId),
        });
        if (verdict.ratio < WARN_AT_FRACTION)
            return;
        if (warnedAt80.has(sessionId))
            return;
        const state = gateStateFor(sessionId);
        // 报告**当前更紧的那个**口径，而不是永远报钱：会话一旦有算不出价的调用，
        // 钱这个数就是静止的，拿它报「还剩多少」是在骗人。
        // Token 那一行报的是折算后的数（闸门就是按它判的），同时给出原始数，
        // 否则用户拿账单一对会发现「插件少算了」。
        const recorded = ledger.get(sessionId);
        const lines = verdict.tightest === 'tokens'
            ? [
                `[预算] Token 已用 ${state.tokens.toLocaleString('en-US')}（折算后；原始 ${(recorded?.totalTokens ?? 0).toLocaleString('en-US')}，缓存读取按 ${CACHE_READ_WEIGHT} 计），达到本会话上限 ${Math.round(tokenBudgetFor(sessionId)).toLocaleString('en-US')} 的 ${Math.round(verdict.ratio * 100)}%`,
                `原因：本会话有 ${state.unpricedCalls} 次调用用的模型不在价目表里，金额无法累计，改用 Token 计数把关。`,
                `超限时任务会被停下，并写一份交接快照。要提高上限：\`${COMMAND_PREFIX} tokens <数量>\``,
            ]
            : [
                `[预算] 已用 ${state.spentCNY.toFixed(4)} 元，达到本会话预算 ${budgetFor(sessionId).toFixed(4)} 元的 ${Math.round(verdict.ratio * 100)}%`,
                `剩余 ${Math.max(0, budgetFor(sessionId) - state.spentCNY).toFixed(4)} 元。钱花完时任务会被停下，并写一份交接快照。`,
                `要提高预算：\`${COMMAND_PREFIX} <金额>\``,
            ];
        try {
            append(lines.join('\n'));
            warnedAt80.add(sessionId);
        }
        catch (err) {
            console.error(`[dsh-budget-handoff] failed to append 80% warning: ${String(err)}`);
        }
    }
    /**
     * 预算超支与余额耗尽**共用**的收尾：写交接单、在会话里留通知、把交接单交给模型。
     *
     * 传 `appendNotice` / `injectContext` 回调而不是传 `Agent` 对象，是为了不引入
     * `@deepseek-ai/dsh-agent` 的包级类型依赖 —— 那两条通道只在这两个调用点存在。
     */
    function writeHandoffOut(options) {
        const state = gateStateFor(options.sessionId);
        const tokenBudget = tokenBudgetFor(options.sessionId);
        const snapshot = buildSnapshot({
            sessionId: options.sessionId,
            turn: options.turn,
            step: options.step,
            spentCNY: options.spentCNY,
            budgetCNY: options.budgetCNY,
            basis: options.basis,
            tokens: state.tokens,
            rawTokens: ledger.get(options.sessionId)?.totalTokens ?? state.tokens,
            tokenBudget,
            unpricedCalls: state.unpricedCalls,
            reason: options.reason,
            trace: taskTracesBySession.get(options.sessionId) ?? emptyTrace(options.workdir),
            recentEvents: recentEventsBySession.get(options.sessionId) ?? [],
        });
        // 先落盘、再通知：通知里必须写**真实**路径。
        //
        // 两次落盘各自兜住 —— 这个函数跑在 `agent/pre-step` 里，抛出去就意味着下面那句
        // `return { kind: 'reject' }` 永远不执行：预算闸门 fail-open，用户却以为有保护。
        // 写失败只降级通知文案（少一行路径、多一行原因），拦停照旧。
        let workdirPath;
        let workdirError;
        try {
            workdirPath = writeSnapshot(snapshot, options.workdir);
        }
        catch (err) {
            workdirError = String(err);
            console.error(`[dsh-budget-handoff] failed to write snapshot to workdir: ${workdirError}`);
        }
        let dshHomePath;
        let dshHomeError;
        try {
            dshHomePath = writeSnapshotToDshHome(snapshot);
        }
        catch (err) {
            dshHomeError = String(err);
            console.error(`[dsh-budget-handoff] failed to write snapshot to DSH_HOME: ${dshHomeError}`);
        }
        const writtenLines = [];
        if (workdirPath !== undefined && dshHomePath !== undefined) {
            writtenLines.push('交接快照已写入：', `  1. ${workdirPath}`, `  2. ${dshHomePath}`);
        }
        else if (workdirPath !== undefined || dshHomePath !== undefined) {
            writtenLines.push('交接快照只写成功了一处：', workdirPath !== undefined ? `  1. ${workdirPath}` : `  1. （工作目录写入失败：${workdirError}）`, dshHomePath !== undefined ? `  2. ${dshHomePath}` : `  2. （DSH_HOME 写入失败：${dshHomeError}）`);
        }
        else {
            writtenLines.push('⚠️ 交接快照两处都没写成功 —— 任务已停止，但断点没有落盘：', `  1. 工作目录：${workdirError}`, `  2. DSH_HOME：${dshHomeError}`);
        }
        // 通知正文只报**真正卡住的那个数**，另一个口径放在括号里当背景。
        // 报错口径的后果很实在：用户照着「把预算调大」做了一遍，还是被拦。
        const usedLine = options.basis === 'tokens'
            ? `累计 Token：${state.tokens.toLocaleString('en-US')} / 上限 ${Math.round(tokenBudget).toLocaleString('en-US')}（金额因 ${state.unpricedCalls} 次调用无价目表而未累计）`
            : `累计消费：${options.spentCNY.toFixed(4)} 元 / 预算：${options.budgetCNY.toFixed(4)} 元`;
        try {
            options.appendNotice([
                options.headline,
                ...(options.extraLine !== undefined ? [options.extraLine] : []),
                usedLine,
                ...writtenLines,
                '打开快照可以看到「干到哪了 / 动过哪些文件 / 怎么接着干」。',
            ].join('\n'));
            options.injectContext(snapshot);
            if (config.verbose) {
                console.log(`[dsh-budget-handoff] handoff written: ${workdirPath ?? dshHomePath ?? '(none)'}`);
            }
        }
        catch (err) {
            console.error(`[dsh-budget-handoff] failed to append notice: ${String(err)}`);
        }
        console.error(`[dsh-budget-handoff] ${options.headline}`);
        if (options.extraLine !== undefined)
            console.error(`[dsh-budget-handoff] ${options.extraLine}`);
        console.error(`[dsh-budget-handoff] ${usedLine}`);
        for (const line of writtenLines)
            console.error(`[dsh-budget-handoff] ${line}`);
    }
    // ① Durable session firehose (emit): fires whenever a session's log grows —
    //    turn/step boundaries, user/assistant messages, tool results, …
    ctx.on('session/event', (session, event) => {
        // 最近事件环缓冲：放在任何分支之前，保证每条事件都被记录。
        const sessionId = String(session.id);
        const summary = summarizeEvent(event);
        if (summary !== null) {
            const arr = recentEventsBySession.get(sessionId) ?? [];
            arr.push(summary);
            while (arr.length > MAX_RECENT_EVENTS)
                arr.shift();
            recentEventsBySession.set(sessionId, arr);
        }
        // 结构化痕迹：环缓冲把每条事件压成一行，任务目标 / 工具参数 / 涉及文件在
        // 进入缓冲之前就已经丢掉；这里把同一个事件折叠进 TaskTrace 保留下来。
        // harvest 是纯函数：无 IO、无时钟、不调模型 —— 因此这一步不产生任何费用。
        // 工作目录取自 `session.header.cwd`（会话创建时的绝对目录）。**不要**退回
        // `process.cwd()`：那是宿主进程的启动目录，实测会把快照写进 DSH 自己的安装路径。
        const trace = taskTracesBySession.get(sessionId) ?? emptyTrace(session.header?.cwd ?? process.cwd());
        taskTracesBySession.set(sessionId, harvest(trace, event));
        // Token accounting. `SessionEvent` nests its payload under `data`
        // (`@deepseek-ai/dsh-session`, `lib/types/types.d.ts:489-512`:
        // `{ type: K; seq; time; data: SessionEventMap[K]; … }`), so the
        // `assistant/message` fields live at `event.data.message` / `event.data.usage`.
        if (event.type === 'assistant/message') {
            const payload = event.data;
            const usage = payload.usage;
            if (usage === undefined) {
                if (config.verbose)
                    console.log('[dsh-budget-handoff] assistant/message without usage, skipped');
            }
            else {
                const provider = payload.message.source.provider;
                const model = payload.message.source.model;
                // Per-call billed total, derived from the four disjoint buckets
                // (`TokenUsage` upstream counts them disjointly).
                const callTotal = usage.inputTokens +
                    (usage.cacheReadTokens ?? 0) +
                    (usage.cacheWriteTokens ?? 0) +
                    usage.outputTokens;
                ledger.record(String(session.id), provider, model, usage);
                // `totalTokens` 是 TokenUsage 的可选字段（dsh-llm\lib\types\types.d.ts:170），
                // provider 未提供时回退到四桶求和 callTotal，保证这一行总有数字。
                if (config.verbose) {
                    console.log(`[dsh-budget-handoff] usage provider=${provider} model=${model} total=${usage.totalTokens ?? callTotal} tokens`);
                }
                // Money layer: price this call against the peak/off-peak table and fold
                // it into the session's running CNY total.
                const isPeak = isPeakHour(new Date());
                const cost = calculateCost(provider, model, usage, isPeak);
                if (cost >= 0) {
                    const cumulativeCost = (sessionCosts.get(String(session.id)) ?? 0) + cost;
                    sessionCosts.set(String(session.id), cumulativeCost);
                    if (config.verbose) {
                        console.log(`[dsh-budget-handoff] cost thisCall=${cost.toFixed(4)} 累计=${cumulativeCost.toFixed(4)} 元`);
                    }
                }
                else {
                    // 金额算不出来 —— 从这一刻起金额闸门是瞎的。但 Token 数照常记（上面
                    // ledger.record 已经做了），所以「至少把它记上」这件事在这里是成立的：
                    // 这个分支唯一的副作用就是给 Token 闸门点一次火。
                    const sessionKey = String(session.id);
                    unpricedCallsBySession.set(sessionKey, (unpricedCallsBySession.get(sessionKey) ?? 0) + 1);
                    console.error(`[dsh-budget-handoff] ⚠️ 未知 provider/model: ${provider}/${model} — 无法按价目表计费，本会话改用 Token 计数把关`);
                    console.error(`[dsh-budget-handoff]    价目表可在 dist/pricing.json 补全；或换用已知模型，金额闸门会自动恢复`);
                    // A7：把这件事从终端搬到会话里。GUI 用户看不到 stdout，原来那两句
                    // 警告等于没说。按 (会话, provider/model) 去重，否则每一步都刷一条。
                    const uncoveredKey = `${sessionKey}|${provider}/${model}`;
                    if (!uncoveredWarned.has(uncoveredKey)) {
                        uncoveredWarned.add(uncoveredKey);
                        // 只入队，不在这里 append —— 原因见 pendingNoticesBySession 的注释。
                        const queue = pendingNoticesBySession.get(sessionKey) ?? [];
                        const ceiling = Math.round(tokenBudgetFor(sessionKey)).toLocaleString('en-US');
                        const recorded = ledger.get(sessionKey);
                        queue.push([
                            `[预算] 价目表里没有 ${provider}/${model} 的价格`,
                            `后果：本会话的金额不再累计（它不涨，也就不会再拦停），但 Token 数照记`,
                            `现在的保护：Token 上限 ${ceiling}，已用 ${recorded?.totalTokens.toLocaleString('en-US') ?? 0}（折算后 ${Math.round(recorded?.effectiveTokens ?? 0).toLocaleString('en-US')}，缓存读取按 ${CACHE_READ_WEIGHT} 计）`,
                            `要调上限：\`${COMMAND_PREFIX} tokens <数量>\`；想恢复金额把关：补 dist/pricing.json 或换已知模型`,
                        ].join('\n'));
                        pendingNoticesBySession.set(sessionKey, queue);
                    }
                }
                // 每记一笔就把本会话的数字落盘（带 2 秒节流）。这是「Token 累计跟会话走、
                // 不随重启归零」的写入端：读回发生在 apply() 顶部，写在这里。
                persistSession(String(session.id));
            }
        }
    });
    // ④ Budget gate (waterfall): the last line of defence before a step is
    //    proposed to the model. NOT calling next() short-circuits the loop, so
    //    returning `{ kind: 'reject' }` ends the turn with reason `blocked`
    //    instead of throwing, and no further request is billed.
    ctx.on('agent/pre-step', async (payload, next) => {
        const sessionId = String(payload.agent.session?.id ?? '');
        const spent = sessionCosts.get(sessionId) ?? 0;
        // 本会话生效的预算：单独设过就用单独设的，否则用全局默认。
        const budgetCNY = budgetFor(sessionId);
        // 先把 `session/event` 期间攒下的通知发出去 —— 只有在这个回调里
        // `session.append()` 才真的能插进会话（原因见 pendingNoticesBySession）。
        const queued = pendingNoticesBySession.get(sessionId);
        if (queued !== undefined && queued.length > 0) {
            pendingNoticesBySession.delete(sessionId);
            for (const text of queued) {
                try {
                    payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
                }
                catch (err) {
                    console.error(`[dsh-budget-handoff] failed to append queued notice: ${String(err)}`);
                }
            }
        }
        // 口令**先于**闸门。顺序反过来的话，预算一旦耗尽，用户连「提高预算」这件事都
        // 做不了 —— 而那恰恰是他唯一想做的事。口令在模型之前被接住，所以改预算本身
        // 不花一分钱；随后 reject 掉这一步，不给模型任何回答的机会。
        const command = findBudgetCommand(payload.messages);
        if (command !== null) {
            if (command.kind === 'set')
                sessionBudgets.set(sessionId, command.budgetCNY);
            if (command.kind === 'set-tokens')
                sessionTokenBudgets.set(sessionId, command.tokenBudget);
            const recorded = ledger.get(sessionId);
            const receipt = renderReceipt(command, budgetFor(sessionId), sessionCosts.get(sessionId) ?? 0, recorded?.totalTokens ?? 0, tokenBudgetFor(sessionId), recorded?.effectiveTokens ?? 0);
            try {
                payload.agent.session.append('user/message', createUserMessage({
                    content: [{ type: 'text', text: receipt }],
                    // 必须 `kind: 'user'`：客户端只渲染这一种（说明见下方拦截通知处）。
                    source: { kind: 'user' },
                }), { surfaceOp: 'append' });
                if (config.verbose)
                    console.log(`[dsh-budget-handoff] budget command handled: ${command.kind}`);
            }
            catch (err) {
                console.error(`[dsh-budget-handoff] failed to append receipt: ${String(err)}`);
            }
            // 改了上限就必须立刻落盘：用户敲这条命令往往正是因为下一步就会被拦，
            // 此时重启一次却把新上限弄丢，等于这条命令白敲。
            persistSession(sessionId, true);
            return { kind: 'reject' };
        }
        // 两个口径问同一个纯函数 —— 预警和拦停不可能对「还剩多少」给出不同答案。
        const verdict = judge(gateStateFor(sessionId), {
            budgetCNY,
            tokenBudget: tokenBudgetFor(sessionId),
        });
        if (verdict.tripped.length > 0) {
            // 会话的真实工作目录在 SessionHeader 上（`session.header.cwd`），**不是**
            // `process.cwd()`：后者是宿主进程的启动目录（实测为 profiles\desktop），
            // 会把快照写进 DSH 自己的安装目录，用户在自己的工作区里根本找不到。
            const workdir = payload.agent.session?.header?.cwd ?? process.cwd();
            const basis = verdict.tightest;
            // 拦停时两个数都写：原始值对账，折算值解释「为什么现在停」。只写折算值会让人
            // 以为 Token 少算了；只写原始值会让人以为闸门坏了。
            const recorded = ledger.get(sessionId);
            const reason = basis === 'tokens'
                ? `session used ${Math.round(recorded?.effectiveTokens ?? 0).toLocaleString('en-US')} weighted tokens (${(recorded?.totalTokens ?? 0).toLocaleString('en-US')} raw, cache reads at ${CACHE_READ_WEIGHT}) >= token ceiling ${Math.round(tokenBudgetFor(sessionId)).toLocaleString('en-US')} (money not accrued: ${verdict.tokenArmed ? 'price table gap' : 'n/a'})`
                : `session spent ${spent.toFixed(4)} CNY >= budget ${budgetCNY.toFixed(4)} CNY`;
            writeHandoffOut({
                sessionId,
                turn: payload.turn,
                step: payload.step,
                reason,
                basis,
                spentCNY: spent,
                budgetCNY,
                workdir,
                headline: basis === 'tokens'
                    ? '[预算] Token 用量已达上限，任务已停止'
                    : '[预算] 预算已耗尽，任务已停止',
                // 如果这一步直接把累计从「还没到 80%」顶到了「超过 100%」，80% 预警就没有机会发
                // （pre-step 里超支分支在预警检查之前 return 了）。把「越过了预警线」这个事实并进
                // 拦停通知：信息不丢，又不必连发两条。已经提醒过的情况就不重复了。
                extraLine: verdict.ratio >= 1 && !warnedAt80.has(sessionId)
                    ? '注意：本次用量越过了 80% 预警线，但直到触顶才停下。'
                    : undefined,
                appendNotice: (text) => {
                    payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
                },
                injectContext: (text) => {
                    payload.agent.inject(recallMessage(text));
                },
            });
            // 拦停是这一轮最重要的一次写盘：任务已经停了，用户可能马上重启 DSH 去
            // 接着干，重启后必须还记得「这个会话已经用掉了多少」。
            persistSession(sessionId, true);
            return { kind: 'reject' };
        }
        // 80% 预警：多步任务会在中途跨过阈值，这里当场提示。
        warnAt80IfNeeded(sessionId, (text) => {
            payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
        });
        return next();
    });
    // turn 即将关闭时的兜底：单步任务、或恰好停在最后一步时，`agent/pre-step` 不会再来。
    // 没有这个钩子，80% 预警就只能等用户下次开口才弹出来（实测 2026-10-08 的用户反馈：
    // 「到达预警之后没有自动弹，是我发了下一条消息才弹在我那条消息之前」）。
    //
    // 这个钩子在「边界提交之前」被 await，所以插进去的通知落在本轮结束之前 ——
    // 即用户看到的就是「这条消息跑完，预警自己冒出来」。
    ctx.on('agent/turn-stopping', (payload) => {
        const sessionId = String(payload.agent.session?.id ?? '');
        warnAt80IfNeeded(sessionId, (text) => {
            payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
        });
    });
    // 余额耗尽兜底：账户真没钱时 DeepSeek 会拒绝这次请求，DSH 把失败归一化成一个标准码送进来。
    // 认这个码，走与预算超支**同一套**收尾 —— 否则账户耗尽就是一次无法辨认的死法：用户第二天
    // 只看到一句报错，任务干到哪了没有任何记录。
    //
    // 这里不需要任何凭据、不发任何网络请求：错误是宿主送进来的，插件只读。抢救动作（写文件 +
    // 插消息）也全是本地行为，**不调模型** —— 所以「没钱了也能收尾」在成本上成立。
    ctx.on('agent/request-error', async (payload, next) => {
        const code = payload.failure.code;
        if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') {
            const sessionId = String(payload.agent.session?.id ?? '');
            // 配额错误会连续触发（之后每一步都失败），只收尾一次。
            if (!quotaHandoffDone.has(sessionId)) {
                quotaHandoffDone.add(sessionId);
                writeHandoffOut({
                    sessionId,
                    turn: payload.turn,
                    step: payload.step,
                    reason: `provider rejected the request: ${payload.provider} → ${code} (${payload.failure.message})`,
                    // 账户余额耗尽与「金额超预算」是同一类事：卡住的是钱。
                    basis: 'money',
                    spentCNY: sessionCosts.get(sessionId) ?? 0,
                    budgetCNY: budgetFor(sessionId),
                    workdir: payload.agent.session?.header?.cwd ?? process.cwd(),
                    headline: '[预算] 账户余额已耗尽，任务已停止',
                    appendNotice: (text) => {
                        payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
                    },
                    injectContext: (text) => {
                        payload.agent.inject(recallMessage(text));
                    },
                });
            }
        }
        // 不接管恢复：没钱了重试没有意义，保持失败终局。
        return next();
    });
    // ⑤ ctx.on() is already an EFFECT (auto-disposed on unload). The 30s heartbeat
    //    timer was removed in v0.1.1 (pure noise); this empty effect is kept only
    //    so the reversible-cleanup proof — the DISPOSED line on unload — survives.
    ctx.effect(() => {
        return () => {
            // 卸载前把每个记过账的会话都写一遍（不受 2 秒节流限制）：插件被停用、
            // 或宿主走正常退出流程时，最后两秒的记账否则就丢了。
            // 逐个更新内存里的 persisted，最后只落盘一次 —— N 个会话写 N 次文件没有意义。
            const all = ledger.getAll();
            for (const usage of all)
                mergePersisted(usage.sessionId);
            if (all.length > 0) {
                const now = Date.now();
                persisted.sessions = pruneSessions(persisted.sessions, now);
                saveState(persisted);
            }
            console.log(`[dsh-budget-handoff] DISPOSED — listeners removed`);
        };
    });
    console.log(`[dsh-budget-handoff] 已加载，默认预算 ${config.budgetCNY} CNY、Token 上限 ${config.tokenBudget.toLocaleString('en-US')}（${COMMAND_PREFIX} <金额> / ${COMMAND_PREFIX} tokens <数量> 可按会话覆盖）`);
    // 读回了几条历史会话就说一句：这句话是「重启不清零」唯一的外部证据，
    // 没有它，用户只能靠花掉一笔钱去反推功能是否生效。
    if (restoredCount > 0) {
        console.log(`[dsh-budget-handoff] 已从上次运行恢复 ${restoredCount} 个会话的累计用量`);
    }
}
