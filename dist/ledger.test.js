// Minimal self-check for the ledger. No test framework: run the compiled file
// with `node dist/ledger.test.js` and read the printed PASS/FAIL lines.
//
// The `./ledger.js` specifier (not `./ledger`) is deliberate: TypeScript maps it
// to `ledger.ts` at compile time, and the emitted ESM keeps the extension Node
// needs at run time.
import { Ledger } from './ledger.js';
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
console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`);
if (failed !== 0)
    process.exitCode = 1;
