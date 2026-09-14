import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Types shared between the generated context-composition dataset
 * (`docs/internal/context-dataset.draft.ts`, git-ignored because it carries
 * redacted real-session transcripts) and the harness that consumes it.
 *
 * Sharing these types (instead of inlining them in the generated draft) lets
 * `run-context.ts` type-check even when the git-ignored dataset has not been
 * generated yet, and fail with a friendly message at runtime.
 */
export type F9ContextExpectation =
	| { kind: "silence" }
	| { kind: "finding"; terms: readonly string[] };

export interface F9ContextItem {
	id: string;
	sourceFile: string;
	budgetTokens: number;
	cursorIndex: number;
	withReasoning: { retainedEntries: number; totalEntries: number; truncated: boolean };
	noReasoning: { retainedEntries: number; totalEntries: number; truncated: boolean };
	entries: readonly SessionEntry[];
	/** `null` until the cut is hand-labeled; `run-context.ts` refuses to start until every item is labeled. */
	expectation: F9ContextExpectation | null;
}
