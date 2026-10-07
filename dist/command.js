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
/** Literal prefix that addresses this plugin from inside a session. */
export const COMMAND_PREFIX = '/budget';
/** Smallest budget the config schema accepts (`z.number().min(0.0001)`). */
const MIN_BUDGET_CNY = 0.0001;
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
 * @returns one line, always prefixed with `[预算]`.
 */
export function renderReceipt(command, budgetCNY, spentCNY) {
    const budget = budgetCNY.toFixed(4);
    const spent = spentCNY.toFixed(4);
    switch (command.kind) {
        case 'set':
            return `[预算] 本会话预算已设为 ${budget} 元（已用 ${spent} 元）`;
        case 'query': {
            const remaining = Math.max(0, budgetCNY - spentCNY).toFixed(4);
            return `[预算] 本会话预算 ${budget} 元，已用 ${spent} 元，剩余 ${remaining} 元`;
        }
        case 'invalid':
            return `[预算] 预算没有改动：${command.reason}。用法：\`${COMMAND_PREFIX} 5\` 设为 5 元，或 \`${COMMAND_PREFIX}\` 查询当前预算。`;
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
