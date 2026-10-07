// dsh-budget-handoff — offline price table + cost arithmetic.
//
// UNITS: every number in `pricing.json` (and therefore in every `PriceBucket`
// below) is CNY 人民币元 per 1,000,000 tokens.
//
// TIME MODEL (from the official DeepSeek pricing page):
//   - Peak (高峰): Beijing time (UTC+8), Monday–Friday, 09:00–12:00 and 14:00–18:00.
//   - Off-peak (空闲): every other moment.
//   - Chinese statutory holidays are NOT modelled (deliberate simplification;
//     the rule is only weekday + wall-clock, as agreed for this iteration).
//   - The windows are half-open: [09:00, 12:00) and [14:00, 18:00), so exactly
//     12:00:00 and 18:00:00 count as off-peak.
//
// LEGACY MODEL NAMES: DeepSeek still accepts the retired names
// `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`; such requests are
// served by the current Flash model and billed at the Flash price, so the table
// carries them as aliases with buckets identical to `deepseek-flash`.
//
// UNKNOWN-MODEL POLICY: an unrecognised provider or model is NOT an error and
// NOT a zero cost — it returns the sentinel `UNKNOWN_PRICE` (-1) so callers can
// print "price unknown" and skip accounting instead of silently billing 0.
//
// This module is pure: no cordis, no I/O, no clock of its own (`isPeakHour`
// takes the Date it should judge).

import priceTable from './pricing.json' with { type: 'json' }
import type { UsageSample } from './ledger.js'

/** Price for one billing bucket in each of the two windows (CNY / 1M tokens). */
export interface PriceBucket {
  /** 空闲时段单价（元 / 百万 token）。 */
  offPeak: number
  /** 高峰时段单价（元 / 百万 token）。 */
  peak: number
}

/**
 * Price of one model: cached reads and cache misses are the two input tiers the
 * official page publishes; there is no separate cache-write tier.
 */
export interface ModelPrice {
  /** 缓存命中（cache read）输入单价。 */
  cacheRead: PriceBucket
  /** 缓存未命中（cache miss）输入单价；缓存写入也按此价计。 */
  cacheMiss: PriceBucket
  /** 输出单价。 */
  output: PriceBucket
}

/** Whole table: provider → model → price. */
export type PriceTable = Record<string, Record<string, ModelPrice>>

/** Sentinel returned by {@link calculateCost} when the route is not priced. */
export const UNKNOWN_PRICE = -1

/**
 * Price table loaded verbatim from `src/pricing.json`.
 *
 * The annotation is what makes the JSON's inferred literal type usable as a
 * `PriceTable`: the import itself carries `"deepseek-flash"` etc. as strings, so
 * `table[provider]` would otherwise be a lookup on a literal-only object.
 */
const table: PriceTable = priceTable

/** Milliseconds of the Beijing (UTC+8) offset; no DST, so this is exact. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Decide whether a moment falls in the DeepSeek peak billing window.
 *
 * @param date - the moment to judge (its instant is what matters, not the local
 *   zone of the caller: the input is converted to Beijing wall-clock time).
 * @returns `true` for Monday–Friday 09:00–12:00 / 14:00–18:00 Beijing time,
 *   `false` for everything else (weekends, nights, lunch break, holidays).
 */
export function isPeakHour(date: Date): boolean {
  // Shift the instant by +8h and then read it back as UTC: the UTC getters now
  // report Beijing wall-clock fields without depending on the host TZ.
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS)
  const weekday = beijing.getUTCDay() // 0 = Sunday … 6 = Saturday
  if (weekday === 0 || weekday === 6) return false

  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const inWindow = (startHour: number, endHour: number): boolean =>
    minutes >= startHour * 60 && minutes < endHour * 60

  return inWindow(9, 12) || inWindow(14, 18)
}

/**
 * Cost in CNY of one usage sample on one route.
 *
 * `cost = uncachedInput/1e6 * cacheMiss + cacheRead/1e6 * cacheRead
 *        + cacheWrite/1e6 * cacheMiss + output/1e6 * output`
 * with every tier taken from the peak or off-peak column as given.
 *
 * Cache writes are billed at the cache-miss tier because the official page
 * publishes only two input tiers (hit / miss); if DeepSeek later adds a
 * dedicated cache-write price, only this function changes.
 *
 * @param provider - e.g. `deepseek-official`.
 * @param model - e.g. `deepseek-flash`.
 * @param usage - the call's token counts (`TokenUsage` shape).
 * @param isPeak - the window to price against; use {@link isPeakHour}.
 * @returns the cost in CNY rounded to 6 decimals, or {@link UNKNOWN_PRICE}
 *   (-1) when the provider/model pair is absent from the table.
 */
export function calculateCost(
  provider: string,
  model: string,
  usage: UsageSample,
  isPeak: boolean,
): number {
  const window: keyof PriceBucket = isPeak ? 'peak' : 'offPeak'

  const modelPrice: ModelPrice | undefined = table[provider]?.[model]
  if (modelPrice === undefined) return UNKNOWN_PRICE

  const cost =
    (usage.inputTokens / 1_000_000) * modelPrice.cacheMiss[window] +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * modelPrice.cacheRead[window] +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * modelPrice.cacheMiss[window] +
    (usage.outputTokens / 1_000_000) * modelPrice.output[window]

  // Keep 6 decimals so that summing many calls does not drift; display rounds
  // to 4 decimals at the call site.
  return Math.round(cost * 1_000_000) / 1_000_000
}
