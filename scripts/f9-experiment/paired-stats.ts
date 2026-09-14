/**
 * Seeded paired statistics for the compaction A/B experiment.
 *
 * Sized to the acceptance bar recorded in issue #141 (comment 5518416233):
 * a 95% paired confidence interval for each comparison, with the interval
 * required to support BOTH the recall improvement and the false-positive
 * safety limit. The thresholds themselves are NOT defined here — the caller
 * passes them in, so the bar has to be written down before a run (see
 * `docs/internal/compact-ab-protocol.md`), which is what the reviewer asked
 * for: "record them before the experiment and apply them consistently".
 *
 * Design notes.
 *
 * - **Clustering.** The same case is run `minReps` times per arm. Repeats of
 *   one case are not independent draws (same transcript, same injection), so
 *   the resampling unit is the CASE rather than the (case, rep) run.
 *   `bootstrapCi` resamples cases with replacement and re-derives each arm's
 *   rate from all of that case's repeats, which keeps within-case correlation
 *   out of the interval tails.
 * - **Pairing.** Every case is measured under both arms, so the estimand is a
 *   within-case difference (`treatment − control`). Pairing removes the
 *   between-case difficulty variance that dominates here: some transcripts are
 *   simply harder to review than others, and that difficulty is shared by both
 *   arms of the same case.
 * - **Determinism.** The PRNG is seeded, so re-analysing a saved result set
 *   reproduces the identical interval. The seed is reported with the result.
 * - **Not used for the gate.** McNemar's exact test is reported alongside the
 *   bootstrap as a distribution-free sanity check on the discordant pairs. The
 *   gate decision is interval-based, matching the reviewer's wording.
 */
import { isNumberValue } from "../../src/value-guards.js";

/** `control` = verbatim history (v0.4.1 behaviour); `treatment` = deterministic compression. */
export type AbArm = "control" | "treatment";

export const AB_ARMS: readonly AbArm[] = ["control", "treatment"];

/**
 * Case kinds. The reviewer's bar names three distinct populations, and they are
 * scored separately because they answer different questions:
 * `history-only-finding` (evidence survives only in history the compressor
 * rewrites) carries the recall gate; `visible-finding` guards against
 * collateral damage; `silence` guards against manufacturing findings.
 */
export type AbStratum =
	| "history-only-finding"
	| "render-only-finding"
	| "visible-finding"
	| "silence";

export const AB_STRATA: readonly AbStratum[] = [
	"history-only-finding",
	"render-only-finding",
	"visible-finding",
	"silence",
];

/** One arm's aggregate for a case, across that case's repeats. */
export interface ArmObservation {
	/** Runs in which the Advisor emitted a material note. */
	successes: number;
	/** Runs performed (equals the case's repeat count when complete). */
	trials: number;
	/** Total tokens billed across runs. */
	tokens: number;
}

/** One case, measured under both arms. */
export interface CaseObservation {
	caseId: string;
	stratum: AbStratum;
	/** Source session, used to prove finding and silence cases are disjoint. */
	sessionId: string;
	control: ArmObservation;
	treatment: ArmObservation;
}

/** A metric with its paired interval. */
export interface PairedEstimate {
	control: number;
	treatment: number;
	/** `treatment − control`: percentage points for rates, percent for tokens. */
	delta: number;
	lower: number;
	upper: number;
	/** Cases contributing to the estimate. */
	clusters: number;
	/** Bootstrap iterations skipped because a resample held no eligible case. */
	skippedIterations: number;
	confidence: number;
	seed: number;
	iterations: number;
}

export interface AbSummary {
	/** Recall on cases whose only evidence is in compressed history — the primary gate. */
	historyRecall: PairedEstimate;
	/**
	 * Correctness on cases whose evidence is visible to `control` but NOT to
	 * `treatment` (stripping reasoning removed it). This is deliberately a
	 * SEPARATE estimate from `historyRecall`: the two strata ask opposite
	 * questions — "does extra retained history gain a finding" versus "does
	 * removing reasoning lose one" — so netting them into a single delta would
	 * report a number that corresponds to no hypothesis.
	 */
	renderOnlyRecall: PairedEstimate;
	/** Recall on cases whose evidence is visible regardless of compression — collateral-damage guard. */
	visibleRecall: PairedEstimate;
	/** Rate of manufactured notes on silence cases. */
	silenceFalsePositiveRate: PairedEstimate;
	/** `TP / (TP + FP)` over all cases: expected notes over notes actually emitted. */
	precision: PairedEstimate;
	/** Mean billed tokens per run, as a relative change versus control. */
	tokensPct: PairedEstimate;
	/** Case counts actually present, to compare against the bar's floors. */
	counts: {
		historyOnlyFindingCases: number;
		renderOnlyFindingCases: number;
		visibleFindingCases: number;
		silenceCases: number;
		repsPerCase: number;
		/** Distinct sessions the cases came from: the unit the interval resamples. */
		clusters: number;
	};
	/** McNemar exact two-sided p on history-only discordant pairs (descriptive only). */
	historyRecallMcNemarP: number;
	/** McNemar exact two-sided p on visible-finding discordant pairs (descriptive only). */
	visibleRecallMcNemarP: number;
	seed: number;
	iterations: number;
	confidence: number;
}

/** The bar. Callers must supply these explicitly. */
export interface AcceptanceThresholds {
	/** Minimum point improvement in history-only recall, in percentage points. */
	historyRecallGainPp: number;
	/** Maximum tolerated increase in silence-case false positives, in percentage points. */
	falsePositiveMaxIncreasePp: number;
	/** Maximum tolerated drop in recall for findings already visible, in percentage points. */
	visibleRecallMaxDropPp: number;
	/** Maximum tolerated drop in factual precision, in percentage points. */
	precisionMaxDropPp: number;
	/** Maximum tolerated increase in billed tokens, in percent. */
	tokensMaxIncreasePct: number;
	confidence: number;
	minFindingCases: number;
	minSilenceCases: number;
	minReps: number;
}

/** The reviewer's proposal, frozen verbatim so a run can cite it. */
export const PROPOSED_THRESHOLDS: AcceptanceThresholds = {
	historyRecallGainPp: 10,
	falsePositiveMaxIncreasePp: 5,
	visibleRecallMaxDropPp: 5,
	precisionMaxDropPp: 5,
	tokensMaxIncreasePct: 10,
	confidence: 0.95,
	minFindingCases: 30,
	minSilenceCases: 30,
	minReps: 5,
};

export interface GateResult {
	id: string;
	requirement: string;
	observed: string;
	/** `unmet` means the evidence cannot decide (interval straddles the bar). */
	verdict: "pass" | "fail" | "unmet";
	/** Explicitly optional: gates without an explanatory note assign `undefined`. */
	note?: string | undefined;
}

export interface GateReport {
	gates: GateResult[];
	/** `pass` only when every gate passes and the corpus floors are met. */
	overall: "pass" | "fail" | "insufficient-evidence";
	thresholds: AcceptanceThresholds;
}

/** Deterministic PRNG (mulberry32). Returns a function yielding [0, 1). */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Rate in percentage points, or `undefined` when no trial was observed. */
function ratePp(successes: number, trials: number): number | undefined {
	return trials === 0 ? undefined : (successes / trials) * 100;
}

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) throw new Error("percentile requires at least one sample");
	const position = q * (sorted.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sorted[lowerIndex];
	const upper = sorted[upperIndex];
	if (lower === undefined || upper === undefined) throw new Error("percentile index out of range");
	return lower + (upper - lower) * (position - lowerIndex);
}

interface BootstrapOptions {
	seed: number;
	iterations: number;
	confidence: number;
}

/** Percentile interval produced by the cluster bootstrap. */
interface BootstrapInterval {
	lower: number;
	upper: number;
	/** Cases contributing to the interval. */
	clusterCount: number;
	/** Iterations skipped because a resample held no eligible case. */
	skipped: number;
}

function clampConfidence(confidence: number): number {
	if (
		!isNumberValue(confidence) ||
		!Number.isFinite(confidence) ||
		confidence <= 0 ||
		confidence >= 1
	) {
		throw new Error(`confidence must be a finite number in (0, 1); received ${String(confidence)}`);
	}
	return confidence;
}

/**
 * Cluster bootstrap over paired cases for one statistic.
 *
 * `statistic` returns `undefined` when a resample carries no eligible case (for
 * example one that dropped every silence case while estimating the
 * false-positive rate). Those iterations are counted and skipped rather than
 * defaulted to zero, which would fabricate a tighter interval than the data
 * supports.
 */
export function bootstrapCi(
	cases: readonly CaseObservation[],
	statistic: (sample: readonly CaseObservation[]) => number | undefined,
	options: BootstrapOptions,
): BootstrapInterval {
	const confidence = clampConfidence(options.confidence);
	if (cases.length === 0) throw new Error("bootstrapCi requires at least one case");
	if (!Number.isInteger(options.iterations) || options.iterations < 1) {
		throw new Error(
			`iterations must be a positive integer; received ${String(options.iterations)}`,
		);
	}
	const random = seededRandom(options.seed);
	const samples: number[] = [];
	let skipped = 0;
	for (let iteration = 0; iteration < options.iterations; iteration++) {
		const resample: CaseObservation[] = [];
		for (let draw = cases.length; draw > 0; draw--) {
			const pick = cases[Math.floor(random() * cases.length)];
			if (pick !== undefined) resample.push(pick);
		}
		const value = statistic(resample);
		if (value === undefined || !Number.isFinite(value)) skipped++;
		else samples.push(value);
	}
	if (samples.length === 0) throw new Error("bootstrap produced no finite samples");
	samples.sort((a, b) => a - b);
	const tail = (1 - confidence) / 2;
	return {
		lower: percentile(samples, tail),
		upper: percentile(samples, 1 - tail),
		clusterCount: cases.length,
		skipped,
	};
}

/** McNemar exact p on clusters whose success counts disagree. */
function mcnemarOnClusters(clusters: readonly CaseObservation[]): number {
	let controlOnly = 0;
	let treatmentOnly = 0;
	for (const entry of clusters) {
		if (entry.control.successes > entry.treatment.successes) controlOnly++;
		else if (entry.treatment.successes > entry.control.successes) treatmentOnly++;
	}
	return mcnemarExact(controlOnly, treatmentOnly);
}

/**
 * McNemar's exact two-sided p-value on discordant pairs.
 *
 * Reported for transparency only: the gate is interval-based. With the small
 * discordant counts typical here the exact form is the honest one — the
 * chi-square approximation is unreliable below roughly 25 discordant pairs.
 */
export function mcnemarExact(
	discordantControlOnly: number,
	discordantTreatmentOnly: number,
): number {
	const b = discordantControlOnly;
	const c = discordantTreatmentOnly;
	if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
		throw new Error(
			`discordant counts must be non-negative integers; got ${String(b)}, ${String(c)}`,
		);
	}
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	// Two-sided exact: 2 * P(X <= k) for X ~ Binomial(n, 1/2), capped at 1.
	let cumulative = 0;
	let coefficient = 1;
	for (let i = 0; i <= k; i++) {
		cumulative += coefficient;
		coefficient = (coefficient * (n - i)) / (i + 1);
	}
	return Math.min(1, (2 * cumulative) / 2 ** n);
}

/**
 * Collapse cases down to one row per (SOURCE SESSION, STRATUM).
 *
 * A session may legitimately supply several cases (different review windows, or
 * several injected variants), but those cases share one transcript and one style,
 * so they are not independent draws. Resampling cases would then understate the
 * interval — precisely the failure mode the reviewer's "separate sessions" clause
 * exists to prevent. The bootstrap therefore resamples SESSIONS, while the
 * reported case counts (which the bar's floors are stated in) keep counting
 * cases.
 *
 * The stratum is part of the key rather than an assertion: a real corpus can put
 * a finding case and a silence case in the same session (the accuracy corpus draws
 * all four variants from one source cut), and that is a legitimate design — only
 * the *statistical* independence is what matters. Keeping the stratum in the key
 * means a finding cluster and a silence cluster from one session stay separate, so
 * no cluster ever mixes two different expectations.
 *
 * Point estimates are unchanged by the collapse: every metric here is a ratio of
 * summed successes to summed trials, and summing is associative.
 */
export function clusterBySession(cases: readonly CaseObservation[]): CaseObservation[] {
	const byCluster = new Map<string, CaseObservation>();
	for (const entry of cases) {
		const key = `${entry.sessionId}\u0000${entry.stratum}`;
		const existing = byCluster.get(key);
		if (existing === undefined) {
			byCluster.set(key, {
				caseId: key,
				stratum: entry.stratum,
				sessionId: entry.sessionId,
				control: { ...entry.control },
				treatment: { ...entry.treatment },
			});
			continue;
		}
		existing.control.successes += entry.control.successes;
		existing.control.trials += entry.control.trials;
		existing.control.tokens += entry.control.tokens;
		existing.treatment.successes += entry.treatment.successes;
		existing.treatment.trials += entry.treatment.trials;
		existing.treatment.tokens += entry.treatment.tokens;
	}
	return [...byCluster.values()];
}

/** Successes/trials/tokens summed across the given cases for one arm. */
function aggregate(cases: readonly CaseObservation[], arm: AbArm): ArmObservation {
	let successes = 0;
	let trials = 0;
	let tokens = 0;
	for (const observation of cases) {
		const view = observation[arm];
		successes += view.successes;
		trials += view.trials;
		tokens += view.tokens;
	}
	return { successes, trials, tokens };
}

function estimate(
	population: readonly CaseObservation[],
	statistic: (sample: readonly CaseObservation[]) => number | undefined,
	point: { control: number; treatment: number; delta?: number },
	options: BootstrapOptions,
): PairedEstimate {
	const ci = bootstrapCi(population, statistic, options);
	return {
		control: point.control,
		treatment: point.treatment,
		// Rates and token means both carry a plain difference, but the token
		// metric reports a RELATIVE change, so callers may supply the point
		// estimate explicitly rather than have it recomputed as a subtraction.
		delta: point.delta ?? point.treatment - point.control,
		lower: ci.lower,
		upper: ci.upper,
		clusters: ci.clusterCount,
		skippedIterations: ci.skipped,
		confidence: clampConfidence(options.confidence),
		seed: options.seed,
		iterations: options.iterations,
	};
}

/** Paired rate difference in percentage points, over an explicit case population. */
function estimateRateDelta(
	population: readonly CaseObservation[],
	options: BootstrapOptions,
): PairedEstimate {
	const control =
		ratePp(aggregate(population, "control").successes, aggregate(population, "control").trials) ??
		0;
	const treatment =
		ratePp(
			aggregate(population, "treatment").successes,
			aggregate(population, "treatment").trials,
		) ?? 0;
	return estimate(
		population,
		(sample) => {
			const c = ratePp(aggregate(sample, "control").successes, aggregate(sample, "control").trials);
			const t = ratePp(
				aggregate(sample, "treatment").successes,
				aggregate(sample, "treatment").trials,
			);
			return c === undefined || t === undefined ? undefined : t - c;
		},
		{ control, treatment },
		options,
	);
}

function precisionOf(sample: readonly CaseObservation[], arm: AbArm): number | undefined {
	const truePositives = aggregate(
		sample.filter((entry) => entry.stratum !== "silence"),
		arm,
	).successes;
	const falsePositives = aggregate(
		sample.filter((entry) => entry.stratum === "silence"),
		arm,
	).successes;
	const emitted = truePositives + falsePositives;
	return emitted === 0 ? undefined : (truePositives / emitted) * 100;
}

function meanTokensPerRun(sample: readonly CaseObservation[], arm: AbArm): number | undefined {
	const totals = aggregate(sample, arm);
	return totals.trials === 0 ? undefined : totals.tokens / totals.trials;
}

export interface SummarizeOptions {
	seed: number;
	iterations: number;
	confidence: number;
}

/**
 * Summarise a paired result set into the metrics the acceptance bar scores.
 *
 * Rates are percentage points and tokens a relative percent, so deltas line up
 * with the reviewer's wording without unit conversion at the call site.
 */
export function summarizeAb(
	cases: readonly CaseObservation[],
	options: SummarizeOptions,
): AbSummary {
	if (cases.length === 0) throw new Error("summarizeAb requires at least one case");
	const bootstrapOptions: BootstrapOptions = {
		seed: options.seed,
		iterations: options.iterations,
		confidence: options.confidence,
	};

	// Interval estimation resamples SESSIONS; the reported counts and the bar's
	// floors stay in cases. See clusterBySession for why.
	const clusters = clusterBySession(cases);
	const historyOnly = clusters.filter((entry) => entry.stratum === "history-only-finding");
	const renderOnly = clusters.filter((entry) => entry.stratum === "render-only-finding");
	const visible = clusters.filter((entry) => entry.stratum === "visible-finding");
	const silence = clusters.filter((entry) => entry.stratum === "silence");

	if (historyOnly.length === 0 && renderOnly.length === 0 && visible.length === 0) {
		throw new Error(
			"summarizeAb requires at least one finding case (history-only or render-only or visible); without one the comparison is undecidable",
		);
	}

	const historyRecall =
		historyOnly.length === 0
			? emptyEstimate(bootstrapOptions)
			: estimateRateDelta(historyOnly, bootstrapOptions);
	const renderOnlyRecall =
		renderOnly.length === 0
			? emptyEstimate(bootstrapOptions)
			: estimateRateDelta(renderOnly, bootstrapOptions);
	const visibleRecall =
		visible.length === 0
			? emptyEstimate(bootstrapOptions)
			: estimateRateDelta(visible, bootstrapOptions);
	const silenceFalsePositiveRate =
		silence.length === 0
			? emptyEstimate(bootstrapOptions)
			: estimateRateDelta(silence, bootstrapOptions);

	const precisionControl = precisionOf(clusters, "control");
	const precisionTreatment = precisionOf(clusters, "treatment");
	// Precision is undefined when an arm emitted no note at all: `TP / (TP + FP)`
	// has no denominator. That is legitimate data (a perfectly silent corpus),
	// not an error, so the metric degrades to an empty estimate and the gate
	// reports `unmet` instead of pretending the guard held.
	const precision =
		precisionControl === undefined || precisionTreatment === undefined
			? emptyEstimate(bootstrapOptions)
			: estimate(
					clusters,
					(sample) => {
						const c = precisionOf(sample, "control");
						const t = precisionOf(sample, "treatment");
						return c === undefined || t === undefined ? undefined : t - c;
					},
					{ control: precisionControl, treatment: precisionTreatment },
					bootstrapOptions,
				);

	const tokensControl = meanTokensPerRun(clusters, "control") ?? 0;
	const tokensTreatment = meanTokensPerRun(clusters, "treatment") ?? 0;
	const tokensPct = estimate(
		clusters,
		(sample) => {
			const c = meanTokensPerRun(sample, "control");
			const t = meanTokensPerRun(sample, "treatment");
			return c === undefined || t === undefined || c === 0 ? undefined : ((t - c) / c) * 100;
		},
		{
			control: tokensControl,
			treatment: tokensTreatment,
			delta: tokensControl === 0 ? 0 : ((tokensTreatment - tokensControl) / tokensControl) * 100,
		},
		bootstrapOptions,
	);

	const repsPerCase = cases.reduce(
		(minimum, entry) => Math.min(minimum, entry.control.trials, entry.treatment.trials),
		Number.POSITIVE_INFINITY,
	);

	return {
		historyRecall,
		renderOnlyRecall,
		visibleRecall,
		silenceFalsePositiveRate,
		precision,
		tokensPct,
		counts: {
			// Case-level counts: the bar's floors are stated in cases.
			historyOnlyFindingCases: cases.filter((entry) => entry.stratum === "history-only-finding")
				.length,
			visibleFindingCases: cases.filter((entry) => entry.stratum === "visible-finding").length,
			renderOnlyFindingCases: cases.filter((entry) => entry.stratum === "render-only-finding")
				.length,
			silenceCases: cases.filter((entry) => entry.stratum === "silence").length,
			repsPerCase: Number.isFinite(repsPerCase) ? repsPerCase : 0,
			clusters: clusters.length,
		},
		historyRecallMcNemarP: mcnemarOnClusters(historyOnly),
		visibleRecallMcNemarP: mcnemarOnClusters(visible),
		seed: options.seed,
		iterations: options.iterations,
		confidence: clampConfidence(options.confidence),
	};
}

/** A zero-width estimate for a stratum the corpus did not supply. */
function emptyEstimate(options: BootstrapOptions): PairedEstimate {
	return {
		control: 0,
		treatment: 0,
		delta: 0,
		lower: 0,
		upper: 0,
		clusters: 0,
		skippedIterations: 0,
		confidence: clampConfidence(options.confidence),
		seed: options.seed,
		iterations: options.iterations,
	};
}

/**
 * The bar's structural preconditions, checked before any verdict is reported.
 *
 * "Improve history-only finding recall by at least 10 percentage points" is not
 * decidable from a corpus with no history-only cases, so a run that misses a
 * floor reports `insufficient-evidence` rather than `fail`: `fail` would close
 * the question, and the problem is the corpus, not the feature.
 */
export function evaluateGates(summary: AbSummary, thresholds: AcceptanceThresholds): GateReport {
	const pp = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)}pp`;
	const pct = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
	const ci = (estimateValue: PairedEstimate, format: (value: number) => string): string =>
		`[${format(estimateValue.lower)}, ${format(estimateValue.upper)}]`;

	const findingCases =
		summary.counts.historyOnlyFindingCases +
		summary.counts.renderOnlyFindingCases +
		summary.counts.visibleFindingCases;
	const floorsMet =
		findingCases >= thresholds.minFindingCases &&
		summary.counts.silenceCases >= thresholds.minSilenceCases &&
		summary.counts.repsPerCase >= thresholds.minReps;

	const gates: GateResult[] = [];
	gates.push({
		id: "corpus-floors",
		requirement: `>=${String(thresholds.minFindingCases)} finding + >=${String(thresholds.minSilenceCases)} silence cases, >=${String(thresholds.minReps)} reps each`,
		observed: `${String(summary.counts.historyOnlyFindingCases)} history-only + ${String(summary.counts.renderOnlyFindingCases)} render-only + ${String(summary.counts.visibleFindingCases)} visible finding, ${String(summary.counts.silenceCases)} silence, ${String(summary.counts.repsPerCase)} reps`,
		verdict: floorsMet ? "pass" : "fail",
	});

	const recall = summary.historyRecall;
	gates.push({
		id: "history-recall-gain",
		requirement: `point delta >= ${String(thresholds.historyRecallGainPp)}pp AND CI lower bound > 0`,
		observed: `${pp(recall.delta)} ${ci(recall, pp)}`,
		verdict:
			recall.clusters === 0
				? "unmet"
				: recall.delta >= thresholds.historyRecallGainPp && recall.lower > 0
					? "pass"
					: recall.upper < thresholds.historyRecallGainPp
						? "fail"
						: "unmet",
		note:
			recall.clusters === 0
				? "the corpus supplied no history-only case"
				: recall.upper < thresholds.historyRecallGainPp
					? "the interval excludes the required gain"
					: "the interval does not yet support the required gain",
	});

	// The opposite question to `history-recall-gain`: evidence that the control
	// could see and the treatment cannot, because stripping reasoning removed it.
	// Reported separately so neither direction can mask the other; bounded by the
	// same 5pp collateral-damage margin as the visible-recall guard.
	const renderCost = summary.renderOnlyRecall;
	gates.push({
		id: "render-recall-cost",
		requirement: `point delta >= -${String(thresholds.visibleRecallMaxDropPp)}pp AND CI lower bound >= -${String(thresholds.visibleRecallMaxDropPp)}pp`,
		observed: `${pp(renderCost.delta)} ${ci(renderCost, pp)}`,
		verdict:
			renderCost.clusters === 0
				? "unmet"
				: renderCost.lower >= -thresholds.visibleRecallMaxDropPp
					? "pass"
					: renderCost.upper < -thresholds.visibleRecallMaxDropPp
						? "fail"
						: "unmet",
		note: renderCost.clusters === 0 ? "no case is visible only to the control arm" : undefined,
	});

	const falsePositive = summary.silenceFalsePositiveRate;
	gates.push({
		id: "false-positive-safety",
		requirement: `point delta <= ${String(thresholds.falsePositiveMaxIncreasePp)}pp AND CI upper bound <= ${String(thresholds.falsePositiveMaxIncreasePp)}pp`,
		observed: `${pp(falsePositive.delta)} ${ci(falsePositive, pp)}`,
		verdict:
			falsePositive.clusters === 0
				? "unmet"
				: falsePositive.upper <= thresholds.falsePositiveMaxIncreasePp
					? "pass"
					: falsePositive.lower > thresholds.falsePositiveMaxIncreasePp
						? "fail"
						: "unmet",
		note:
			falsePositive.clusters === 0
				? "the corpus supplied no silence case"
				: falsePositive.lower > thresholds.falsePositiveMaxIncreasePp
					? "the interval excludes the safety limit"
					: "the interval does not yet exclude the safety limit",
	});

	const visibleEstimate = summary.visibleRecall;
	gates.push({
		id: "visible-recall-guard",
		requirement: `point delta >= -${String(thresholds.visibleRecallMaxDropPp)}pp AND CI lower bound >= -${String(thresholds.visibleRecallMaxDropPp)}pp`,
		observed: `${pp(visibleEstimate.delta)} ${ci(visibleEstimate, pp)}`,
		verdict:
			visibleEstimate.clusters === 0
				? "unmet"
				: visibleEstimate.lower >= -thresholds.visibleRecallMaxDropPp
					? "pass"
					: visibleEstimate.upper < -thresholds.visibleRecallMaxDropPp
						? "fail"
						: "unmet",
		note: visibleEstimate.clusters === 0 ? "no visible-finding cases in the corpus" : undefined,
	});

	const precision = summary.precision;
	gates.push({
		id: "precision-guard",
		requirement: `point delta >= -${String(thresholds.precisionMaxDropPp)}pp AND CI lower bound >= -${String(thresholds.precisionMaxDropPp)}pp`,
		observed: `${pp(precision.delta)} ${ci(precision, pp)}`,
		verdict:
			precision.clusters === 0
				? "unmet"
				: precision.lower >= -thresholds.precisionMaxDropPp
					? "pass"
					: precision.upper < -thresholds.precisionMaxDropPp
						? "fail"
						: "unmet",
		note:
			precision.clusters === 0
				? "an arm emitted no note, so precision has no denominator"
				: undefined,
	});

	const tokens = summary.tokensPct;
	gates.push({
		id: "token-budget",
		requirement: `delta <= ${String(thresholds.tokensMaxIncreasePct)}% AND CI upper bound <= ${String(thresholds.tokensMaxIncreasePct)}%`,
		observed: `${pct(tokens.delta)} ${ci(tokens, pct)}`,
		verdict:
			tokens.upper <= thresholds.tokensMaxIncreasePct
				? "pass"
				: tokens.lower > thresholds.tokensMaxIncreasePct
					? "fail"
					: "unmet",
	});

	const failed = gates.filter((gate) => gate.verdict === "fail" && gate.id !== "corpus-floors");
	const unmet = gates.filter((gate) => gate.verdict === "unmet");
	const overall = !floorsMet
		? "insufficient-evidence"
		: failed.length > 0
			? "fail"
			: unmet.length > 0
				? "insufficient-evidence"
				: "pass";
	return { gates, overall, thresholds };
}

/**
 * Finding and silence cases must come from separate sessions.
 *
 * The reviewer asked for exactly this ("verified history-only finding cases and
 * verified silence cases from separate sessions"): a silence label drawn from a
 * session that also supplied a finding case is not an independent negative, and
 * mixing them would let one session's style drive both sides of the comparison.
 */
export function checkSessionSeparation(cases: readonly CaseObservation[]): string[] {
	const findingSessions = new Set(
		cases.filter((entry) => entry.stratum !== "silence").map((entry) => entry.sessionId),
	);
	const overlap = new Set(
		cases
			.filter((entry) => entry.stratum === "silence")
			.map((entry) => entry.sessionId)
			.filter((session) => findingSessions.has(session)),
	);
	return [...overlap].sort();
}
