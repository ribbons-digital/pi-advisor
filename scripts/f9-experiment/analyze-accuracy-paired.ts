/**
 * Paired analysis for the version-vs-version Advisor accuracy A/B.
 *
 * Compares the CURRENT implementation plus default config against v0.4.1 plus
 * default config on the injection corpus, with the statistics the acceptance bar
 * in issue #141 (comment 5518416233) asks for: at least five repeats per case per
 * configuration and a 95% paired interval per comparison.
 *
 * Two things this deliberately does NOT pretend:
 *
 *  - **The corpus is below the bar's floors.** It has 36 items, not 30 finding
 *    plus 30 silence, and the items come from 9 source cuts rather than 60
 *    independent sessions. `evaluateGates` therefore reports
 *    `insufficient-evidence`; the per-arm rates below are still the substantive
 *    comparison, but they are not a merge decision.
 *  - **`success` here means "the verdict matched that arm's own expectation"**,
 *    not "found the defect". The corpus grades each arm against what ITS
 *    rendering makes visible, so an item where only the treatment arm can see the
 *    inject is scored as "must stay silent" for control and "must report" for
 *    treatment. The two asymmetric directions are reported as SEPARATE strata
 *    (`history-only` = extra history gained a finding?; `render-only` = stripping
 *    reasoning lost one?), because netting them would report a delta that
 *    corresponds to no hypothesis.
 *
 * Run: `bun scripts/f9-experiment/analyze-accuracy-paired.ts [--in <path>]
 *      [--seed 20260912] [--iterations 10000]`
 */
import {
	clusterBySession,
	evaluateGates,
	PROPOSED_THRESHOLDS,
	summarizeAb,
	type AbStratum,
	type CaseObservation,
} from "./paired-stats.js";
import {
	cutKeyForItemId,
	dedupeResultRows,
	loadResultRows,
	placeholderOnlyNoteCount,
	resultRowIsUsable,
	type AccuracyResultRow,
} from "./result-rows.js";

const DEFAULT_INPUT = "docs/internal/accuracy-ab-ds41.jsonl";

function argValue(args: readonly string[], name: string): string | undefined {
	return args.find((_value, index) => args[index - 1] === `--${name}`);
}

function numberArg(args: readonly string[], name: string, fallback: number): number {
	const raw = argValue(args, name);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive number; received ${raw}`);
	}
	return parsed;
}

/** Per-arm aggregate for one case, folded across that case's repeats. */
interface ArmAggregate {
	successes: number;
	trials: number;
	tokens: number;
}

function stratumFor(controlIsFinding: boolean, treatmentIsFinding: boolean): AbStratum {
	if (controlIsFinding && treatmentIsFinding) return "visible-finding";
	if (!controlIsFinding && !treatmentIsFinding) return "silence";
	// The two asymmetric directions are opposite questions and must not be
	// netted: `render-only` asks whether stripping reasoning LOST evidence the
	// control could see; `history-only` asks whether the extra retained history
	// GAINED a finding the control could not see.
	return controlIsFinding ? "render-only-finding" : "history-only-finding";
}

function rate(hits: number, total: number): string {
	return total === 0 ? "  n/a" : `${((hits / total) * 100).toFixed(1)}%`;
}

function main(): void {
	const args = process.argv.slice(2);
	const inputPath = argValue(args, "in") ?? DEFAULT_INPUT;
	const seed = numberArg(args, "seed", 20_260_912);
	const iterations = numberArg(args, "iterations", 10_000);
	const loaded = loadResultRows(inputPath);
	const { rows, superseded } = dedupeResultRows(loaded, inputPath);

	const runErrors = rows.filter((row) => row.verdict === "run-error").length;
	// Provider failures written before the runner classified them (no usage, empty
	// advise view) still carry silence/miss verdicts; counting them would fabricate
	// observations, so they are excluded here too.
	const usable = rows.filter((row) => resultRowIsUsable(row));
	const excluded = rows.length - usable.length;
	const items = [...new Set(usable.map((row) => row.itemId))].sort();
	const repsByKey = new Map<string, number>();
	for (const row of usable) {
		const key = `${row.itemId}:${row.arm}`;
		repsByKey.set(key, (repsByKey.get(key) ?? 0) + 1);
	}

	console.log(`# Advisor A/B — current+default vs v0.4.1+default`);
	console.log(`input      : ${inputPath}`);
	console.log(
		`rows       : ${String(rows.length)} (${String(runErrors)} run-error, ${String(excluded)} excluded as unusable) over ${String(items.length)} items`,
	);
	if (superseded > 0) {
		console.log(
			`resume     : ${String(superseded)} superseded row(s) collapsed (a retry after a provider failure re-ran a recorded key)`,
		);
	}
	const placeholders = placeholderOnlyNoteCount(usable);
	if (placeholders > 0) {
		console.log(
			`junk notes : ${String(placeholders)} usable rows carry a literal "placeholder" note (counts as a note; inflates FP-rate)`,
		);
	}
	const repCounts = [...new Set(repsByKey.values())].sort((a, b) => a - b);
	console.log(`reps/(item,arm): ${repCounts.join(", ")}`);
	console.log("");

	// --- Per-arm rates -------------------------------------------------------
	console.log("## Per-arm rates (each arm graded against its own visible content)");
	console.log(
		"| arm | n | hit | miss | FP | silence-ok | recall | FP-rate | precision | mean tok |",
	);
	console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const arm of ["old", "new"] as const) {
		const sub = usable.filter((row) => row.arm === arm);
		const hit = sub.filter((row) => row.verdict === "hit").length;
		const miss = sub.filter((row) => row.verdict === "miss").length;
		const fp = sub.filter((row) => row.verdict === "false-positive").length;
		const sil = sub.filter((row) => row.verdict === "silence-correct").length;
		const meanTok =
			sub.length === 0 ? 0 : sub.reduce((sum, row) => sum + row.tokens, 0) / sub.length;
		const precision = hit + fp === 0 ? 0 : (hit / (hit + fp)) * 100;
		console.log(
			`| ${arm} | ${String(sub.length)} | ${String(hit)} | ${String(miss)} | ${String(fp)} | ${String(sil)} | ${rate(hit, hit + miss)} | ${rate(fp, fp + sil)} | ${precision.toFixed(1)}% | ${meanTok.toFixed(0)} |`,
		);
	}
	console.log("");

	// --- Per-variant breakdown ----------------------------------------------
	console.log("## Per-variant (variant encodes where the inject sits)");
	console.log("| variant | arm | n | hit | miss | FP | silence-ok |");
	console.log("| --- | --- | --- | --- | --- | --- | --- |");
	for (const variant of [...new Set(usable.map((row) => row.variant))].sort()) {
		for (const arm of ["old", "new"] as const) {
			const sub = usable.filter((row) => row.variant === variant && row.arm === arm);
			if (sub.length === 0) continue;
			const count = (verdict: string): number =>
				sub.filter((row) => row.verdict === verdict).length;
			console.log(
				`| ${variant} | ${arm} | ${String(sub.length)} | ${String(count("hit"))} | ${String(count("miss"))} | ${String(count("false-positive"))} | ${String(count("silence-correct"))} |`,
			);
		}
	}
	console.log("");

	// --- Paired comparison ---------------------------------------------------
	const observations: CaseObservation[] = [];
	const notPaired: string[] = [];
	const incomplete: string[] = [];
	let droppedRepeats = 0;
	for (const itemId of items) {
		const inItem = usable.filter((entry) => entry.itemId === itemId);
		const oldRows = inItem.filter((row) => row.arm === "old");
		const newRows = inItem.filter((row) => row.arm === "new");
		// Every row for one item+arm must agree on the expectation the corpus gives
		// that arm; a disagreement means rows from different corpora or identities
		// were mixed and the stratum (which drives the gate) would depend on
		// whichever row happened to be read first.
		for (const [arm, sub] of [
			["old", oldRows],
			["new", newRows],
		] as const) {
			const expectations = new Set(sub.map((row) => `${row.expected}:${String(row.visible)}`));
			if (expectations.size > 1) {
				throw new Error(
					`${inputPath}: item ${itemId} arm ${arm} mixes expectations ${[...expectations].sort((a, b) => a.localeCompare(b)).join(", ")}; the results file mixes corpora or identities`,
				);
			}
		}
		if (oldRows.length === 0 || newRows.length === 0) {
			incomplete.push(itemId);
			continue;
		}
		// Score both arms over the repeats they BOTH recorded: an asymmetric
		// exclusion (a provider failure costs one arm its later repeats) otherwise
		// measures each arm over a different repeat set.
		const oldReps = new Set(oldRows.map((row) => row.rep ?? 1));
		const sharedReps = new Set<number>();
		for (const row of newRows) {
			const rep = row.rep ?? 1;
			if (oldReps.has(rep)) sharedReps.add(rep);
		}
		if (sharedReps.size === 0) {
			incomplete.push(itemId);
			continue;
		}
		const pairedOld = oldRows.filter((row) => sharedReps.has(row.rep ?? 1));
		const pairedNew = newRows.filter((row) => sharedReps.has(row.rep ?? 1));
		droppedRepeats += oldRows.length - pairedOld.length + (newRows.length - pairedNew.length);
		const stratum = stratumFor(
			pairedOld[0]?.expected === "finding",
			pairedNew[0]?.expected === "finding",
		);
		if (stratum !== "silence" && stratum !== "visible-finding") {
			// The two asymmetric strata are NOT well-posed pairs: one arm is graded on
			// FINDING the inject while the other is graded on STAYING SILENT, so a single
			// paired delta would subtract a false-positive rate from a recall. They are
			// reported descriptively in the per-variant table instead.
			notPaired.push(itemId);
			continue;
		}
		const build = (sub: readonly AccuracyResultRow[]): ArmAggregate => {
			// The module's convention is that `successes` is the event each rate names:
			// a hit for a finding stratum (recall), a manufactured note for the silence
			// stratum (false-positive rate). Feeding silence-correct counts in here would
			// invert the safety gate's sign and let a WORSE false-positive rate report as
			// a pass.
			const successes =
				stratum === "silence"
					? sub.filter((row) => row.verdict === "false-positive").length
					: sub.filter((row) => row.verdict === "hit").length;
			return {
				successes,
				trials: sub.length,
				tokens: sub.reduce((sum, row) => sum + row.tokens, 0),
			};
		};
		observations.push({
			caseId: itemId,
			stratum,
			sessionId: cutKeyForItemId(itemId),
			control: build(pairedOld),
			treatment: build(pairedNew),
		});
	}
	if (droppedRepeats > 0) {
		console.log(
			`note: ${String(droppedRepeats)} row(s) dropped so both arms are scored over the same (item, arm, rep) set.`,
		);
		console.log("");
	}
	if (incomplete.length > 0) {
		console.log(
			`note: ${String(incomplete.length)} items lack usable rows for one arm and are NOT paired (partial results file).`,
		);
		console.log("");
	}
	if (notPaired.length > 0) {
		console.log(
			`note: ${String(notPaired.length)} items sit in the asymmetric strata (finding for exactly one arm) and are deliberately NOT paired — see the per-variant table for those.`,
		);
		console.log("");
	}

	console.log("## Paired comparison (well-posed pairs only)");
	if (observations.length === 0) {
		console.log(
			"no well-posed pairs to summarise (every item was incomplete or in an asymmetric stratum).",
		);
		process.exitCode = 1;
		return;
	}
	const summary = summarizeAb(observations, {
		seed,
		iterations,
		confidence: PROPOSED_THRESHOLDS.confidence,
	});
	const clusters = clusterBySession(observations);
	console.log(
		`clusters (source cuts): ${String(clusters.length)}   items: ${String(observations.length)}   reps/item/arm: ${String(summary.counts.repsPerCase)}`,
	);
	console.log("");
	console.log("| stratum | cases | control | treatment | delta | 95% CI |");
	console.log("| --- | --- | --- | --- | --- | --- |");
	const row = (
		label: string,
		estimate: (typeof summary)["historyRecall"],
		cases: number,
	): string => {
		if (cases === 0) return `| ${label} | 0 | n/a | n/a | n/a | n/a |`;
		return `| ${label} | ${String(cases)} | ${estimate.control.toFixed(1)}% | ${estimate.treatment.toFixed(1)}% | ${estimate.delta >= 0 ? "+" : ""}${estimate.delta.toFixed(1)}pp | [${estimate.lower.toFixed(1)}, ${estimate.upper.toFixed(1)}] |`;
	};
	console.log(
		row(
			"visible-finding stratum — RECALL (hit counts as the event)",
			summary.visibleRecall,
			summary.counts.visibleFindingCases,
		),
	);
	console.log(
		row(
			"silence stratum — FALSE-POSITIVE rate (FP counts as the event)",
			summary.silenceFalsePositiveRate,
			summary.counts.silenceCases,
		),
	);
	console.log("");
	console.log(
		`McNemar exact p (visible-finding stratum, ${String(summary.visibleRecall.clusters)} clusters): ${summary.visibleRecallMcNemarP.toFixed(4)}`,
	);
	console.log(
		`tokens: control ${summary.tokensPct.control.toFixed(0)} -> treatment ${summary.tokensPct.treatment.toFixed(0)} (${summary.tokensPct.delta >= 0 ? "+" : ""}${summary.tokensPct.delta.toFixed(1)}%, CI [${summary.tokensPct.lower.toFixed(1)}, ${summary.tokensPct.upper.toFixed(1)}])`,
	);
	console.log("");

	const report = evaluateGates(summary, PROPOSED_THRESHOLDS);
	console.log(`## Acceptance gates (issue #141 bar) — overall: ${report.overall}`);
	console.log("| gate | requirement | observed | verdict |");
	console.log("| --- | --- | --- | --- |");
	for (const gate of report.gates) {
		console.log(`| ${gate.id} | ${gate.requirement} | ${gate.observed} | ${gate.verdict} |`);
	}
	console.log("");
	console.log(
		report.overall === "pass"
			? "VERDICT: the bar is met."
			: report.overall === "fail"
				? "VERDICT: the bar is not met and the interval is decisive."
				: "VERDICT: insufficient evidence — the corpus is below the bar's floors and/or the interval straddles it. Read the per-arm rates; do not treat this as a merge decision.",
	);
}

main();
