import z from '@deepseek-ai/schemastery';
import { Ledger } from './ledger.js';
import { calculateCost, isPeakHour } from './pricing.js';
import { buildSnapshot, writeSnapshot, writeSnapshotToDshHome } from './snapshot.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const Config = z.object({
    budgetCNY: z.number().min(0.0001).default(1.0),
    priceTablePath: z.string().default(''),
});
// Plugin display name, shown in loader diagnostics.
export const name = 'dsh-budget-handoff';
export function apply(ctx, config) {
    let sessionEvents = 0;
    let toolChanges = 0;
    let toolPreExecutes = 0;
    // Cumulative token accounting, one record per session.
    const ledger = new Ledger();
    // Cumulative CNY spend, one total per session.
    const sessionCosts = new Map();
    // ① Durable session firehose (emit): fires whenever a session's log grows —
    //    turn/step boundaries, user/assistant messages, tool results, …
    ctx.on('session/event', (session, event) => {
        sessionEvents += 1;
        if (sessionEvents <= 5 || sessionEvents % 25 === 0) {
            console.log(`[dsh-budget-handoff] session/event #${sessionEvents} type=${event.type} session=${String(session.id)}`);
        }
        // Token accounting. `SessionEvent` nests its payload under `data`
        // (`@deepseek-ai/dsh-session`, `lib/types/types.d.ts:489-512`:
        // `{ type: K; seq; time; data: SessionEventMap[K]; … }`), so the
        // `assistant/message` fields live at `event.data.message` / `event.data.usage`.
        if (event.type === 'assistant/message') {
            const payload = event.data;
            const usage = payload.usage;
            if (usage === undefined) {
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
                console.log(`[dsh-budget-handoff] usage recorded provider=${provider} model=${model} uncachedInput=${usage.inputTokens} cacheRead=${usage.cacheReadTokens ?? 0} cacheWrite=${usage.cacheWriteTokens ?? 0} output=${usage.outputTokens} total=${callTotal}`);
                const cumulative = ledger.get(String(session.id));
                console.log(`[dsh-budget-handoff] usage cumulative session=${String(session.id)} uncachedInput=${cumulative?.uncachedInputTokens ?? 0} cacheRead=${cumulative?.cacheReadTokens ?? 0} cacheWrite=${cumulative?.cacheWriteTokens ?? 0} output=${cumulative?.outputTokens ?? 0} totalTokens=${cumulative?.totalTokens ?? 0}`);
                // Money layer: price this call against the peak/off-peak table and fold
                // it into the session's running CNY total.
                const isPeak = isPeakHour(new Date());
                const cost = calculateCost(provider, model, usage, isPeak);
                if (cost >= 0) {
                    const cumulativeCost = (sessionCosts.get(String(session.id)) ?? 0) + cost;
                    sessionCosts.set(String(session.id), cumulativeCost);
                    console.log(`[dsh-budget-handoff] cost session=${String(session.id)} provider=${provider} model=${model} peak=${isPeak} thisCall=${cost.toFixed(4)} 累计=${cumulativeCost.toFixed(4)} 元`);
                }
                else {
                    console.error(`[dsh-budget-handoff] ⚠️ 未知 provider/model: ${provider}/${model} — 本插件无法为其计费，预算保护已失效`);
                    console.error(`[dsh-budget-handoff]    如果你在用自定义 provider 或新模型，请更新 src/pricing.json 或换用已知模型`);
                }
            }
        }
    });
    // ② Live registry change (emit): fires the moment any tool is registered or
    //    unregistered — including by sibling plugins in the same composition.
    ctx.on('tools/change', () => {
        toolChanges += 1;
        console.log(`[dsh-budget-handoff] tools/change #${toolChanges}`);
    });
    // ③ Tool execution pipeline (waterfall): log, then delegate with next().
    //    NOT calling next() would short-circuit and block the tool call.
    ctx.on('tools/pre-execute', (exec, next) => {
        toolPreExecutes += 1;
        console.log(`[dsh-budget-handoff] tools/pre-execute #${toolPreExecutes} tool=${exec.name}`);
        return next();
    });
    // ④ Budget gate (waterfall): the last line of defence before a step is
    //    proposed to the model. NOT calling next() short-circuits the loop, so
    //    returning `{ kind: 'reject' }` ends the turn with reason `blocked`
    //    instead of throwing, and no further request is billed.
    ctx.on('agent/pre-step', async (payload, next) => {
        const sessionId = String(payload.agent.session?.id ?? '');
        const spent = sessionCosts.get(sessionId) ?? 0;
        if (spent >= config.budgetCNY) {
            const snapshot = buildSnapshot({
                sessionId,
                turn: payload.turn,
                step: payload.step,
                spentCNY: spent,
                budgetCNY: config.budgetCNY,
                reason: `session spent ${spent.toFixed(4)} CNY >= budget ${config.budgetCNY.toFixed(4)} CNY`,
                recentEvents: [], // 本 MVP 先留空，后续可加
            });
            try {
                const noticeText = [
                    `⛔ 预算已耗尽，任务已停止`,
                    `累计消费：${spent.toFixed(4)} 元 / 预算：${config.budgetCNY.toFixed(4)} 元`,
                    `交接快照已写入：`,
                    `  1. ${process.cwd()}\\BUDGET-STOPPED-handoff-snapshot.md`,
                    `  2. $DSH_HOME/storages/dsh-budget-handoff/last-stop.md`,
                    `请查看快照了解任务进度，调整预算后重试。`,
                ].join('\n');
                const noticeMsg = createUserMessage({
                    content: [{ type: 'text', text: noticeText }],
                    source: {
                        kind: 'budget-handoff',
                        form: 'notice',
                        summary: `预算耗尽：${spent.toFixed(4)}/${config.budgetCNY.toFixed(4)} 元`,
                    },
                });
                payload.agent.session.append('user/message', noticeMsg, { surfaceOp: 'append' });
                console.log(`[dsh-budget-handoff] notice appended to session log`);
            }
            catch (err) {
                console.error(`[dsh-budget-handoff] failed to append notice: ${String(err)}`);
            }
            const workdirPath = writeSnapshot(snapshot, process.cwd());
            const dshHomePath = writeSnapshotToDshHome(snapshot);
            console.error(`[dsh-budget-handoff] ⛔ 预算已耗尽，任务已停止`);
            console.error(`[dsh-budget-handoff] 累计消费：${spent.toFixed(4)} 元 / 预算：${config.budgetCNY.toFixed(4)} 元`);
            console.error(`[dsh-budget-handoff] 交接快照已写入：`);
            console.error(`[dsh-budget-handoff]   1. ${workdirPath}`);
            console.error(`[dsh-budget-handoff]   2. ${dshHomePath}`);
            console.error(`[dsh-budget-handoff] 请查看快照了解任务进度，调整预算后重试。`);
            return { kind: 'reject' };
        }
        return next();
    });
    // ⑤ ctx.on() is already an EFFECT (auto-disposed on unload). For a resource
    //    Cordis does NOT manage (a timer/connection/watcher), wrap it in
    //    ctx.effect() and return a disposer — the reversible-cleanup proof:
    //    unload this plugin and watch the DISPOSED line print.
    ctx.effect(() => {
        const timer = setInterval(() => {
            console.log(`[dsh-budget-handoff] heartbeat sessionEvents=${sessionEvents} toolPreExecutes=${toolPreExecutes} toolChanges=${toolChanges}`);
        }, 30_000);
        return () => {
            clearInterval(timer);
            console.log(`[dsh-budget-handoff] DISPOSED — listeners removed, timer cleared`);
        };
    });
    console.log(`[dsh-budget-handoff] listeners registered: session/event + tools/change + tools/pre-execute | resolved budget=${config.budgetCNY} CNY priceTablePath='${config.priceTablePath}'`);
}
