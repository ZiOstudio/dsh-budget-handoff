// Minimal self-check for the ledger. No test framework: run the compiled file
// with `node dist/ledger.test.js` and read the printed PASS/FAIL lines.
//
// The `./ledger.js` specifier (not `./ledger`) is deliberate: TypeScript maps it
// to `ledger.ts` at compile time, and the emitted ESM keeps the extension Node
// needs at run time.
import { CACHE_READ_WEIGHT, Ledger } from './ledger.js';
const session = 'session-test-0001';
const ledger = new Ledger();
// Two hand-built samples standing in for two `assistant/message` events.
const first = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
};
const second = {
    inputTokens: 400,
    outputTokens: 80,
    cacheReadTokens: 9000,
};
console.log('--- ledger self-check ---');
console.log('sample #1:', JSON.stringify(first));
console.log('sample #2:', JSON.stringify(second));
const afterFirst = ledger.record(session, 'deepseek', 'deepseek-chat', first);
console.log('after record #1:', JSON.stringify(afterFirst));
const afterSecond = ledger.record(session, 'deepseek', 'deepseek-chat', second);
console.log('after record #2:', JSON.stringify(afterSecond));
const missing = ledger.get('session-does-not-exist');
console.log('get(missing):', JSON.stringify(missing));
const all = ledger.getAll();
console.log('getAll():', JSON.stringify(all));
// Expected accumulation across the two disjoint buckets.
const expected = {
    uncachedInputTokens: 1400,
    cacheReadTokens: 14000,
    cacheWriteTokens: 100,
    outputTokens: 280,
    reasoningTokens: 50,
    totalTokens: 15780,
    // 1400 + 14000*0.1 + 100 + 280 —— 缓存命中只按十分之一计入闸门口径。
    effectiveTokens: 1400 + 14000 * CACHE_READ_WEIGHT + 100 + 280,
};
const actual = ledger.get(session);
let failed = 0;
function check(label, ok, detail) {
    if (!ok)
        failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`);
}
check('uncachedInputTokens 1000+400', actual?.uncachedInputTokens === expected.uncachedInputTokens, `${actual?.uncachedInputTokens} (want ${expected.uncachedInputTokens})`);
check('cacheReadTokens 5000+9000', actual?.cacheReadTokens === expected.cacheReadTokens, `${actual?.cacheReadTokens} (want ${expected.cacheReadTokens})`);
check('cacheWriteTokens 100+absent', actual?.cacheWriteTokens === expected.cacheWriteTokens, `${actual?.cacheWriteTokens} (want ${expected.cacheWriteTokens})`);
check('outputTokens 200+80', actual?.outputTokens === expected.outputTokens, `${actual?.outputTokens} (want ${expected.outputTokens})`);
check('reasoningTokens 50+absent', actual?.reasoningTokens === expected.reasoningTokens, `${actual?.reasoningTokens} (want ${expected.reasoningTokens})`);
check('totalTokens = 1400+14000+100+280', actual?.totalTokens === expected.totalTokens, `${actual?.totalTokens} (want ${expected.totalTokens})`);
check('get(missing) is null', missing === null, `${JSON.stringify(missing)}`);
check('getAll() has 1 entry', all.length === 1, `length=${all.length}`);
check('record returns the same object as get()', afterSecond === actual, `${afterSecond === actual}`);
// ── 缓存折算 ────────────────────────────────────────────────────────────────
check('effectiveTokens weights cache reads', actual?.effectiveTokens === expected.effectiveTokens, `${actual?.effectiveTokens} (want ${expected.effectiveTokens})`);
check('effectiveTokens < totalTokens when cache reads exist', (actual?.effectiveTokens ?? 0) < (actual?.totalTokens ?? 0), `${actual?.effectiveTokens} < ${actual?.totalTokens}`);
// ── restore：把盘上的记录装回来，并且不信盘上的折算值 ─────────────────────────
const restored = new Ledger();
restored.restore({
    ...actual,
    // 故意写一个错误值：restore 必须重算，而不是照抄。
    effectiveTokens: 999_999,
});
const restoredRecord = restored.get(session);
check('restore recomputes effectiveTokens', restoredRecord?.effectiveTokens === expected.effectiveTokens, `${restoredRecord?.effectiveTokens} (want ${expected.effectiveTokens})`);
check('restore keeps raw buckets intact', restoredRecord?.totalTokens === expected.totalTokens, `${restoredRecord?.totalTokens} (want ${expected.totalTokens})`);
// restore 之后再 record，必须在这条基线之上累加，而不是从零开始。
const onTop = restored.record(session, 'deepseek', 'deepseek-chat', { inputTokens: 10, outputTokens: 0 });
check('record after restore accumulates', onTop.uncachedInputTokens === expected.uncachedInputTokens + 10, `${onTop.uncachedInputTokens} (want ${expected.uncachedInputTokens + 10})`);
console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`);
if (failed !== 0)
    process.exitCode = 1;
