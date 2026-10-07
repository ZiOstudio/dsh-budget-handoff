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
     * Snapshot every session's cumulative record.
     *
     * @returns a fresh array (insertion order); empty when nothing was recorded.
     */
    getAll() {
        return [...this.bySession.values()];
    }
}
