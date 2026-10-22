// Self-check for the budget command parser. No test framework: run the
// compiled file with `node dist/command.test.js` and read the PASS/FAIL lines.
//
// The rejection cases matter as much as the happy path: a command surface that
// silently swallows a typo is worse than one that has no command at all,
// because the user cannot tell "not applied" from "not understood".
import { parseBudgetCommand, findBudgetCommand, renderReceipt, COMMAND_PREFIX } from './command.js';
let failed = 0;
function check(label, ok, detail) {
    if (!ok)
        failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`);
}
function message(text) {
    return { content: [{ type: 'text', text }] };
}
console.log('--- command self-check ---');
// ── query ───────────────────────────────────────────────────────────────────
const bare = parseBudgetCommand('/budget');
check('bare command is a query', bare !== null && bare.kind === 'query', JSON.stringify(bare));
const padded = parseBudgetCommand('  /budget  ');
check('surrounding whitespace is ignored', padded !== null && padded.kind === 'query', JSON.stringify(padded));
const upperBare = parseBudgetCommand('/BUDGET');
check('bare command is case-insensitive', upperBare !== null && upperBare.kind === 'query', JSON.stringify(upperBare));
// ── set ─────────────────────────────────────────────────────────────────────
const five = parseBudgetCommand('/budget 5');
check('set parses the amount', five !== null && five.kind === 'set' && five.budgetCNY === 5, JSON.stringify(five));
const half = parseBudgetCommand('/budget 0.5');
check('decimals parse', half !== null && half.kind === 'set' && half.budgetCNY === 0.5, JSON.stringify(half));
const spaced = parseBudgetCommand('/budget    12.75');
check('extra spaces between prefix and amount', spaced !== null && spaced.kind === 'set' && spaced.budgetCNY === 12.75, JSON.stringify(spaced));
const upperSet = parseBudgetCommand('/Budget 20');
check('case-insensitive set', upperSet !== null && upperSet.kind === 'set' && upperSet.budgetCNY === 20, JSON.stringify(upperSet));
const trailing = parseBudgetCommand('/budget 5   ');
check('trailing whitespace after amount', trailing !== null && trailing.kind === 'set' && trailing.budgetCNY === 5, JSON.stringify(trailing));
// ── invalid ─────────────────────────────────────────────────────────────────
const notANumber = parseBudgetCommand('/budget abc');
check('non-numeric amount is rejected, not ignored', notANumber !== null && notANumber.kind === 'invalid', JSON.stringify(notANumber));
const zero = parseBudgetCommand('/budget 0');
check('zero is rejected', zero !== null && zero.kind === 'invalid', JSON.stringify(zero));
const negative = parseBudgetCommand('/budget -1');
check('negative is rejected', negative !== null && negative.kind === 'invalid', JSON.stringify(negative));
const twoValues = parseBudgetCommand('/budget 5 6');
check('two amounts are rejected', twoValues !== null && twoValues.kind === 'invalid', JSON.stringify(twoValues));
const longGarbage = parseBudgetCommand(`/budget ${'x'.repeat(80)}`);
check('a long bad argument is clipped in the reason', longGarbage !== null && longGarbage.kind === 'invalid' && longGarbage.reason.length < 60, `reason length = ${longGarbage !== null && longGarbage.kind === 'invalid' ? longGarbage.reason.length : 'n/a'}`);
// ── token ceiling ───────────────────────────────────────────────────────────
const tokensBare = parseBudgetCommand('/budget tokens');
check('bare token subcommand is a query', tokensBare !== null && tokensBare.kind === 'query', JSON.stringify(tokensBare));
const tokensSet = parseBudgetCommand('/budget tokens 200000');
check('token ceiling parses', tokensSet !== null && tokensSet.kind === 'set-tokens' && tokensSet.tokenBudget === 200_000, JSON.stringify(tokensSet));
const tokensSpaced = parseBudgetCommand('/budget   TOKENS   1500000');
check('token subcommand is case-insensitive and tolerates spacing', tokensSpaced !== null && tokensSpaced.kind === 'set-tokens' && tokensSpaced.tokenBudget === 1_500_000, JSON.stringify(tokensSpaced));
const tokensRounded = parseBudgetCommand('/budget tokens 12345.6');
check('fractional token counts round to whole tokens', tokensRounded !== null && tokensRounded.kind === 'set-tokens' && tokensRounded.tokenBudget === 12_346, JSON.stringify(tokensRounded));
const tokensTooSmall = parseBudgetCommand('/budget tokens 10');
check('a ceiling below one call is rejected', tokensTooSmall !== null && tokensTooSmall.kind === 'invalid', JSON.stringify(tokensTooSmall));
const tokensNotANumber = parseBudgetCommand('/budget tokens abc');
check('non-numeric token ceiling is rejected, not ignored', tokensNotANumber !== null && tokensNotANumber.kind === 'invalid', JSON.stringify(tokensNotANumber));
// A bare `/budget tokens` must never be mistaken for "set the budget to NaN".
check('token subcommand never falls through to the money parser', tokensBare?.kind === 'query', JSON.stringify(tokensBare));
// ── not a command ───────────────────────────────────────────────────────────
check('plain Chinese sentence is not a command', parseBudgetCommand('看看当前目录有哪些文件') === null, 'null');
check('prefix without separator is not a command', parseBudgetCommand('/budgetx 5') === null, 'null');
check('translated word is not a command', parseBudgetCommand('预算 5') === null, 'null');
check('empty string is not a command', parseBudgetCommand('') === null, 'null');
// ── findBudgetCommand ───────────────────────────────────────────────────────
const found = findBudgetCommand([message('看看当前目录有哪些文件'), message('/budget 8')]);
check('finds the command among ordinary messages', found !== null && found.kind === 'set' && found.budgetCNY === 8, JSON.stringify(found));
const noneFound = findBudgetCommand([message('你好'), message('帮我看下文件')]);
check('returns null when no message is a command', noneFound === null, JSON.stringify(noneFound));
const emptyBatch = findBudgetCommand([]);
check('returns null for an empty batch', emptyBatch === null, JSON.stringify(emptyBatch));
// ── receipts ────────────────────────────────────────────────────────────────
const setReceipt = renderReceipt({ kind: 'set', budgetCNY: 5 }, 5, 0.32, 12_000, 5_000_000);
check('set receipt reports the new budget and the spend', setReceipt === '[预算] 本会话预算已设为 5.0000 元（已用 0.3200 元）', setReceipt);
const setTokensReceipt = renderReceipt({ kind: 'set-tokens', tokenBudget: 200_000 }, 5, 0.32, 12_000, 200_000);
check('set-tokens receipt reports the new ceiling and the usage', setTokensReceipt === '[预算] 本会话 Token 上限已设为 200,000；已用 12,000', setTokensReceipt);
const queryReceipt = renderReceipt({ kind: 'query' }, 5, 0.32, 12_000, 5_000_000);
check('query receipt reports budget, spend and remainder, then the token line', queryReceipt ===
    '[预算] 本会话预算 5.0000 元，已用 0.3200 元，剩余 4.6800 元\n[预算] Token 上限 5,000,000，已用 12,000', queryReceipt);
const overspentReceipt = renderReceipt({ kind: 'query' }, 1, 3, 12_000, 5_000_000);
check('remainder never goes negative', overspentReceipt.includes('剩余 0.0000 元'), overspentReceipt);
const invalidReceipt = renderReceipt({ kind: 'invalid', reason: '「abc」不是数字' }, 10, 1, 0, 5_000_000);
check('invalid receipt says nothing changed', invalidReceipt.includes('预算没有改动'), invalidReceipt);
check('invalid receipt shows the money usage', invalidReceipt.includes(`\`${COMMAND_PREFIX} 5\``), invalidReceipt);
check('invalid receipt shows the token usage', invalidReceipt.includes(`\`${COMMAND_PREFIX} tokens 200000\``), invalidReceipt);
check('every receipt carries the plugin prefix', [setReceipt, setTokensReceipt, queryReceipt, invalidReceipt].every((r) => r.startsWith('[预算] ')), '4/4 start with [预算]');
// ── 折算后 Token 的回执（缓存命中按 0.1 计）──────────────────────────────────
const weightedQuery = renderReceipt({ kind: 'query' }, 5, 0.32, 120_000, 5_000_000, 12_000);
check('query shows both raw and weighted when they differ', weightedQuery.includes('已用 120,000（折算后 12,000，缓存读取按 0.1 计）'), weightedQuery);
const sameQuery = renderReceipt({ kind: 'query' }, 5, 0.32, 12_000, 5_000_000, 12_000);
check('query stays quiet when weighted equals raw', sameQuery === '[预算] 本会话预算 5.0000 元，已用 0.3200 元，剩余 4.6800 元\n[预算] Token 上限 5,000,000，已用 12,000', sameQuery);
const weightedSetTokens = renderReceipt({ kind: 'set-tokens', tokenBudget: 200_000 }, 5, 0.32, 120_000, 200_000, 12_000);
check('set-tokens receipt also discloses the weighting', weightedSetTokens.includes('已用 120,000（折算后 12,000，缓存读取按 0.1 计）'), weightedSetTokens);
console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`);
if (failed !== 0)
    process.exitCode = 1;
