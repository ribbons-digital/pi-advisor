/**
 * Prompt A/B: does the scoped-materiality prompt variant improve Advisor
 * effectiveness?
 *
 * Compares two accuracy runs that differ ONLY in the appended prompt block
 * (`--prompt-variant baseline` vs `scoped`), pairing per (item, arm). Both runs
 * use the same rendering arms, so for a given item+arm the expectation is
 * identical in the two runs and the pair is well-posed — unlike the
 * version-vs-version comparison, no stratum has to be dropped.
 *
 * Semantics follow `paired-stats`: `successes` is the event each rate names — a
 * hit for a finding-expected item (recall), a manufactured note for a
 * silence-expected item (false-positive rate). Feeding silence-correct counts
 * into the silence stratum would invert the sign of the FP result.
 *
 * Run: `bun scripts/f9-experiment/analyze-prompt-ab.ts
 *        --control docs/internal/accuracy-ab-ds41.jsonl
 *        --treatment docs/internal/accuracy-ab-scoped.jsonl`
 */
import {
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

interface ArmAggregate {
	successes: number;
	trials: number;
	tokens: number;
}

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

function pct(value: number): string {
	return `${value.toFixed(1)}%`;
}

function pp(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}pp`;
}

/** Per-arm descriptive rates for one result file. */
function describe(rows: readonly AccuracyResultRow[], label: string): void {
	console.log(`### ${label}`);
	console.log(
		"| arm | n | hit | miss | FP | silence-ok | recall | FP-rate | precision | mean tok |",
	);
	console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const arm of ["old", "new"] as const) {
		const sub = rows.filter((row) => row.arm === arm && resultRowIsUsable(row));
		if (sub.length === 0) continue;
		const count = (verdict: string): number => sub.filter((row) => row.verdict === verdict).length;
		const hit = count("hit");
		const miss = count("miss");
		const fp = count("false-positive");
		const sil = count("silence-correct");
		const meanTok = sub.reduce((sum, row) => sum + row.tokens, 0) / sub.length;
		const precision = hit + fp === 0 ? 0 : (hit / (hit + fp)) * 100;
		console.log(
			`| ${arm} | ${String(sub.length)} | ${String(hit)} | ${String(miss)} | ${String(fp)} | ${String(sil)} | ${hit + miss === 0 ? "n/a" : pct((hit / (hit + miss)) * 100)} | ${fp + sil === 0 ? "n/a" : pct((fp / (fp + sil)) * 100)} | ${pct(precision)} | ${meanTok.toFixed(0)} |`,
		);
	}
	console.log("");
}

function main(): void {
	const args = process.argv.slice(2);
	const controlPath = argValue(args, "control");
	const treatmentPath = argValue(args, "treatment");
	if (controlPath === undefined || treatmentPath === undefined) {
		throw new Error("usage: --control <baseline.jsonl> --treatment <variant.jsonl>");
	}
	const controlLoaded = dedupeResultRows(loadResultRows(controlPath), controlPath);
	const treatmentLoaded = dedupeResultRows(loadResultRows(treatmentPath), treatmentPath);
	const controlRows = controlLoaded.rows;
	const treatmentRows = treatmentLoaded.rows;
	const iterations = numberArg(args, "iterations", 10_000);
	const confidence = PROPOSED_THRESHOLDS.confidence;
	// Labels are display-only: they name the two files in the report headers so a
	// comparison between two non-baseline variants does not misdescribe itself.
	const controlLabel = argValue(args, "control-label") ?? "control";
	const treatmentLabel = argValue(args, "treatment-label") ?? "treatment";

	console.log(`# Prompt A/B — ${controlLabel} vs ${treatmentLabel}`);
	console.log(`control   : ${controlPath} (${String(controlRows.length)} rows)`);
	console.log(`treatment : ${treatmentPath} (${String(treatmentRows.length)} rows)`);
	for (const [label, loaded] of [
		["control", controlLoaded],
		["treatment", treatmentLoaded],
	] as const) {
		const excluded =
			loaded.rows.length - loaded.rows.filter((row) => resultRowIsUsable(row)).length;
		if (loaded.superseded > 0) {
			console.log(
				`${label}   : ${String(loaded.superseded)} superseded row(s) collapsed (a retry after a provider failure re-ran a recorded key)`,
			);
		}
		if (excluded > 0) {
			console.log(
				`${label}   : ${String(excluded)} rows excluded (run-error or no model usage; provider failures persisted before the runner classified them)`,
			);
		}
		const placeholders = placeholderOnlyNoteCount(
			loaded.rows.filter((row) => resultRowIsUsable(row)),
		);
		if (placeholders > 0) {
			console.log(
				`${label}   : ${String(placeholders)} usable rows carry a literal "placeholder" note (counts as a note; inflates FP-rate)`,
			);
		}
	}
	console.log("");
	describe(controlRows, `${controlLabel} (control)`);
	describe(treatmentRows, `${treatmentLabel} (treatment)`);

	for (const arm of ["old", "new"] as const) {
		const observations: CaseObservation[] = [];
		const asymmetricPairs: string[] = [];
		let droppedRepeats = 0;
		const items = [
			...new Set(controlRows.filter((row) => row.arm === arm).map((row) => row.itemId)),
		].sort();
		for (const itemId of items) {
			const controlSub = controlRows.filter(
				(row) => row.itemId === itemId && row.arm === arm && resultRowIsUsable(row),
			);
			const treatmentSub = treatmentRows.filter(
				(row) => row.itemId === itemId && row.arm === arm && resultRowIsUsable(row),
			);
			if (controlSub.length === 0 || treatmentSub.length === 0) continue;
			// Pair at the exact (item, arm, rep) key. Once unusable rows are excluded
			// the two sides can hold different repeats (a provider failure costs one
			// side its reps 4-5), and scoring each side over a different repeat set
			// would let the missingness masquerade as a prompt effect.
			const controlReps = new Set(controlSub.map((row) => row.rep ?? 1));
			const sharedReps = new Set<number>();
			for (const row of treatmentSub) {
				const rep = row.rep ?? 1;
				if (controlReps.has(rep)) sharedReps.add(rep);
			}
			if (sharedReps.size === 0) {
				asymmetricPairs.push(`${itemId}:${arm}`);
				continue;
			}
			const pairedControl = controlSub.filter((row) => sharedReps.has(row.rep ?? 1));
			const pairedTreatment = treatmentSub.filter((row) => sharedReps.has(row.rep ?? 1));
			droppedRepeats +=
				controlSub.length - pairedControl.length + (treatmentSub.length - pairedTreatment.length);
			// Both runs render the same arm, so the corpus expectation must agree across
			// every row of the pair; otherwise the stratum would depend on row order.
			const expectations = new Set(
				[...pairedControl, ...pairedTreatment].map(
					(row) => `${row.itemId}:${row.arm}:${row.expected}:${String(row.visible)}`,
				),
			);
			if (expectations.size > 1) {
				throw new Error(
					`${itemId} arm ${arm} mixes expectations ${[...expectations].sort((a, b) => a.localeCompare(b)).join(", ")}; the two files do not share one corpus`,
				);
			}
			const expected = pairedControl[0]?.expected;
			if (expected === undefined) continue;
			// Same rendering in both runs, so the expectation is shared and the pair
			// is well-posed; only the prompt differs.
			const stratum: AbStratum = expected === "finding" ? "visible-finding" : "silence";
			const build = (sub: readonly AccuracyResultRow[]): ArmAggregate => ({
				successes:
					stratum === "silence"
						? sub.filter((row) => row.verdict === "false-positive").length
						: sub.filter((row) => row.verdict === "hit").length,
				trials: sub.length,
				tokens: sub.reduce((sum, row) => sum + row.tokens, 0),
			});
			observations.push({
				caseId: `${itemId}:${arm}`,
				stratum,
				sessionId: cutKeyForItemId(itemId),
				control: build(pairedControl),
				treatment: build(pairedTreatment),
			});
		}
		const finding = observations.filter((entry) => entry.stratum !== "silence");
		const silence = observations.filter((entry) => entry.stratum === "silence");
		if (asymmetricPairs.length > 0) {
			console.log(
				`note arm=${arm}: ${String(asymmetricPairs.length)} item(s) have no repeat present in BOTH sides and were dropped (${asymmetricPairs.slice(0, 4).join(", ")}${asymmetricPairs.length > 4 ? ", …" : ""}).`,
			);
		}
		if (droppedRepeats > 0) {
			console.log(
				`note arm=${arm}: ${String(droppedRepeats)} row(s) dropped so both sides are scored over the same (item, arm, rep) set.`,
			);
		}
		if (finding.length === 0 && silence.length === 0) continue;

		const summary = summarizeAb(observations, {
			seed: 20_260_912,
			iterations,
			confidence,
		});
		console.log(
			`## arm=${arm} — paired (control = ${controlLabel}, treatment = ${treatmentLabel})`,
		);
		console.log("| metric | stratum | cases | control | treatment | delta | 95% CI |");
		console.log("| --- | --- | --- | --- | --- | --- | --- |");
		if (finding.length > 0) {
			const recall = summary.visibleRecall;
			console.log(
				`| recall | finding-expected | ${String(finding.length)} | ${pct(recall.control)} | ${pct(recall.treatment)} | ${pp(recall.delta)} | [${pp(recall.lower)}, ${pp(recall.upper)}] |`,
			);
		}
		if (silence.length > 0) {
			const fp = summary.silenceFalsePositiveRate;
			console.log(
				`| false-positive rate | silence-expected | ${String(silence.length)} | ${pct(fp.control)} | ${pct(fp.treatment)} | ${pp(fp.delta)} | [${pp(fp.lower)}, ${pp(fp.upper)}] |`,
			);
		}
		const tokens = summary.tokensPct;
		console.log(
			`| tokens | all | ${String(observations.length)} | ${tokens.control.toFixed(0)} | ${tokens.treatment.toFixed(0)} | ${tokens.delta >= 0 ? "+" : ""}${tokens.delta.toFixed(1)}% | [${tokens.lower.toFixed(1)}%, ${tokens.upper.toFixed(1)}%] |`,
		);
		console.log("");
		const fpEstimate = summary.silenceFalsePositiveRate;
		const recallEstimate = summary.visibleRecall;
		const fpVerdict =
			silence.length === 0
				? "unmeasured"
				: fpEstimate.upper < 0
					? "FP decisively LOWER"
					: fpEstimate.lower > 0
						? "FP decisively HIGHER"
						: "FP change not decisive";
		const recallVerdict =
			finding.length === 0
				? "unmeasured"
				: recallEstimate.lower >= -PROPOSED_THRESHOLDS.visibleRecallMaxDropPp
					? "recall preserved (within 5pp)"
					: recallEstimate.upper < -PROPOSED_THRESHOLDS.visibleRecallMaxDropPp
						? "recall decisively LOWER"
						: "recall not decisive";
		console.log(`arm=${arm}: ${fpVerdict}; ${recallVerdict}`);
		console.log("");
	}
	console.log(
		"note: intervals resample SOURCE CUTS, and the corpus has only 9 cuts, so the intervals are wide by construction — 'not decisive' is expected at this sample size.",
	);
}

main();
