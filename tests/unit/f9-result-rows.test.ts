/**
 * Regression tests for the shared F9 result-row helpers.
 *
 * The load-bearing case is `resultRowIsUsable`: when a provider ran out of quota
 * mid-run, 222 of 360 rows were persisted with `stopReason: "error"`, zero usage
 * and a fabricated `silence-correct`/`miss` verdict. Every analyzer must exclude
 * those rows, otherwise the rate denominators count observations that never
 * happened.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	cutKeyForItemId,
	dedupeResultRows,
	evaluationNotePathFor,
	loadResultRows,
	noteMatchesTerms,
	placeholderOnlyNoteCount,
	resultRowIsUsable,
	unusableRowCount,
	type AccuracyResultRow,
} from "../../scripts/f9-experiment/result-rows.js";

const created: string[] = [];

async function scratchDir(): Promise<string> {
	const dir = join(tmpdir(), `f9-result-rows-test-${String(created.length)}-${String(Date.now())}`);
	await mkdir(dir, { recursive: true });
	created.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function row(overrides: Partial<AccuracyResultRow> = {}): AccuracyResultRow {
	return {
		itemId: "ctx-01-tail",
		arm: "new",
		rep: 1,
		variant: "tail",
		expected: "finding",
		visible: true,
		verdict: "hit",
		tokens: 21_000,
		...overrides,
	};
}

describe("resultRowIsUsable (provider failures must not count as observations)", () => {
	it("accepts a normal observation, including one that produced a note after an errored final turn", () => {
		expect(resultRowIsUsable(row())).toBe(true);
		expect(
			resultRowIsUsable(row({ verdict: "false-positive", stopReason: "error", note: "real note" })),
		).toBe(true);
	});

	it("rejects an explicit run-error row", () => {
		expect(resultRowIsUsable(row({ verdict: "run-error", tokens: 0 }))).toBe(false);
	});

	it("rejects a legacy provider-failure row that was persisted with a fabricated verdict", () => {
		// The measured 222-row incident: no usage, stopReason "error", but the
		// verdict says the review succeeded.
		const fabricated = row({ verdict: "silence-correct", tokens: 0, stopReason: "error" });
		expect(resultRowIsUsable(fabricated)).toBe(false);
		expect(unusableRowCount([row(), fabricated])).toBe(1);
	});

	it("rejects a row whose tokens field is missing (legacy schema)", () => {
		const legacy = row();
		// SAFETY: the fixture is a legacy row that predates the current schema - the
		// missing field IS the case under test, so the partial cast is intentional.
		delete (legacy as Partial<AccuracyResultRow>).tokens;
		expect(resultRowIsUsable(legacy)).toBe(false);
	});
});

describe("dedupeResultRows (resume retries vs genuine conflicts)", () => {
	it("keeps distinct (itemId, arm, rep) keys untouched", () => {
		const result = dedupeResultRows(
			[row({ rep: 1 }), row({ rep: 2 }), row({ arm: "old" })],
			"x.jsonl",
		);
		expect(result.rows).toHaveLength(3);
		expect(result.superseded).toBe(0);
	});

	it("collapses a key that a resumed run re-ran after a provider failure", () => {
		// run-accuracy keeps the failed row for provenance and appends the retry, so
		// the file legitimately holds the same key twice.
		const failed = row({ rep: 3, verdict: "run-error", tokens: 0, stopReason: "error" });
		const retried = row({ rep: 3, verdict: "hit" });
		const result = dedupeResultRows([failed, retried], "x.jsonl");
		expect(result.superseded).toBe(1);
		expect(result.rows).toEqual([retried]);
	});

	it("fails closed on two usable rows for one key", () => {
		expect(() => dedupeResultRows([row({ rep: 3 }), row({ rep: 3 })], "x.jsonl")).toThrow(
			/x\.jsonl: duplicate usable \(itemId, arm, rep\) rows for ctx-01-tail:new:3/u,
		);
	});

	it("treats a missing rep as rep 1 so a legacy row cannot shadow a repeat", () => {
		const noRep = row();
		// SAFETY: rows persisted before repeats existed carry no `rep` field; removing
		// it is the legacy shape this case pins down.
		delete (noRep as Partial<AccuracyResultRow>).rep;
		expect(() => dedupeResultRows([noRep, row({ rep: 1 })], "x.jsonl")).toThrow(
			/duplicate usable/u,
		);
	});
});

describe("loadResultRows (fail closed on a torn or empty file)", () => {
	it("reads rows and skips blank lines", async () => {
		const dir = await scratchDir();
		const path = join(dir, "rows.jsonl");
		await writeFile(
			path,
			`${JSON.stringify(row())}\n\n${JSON.stringify(row({ rep: 2 }))}\n`,
			"utf8",
		);
		expect(loadResultRows(path)).toHaveLength(2);
	});

	it("throws with the line number on a torn final append", async () => {
		const dir = await scratchDir();
		const path = join(dir, "torn.jsonl");
		await writeFile(path, `${JSON.stringify(row())}\n{"itemId":"ctx-01-tail"\n`, "utf8");
		expect(() => loadResultRows(path)).toThrow(/torn\.jsonl:2 is not valid JSON/u);
	});

	it("throws instead of returning an empty corpus", async () => {
		const dir = await scratchDir();
		const path = join(dir, "empty.jsonl");
		await writeFile(path, "\n", "utf8");
		expect(() => loadResultRows(path)).toThrow(/no rows/u);
	});

	it("throws on a well-formed JSON row whose tokens field is not a number", async () => {
		const dir = await scratchDir();
		const path = join(dir, "typed.jsonl");
		const mistyped = { ...row(), tokens: "21000" };
		await writeFile(path, `${JSON.stringify(mistyped)}\n`, "utf8");
		expect(() => loadResultRows(path)).toThrow(/typed\.jsonl:1 tokens must be a finite number/u);
	});
});

describe("placeholderOnlyNoteCount (weak-model junk notes inflate FP)", () => {
	it("counts only literal placeholder notes", () => {
		const rows = [
			row({ note: "placeholder" }),
			row({ note: "placeholder2" }),
			row({ note: "_placeholder_" }),
			row({ note: "real finding about src/runtime.ts" }),
			row(),
		];
		expect(placeholderOnlyNoteCount(rows)).toBe(3);
	});
});

describe("cutKeyForItemId (cluster key = source cut)", () => {
	it("strips the variant suffix", () => {
		expect(cutKeyForItemId("ctx-01-tail")).toBe("ctx-01");
		expect(cutKeyForItemId("ctx-12-clean")).toBe("ctx-12");
	});
});

describe("noteMatchesTerms (both sides lowercased)", () => {
	it("hits when the corpus term is uppercase and the note is mixed case", () => {
		expect(
			noteMatchesTerms("Found INJECTED_DEFECT_audit_v7_downgrade", [
				"INJECTED_DEFECT_audit_v7_downgrade",
			]),
		).toBe(true);
	});

	it("misses when no term is present", () => {
		expect(noteMatchesTerms("unrelated observation", ["injected_defect"])).toBe(false);
	});
});

describe("evaluationNotePathFor (derived from --out)", () => {
	it("replaces a jsonl suffix and otherwise appends", () => {
		expect(evaluationNotePathFor("docs/internal/accuracy-ab-posind.jsonl")).toBe(
			"docs/internal/accuracy-ab-posind.evaluation.md",
		);
		expect(evaluationNotePathFor("out/results")).toBe("out/results.evaluation.md");
	});
});
