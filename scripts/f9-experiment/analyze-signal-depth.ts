/**
 * P2 offline signal-depth analysis (no LLM calls).
 *
 * Answers the open P2 question: for the NATURAL findings in the
 * advisor-hist corpus, how deep into the rendered window does each
 * finding's signal actually live? This decides whether a "retention
 * depth cap" (max user cycles of retained history) is safe and what its
 * default should be.
 *
 * Method: for each `kind: finding` row in advisor-hist-corpus.jsonl,
 * anchor on a hand-curated per-finding table of SPECIFIC tokens (the
 * corpus `terms` field mixes in findingKey slugs and cross-finding words
 * like `push`/`origin` that appear in every window and would pollute the
 * depth measurement). For each specific token take its NEWEST occurrence
 * in the already-rendered `update_text` window — the instance the advisor
 * is most likely to actually use — and compute its user-cycle depth: how
 * many `[Executor user]` boundaries sit between it and the newest end of
 * the window. The finding's reachable depth is the minimum across tokens.
 *
 * A finding is "safe under a cap of N" when its reachable depth <= N: the
 * signal still renders if retention keeps only the newest N user cycles.
 * If every natural finding is safe under a small cap, the 58% extra
 * history retained by no-reasoning carries no measurable recall value.
 *
 * Run: `bun scripts/f9-experiment/analyze-signal-depth.ts`
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface HistRow {
	id: string;
	kind: string;
	findingKey: string;
	terms: string[];
	update_text: string;
	upd_bytes: number;
	truncated: boolean;
}

const CORPUS_PATH = join("docs", "internal", "advisor-hist-corpus.jsonl");

/** Finding-specific signal tokens (curated from old-vs-new-comparison.md seed terms). */
const SPECIFIC_TOKENS = new Map<string, readonly string[]>([
	["hist-07", ["config-apply", "maxAdvisorTurnsPerUpdate"]],
	["hist-08", ["bc53cd8a", "maxAdvisorTurnsPerUpdate", "turn-limit"]],
	["hist-10", ["mcp-tool-groups"]],
	["hist-12", ["executorOptions[0]", "form.connectorId", "executor-bound-mode"]],
	["hist-13", ["7dc0874", "bounded-nested-lifecycle"]],
	["hist-14", ["7dc0874", "issuecomment-5489405234"]],
	["hist-23", ["WATCHDOG.yml", "migration_v7", "audit_events"]],
	["hist-25", ["showExecutorField", "AssetEditDrawer.svelte", "executorOptions"]],
	["hist-26", ["watchdog", "maxAdvisorTurnsPerUpdate"]],
	["hist-31", ["asset-executor-mode-toggle", "rebind"]],
	["hist-34", ["migration_v7", "audit_events", "14,203"]],
	["hist-35", ["streak", "retryable", "b2c0927"]],
	["hist-41", ["e2e-verify", "check_interval", "keepalive"]],
	["hist-45", ["PR #135", "7dc0874"]],
	["hist-46", ["admin", "catalog", "失败载荷"]],
	["hist-48", ["cacheRead", "nonmonotonic", "非单调"]],
	["hist-50", ["dev-host-asset", "keepalive"]],
	["hist-55", ["catalog", "validation"]],
]);

/** Positions (character index) of every user-message boundary marker. */
function userCycleBoundaries(text: string): number[] {
	const boundaries: number[] = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf("user]", from);
		if (at === -1) break;
		boundaries.push(at);
		from = at + 1;
	}
	return boundaries;
}

interface RowAnalysis {
	reachableDepth: number | undefined;
	tokenDepths: number[];
	userCycleCount: number;
}

function analyzeRow(row: HistRow, specific: readonly string[]): RowAnalysis {
	const text = row.update_text;
	const boundaries = userCycleBoundaries(text);
	const tokenDepths: number[] = [];
	for (const token of specific) {
		if (token.length === 0) continue;
		// NEWEST occurrence = the instance closest to the newest end; this is
		// the reachable signal under a retention cap, not the folklore-oldest.
		const at = text.lastIndexOf(token);
		if (at === -1) continue;
		tokenDepths.push(boundaries.filter((b) => b > at).length);
	}
	return {
		reachableDepth: tokenDepths.length === 0 ? undefined : Math.min(...tokenDepths),
		tokenDepths,
		userCycleCount: boundaries.length,
	};
}

// A malformed line fails loudly with its line number instead of silently
// emptying the corpus (which would report "no findings" as a real result).
const rows = (await readFile(CORPUS_PATH, "utf8"))
	.split("\n")
	.map((line, index) => ({ line, number: index + 1 }))
	.filter(({ line }) => line.trim().length > 0)
	.map(({ line, number }): HistRow => {
		try {
			// SAFETY: advisor-hist-corpus.jsonl is a git-ignored hand corpus with a
			// fixed HistRow schema (not written by collect-corpus.ts); the parse is
			// checked here and the shape surfaces on field access below.
			return JSON.parse(line) as HistRow;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${CORPUS_PATH}:${String(number)} is not valid JSON (${message})`);
		}
	});

const findings = rows.filter((r) => r.kind === "finding");
const analyzed = findings.map((row) => ({
	id: row.id,
	findingKey: row.findingKey,
	...analyzeRow(row, SPECIFIC_TOKENS.get(row.id) ?? []),
}));

const locatable = analyzed.filter((a) => a.reachableDepth !== undefined);
console.log(`corpus rows: ${String(rows.length)}; findings: ${String(findings.length)}\n`);
console.log("id     | reachableDepth(cycles) | tokenDepths            | window user-cycles");
for (const a of analyzed) {
	const depth = a.reachableDepth === undefined ? "n/a" : String(a.reachableDepth);
	console.log(
		`${a.id.padEnd(7)} | ${depth.padEnd(21)} | ${String(a.tokenDepths).padEnd(24)} | ${String(a.userCycleCount)}`,
	);
}
console.log(`\nlocatable: ${String(locatable.length)}/${String(findings.length)}`);
const depths = locatable
	.flatMap((a) => (a.reachableDepth === undefined ? [] : [a.reachableDepth]))
	.sort((x, y) => x - y);
console.log(`depth distribution: [${depths.join(", ")}]`);
console.log("\n== retention-cap safety (reachable signal within newest N user cycles) ==");
for (const n of [0, 1, 2, 3, 5]) {
	const safe = locatable.filter((a) => (a.reachableDepth ?? Infinity) <= n).length;
	console.log(
		`cap=${String(n).padEnd(3)}: ${String(safe).padEnd(3)}/${String(locatable.length)} findings safe`,
	);
}
