/**
 * Context-composition corpus collector (protocol draft 2026-09-02).
 *
 * Slices real Pi session transcripts into bounded Advisor updates that
 * exercise the truncation path of `renderBoundedEntries`, then writes them
 * out as a draft dataset for the context-composition A/B experiment.
 *
 * Goal: measure whether stripping reasoning / tool-result bodies and buying
 * more Executor history changes Advisor detection accuracy on updates whose
 * rendered delta would otherwise be cut off by `context.maxUpdateTokens`.
 *
 * Safety and scope
 * ----------------
 * - Defaults to the session directory of the CURRENT working directory only
 *   (`getDefaultSessionDir(cwd)`), never the whole `~/.pi/agent/sessions`.
 *   Pass `--session-dir` explicitly to widen the scan (still scoped to one
 *   directory).
 * - Every emitted entry body passes through `redactSecrets` before being
 *   written, so tokens/secrets/keys in tool results are redacted on disk.
 * - The generated dataset is written to `docs/internal/` (git-ignored). Only
 *   a manually reviewed, de-identified, expectation-labeled corpus belongs in
 *   the committed `scripts/f9-experiment/context-dataset.ts`.
 *
 * Rendering fidelity
 * ------------------
 * Uses the exact production renderer `renderAdvisorDelta` from
 * src/transcript.ts (UTF-8-safe truncation + redaction + per-tool-result
 * bounds) instead of duplicating the budgeting logic, so the
 * withReasoning/noReasoning retained-entry counts are the same numbers the
 * runtime would produce.
 *
 * Run: `pnpm tsx scripts/f9-experiment/collect-corpus.ts [--session-dir <dir>] [--budget 20000] [--max-items 12]`
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { redactSecrets } from "../../src/redaction.js";
import { renderAdvisorDelta } from "../../src/transcript.js";
import { isStringValue } from "../../src/value-guards.js";

const DEFAULT_BUDGET_TOKENS = 20_000;
const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_PER_FILE_CAP = 2;
const MAX_FILE_BYTES = 40 * 1_024 * 1_024; // Skip multi-hundred-MB transcripts.
const MAX_FILES_PER_DIR = 20;
const OUTPUT_DIR = resolve("docs", "internal");

/** Parse a positive-integer CLI arg with an explicit failure instead of silent fallback. */
function positiveIntArg(args: readonly string[], flag: string, fallback: number): number {
	const raw = args.find((_value, index) => args[index - 1] === flag);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

/** Same cwd-encoded session directory naming as pi's SessionManager. */
function sessionDirForCwd(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safePath);
}

interface Cut {
	entries: SessionEntry[];
	cursorIndex: number;
	budgetTokens: number;
	withReasoning: { retainedEntries: number; totalEntries: number; truncated: boolean };
	noReasoning: { retainedEntries: number; totalEntries: number; truncated: boolean };
	sourceFile: string;
}

function isMaterialBoundary(entry: SessionEntry | undefined): boolean {
	if (entry?.type !== "message") return false;
	const message = entry.message;
	if (message.role === "user") return true;
	if (message.role === "assistant") {
		return message.content.some((part) => part.type === "toolCall" || part.type === "text");
	}
	return false;
}

function windowHasReasoningOrToolResult(entries: SessionEntry[], cursorIndex: number): boolean {
	for (const entry of entries.slice(cursorIndex)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") return true;
		if (message.role === "assistant" && message.content.some((part) => part.type === "thinking")) {
			return true;
		}
	}
	return false;
}

/** Unvalidated message content part shape, redacted defensively at this boundary. */
interface UnvalidatedContentPart {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	arguments?: unknown;
}

/** Redact the text-bearing content parts of a message (assistant/user/toolResult content arrays). */
function redactContentParts(
	content: string | readonly UnvalidatedContentPart[],
): readonly UnvalidatedContentPart[] {
	if (isStringValue(content)) return [{ text: redactSecrets(content).text }];
	return content.map((part) => {
		const result: UnvalidatedContentPart = { ...part };
		if (isStringValue(result.text)) result.text = redactSecrets(result.text).text;
		if (isStringValue(result.thinking)) result.thinking = redactSecrets(result.thinking).text;
		if (result.arguments !== undefined) {
			const serialized = JSON.stringify(result.arguments);
			const redacted = redactSecrets(serialized).text;
			try {
				// SAFETY: re-parsed redacted JSON stays an opaque value consumed only for serialization.
				result.arguments = JSON.parse(redacted) as unknown;
			} catch {
				// Redaction may produce text that no longer parses; keep the original arguments.
			}
		}
		return result;
	});
}

/** Deep-redact every text-bearing field of an entry so the on-disk draft is safe to share. */
function redactEntry(entry: SessionEntry): SessionEntry {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant" || message.role === "user") {
			// SAFETY: the spread preserves the entry shape; only string fields inside
			// message.content are redacted, so the result is still a SessionEntry.
			return {
				...entry,
				message: { ...message, content: redactContentParts(message.content) },
			} as SessionEntry;
		}
		if (message.role === "toolResult") {
			// SAFETY: same shape-preserving redaction as the assistant/user branch above.
			return {
				...entry,
				message: { ...message, content: redactContentParts(message.content) },
			} as SessionEntry;
		}
		return entry;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { ...entry, summary: redactSecrets(entry.summary).text };
	}
	if (entry.type === "custom_message" && isStringValue(entry.content)) {
		return { ...entry, content: redactSecrets(entry.content).text };
	}
	return entry;
}

function parseEntries(lines: readonly string[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			// SAFETY: lines come from local Pi session JSONL; only known entry types are
			// pushed below and malformed lines are skipped.
			const entry = JSON.parse(line) as SessionEntry;
			if (
				entry.type === "message" ||
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				entry.type === "custom_message"
			) {
				entries.push(entry);
			}
		} catch {
			// Skip malformed lines.
		}
	}
	return entries;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const explicitSessionDir = args.find((_value, index) => args[index - 1] === "--session-dir");
	const budgetTokens = positiveIntArg(args, "budget", DEFAULT_BUDGET_TOKENS);
	const maxItems = positiveIntArg(args, "max-items", DEFAULT_MAX_ITEMS);
	const perFileCap = positiveIntArg(args, "per-file-cap", DEFAULT_PER_FILE_CAP);

	const cwd = process.cwd();
	const agentDir = join(homedir(), ".pi", "agent");
	const sessionRoot = resolve(explicitSessionDir ?? sessionDirForCwd(cwd, agentDir));
	if (explicitSessionDir === undefined) {
		console.log(`[collect] scanning session directory for cwd ${cwd}`);
		console.log(`[collect]   ${sessionRoot}`);
		console.log(
			"[collect]   pass --session-dir to scan another project's sessions (still one directory)",
		);
	}
	const sessionDirs = (await readdir(sessionRoot, { withFileTypes: true }))
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => join(sessionRoot, dirent.name));
	const sessionFiles = (await readdir(sessionRoot)).filter((name) => name.endsWith(".jsonl"));
	// The cwd session directory stores transcripts directly; an explicit
	// --session-dir pointing at the sessions root has per-project subdirectories.
	const scanRoots: string[] =
		sessionFiles.length > 0
			? [sessionRoot]
			: sessionDirs.length > 0
				? sessionDirs.sort((a, b) => b.localeCompare(a))
				: [];
	if (scanRoots.length === 0) {
		console.error(`[collect] no session transcripts under ${sessionRoot}`);
		process.exitCode = 1;
		return;
	}
	if (sessionFiles.length === 0) {
		console.log(
			`[collect] scanning ${String(sessionDirs.length)} project session directories under ${sessionRoot}`,
		);
	}

	const cuts: Cut[] = [];
	const seenRenderHashes = new Set<string>();
	for (const dir of scanRoots) {
		const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
		let scannedFiles = 0;
		for (const file of files) {
			if (scannedFiles >= MAX_FILES_PER_DIR) break;
			// stat before readFile: oversized transcripts (hundreds of MB) must be
			// skipped without ever loading them into memory.
			const fileStats = await stat(join(dir, file)).catch(() => undefined);
			if (fileStats === undefined) continue;
			scannedFiles++;
			if (fileStats.size > MAX_FILE_BYTES) {
				console.log(
					`[collect] skipping oversized ${file.slice(0, 24)} (${String(fileStats.size / 1_048_576).slice(0, 5)} MB)`,
				);
				continue;
			}
			let fileCuts = 0;
			const raw = await readFile(join(dir, file), "utf8");
			const entries = parseEntries(raw.split("\n"));
			if (entries.length < 24) continue;
			for (let cursor = 0; cursor < entries.length; cursor++) {
				if (!isMaterialBoundary(entries[cursor])) continue;
				const window = entries.slice(cursor);
				const withReasoningRender = renderAdvisorDelta(window, budgetTokens, {
					includeReasoning: true,
				});
				const noReasoningRender = renderAdvisorDelta(window, budgetTokens, {
					includeReasoning: false,
				});
				if (!withReasoningRender.truncated) continue;
				if (!windowHasReasoningOrToolResult(window, 0)) continue;
				if (noReasoningRender.retainedEntryCount < withReasoningRender.retainedEntryCount * 1.3) {
					continue;
				}
				// Dedupe by rendered content: different cursors in one file usually
				// retain the same newest tail, which would be the same model input.
				const hash = createHash("sha256").update(withReasoningRender.text).digest("hex");
				if (seenRenderHashes.has(hash)) continue;
				seenRenderHashes.add(hash);
				cuts.push({
					entries: window,
					cursorIndex: cursor,
					budgetTokens,
					withReasoning: {
						retainedEntries: withReasoningRender.retainedEntryCount,
						totalEntries: window.length,
						truncated: withReasoningRender.truncated,
					},
					noReasoning: {
						retainedEntries: noReasoningRender.retainedEntryCount,
						totalEntries: window.length,
						truncated: noReasoningRender.truncated,
					},
					sourceFile: file,
				});
				fileCuts++;
				if (cuts.length >= maxItems || fileCuts >= perFileCap) break;
			}
			if (cuts.length >= maxItems) break;
		}
		if (cuts.length >= maxItems) break;
	}

	if (cuts.length === 0) {
		console.error("[collect] no truncating windows found in the scanned transcripts");
		process.exitCode = 1;
		return;
	}

	// Deterministic ordering by (retained-entry delta, cursor) so the reviewer
	// sees the most dramatic reasoning/tool-result impact first.
	cuts.sort(
		(a, b) =>
			b.noReasoning.retainedEntries -
				b.withReasoning.retainedEntries -
				(a.noReasoning.retainedEntries - a.withReasoning.retainedEntries) ||
			a.cursorIndex - b.cursorIndex,
	);

	const redactedCuts = cuts.map((cut) => ({
		...cut,
		entries: cut.entries.map(redactEntry),
	}));

	const output = redactedCuts
		.map((cut, index) => {
			const withReasoning = JSON.stringify(cut.withReasoning);
			const noReasoning = JSON.stringify(cut.noReasoning);
			return `	{
		id: "ctx-${String(index + 1).padStart(2, "0")}",
		sourceFile: ${JSON.stringify(cut.sourceFile)},
		budgetTokens: ${String(cut.budgetTokens)},
		cursorIndex: ${String(cut.cursorIndex)},
		withReasoning: ${withReasoning},
		noReasoning: ${noReasoning},
		entries: ${JSON.stringify(cut.entries, null, "\t")} as unknown as SessionEntry[],
		expectation: null as F9ContextExpectation | null,
	},`;
		})
		.join("\n");

	const fileText = `/**
 * Context-composition dataset (DRAFT — git-ignored until reviewed).
 *
 * Generated by \`collect-corpus.ts\` from real session transcripts under the
 * cwd's session directory, with every entry body redacted by \`redactSecrets\`.
 * Every cut triggers the \`renderBoundedEntries\` overall-truncation branch at
 * \`budgetTokens\`, and the no-reasoning arm retains >= 30% more entries
 * (counts computed by the production renderer, see src/transcript.ts).
 *
 * Expectation labels are NOT auto-filled: the reviewer must label each cut
 * (silence vs finding with terms) before this file may be promoted to the
 * committed dataset.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
	entries: SessionEntry[];
	expectation: F9ContextExpectation | null;
}

export const F9_CONTEXT_DATASET: readonly F9ContextItem[] = [
${output}
];
`;

	await mkdir(OUTPUT_DIR, { recursive: true });
	const outputPath = join(OUTPUT_DIR, "context-dataset.draft.ts");
	await writeFile(outputPath, fileText, "utf8");
	console.log(`[collect] wrote ${String(cuts.length)} cuts to ${outputPath} (git-ignored)`);
	for (const cut of cuts) {
		console.log(
			`  ${cut.sourceFile.slice(0, 20)} cursor=${String(cut.cursorIndex).padStart(4)} withReas=${String(cut.withReasoning.retainedEntries).padStart(3)} noReas=${String(cut.noReasoning.retainedEntries).padStart(3)} (delta +${String(cut.noReasoning.retainedEntries - cut.withReasoning.retainedEntries)})`,
		);
	}
}

await main();
