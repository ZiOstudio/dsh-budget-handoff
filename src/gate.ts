// dsh-budget-handoff — which limit is binding, and are we past it.
//
// WHY THIS MODULE EXISTS
// The budget gate used to answer exactly one question: "累计金额 ≥ 预算了吗".
// That question has no answer when the price table does not cover the model the
// session is actually calling — `calculateCost` returns `UNKNOWN_PRICE`, the CNY
// total stops moving, and the gate silently stops being a gate.
//
// Tokens are the only quantity that exists for *every* call, priced or not
// (`TokenUsage` is reported by the provider regardless of our table). So the
// gate gets a second basis: a per-session token ceiling. It arms **only** once
// the session has seen an unpriced call — i.e. exactly when money stopped being
// trustworthy. A session whose every call was priced keeps behaving as before,
// so long legitimate runs are not cut short by a number they never needed.
//
// Pure: no cordis, no I/O, no clock. Both the 80% warning and the stop gate ask
// this module, so the two can never disagree about "how close are we".

/** What a session has consumed so far. */
export interface GateState {
  /** Cumulative spend in CNY, counting only the calls the price table covers. */
  spentCNY: number
  /** Cumulative billed tokens, counting every call (priced and unpriced). */
  tokens: number
  /** How many calls this session made that the price table could not price. */
  unpricedCalls: number
}

/** The two ceilings a session is judged against. */
export interface GateLimits {
  /** Per-session money ceiling, CNY. */
  budgetCNY: number
  /** Per-session token ceiling; only consulted when {@link GateState.unpricedCalls} > 0. */
  tokenBudget: number
}

/** Which basis a judgement came from. */
export type GateBasis = 'money' | 'tokens'

/** The verdict for one session at one moment. */
export interface GateVerdict {
  /** Limits already reached. Empty = keep going. Both = money and tokens are both over. */
  tripped: GateBasis[]
  /** How full the tighter limit is (may exceed 1). Drives the 80% warning. */
  ratio: number
  /** Which limit is tighter right now. */
  tightest: GateBasis
  /** Whether the token ceiling is in play (the session has unpriced calls). */
  tokenArmed: boolean
}

/**
 * Judge one session against its limits.
 *
 * @param state - cumulative usage (see {@link GateState}).
 * @param limits - the session's ceilings.
 * @returns the verdict; `tripped.length === 0` means the step may proceed.
 */
export function judge(state: GateState, limits: GateLimits): GateVerdict {
  // A zero/negative money budget is not a thing the schema allows, but a guard
  // here keeps a mis-set config from turning the ratio into Infinity.
  const moneyRatio = limits.budgetCNY > 0 ? state.spentCNY / limits.budgetCNY : 0

  // The token ceiling is armed by *evidence that money is undercounted*, not by
  // configuration alone — see the module header.
  const tokenArmed = state.unpricedCalls > 0 && limits.tokenBudget > 0
  const tokenRatio = tokenArmed ? state.tokens / limits.tokenBudget : 0

  const tripped: GateBasis[] = []
  if (state.spentCNY >= limits.budgetCNY) tripped.push('money')
  if (tokenArmed && state.tokens >= limits.tokenBudget) tripped.push('tokens')

  // Strict `>`: on a tie the money basis wins, because that is the number the
  // user set and the number the receipt shows.
  const tightest: GateBasis = tokenRatio > moneyRatio ? 'tokens' : 'money'

  return {
    tripped,
    ratio: Math.max(moneyRatio, tokenRatio),
    tightest,
    tokenArmed,
  }
}
