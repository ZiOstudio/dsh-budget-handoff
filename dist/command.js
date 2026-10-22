// dsh-budget-handoff — the in-session budget command.
//
// Why a literal command instead of natural language: the plugin has to
// recognise the request *before* the step reaches the model (`agent/pre-step`),
// because otherwise changing a budget would itself cost a model call — paying
// money to stop paying money. Interpreting free-form phrasing requires exactly
// that call, so the surface is a fixed prefix the user types verbatim.
//
// Pure text in, intent out: no I/O, no context, no clock — unit-testable.
import { messageText } from './harvest.js';
// 只为一个常量而 import：回执里要说清「折算后」是按什么比例折的，那个比例必须与
// ledger 实际使用的完全一致，各写一份 0.1 会在某次调整后静默说错话。
import { CACHE_READ_WEIGHT } from './ledger.js';
/** Literal prefix that addresses this plugin from inside a session. */
export const COMMAND_PREFIX = '/budget';
/** Smallest budget the config schema accepts (`z.number().min(0.0001)`). */
const MIN_BUDGET_CNY = 0.0001;
/**
 * Smallest token ceiling accepted: 1000 tokens.
 *
 * Not a display precision — a ceiling below one call's size would stop the
 * session on its first step, which is indistinguishable from a broken plugin.
 */
const MIN_TOKEN_BUDGET = 1_000;
/** The word that switches `/budget` from CNY to tokens. */
const TOKEN_SUBCOMMAND = 'tokens';
/** Longest echoed fragment in a rejection, so a careless paste cannot inflate the receipt. */
const MAX_ECHO_CHARS = 20;
/**
 * Interpret one message's text as a budget command.
 *
 * The prefix must stand alone or be followed by whitespace: `/budgetx` is not a
 * command, it is someone typing about budgets.
 *
 * @param text - the message's text, exactly as the user typed it.
 * @returns the intent, or null when the message is not addressed to this plugin.
 */
export function parseBudgetCommand(text) {
    const trimmed = text.trim();
    const prefix = COMMAND_PREFIX.toLowerCase();
    const lower = trimmed.toLowerCase();
    let argument;
    if (lower === prefix) {
        argument = '';
    }
    else if (lower.startsWith(`${prefix} `)) {
        argument = trimmed.slice(COMMAND_PREFIX.length).trim();
    }
    else {
        return null;
    }
    if (argument === '')
        return { kind: 'query' };
    // `/budget tokens 200000` — the token ceiling, used when the price table
    // cannot price the session's model. Bare `/budget tokens` reports it instead
    // of setting it, matching bare `/budget`.
    const lowerArgument = argument.toLowerCase();
    if (lowerArgument === TOKEN_SUBCOMMAND)
        return { kind: 'query' };
    if (lowerArgument.startsWith(`${TOKEN_SUBCOMMAND} `)) {
        const amountText = argument.slice(TOKEN_SUBCOMMAND.length).trim();
        const tokenBudget = Number(amountText);
        if (!Number.isFinite(tokenBudget)) {
            return { kind: 'invalid', reason: `「${clip(amountText)}」不是数字` };
        }
        // Fractional tokens are meaningless; round so the receipt and the gate agree.
        const rounded = Math.round(tokenBudget);
        if (rounded < MIN_TOKEN_BUDGET) {
            return { kind: 'invalid', reason: `Token 上限不能小于 ${MIN_TOKEN_BUDGET}` };
        }
        return { kind: 'set-tokens', tokenBudget: rounded };
    }
    const value = Number(argument);
    if (!Number.isFinite(value)) {
        return { kind: 'invalid', reason: `「${clip(argument)}」不是数字` };
    }
    if (value < MIN_BUDGET_CNY) {
        return { kind: 'invalid', reason: `预算不能小于 ${MIN_BUDGET_CNY} 元` };
    }
    return { kind: 'set', budgetCNY: value };
}
/**
 * Find the first budget command among the messages entering one step.
 *
 * @param messages - the step's user messages, in order.
 * @returns the first command found, or null when none of them is one.
 */
export function findBudgetCommand(messages) {
    for (const message of messages) {
        const command = parseBudgetCommand(messageText(message.content));
        if (command !== null)
            return command;
    }
    return null;
}
/**
 * Render the receipt this command leaves in the session.
 *
 * The receipt travels as `kind: 'user'` — the desktop client renders nothing
 * else (measured 2026-10-08) — so the `[预算]` prefix is what identifies it as
 * the plugin speaking. A rejected command still gets a receipt: silence would
 * leave the user unable to tell "not applied" from "not understood".
 *
 * @param command - the parsed intent; never the `null` "not a command" case.
 * @param budgetCNY - the budget now in force for this session.
 * @param spentCNY - what this session has spent so far.
 * @param tokens - what this session has consumed so far, in raw tokens.
 * @param tokenBudget - the token ceiling now in force for this session.
 * @param effectiveTokens - the weighted total the ceiling actually judges
 *   (cache reads discounted — see `ledger.ts`). Omitted or equal to `tokens`
 *   renders one number; different renders both, because a user who sees
 *   "12,000 / 5,000,000" cannot tell why the gate stopped them at a lower raw
 *   count.
 * @returns one line, always prefixed with `[预算]`.
 */
export function renderReceipt(command, budgetCNY, spentCNY, tokens, tokenBudget, effectiveTokens) {
    const budget = budgetCNY.toFixed(4);
    const spent = spentCNY.toFixed(4);
    const tokenCeiling = Math.round(tokenBudget).toLocaleString('en-US');
    const tokenUsed = Math.round(tokens).toLocaleString('en-US');
    // 折算后与原始值只差在缓存命中上；相等时没必要让用户读两遍。
    const weightedUsed = Math.round(effectiveTokens ?? tokens);
    const weightedSuffix = weightedUsed === Math.round(tokens)
        ? ''
        : `（折算后 ${weightedUsed.toLocaleString('en-US')}，缓存读取按 ${CACHE_READ_WEIGHT} 计）`;
    switch (command.kind) {
        case 'set':
            return `[预算] 本会话预算已设为 ${budget} 元（已用 ${spent} 元）`;
        case 'set-tokens':
            return `[预算] 本会话 Token 上限已设为 ${Math.round(command.tokenBudget).toLocaleString('en-US')}；已用 ${tokenUsed}${weightedSuffix}`;
        case 'query': {
            const remaining = Math.max(0, budgetCNY - spentCNY).toFixed(4);
            return [
                `[预算] 本会话预算 ${budget} 元，已用 ${spent} 元，剩余 ${remaining} 元`,
                `[预算] Token 上限 ${tokenCeiling}，已用 ${tokenUsed}${weightedSuffix}`,
            ].join('\n');
        }
        case 'invalid':
            return `[预算] 预算没有改动：${command.reason}。用法：\`${COMMAND_PREFIX} 5\` 设为 5 元，\`${COMMAND_PREFIX} ${TOKEN_SUBCOMMAND} 200000\` 设 Token 上限，或 \`${COMMAND_PREFIX}\` 查询当前预算。`;
        default: {
            const exhaustive = command;
            return `[预算] 未知指令：${String(exhaustive)}`;
        }
    }
}
/** Bound one echoed fragment. */
function clip(text) {
    return text.length <= MAX_ECHO_CHARS ? text : `${text.slice(0, MAX_ECHO_CHARS)}…`;
}
