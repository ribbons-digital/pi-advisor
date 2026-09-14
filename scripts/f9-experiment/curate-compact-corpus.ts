/**
 * Compaction A/B corpus curator (compaction-only arms, per issue #141 review).
 *
 * Builds the corpus the acceptance bar in comment 5518416233 asks for: verified
 * history-only finding cases, verified visible cases, and verified silence
 * cases, drawn from SEPARATE sessions, on sessions that actually reach the
 * compaction trigger.
 *
 * Why this reconstructs history instead of harvesting it: the Advisor's nested
 * session is not persisted (only four 4-message fragments exist across the whole
 * session store, and `advisor-history-summary` appears exactly once), so there is
 * no stored nested transcript to slice. The cycles here are rebuilt from real
 * host sessions by rendering each review boundary with the production renderer
 * and wrapping it as `<advisor-update>`, which is the same text the runtime
 * submits.
 *
 * Why arm visibility is verified rather than assumed: "history-only" has to mean
 * *the compressor provably drops this evidence*, not "I injected it somewhere
 * old". The curator runs the production `compressAdvisorHistory` over every
 * candidate and only keeps a case when the signature is present verbatim and
 * absent after compression. Guessing would silently produce cases whose labels
 * do not match the mechanism.
 *
 * Run: `bun scripts/f9-experiment/curate-compact-corpus.ts [--max-fraction 0.2]`
 *      [--budget 20000] [--finding 30] [--silence 30] [--seed 20260912]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	compressAdvisorHistory,
	type AdvisorHistoryMessage,
} from "../../src/history-compaction.js";
import { redactSecrets } from "../../src/redaction.js";
import { renderAdvisorDelta } from "../../src/transcript.js";
import { isNumberValue, isRecordValue, isStringValue } from "../../src/value-guards.js";
import { type AbStratum, checkSessionSeparation } from "./paired-stats.js";

const MANIFEST_PATH = join("docs", "internal", "compact-corpus-manifest.jsonl");
const OUTPUT_PATH = join("docs", "internal", "compact-ab-corpus.jsonl");
/** Model window of the configured Advisor model (commandcode-goat/z-ai/glm-5.3-flash). */
const ADVISOR_CONTEXT_WINDOW = 1_048_576;
/** `context.reserveTokens` from the user config. */
const RESERVE_TOKENS = 8_192;
const DEFAULT_BUDGET_TOKENS = 20_000;
const DEFAULT_MAX_FRACTION = 0.08;
const DEFAULT_SEED = 20_260_912;
/** Cycles kept verbatim by the compressor; everything older is summarised. */
const KEEP_RECENT_CYCLES = 1;
/**
 * Default cases per source session.
 *
 * The reachability ceiling forces this: only a few dozen real sessions ever reach
 * a realistic trigger, so one case per session cannot supply the bar's 30+30
 * floor. Cases from one session are not independent — `clusterBySession` collapses
 * them before resampling — so this buys case-level coverage without inflating the
 * interval's apparent power.
 */
const DEFAULT_PER_SESSION = 4;

/** Session-entry view needed for boundary detection. */
interface ContentPartView {
	type?: unknown;
	text?: unknown;
}

/** One rebuilt Advisor review cycle. */
interface Cycle {
	updateText: string;
	cursorIndex: number;
}

/** Per-arm verdict of the injected signature, computed by the production compressor. */
interface ArmVisibility {
	control: boolean;
	treatment: boolean;
}

interface CuratedCase {
	caseId: string;
	stratum: AbStratum;
	sessionId: string;
	hostSessionFile: string;
	/** The trigger this corpus was built against, so a run can cite the config. */
	contextLimitTokens: number;
	budgetTokens: number;
	/** Newest-last, exactly the order the nested session accumulates them. */
	cycles: string[];
	/** Present only on injected cases; explicitly optional so silence can assign `undefined`. */
	signature?: string | undefined;
	injectedCycleIndex?: number | undefined;
	/** `control` = verbatim, `treatment` = after compressAdvisorHistory. */
	armVisibility: ArmVisibility;
	compressedCycles: number;
}

interface CurateOptions {
	maxFraction: number;
	budgetTokens: number;
	findingTarget: number;
	silenceTarget: number;
	perSession: number;
	seed: number;
}

function positiveNumberArg(args: readonly string[], name: string, fallback: number): number {
	const raw = args.find((_value, index) => args[index - 1] === `--${name}`);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive number; received ${raw}`);
	}
	return parsed;
}

/** Read a JSONL file, failing closed on a malformed line rather than skipping it. */
async function readJsonl(path: string): Promise<SessionEntry[]> {
	const raw = await readFile(path, "utf8");
	const rows: SessionEntry[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		try {
			// SAFETY: the row is a local Pi session transcript, parsed once at this I/O
			// boundary into the same SessionEntry type the renderer consumes. A row that
			// does not match surfaces on the type-narrowed reads below (`entry.type`),
			// which is why the parse must not be silently skipped.
			rows.push(JSON.parse(line) as SessionEntry);
		} catch {
			throw new Error(`${path}:${String(index + 1)} is not valid JSON`);
		}
	}
	return rows;
}

/** Plain-text view of an advisor history message, ignoring non-text parts. */
function messageText(message: AdvisorHistoryMessage): string {
	const content = message.content;
	if (isStringValue(content)) return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecordValue<ContentPartView>(part)) continue;
		if (isStringValue(part.text)) parts.push(part.text);
	}
	return parts.join("\n");
}

/** A user message marks a review boundary: the Executor submitted a new turn. */
function isReviewBoundary(entry: SessionEntry | undefined): boolean {
	if (entry === undefined) return false;
	return entry.type === "message" && entry.message.role === "user";
}

/** Rebuild the `<advisor-update>` prompt the runtime would have submitted. */
function rebuildCycleText(
	entries: readonly SessionEntry[],
	cursorIndex: number,
	budgetTokens: number,
): string {
	const rendered = renderAdvisorDelta(entries.slice(cursorIndex), budgetTokens, {
		includeReasoning: true,
	});
	return `<advisor-update>\n${rendered.text}\n</advisor-update>`;
}

/** Wrap cycle texts as the user-role history messages the compressor consumes. */
function asHistoryMessages(cycles: readonly string[]): AdvisorHistoryMessage[] {
	return cycles.map((text) => ({ role: "user", content: text }));
}

/**
 * Inject the signature as a plain body line.
 *
 * The compressor's summary carries only specific positions (the `[Executor user]`
 * head, advise outcomes, `- [ERROR]` register lines, the `Dropped beyond window:`
 * breadcrumb). A body line is deliberately none of those, so a correctly labelled
 * history-only case has its evidence dropped — which `verifyVisibility` then
 * proves rather than assumes.
 */
function injectSignature(updateText: string, signature: string): string {
	const marker = `Audit note: ${signature} downgraded without a backup.`;
	return `${updateText}\n${marker}`;
}

/** Result of proving per-arm visibility with the production compressor. */
interface VisibilityCheck {
	visibility: ArmVisibility;
	compressedCycles: number;
	compressedText: string;
}

/** Verify per-arm visibility using the production compressor. */
function verifyVisibility(
	cycles: readonly string[],
	signature: string | undefined,
): VisibilityCheck {
	const verbatim = cycles.join("\n");
	const compressed = compressAdvisorHistory(asHistoryMessages(cycles));
	const compressedText = compressed.messages.map((message) => messageText(message)).join("\n");
	return {
		visibility: {
			control: signature === undefined ? false : verbatim.includes(signature),
			treatment: signature === undefined ? false : compressedText.includes(signature),
		},
		compressedCycles: compressed.compressedCycles,
		compressedText,
	};
}

/** The trigger a case was built against, recorded so a run can cite the config. */
function contextLimitTokens(maxFraction: number): number {
	return Math.max(0, Math.floor(ADVISOR_CONTEXT_WINDOW * maxFraction) - RESERVE_TOKENS);
}

interface ManifestRow {
	sessionId: string;
	hostSessionFile: string;
	peakSingleCallInput: number;
	reviews: number;
}

/**
 * Select source sessions that actually reach the trigger.
 *
 * A corpus built on sessions that never exceed the limit cannot exercise the
 * compressor at all: the arms would be byte-identical and the comparison would
 * measure nothing. Requiring `peakSingleCallInput > limit` is what makes the
 * corpus discriminating, and it is why the curator takes a `--max-fraction`.
 */
async function selectSessions(limit: number): Promise<ManifestRow[]> {
	let raw: string;
	try {
		raw = await readFile(MANIFEST_PATH, "utf8");
	} catch {
		throw new Error(
			`cannot read ${MANIFEST_PATH}; run the manifest build first — it is documented in compact-corpus-README.md`,
		);
	}
	const rows: ManifestRow[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		let row: ManifestRow;
		try {
			// SAFETY: the manifest is written by this harness family (documented in
			// compact-corpus-README.md); a row that does not match the shape is
			// rejected by the guard below before any field is used numerically.
			row = JSON.parse(line) as ManifestRow;
		} catch {
			throw new Error(`${MANIFEST_PATH}:${String(index + 1)} is not valid JSON`);
		}
		if (!isStringValue(row.sessionId) || !isStringValue(row.hostSessionFile)) continue;
		if (row.hostSessionFile.length === 0) continue;
		if (!isNumberValue(row.peakSingleCallInput) || !isNumberValue(row.reviews)) continue;
		if (row.peakSingleCallInput <= limit) continue;
		rows.push(row);
	}
	rows.sort((a, b) => b.peakSingleCallInput - a.peakSingleCallInput);
	return rows;
}

/** Dedupe a case-id salt per stratum, so a re-run is idempotent and readable. */
function caseId(stratum: AbStratum, index: number): string {
	const short =
		stratum === "history-only-finding" ? "hist" : stratum === "visible-finding" ? "vis" : "sil";
	return `cx-${short}-${String(index).padStart(3, "0")}`;
}

function countFinding(cases: readonly CuratedCase[]): number {
	return cases.filter((entry) => entry.stratum !== "silence").length;
}

function countSilence(cases: readonly CuratedCase[]): number {
	return cases.filter((entry) => entry.stratum === "silence").length;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options: CurateOptions = {
		maxFraction: positiveNumberArg(args, "max-fraction", DEFAULT_MAX_FRACTION),
		budgetTokens: positiveNumberArg(args, "budget", DEFAULT_BUDGET_TOKENS),
		findingTarget: positiveNumberArg(args, "finding", 30),
		silenceTarget: positiveNumberArg(args, "silence", 30),
		perSession: positiveNumberArg(args, "per-session", DEFAULT_PER_SESSION),
		seed: positiveNumberArg(args, "seed", DEFAULT_SEED),
	};
	if (options.maxFraction >= 1) throw new Error("--max-fraction must be below 1");
	const limit = contextLimitTokens(options.maxFraction);

	const sessions = await selectSessions(limit);
	console.log(
		`[compact] maxFraction=${String(options.maxFraction)} -> limit=${String(limit)} tokens; ${String(sessions.length)} manifest session(s) reach it`,
	);
	if (sessions.length === 0) {
		console.error(
			"[compact] no session reaches the trigger; lower --max-fraction (see compact-corpus-README.md for the reachability table)",
		);
		process.exitCode = 1;
		return;
	}

	const cases: CuratedCase[] = [];
	const perSession = new Map<string, number>();
	const usedSessions = new Set<string>();
	let rejectedVisibility = 0;
	let rejectedTooFewCycles = 0;

	/** Build every cycle of one session, oldest first. */
	async function cyclesFor(row: ManifestRow): Promise<Cycle[]> {
		const path = resolve(row.hostSessionFile);
		const entries = await readJsonl(path);
		const cycles: Cycle[] = [];
		// Bounded: a long session would otherwise render hundreds of windows, and
		// the compressor only needs more than KEEP_RECENT_CYCLES to engage.
		const maxCycles = 12;
		for (let cursor = 0; cursor < entries.length; cursor++) {
			const entry = entries[cursor];
			if (entry === undefined || !isReviewBoundary(entry)) continue;
			const cycle = rebuildCycleText(entries, cursor, options.budgetTokens);
			cycles.push({ updateText: redactSecrets(cycle).text, cursorIndex: cursor });
			if (cycles.length >= maxCycles) break;
		}
		return cycles;
	}

	/** Emit at most one case per (session, stratum) so repeats stay independent. */
	function tryAdd(
		row: ManifestRow,
		stratum: AbStratum,
		cycles: readonly string[],
		signature: string | undefined,
		injectedCycleIndex: number | undefined,
	): boolean {
		const { visibility, compressedCycles } = verifyVisibility(cycles, signature);
		const expected: ArmVisibility =
			stratum === "history-only-finding"
				? { control: true, treatment: false }
				: stratum === "visible-finding"
					? { control: true, treatment: true }
					: { control: false, treatment: false };
		const ok =
			visibility.control === expected.control && visibility.treatment === expected.treatment;
		if (!ok) {
			rejectedVisibility++;
			return false;
		}
		const index = cases.length;
		cases.push({
			caseId: caseId(stratum, index),
			stratum,
			sessionId: row.sessionId,
			hostSessionFile: path_relative(row.hostSessionFile),
			contextLimitTokens: limit,
			budgetTokens: options.budgetTokens,
			cycles: [...cycles],
			signature,
			injectedCycleIndex,
			armVisibility: visibility,
			compressedCycles,
		});
		usedSessions.add(row.sessionId);
		perSession.set(row.sessionId, (perSession.get(row.sessionId) ?? 0) + 1);
		return true;
	}

	for (const row of sessions) {
		if (countFinding(cases) >= options.findingTarget) break;
		if (usedSessions.has(row.sessionId)) continue;
		const cycles = await cyclesFor(row);
		if (cycles.length <= KEEP_RECENT_CYCLES + 1) {
			rejectedTooFewCycles++;
			continue;
		}
		const texts = cycles.map((cycle) => cycle.updateText);
		const newestIndex = texts.length - 1;

		// Visible guard first: cheap, needs only the newest cycle, and keeps the
		// "evidence survives compression" stratum represented in every corpus.
		const visSignature = `COMPACT_AB_VIS_${String(cases.length).padStart(3, "0")}_sig`;
		tryAdd(
			row,
			"visible-finding",
			texts.map((text, index) =>
				index === newestIndex ? injectSignature(text, visSignature) : text,
			),
			visSignature,
			newestIndex,
		);

		// History-only: one case per cycle the compressor rewrites (index < newest),
		// bounded per session.
		let addedHere = 0;
		for (let index = 0; index < newestIndex && addedHere < options.perSession; index++) {
			if (countFinding(cases) >= options.findingTarget) break;
			const signature = `COMPACT_AB_HIST_${String(cases.length).padStart(3, "0")}_sig`;
			const injected = texts.map((text, at) =>
				at === index ? injectSignature(text, signature) : text,
			);
			if (tryAdd(row, "history-only-finding", injected, signature, index)) addedHere++;
		}
	}

	// Silence cases from sessions that supplied no finding case at all, which is
	// what "separate sessions" means for an independent negative.
	for (const row of sessions) {
		if (countSilence(cases) >= options.silenceTarget) break;
		if (usedSessions.has(row.sessionId)) continue;
		const cycles = await cyclesFor(row);
		if (cycles.length <= KEEP_RECENT_CYCLES + 1) continue;
		const texts = cycles.map((cycle) => cycle.updateText);
		// Vary retained history depth: distinct inputs, all with the same "no defect
		// planted" expectation.
		let addedHere = 0;
		for (let drop = 0; drop < options.perSession && addedHere < options.perSession; drop++) {
			if (countSilence(cases) >= options.silenceTarget) break;
			const window = texts.slice(drop);
			if (window.length <= KEEP_RECENT_CYCLES + 1) break;
			if (tryAdd(row, "silence", window, undefined, undefined)) addedHere++;
		}
	}

	const overlap = checkSessionSeparation(
		cases.map((entry) => ({
			caseId: entry.caseId,
			stratum: entry.stratum,
			sessionId: entry.sessionId,
			control: { successes: 0, trials: 0, tokens: 0 },
			treatment: { successes: 0, trials: 0, tokens: 0 },
		})),
	);
	if (overlap.length > 0) {
		throw new Error(
			`session separation violated: ${overlap.join(", ")} supplied both a finding and a silence case`,
		);
	}

	const findingCount = cases.filter((entry) => entry.stratum !== "silence").length;
	const silenceCount = cases.filter((entry) => entry.stratum === "silence").length;
	const floorsMet = findingCount >= options.findingTarget && silenceCount >= options.silenceTarget;

	await mkdir(dirname(OUTPUT_PATH), { recursive: true });
	const body = cases.map((entry) => JSON.stringify(entry)).join("\n");
	const corpusHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
	await writeFile(OUTPUT_PATH, `${body}\n`, "utf8");

	console.log(
		`[compact] wrote ${String(cases.length)} cases to ${OUTPUT_PATH} (hash ${corpusHash})`,
	);
	console.log(
		`[compact]   finding=${String(findingCount)} (history-only=${String(cases.filter((entry) => entry.stratum === "history-only-finding").length)}, visible=${String(cases.filter((entry) => entry.stratum === "visible-finding").length)}) silence=${String(silenceCount)}`,
	);
	console.log(
		`[compact]   sessions used=${String(usedSessions.size)}; rejected: visibility=${String(rejectedVisibility)} too-few-cycles=${String(rejectedTooFewCycles)}`,
	);
	if (!floorsMet) {
		console.error(
			`[compact] corpus floors NOT met (need ${String(options.findingTarget)} finding + ${String(options.silenceTarget)} silence); the runner will report insufficient-evidence`,
		);
		process.exitCode = 1;
	}
}

/** Repo-relative path for portability; falls back to the absolute path. */
function path_relative(absolute: string): string {
	const relative = absolute.startsWith(process.cwd())
		? absolute.slice(process.cwd().length + 1)
		: absolute;
	return relative.length > 0 ? relative : absolute;
}

await main();
