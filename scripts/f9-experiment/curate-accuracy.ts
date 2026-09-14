/**
 * Accuracy comparison corpus generator (injection-based, arm-fair).
 *
 * Fixes the flaw found in the first accuracy test: the live cadence run fed
 * BOTH arms the same pre-rendered update_text, so the no-reasoning difference
 * never reached the model input. Here every item carries RAW SessionEntry[]
 * and the runner renders per-arm with the production renderer
 * (`renderAdvisorDelta` + includeReasoning per arm).
 *
 * For each ctx cut (truncating at 80,000 bytes / 20,000 tokens) we emit up to
 * four variants:
 *   - `clean`: no injection — both arms expect silence.
 *   - `reasoning`: inject a verifiable defect signature into a recent
 *     assistant `thinking` block — `old` (includeReasoning=true) sees it and
 *     must hit; `new` strips reasoning so it cannot see it and must stay
 *     silent. Tests whether reasoning carries detection signal.
 *   - `toolresult`: inject the signature into a recent toolResult body — both
 *     arms see it and must hit. Baseline that injection is detectable.
 *   - `tail`: inject into an entry that the `old` window truncates away but
 *     the `new` window retains (no-reasoning admits ~58% more history) — `new`
 *     must hit, `old` cannot see it. Tests the retention benefit.
 *
 * Expectations are computed PER ARM from the rendered delta (signature present
 * => finding with the signature term; absent => silence), so the corpus is not
 * biased toward either arm — the injection zone determines visibility, and the
 * verdict rewards each arm only for what it actually sees.
 *
 * Run: `bun scripts/f9-experiment/curate-accuracy.ts`
 * Output: docs/internal/accuracy-corpus.jsonl (git-ignored)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { renderAdvisorDelta } from "../../src/transcript.js";
import { isStringValue } from "../../src/value-guards.js";

const BUDGET_TOKENS = 20_000; // WATCHDOG context.maxUpdateTokens
const SIGNATURE = "INJECTED_DEFECT_audit_v7_downgrade_14_203_rows_no_backup";

interface AccuracyItem {
	id: string;
	sourceCut: string;
	variant: "clean" | "reasoning" | "toolresult" | "tail";
	budgetTokens: number;
	entries: unknown[];
	/** Per-arm expectation derived from what that arm's rendered delta shows. */
	expectation: {
		old: { kind: "silence" } | { kind: "finding"; terms: string[] };
		new: { kind: "silence" } | { kind: "finding"; terms: string[] };
	};
	/** Which arm actually sees the signature in its rendered window. */
	visibleIn: { old: boolean; new: boolean };
}

interface ContentPart {
	type?: string;
	thinking?: string;
	text?: string;
}

interface TailInjection {
	entries: Entry[];
	index: number;
}
interface EntryMessage {
	role?: string;
	content?: ContentPart[];
	toolName?: string;
}
interface Entry {
	type?: string;
	id?: string;
	parentId?: string;
	timestamp?: unknown;
	message?: EntryMessage;
}

/** Clone an entry at index i, rewriting its message content to the new array. */
function withContent(entries: Entry[], index: number, content: ContentPart[]): Entry[] {
	const target = entries[index];
	if (target?.message === undefined) return entries;
	return entries.map((entry, i) =>
		i === index ? { ...entry, message: { ...target.message, content } } : entry,
	);
}

function injectReasoning(entries: Entry[]): Entry[] {
	let index = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const content = entries[i]?.message?.content;
		if (!Array.isArray(content)) continue;
		if (content.some((p) => p.type === "thinking")) {
			index = i;
			break;
		}
	}
	if (index < 0) return entries;
	const target = entries[index];
	if (target?.message === undefined) return entries;
	const content = target.message.content ?? [];
	return withContent(
		entries,
		index,
		content.map((p) =>
			p.type === "thinking" && isStringValue(p.thinking)
				? { ...p, thinking: `[DEFECT] ${SIGNATURE}. ${p.thinking}` }
				: p,
		),
	);
}

function injectToolResult(entries: Entry[]): Entry[] {
	let index = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.message?.role === "toolResult") {
			index = i;
			break;
		}
	}
	if (index < 0) return entries;
	const target = entries[index];
	if (target?.message === undefined) return entries;
	const content = target.message.content ?? [];
	return withContent(entries, index, [{ type: "text", text: `[DEFECT] ${SIGNATURE}` }, ...content]);
}

/**
 * Inject into an entry that the OLD window drops (truncation) but NEW retains.
 * Compute both arms' retained tail AFTER injection by scanning backward:
 * choose the newest index i such that old-render drops the entry at i and
 * new-render keeps it.
 */
function injectTail(entries: Entry[]): TailInjection {
	for (let i = entries.length - 5; i >= 0; i--) {
		const target = entries[i];
		if (target?.message === undefined) continue;
		const content = target.message.content ?? [];
		const candidate = withContent(entries, i, [
			{ type: "text", text: `[DEFECT] ${SIGNATURE}` },
			...content,
		]);
		// SAFETY: dataset entries are SessionEntry objects serialized verbatim by
		// collect-corpus.ts; renderAdvisorDelta reads them defensively.
		const oldRendered = renderAdvisorDelta(candidate as never, BUDGET_TOKENS, {
			includeReasoning: true,
		});
		const newRendered = renderAdvisorDelta(
			// SAFETY: same verbatim dataset entries as the old-arm render above.
			candidate as never,
			BUDGET_TOKENS,
			{ includeReasoning: false },
		);
		const oldSees = oldRendered.text.includes(SIGNATURE);
		const newSees = newRendered.text.includes(SIGNATURE);
		if (!oldSees && newSees) return { entries: candidate, index: i };
	}
	return { entries, index: -1 };
}

function renderedSees(entries: Entry[], includeReasoning: boolean): boolean {
	// SAFETY: dataset entries are SessionEntry objects serialized verbatim by
	// collect-corpus.ts; renderAdvisorDelta reads them defensively.
	const rendered = renderAdvisorDelta(entries as never, BUDGET_TOKENS, { includeReasoning });
	return rendered.text.includes(SIGNATURE);
}

function expectationFrom(
	visible: boolean,
): { kind: "silence" } | { kind: "finding"; terms: string[] } {
	return visible ? { kind: "finding", terms: [SIGNATURE.toLowerCase()] } : { kind: "silence" };
}

async function main(): Promise<void> {
	const datasetPath = join("docs", "internal", "context-dataset.draft.ts");
	// SAFETY: the dataset module is generated by collect-corpus.ts with one known
	// named export; the dynamically imported namespace is untyped, so the shape
	// is asserted defensively and every read is null-guarded (`?? []`).
	const module = (await import(pathToFileURL(datasetPath).href)) as {
		F9_CONTEXT_DATASET?: readonly {
			id: string;
			entries: readonly unknown[];
			expectation: { kind: string };
		}[];
	};
	const cuts = module.F9_CONTEXT_DATASET ?? [];
	if (cuts.length === 0) {
		console.error("[curate] no ctx cuts found; run collect-corpus first");
		process.exitCode = 1;
		return;
	}
	console.log(`[curate] ${String(cuts.length)} ctx cuts`);

	const items: AccuracyItem[] = [];
	for (const cut of cuts) {
		// SAFETY: dataset entries are SessionEntry objects serialized verbatim by
		// collect-corpus.ts from real session files; Entry is a read-only optional-
		// field view of that shape and every access below is guarded.
		const base = cut.entries as Entry[];
		// 1. clean
		items.push({
			id: `${cut.id}-clean`,
			sourceCut: cut.id,
			variant: "clean",
			budgetTokens: BUDGET_TOKENS,
			entries: base,
			expectation: { old: { kind: "silence" }, new: { kind: "silence" } },
			visibleIn: { old: false, new: false },
		});
		// 2. reasoning-zone injection
		const reasoning = injectReasoning(base);
		if (reasoning !== base) {
			const oldSees = renderedSees(reasoning, true);
			const newSees = renderedSees(reasoning, false);
			items.push({
				id: `${cut.id}-reasoning`,
				sourceCut: cut.id,
				variant: "reasoning",
				budgetTokens: BUDGET_TOKENS,
				entries: reasoning,
				expectation: { old: expectationFrom(oldSees), new: expectationFrom(newSees) },
				visibleIn: { old: oldSees, new: newSees },
			});
		}
		// 3. toolResult-zone injection
		const tool = injectToolResult(base);
		if (tool !== base) {
			const oldSees = renderedSees(tool, true);
			const newSees = renderedSees(tool, false);
			items.push({
				id: `${cut.id}-toolresult`,
				sourceCut: cut.id,
				variant: "toolresult",
				budgetTokens: BUDGET_TOKENS,
				entries: tool,
				expectation: { old: expectationFrom(oldSees), new: expectationFrom(newSees) },
				visibleIn: { old: oldSees, new: newSees },
			});
		}
		// 4. tail-zone injection (retained only by new's freed budget)
		const tail = injectTail(base);
		if (tail.index >= 0) {
			const oldSees = renderedSees(tail.entries, true);
			const newSees = renderedSees(tail.entries, false);
			if (oldSees && newSees) {
				console.log(
					`[curate] ${cut.id}-tail: injection surfaced in both arms; skipping (not a tail-only case)`,
				);
			} else {
				items.push({
					id: `${cut.id}-tail`,
					sourceCut: cut.id,
					variant: "tail",
					budgetTokens: BUDGET_TOKENS,
					entries: tail.entries,
					expectation: { old: expectationFrom(oldSees), new: expectationFrom(newSees) },
					visibleIn: { old: oldSees, new: newSees },
				});
			}
		}
	}

	const outputPath = join("docs", "internal", "accuracy-corpus.jsonl");
	await mkdir("docs/internal", { recursive: true });
	await writeFile(outputPath, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
	console.log(`[curate] wrote ${String(items.length)} items to ${outputPath}`);
	const byVariant = new Map<string, number>();
	for (const item of items) {
		byVariant.set(item.variant, (byVariant.get(item.variant) ?? 0) + 1);
		const trace =
			item.visibleIn.old && item.visibleIn.new
				? "both"
				: item.visibleIn.old
					? "old-only"
					: item.visibleIn.new
						? "new-only"
						: "none";
		console.log(
			`  ${item.id} (${item.variant}): visible ${trace} — old=${String(item.visibleIn.old)} new=${String(item.visibleIn.new)}`,
		);
	}
	console.log("variants:", [...byVariant.entries()].map(([k, v]) => `${k}:${String(v)}`).join(" "));
}

await main();
