/**
 * Advisor context feature flags.
 *
 * Flags are environment variables rather than WATCHDOG.yml policy on purpose:
 * they change how Advisor interprets Executor context, not what the user
 * asked Advisor to review, and they exist so an experience can be measured
 * and rolled back without a configuration migration. The two context
 * features below default to ON; set the flag to `0` to explicitly opt out.
 */

/**
 * No-reasoning context feature: on by default; `PI_ADVISOR_NO_REASONING=0` opts out.
 *
 * Executor reasoning ("thinking") blocks are excluded from the bounded
 * Advisor context windows — per-update deltas and lifecycle/config re-prime
 * snapshots alike. The freed byte budget admits ~58% more Executor history
 * under the same token ceiling (context-composition experiment,
 * docs/internal/context-evaluation.md, 2026-09-02, appendices 1-6);
 * truncating turns cost +10.6% tokens from denser refill, while
 * non-truncating turns spend ~28% fewer input tokens. Set to `0` to restore
 * reasoning blocks in rendered context.
 */
export const NO_REASONING_FLAG = "PI_ADVISOR_NO_REASONING";

export function isNoReasoningRenderEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[NO_REASONING_FLAG] !== "0";
}

/**
 * Old-turn history compression: on by default; `PI_ADVISOR_HISTORY_COMPRESSION=0` opts out.
 *
 * Deterministic pi-vcc-style compression of the advisor nested session
 * (`src/history-compaction.ts`): review cycles older than the most recent one
 * are replaced by a bounded summary block (advise outcomes with findingKey,
 * unresolved error-register lines, breadcrumbs preserved). Fires in
 * `maintainContextPolicy` as the first response to an over-limit context — it
 * replaces the LLM compaction reset (same one-time cache miss, minus the LLM
 * call and its nondeterminism) and roughly halves nested-session growth.
 * Measured: turn-4 prompt 41–52% of full history with no accuracy cost
 * (docs/internal/context-evaluation.md, appendix 11).
 */
export const HISTORY_COMPRESSION_FLAG = "PI_ADVISOR_HISTORY_COMPRESSION";

export function isHistoryCompressionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[HISTORY_COMPRESSION_FLAG] !== "0";
}

/**
 * Quiescence-aware review triggering (always on, no opt-out).
 *
 * A material Executor turn that ends with stopReason "toolUse" is mid-burst —
 * the next turn lands within seconds (measured p50 ≈ 11s), so a review started
 * there almost always gets superseded before finishing (64% of review starts
 * over a 5-day window, burning ~36% of all fresh input tokens on aborted
 * attempts). Such updates are held and coalesced until a turn ends without
 * toolUse (Executor paused) or until the hold cap below expires, whichever
 * comes first. Coverage is unchanged: the coalesced update still carries every
 * held turn, so the same evidence is reviewed exactly once instead of in N
 * aborted attempts plus one final review.
 *
 * The 90s default bounds evidence staleness during long uninterrupted bursts:
 * a completed review already takes on the order of 1–2 minutes, so the cap
 * adds less latency than the review itself while eliminating most doomed
 * mid-burst starts.
 *
 * `PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS` overrides the hold cap in integer
 * milliseconds: `0` disables quiescence holding entirely, positive values are
 * clamped to [1ms, 1h]. It exists for tests and emergency rollback, not as a
 * supported tuning knob.
 */
export const DEFAULT_QUIESCENCE_HOLD_MAX_MS = 90_000;

const MAX_QUIESCENCE_HOLD_MAX_MS = 3_600_000;
const QUIESCENCE_HOLD_MAX_MS_FLAG = "PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS";

export function quiescenceHoldMaxMs(environment: NodeJS.ProcessEnv = process.env): number {
	const raw = environment[QUIESCENCE_HOLD_MAX_MS_FLAG];
	if (raw === undefined) return DEFAULT_QUIESCENCE_HOLD_MAX_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_QUIESCENCE_HOLD_MAX_MS;
	if (parsed === 0) return 0;
	return Math.min(Math.max(parsed, 1), MAX_QUIESCENCE_HOLD_MAX_MS);
}
