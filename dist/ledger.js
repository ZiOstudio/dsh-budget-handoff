// dsh-budget-handoff — session usage ledger.
//
// Pure data + arithmetic: cumulative token accounting per session. No cordis,
// no I/O, no pricing (the price layer is a later module).
//
// Dependency note: this module intentionally imports NOTHING. The upstream
// `TokenUsage` shape lives in `@deepseek-ai/dsh-llm`
// (`lib/types/types.d.ts:160-174`), which is NOT a declared dependency of this
// plugin, so `UsageSample` below mirrors it structurally instead of importing
// it. When the plugin later takes `@deepseek-ai/dsh-llm` as a real dependency,
// `UsageSample` can be replaced by `TokenUsage` with no other change.
/**
 * How much one cache-read token counts toward the token ceiling.
 *
 * WHY NOT 1.0: DeepSeek bills a cache hit at 0.02 元 / 1M against 1.0 元 / 1M for
 * a miss (see `pricing.json`) — a 50× discount. Counting a cached token the same
 * as a fresh one makes the token ceiling a liar in the other direction: a long
 * cached conversation reaches "5,000,000 tokens" while having cost a few 分.
 *
 * WHY 0.1 AND NOT 0.02: the ceiling is a magnitude guard, not an invoice. The
 * exact 1/50 ratio would let a session with huge cached context run to a hundred
 * million raw tokens before the guard moved, which is the failure mode the
 * ceiling exists to prevent. 0.1 keeps cache reads cheap without making them
 * free: a 10× discount, deliberately conservative.
 */
export const CACHE_READ_WEIGHT = 0.1;
/**
 * In-memory cumulative token ledger, keyed by session id.
 *
 * One `Ledger` instance serves the whole plugin; every `session/event` →
 * `assistant/message` sample is folded in with {@link Ledger.record}.
 */
export class Ledger {
    bySession = new Map();
    /**
     * Fold one usage sample into a session's running total.
     *
     * @param sessionId - session the sample belongs to.
     * @param provider - `assistant/message.message.source.provider`.
     * @param model - `assistant/message.message.source.model`.
     * @param usage - the event's `usage` (`TokenUsage`).
     * @returns the session's updated cumulative record.
     */
    record(sessionId, provider, model, usage) {
        const previous = this.bySession.get(sessionId);
        const uncachedInputTokens = (previous?.uncachedInputTokens ?? 0) + usage.inputTokens;
        const cacheReadTokens = (previous?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
        const cacheWriteTokens = (previous?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        const outputTokens = (previous?.outputTokens ?? 0) + usage.outputTokens;
        const reasoningTokens = (previous?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
        // Derived from the disjoint buckets rather than copying `usage.totalTokens`:
        // the upstream field is optional and may be absent or inconsistent, while the
        // bucket sum is always defined and matches what the provider bills.
        const totalTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
        // Same sum, but cache reads at their discounted weight. Kept as a running
        // sum of the same buckets so it can never drift from `totalTokens`.
        const effectiveTokens = uncachedInputTokens + cacheReadTokens * CACHE_READ_WEIGHT + cacheWriteTokens + outputTokens;
        const next = {
            sessionId,
            provider,
            model,
            uncachedInputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens,
            reasoningTokens,
            totalTokens,
            effectiveTokens,
            updatedAt: Date.now(),
        };
        this.bySession.set(sessionId, next);
        return next;
    }
    /**
     * Read one session's cumulative record.
     *
     * @param sessionId - session to look up.
     * @returns the record, or `null` when nothing was recorded for that session.
     */
    get(sessionId) {
        return this.bySession.get(sessionId) ?? null;
    }
    /**
     * Install a previously persisted record, replacing any in-memory one.
     *
     * Used once per session at startup to undo the "restart wipes the ledger"
     * behaviour: the numbers on disk are the truth, and everything recorded
     * afterwards folds on top of them via {@link Ledger.record}.
     *
     * `effectiveTokens` is recomputed rather than trusted: a record written by an
     * older build (or hand-edited) may not carry the field, and a missing weight
     * would silently make the ceiling judge raw tokens again.
     *
     * @param usage - the record to install; `sessionId` is the key.
     */
    restore(usage) {
        const effectiveTokens = usage.uncachedInputTokens +
            usage.cacheReadTokens * CACHE_READ_WEIGHT +
            usage.cacheWriteTokens +
            usage.outputTokens;
        this.bySession.set(usage.sessionId, { ...usage, effectiveTokens });
    }
    /**
     * Snapshot every session's cumulative record.
     *
     * @returns a fresh array (insertion order); empty when nothing was recorded.
     */
    getAll() {
        return [...this.bySession.values()];
    }
}
