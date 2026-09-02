import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Types shared between the generated context-composition dataset
 * (`docs/internal/context-dataset.draft.ts`, git-ignored because it carries
 * redacted real-session transcripts) and the harness that consumes it.
 *
 * Keeping these in a committed module lets `run-context.ts` type-check and
 * fail with a friendly message on fresh clones, where the dataset has not
 * been generated yet.
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
	expectation: F9ContextExpectation;
}
