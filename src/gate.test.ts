// Self-check for the gate: which limit is binding, and is it over.
//
// The cases that matter are the *arming* ones. A token ceiling that fires on a
// session with a healthy price table would cut long legitimate runs short; one
// that never fires on an unpriced session is the bug this module exists to fix.
import { judge } from './gate.js'
import type { GateLimits, GateState } from './gate.js'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1
    console.log(`PASS ${name} — ${detail}`)
  } else {
    failed += 1
    console.log(`FAIL ${name} — ${detail}`)
  }
}

const limits: GateLimits = { budgetCNY: 10, tokenBudget: 1_000_000 }

function state(partial: Partial<GateState>): GateState {
  return { spentCNY: 0, tokens: 0, unpricedCalls: 0, ...partial }
}

console.log('--- gate self-check ---')

// ── money basis only (every call priced) ────────────────────────────────────
const fresh = judge(state({}), limits)
check('fresh session does not trip', fresh.tripped.length === 0, JSON.stringify(fresh.tripped))
check('fresh session: token ceiling is not armed', !fresh.tokenArmed, `tokenArmed=${fresh.tokenArmed}`)
check('fresh session reports 0 ratio', fresh.ratio === 0, `ratio=${fresh.ratio}`)
check('fresh session is judged on money', fresh.tightest === 'money', fresh.tightest)

const half = judge(state({ spentCNY: 5, tokens: 900_000 }), limits)
check('priced session at 50% money does not trip', half.tripped.length === 0, JSON.stringify(half.tripped))
check('priced session at 90% tokens STILL does not arm tokens', !half.tokenArmed, `tokenArmed=${half.tokenArmed}`)
check('priced session ratio is the money ratio', half.ratio === 0.5, `ratio=${half.ratio}`)

const overMoney = judge(state({ spentCNY: 10.0001 }), limits)
check('money over the ceiling trips', overMoney.tripped.includes('money'), JSON.stringify(overMoney.tripped))
check('money exactly at the ceiling trips (>=)', judge(state({ spentCNY: 10 }), limits).tripped.includes('money'), 'spent = budget')
check('money just under the ceiling does not trip', judge(state({ spentCNY: 9.999 }), limits).tripped.length === 0, 'spent = 9.999')

// ── token basis armed by an unpriced call ───────────────────────────────────
// money 1/10 = 0.10 vs tokens 50k/1M = 0.05 → money is the tighter one here.
const armedUnder = judge(state({ spentCNY: 1, tokens: 50_000, unpricedCalls: 1 }), limits)
check('one unpriced call arms the token ceiling', armedUnder.tokenArmed, `tokenArmed=${armedUnder.tokenArmed}`)
check('armed but under both ceilings does not trip', armedUnder.tripped.length === 0, JSON.stringify(armedUnder.tripped))
check('armed session is judged on money while money is tighter', armedUnder.tightest === 'money', armedUnder.tightest)
check('armed ratio reflects the money ratio at 0.1', armedUnder.ratio === 0.1, `ratio=${armedUnder.ratio}`)

// Arming does not by itself change the verdict: 400k/1M = 0.4 becomes the
// reported ratio, and the session is now watched through the token lens.
const armedTokenTighter = judge(state({ spentCNY: 1, tokens: 400_000, unpricedCalls: 1 }), limits)
check('once tokens are fuller than money, tightest flips to tokens', armedTokenTighter.tightest === 'tokens', armedTokenTighter.tightest)
check('ratio follows the tighter (token) basis', armedTokenTighter.ratio === 0.4, `ratio=${armedTokenTighter.ratio}`)
check('still not tripped at 40%', armedTokenTighter.tripped.length === 0, JSON.stringify(armedTokenTighter.tripped))

const armedOver = judge(state({ spentCNY: 1, tokens: 1_000_000, unpricedCalls: 3 }), limits)
check('token ceiling reached trips', armedOver.tripped.includes('tokens'), JSON.stringify(armedOver.tripped))
check('token ceiling at exactly the limit trips (>=)', armedOver.tripped.includes('tokens'), 'tokens = 1,000,000')
check('armed session is judged on tokens once tokens are tighter', armedOver.tightest === 'tokens', armedOver.tightest)
check('ratio is the token ratio at 1.0', armedOver.ratio === 1, `ratio=${armedOver.ratio}`)

// A session can be over both at once — the caller needs both names, not just one.
const overBoth = judge(state({ spentCNY: 12, tokens: 2_000_000, unpricedCalls: 1 }), limits)
check('over both ceilings reports both', overBoth.tripped.length === 2, JSON.stringify(overBoth.tripped))
check('over both: tightest is tokens (ratio 2.0 vs 1.2)', overBoth.tightest === 'tokens', overBoth.tightest)
check('over both: ratio is the larger one', overBoth.ratio === 2, `ratio=${overBoth.ratio}`)

// ── degenerate inputs ───────────────────────────────────────────────────────
const zeroTokenCeiling = judge(state({ tokens: 5_000_000, unpricedCalls: 1 }), { budgetCNY: 10, tokenBudget: 0 })
check('a zero token ceiling is not armed (mis-set config cannot stop everything)', !zeroTokenCeiling.tokenArmed, `tokenArmed=${zeroTokenCeiling.tokenArmed}`)

const zeroMoneyBudget = judge(state({ spentCNY: 1 }), { budgetCNY: 0, tokenBudget: 1_000_000 })
check('a zero money budget yields a finite ratio', Number.isFinite(zeroMoneyBudget.ratio), `ratio=${zeroMoneyBudget.ratio}`)
check('a zero money budget trips on any spend', zeroMoneyBudget.tripped.includes('money'), JSON.stringify(zeroMoneyBudget.tripped))

// Tie-break: money wins at equal ratios, because money is the number the user typed.
const tie = judge(state({ spentCNY: 5, tokens: 500_000, unpricedCalls: 1 }), limits)
check('equal ratios tie-break to money', tie.tightest === 'money', `ratio=${tie.ratio}, tightest=${tie.tightest}`)

console.log(`--- RESULT: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${passed} passed, ${failed} failed) ---`)
if (failed > 0) process.exitCode = 1
