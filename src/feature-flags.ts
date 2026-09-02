/**
 * Opt-in Advisor feature flags.
 *
 * Flags are environment variables rather than WATCHDOG.yml policy on purpose:
 * they change how Advisor interprets Executor context, not what the user
 * asked Advisor to review, and they exist so an experience can be measured
 * and rolled back without a configuration migration. Every flag defaults to
 * off and changes nothing when unset.
 */

/**
 * No-reasoning context feature: `PI_ADVISOR_NO_REASONING=1`.
 *
 * When enabled, Executor reasoning ("thinking") blocks are excluded from the
 * bounded Advisor context windows — per-update deltas and lifecycle/config
 * re-prime snapshots alike. The freed byte budget admits more Executor
 * history under the same token ceiling. The context-composition experiment
 * (docs/f9-evaluation.md, 2026-09-02) confirmed the mechanism — roughly 58%
 * more retained Executor entries at the same budget — but could not resolve
 * an accuracy difference, so this remains an opt-in experience and the
 * default rendering is unchanged.
 */
export const NO_REASONING_FLAG = "PI_ADVISOR_NO_REASONING";

export function isNoReasoningRenderEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[NO_REASONING_FLAG] === "1";
}
