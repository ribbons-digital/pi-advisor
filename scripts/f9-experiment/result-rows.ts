/**
 * Shared result-row helpers for the F9 accuracy analyzers.
 *
 * `run-accuracy.ts` appends one JSON row per review. Two failure modes have
 * already corrupted analysis once each, so both are handled here instead of
 * being re-derived (and forgotten) in every analyzer:
 *
 *  1. **Provider failures persisted as observations.** When the provider ran
 *     out of quota mid-run, the session ended with `stopReason: "error"`, no
 *     usage, and an empty advise view; the runner then derived `silence-correct`
 *     or `miss` from that emptiness. 222 of 360 rows were fabricated this way.
 *     Newer runs classify those rows as `run-error`, but files written before
 *     that fix still carry the old verdicts, so `resultRowIsUsable` also rejects
 *     any row without usage: `lastAssistantUsage` skips aborted/errored
 *     messages, so `tokens === 0` means no usable model response happened.
 *     Note that `inputTokens` is NOT the signal — it counts only the uncached
 *     input, which a fully cached successful call can report as zero.
 *  2. **Duplicate `(itemId, arm, rep)` keys.** A resumed or restarted run can
 *     append a second row for a key it already recorded. Quietly keeping the
 *     first row would mix identities and make the rate denominators disagree
 *     with the stratum assignment, so `dedupeResultRows` fails closed when both copies are usable.
 */
import { readFileSync } from "node:fs";

import {
	isBooleanValue,
	isNumberValue,
	isRecordValue,
	isStringValue,
} from "../../src/value-guards.js";

export type AccuracyArm = "old" | "new";

export interface AccuracyResultRow {
	itemId: string;
	arm: AccuracyArm;
	rep?: number;
	variant: string;
	expected: "silence" | "finding";
	visible: boolean;
	verdict: string;
	tokens: number;
	stopReason?: string;
	note?: string;
}

/** On-disk JSON shape; each field is narrowed before it is copied onto AccuracyResultRow. */
interface ResultRowJson {
	itemId?: string;
	arm?: string;
	rep?: number;
	variant?: string;
	expected?: string;
	visible?: boolean;
	verdict?: string;
	tokens?: number;
	stopReason?: string;
	note?: string;
}

function requireResultRow(parsed: ResultRowJson, path: string, line: number): AccuracyResultRow {
	const where = `${path}:${String(line)}`;
	if (!isStringValue(parsed.itemId) || parsed.itemId.length === 0) {
		throw new Error(`${where} missing itemId`);
	}
	if (parsed.arm !== "old" && parsed.arm !== "new") {
		throw new Error(`${where} arm must be "old" or "new"`);
	}
	if (!isStringValue(parsed.variant) || parsed.variant.length === 0) {
		throw new Error(`${where} missing variant`);
	}
	if (parsed.expected !== "silence" && parsed.expected !== "finding") {
		throw new Error(`${where} expected must be "silence" or "finding"`);
	}
	if (!isBooleanValue(parsed.visible)) {
		throw new Error(`${where} visible must be a boolean`);
	}
	if (!isStringValue(parsed.verdict) || parsed.verdict.length === 0) {
		throw new Error(`${where} missing verdict`);
	}
	if (!isNumberValue(parsed.tokens) || !Number.isFinite(parsed.tokens)) {
		throw new Error(`${where} tokens must be a finite number`);
	}
	const row: AccuracyResultRow = {
		itemId: parsed.itemId,
		arm: parsed.arm,
		variant: parsed.variant,
		expected: parsed.expected,
		visible: parsed.visible,
		verdict: parsed.verdict,
		tokens: parsed.tokens,
	};
	if (isNumberValue(parsed.rep)) row.rep = parsed.rep;
	if (isStringValue(parsed.stopReason)) row.stopReason = parsed.stopReason;
	if (isStringValue(parsed.note)) row.note = parsed.note;
	return row;
}

/** Load rows, failing closed so a torn or mistyped file cannot silently shrink the corpus. */
export function loadResultRows(path: string): AccuracyResultRow[] {
	const rows: AccuracyResultRow[] = [];
	const lines = readFileSync(path, "utf8").split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		let parsed: ResultRowJson;
		try {
			// SAFETY: JSON.parse is untyped; requireResultRow narrows every field
			// before the row is used numerically, so a mistyped tokens value cannot
			// coerce into a rate denominator.
			parsed = JSON.parse(line) as ResultRowJson;
		} catch {
			throw new Error(`${path}:${String(index + 1)} is not valid JSON`);
		}
		if (!isRecordValue<ResultRowJson>(parsed)) {
			throw new Error(`${path}:${String(index + 1)} is not a JSON object`);
		}
		rows.push(requireResultRow(parsed, path, index + 1));
	}
	if (rows.length === 0) throw new Error(`no rows in ${path}`);
	return rows;
}

/**
 * Collapse duplicate `(itemId, arm, rep)` keys.
 *
 * A key legitimately appears twice when a run resumes after a provider failure:
 * the unusable row is kept for provenance and the retry appends a usable one.
 * That case is resolved to the usable row and counted as `superseded`. Two
 * USABLE rows for one key mean the file mixes runs or identities, which no
 * choice can repair, so that case fails closed.
 */
export function dedupeResultRows<T extends AccuracyResultRow>(rows: readonly T[], path: string) {
	const byKey = new Map<string, T>();
	const conflicts = new Set<string>();
	let superseded = 0;
	for (const row of rows) {
		const key = `${row.itemId}:${row.arm}:${String(row.rep ?? 1)}`;
		const seen = byKey.get(key);
		if (seen === undefined) {
			byKey.set(key, row);
			continue;
		}
		const seenUsable = resultRowIsUsable(seen);
		const rowUsable = resultRowIsUsable(row);
		if (seenUsable && rowUsable) {
			conflicts.add(key);
			continue;
		}
		superseded++;
		if (rowUsable) byKey.set(key, row);
	}
	if (conflicts.size > 0) {
		throw new Error(
			`${path}: duplicate usable (itemId, arm, rep) rows for ${[...conflicts].sort((a, b) => a.localeCompare(b)).join(", ")}; the file mixes runs or identities`,
		);
	}
	return { rows: [...byKey.values()], superseded };
}

/** True when the row holds a real model observation (see the module header). */
export function resultRowIsUsable(row: AccuracyResultRow): boolean {
	// A missing `tokens` field (legacy row) compares as NaN and is therefore
	// excluded too, which is the conservative direction.
	return row.verdict !== "run-error" && row.tokens > 0;
}

/** Rows excluded because the review never produced a usable model response. */
export function unusableRowCount(rows: readonly AccuracyResultRow[]): number {
	return rows.filter((row) => !resultRowIsUsable(row)).length;
}

const PLACEHOLDER_NOTE = /^\s*_?placeholder\d*_?\s*$/iu;

/**
 * Rows whose note is a literal "placeholder" (a weak-model artifact measured on
 * commandcode-goat/deepseek-v4-flash). Such a note counts as a false positive on
 * silence-expected items while carrying no content, so the analyzers report the
 * count instead of letting it inflate FP rates unnoticed.
 */
export function placeholderOnlyNoteCount(rows: readonly AccuracyResultRow[]): number {
	return rows.filter((row) => row.note !== undefined && PLACEHOLDER_NOTE.test(row.note)).length;
}

/**
 * Cluster key for the source cut an item came from (`ctx-01-tail` -> `ctx-01`).
 * The acceptance bar wants one independent source per case; these items share
 * nine source cuts, so the intervals resample cuts.
 */
export function cutKeyForItemId(itemId: string): string {
	return itemId.replace(/-[^-]+$/u, "");
}

/**
 * Case-insensitive term match used to grade a finding-expected note.
 * Both the note and each term are lowercased so a corpus term written in
 * either case still hits; matching only the note would silently score 0
 * recall against an uppercase term.
 */
export function noteMatchesTerms(note: string, terms: readonly string[]): boolean {
	const normalized = note.toLocaleLowerCase("en-US");
	return terms.some((term) => normalized.includes(term.toLocaleLowerCase("en-US")));
}

/** Evaluation note path derived from a results jsonl path so one model's run cannot overwrite another's. */
export function evaluationNotePathFor(resultsPath: string): string {
	return /\.jsonl$/iu.test(resultsPath)
		? resultsPath.replace(/\.jsonl$/iu, ".evaluation.md")
		: `${resultsPath}.evaluation.md`;
}
