// Minimal self-check for the price layer. No test framework: run the compiled
// file with `node dist/pricing.test.js` and read the printed PASS/FAIL lines.
//
// The `./pricing.js` / `./ledger.js` specifiers (not extension-less) are
// deliberate: TypeScript maps them to `.ts` at compile time, and the emitted
// ESM keeps the extension Node needs at run time.

import { calculateCost, isPeakHour, UNKNOWN_PRICE } from './pricing.js'
import type { UsageSample } from './ledger.js'

// 1M uncached input + 1M output, no cache traffic.
const oneMillionEach: UsageSample = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

console.log('--- pricing self-check ---')
console.log('usage:', JSON.stringify(oneMillionEach))

const peakFlash = calculateCost('deepseek-official', 'deepseek-flash', oneMillionEach, true)
console.log('case 1 calculateCost(deepseek-official, deepseek-flash, peak) =', peakFlash)

const offPeakFlash = calculateCost('deepseek-official', 'deepseek-flash', oneMillionEach, false)
console.log('case 2 calculateCost(deepseek-official, deepseek-flash, off-peak) =', offPeakFlash)

const unknown = calculateCost('deepseek-official', 'no-such-model', oneMillionEach, true)
console.log('case 3 calculateCost(deepseek-official, no-such-model, peak) =', unknown)

// The spec asks for exactly three cases; `isPeakHour` is imported because the
// price table's window selection depends on it, so its boundaries are asserted
// here too rather than left unexercised.
const peakWednesday = isPeakHour(new Date('2026-10-07T02:00:00Z')) // 北京 周三 10:00
const saturdayMorning = isPeakHour(new Date('2026-10-10T02:00:00Z')) // 北京 周六 10:00
console.log('extra isPeakHour 2026-10-07T02:00:00Z (周三 10:00 北京) =', peakWednesday)
console.log('extra isPeakHour 2026-10-10T02:00:00Z (周六 10:00 北京) =', saturdayMorning)

let failed = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`)
}

check('case 1 flash peak = 2.0 + 8.0 = 10.0', peakFlash === 10.0, `${peakFlash} (want 10)`)
check('case 2 flash off-peak = 1.0 + 4.0 = 5.0', offPeakFlash === 5.0, `${offPeakFlash} (want 5)`)
check('case 3 unknown model = -1', unknown === UNKNOWN_PRICE, `${unknown} (want ${UNKNOWN_PRICE})`)
check('extra isPeakHour 周三 10:00 = true', peakWednesday === true, `${peakWednesday}`)
check('extra isPeakHour 周六 10:00 = false', saturdayMorning === false, `${saturdayMorning}`)

console.log(failed === 0 ? '--- RESULT: ALL PASS ---' : `--- RESULT: ${failed} FAILED ---`)
if (failed !== 0) process.exitCode = 1
