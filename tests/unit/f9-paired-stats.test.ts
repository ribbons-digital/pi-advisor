/**
 * Unit tests for the compaction A/B paired statistics (issue #141 review gate).
 *
 * The bar is interval-based, so the properties that matter are: the point
 * estimates are exactly the arithmetic the gate claims, the interval is
 * reproducible from its recorded seed, a zero-effect corpus never produces a
 * confident interval, and a corpus that cannot decide reports
 * `insufficient-evidence` instead of `fail` (which would close the question on
 * a corpus problem). Parsing is covered too, because a silently-coerced row
 * would shift a rate and be indistinguishable from a real outcome.
 */
import { describe, expect, it } from "vitest";

import {
	AB_STRATA,
	type AbStratum,
	type ArmObservation,
	type CaseObservation,
	checkSessionSeparation,
	evaluateGates,
	mcnemarExact,
	PROPOSED_THRESHOLDS,
	seededRandom,
	summarizeAb,
} from "../../scripts/f9-experiment/paired-stats.js";

const OPTIONS = { seed: 20260912, iterations: 2_000, confidence: 0.95 };

function arm(successes: number, trials: number, tokens = 1_000): ArmObservation {
	return { successes, trials, tokens };
}

function observation(
	caseId: string,
	stratum: AbStratum,
	sessionId: string,
	control: ArmObservation,
	treatment: ArmObservation,
): CaseObservation {
	return { caseId, stratum, sessionId, control, treatment };
}

/** Build `count` cases of one stratum with constant per-case outcomes. */
function uniform(
	stratum: AbStratum,
	count: number,
	control: ArmObservation,
	treatment: ArmObservation,
	sessionIdPrefix = "s",
): CaseObservation[] {
	return Array.from({ length: count }, (_value, index) =>
		observation(
			`${stratum}-${String(index)}`,
			stratum,
			`${sessionIdPrefix}-${String(index)}`,
			control,
			treatment,
		),
	);
}

describe("mcnemarExact", () => {
	it("returns 1 when there are no discordant pairs", () => {
		expect(mcnemarExact(0, 0)).toBe(1);
	});

	it("matches the exact two-sided binomial tail", () => {
		// n=5, k=0 -> 2 * C(5,0) / 2^5
		expect(mcnemarExact(5, 0)).toBeCloseTo(2 / 32, 12);
		// n=10, k=0 -> 2 / 2^10
		expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024, 12);
		// n=6, k=2 -> 2 * (C(6,0)+C(6,1)+C(6,2)) / 2^6 = 2*22/64
		expect(mcnemarExact(4, 2)).toBeCloseTo(44 / 64, 12);
	});

	it("is symmetric and rejects malformed counts", () => {
		expect(mcnemarExact(3, 7)).toBeCloseTo(mcnemarExact(7, 3), 12);
		expect(() => mcnemarExact(-1, 2)).toThrow(/non-negative integers/u);
		expect(() => mcnemarExact(1.5, 2)).toThrow(/non-negative integers/u);
	});
});

describe("seededRandom", () => {
	it("reproduces the same stream for the same seed", () => {
		const first = seededRandom(7);
		const second = seededRandom(7);
		const drawn = Array.from({ length: 5 }, () => first());
		expect(drawn).toEqual(Array.from({ length: 5 }, () => second()));
	});

	it("stays inside [0, 1)", () => {
		const random = seededRandom(99);
		for (let index = 0; index < 1_000; index++) {
			const value = random();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});

describe("summarizeAb point estimates", () => {
	it("computes recall deltas in percentage points", () => {
		// control 1/5 = 20%, treatment 4/5 = 80% -> +60pp
		const corpus = uniform("history-only-finding", 20, arm(1, 5), arm(4, 5));
		const summary = summarizeAb(corpus, OPTIONS);
		expect(summary.counts.historyOnlyFindingCases).toBe(20);
		expect(summary.counts.repsPerCase).toBe(5);
		expect(summary.historyRecall.control).toBeCloseTo(20, 12);
		expect(summary.historyRecall.treatment).toBeCloseTo(80, 12);
		expect(summary.historyRecall.delta).toBeCloseTo(60, 12);
	});

	it("computes the silence false-positive rate and precision separately", () => {
		const findings = uniform("history-only-finding", 4, arm(5, 5), arm(5, 5), "f");
		const silence = uniform("silence", 4, arm(0, 5), arm(1, 5), "q");
		const summary = summarizeAb([...findings, ...silence], OPTIONS);
		// control: 4 TP over 4 silence runs with 0 notes -> precision 100%
		expect(summary.precision.control).toBeCloseTo(100, 12);
		// treatment: 20 TP + 4 FP (4 silence cases x 1/5) -> 20/24
		expect(summary.precision.treatment).toBeCloseTo((20 / 24) * 100, 12);
		expect(summary.silenceFalsePositiveRate.control).toBeCloseTo(0, 12);
		expect(summary.silenceFalsePositiveRate.treatment).toBeCloseTo(20, 12);
	});

	it("computes the token delta as a relative percent of the control mean", () => {
		const corpus = [...uniform("history-only-finding", 3, arm(1, 1, 1_000), arm(1, 1, 1_100), "a")];
		const summary = summarizeAb(corpus, OPTIONS);
		expect(summary.tokensPct.control).toBeCloseTo(1_000, 12);
		expect(summary.tokensPct.treatment).toBeCloseTo(1_100, 12);
		expect(summary.tokensPct.delta).toBeCloseTo(10, 12);
	});

	it("refuses a corpus with no history-only case, because the primary gate is undecidable", () => {
		const corpus = uniform("silence", 30, arm(0, 5), arm(0, 5));
		expect(() => summarizeAb(corpus, OPTIONS)).toThrow(/history-only or render-only/u);
	});
});

describe("summarizeAb interval behaviour", () => {
	it("is reproducible from the recorded seed", () => {
		const corpus = [
			...uniform("history-only-finding", 12, arm(1, 5), arm(3, 5), "h"),
			...uniform("silence", 12, arm(0, 5), arm(1, 5), "s"),
		];
		const first = summarizeAb(corpus, OPTIONS);
		const second = summarizeAb(corpus, OPTIONS);
		expect(second).toEqual(first);
		expect(first.seed).toBe(OPTIONS.seed);
	});

	it("produces a zero-width interval for a zero-effect corpus instead of a confident one", () => {
		const corpus = uniform("history-only-finding", 10, arm(5, 5), arm(5, 5));
		const summary = summarizeAb(corpus, OPTIONS);
		expect(summary.historyRecall.delta).toBe(0);
		expect(summary.historyRecall.lower).toBe(0);
		expect(summary.historyRecall.upper).toBe(0);
		expect(summary.historyRecall.skippedIterations).toBe(0);
	});

	it("excludes zero from the interval when the improvement is large and consistent", () => {
		// Heterogeneous per-case outcomes, so the interval has non-zero width and
		// `lower > 0` is a real claim about the interval rather than about a
		// degenerate point mass.
		const corpus = Array.from({ length: 40 }, (_value, index) =>
			observation(
				`h${String(index)}`,
				"history-only-finding",
				`s${String(index)}`,
				arm(index % 2 === 0 ? 0 : 1, 5),
				arm(index % 2 === 0 ? 5 : 3, 5),
			),
		);
		const summary = summarizeAb(corpus, OPTIONS);
		expect(summary.historyRecall.delta).toBeCloseTo(70, 12);
		expect(summary.historyRecall.lower).toBeGreaterThan(0);
		expect(summary.historyRecall.upper).toBeGreaterThan(summary.historyRecall.lower);
	});

	it("reports the discordant-pair counts as a McNemar p-value", () => {
		const corpus = [
			observation("a", "history-only-finding", "s1", arm(0, 5), arm(5, 5)),
			observation("b", "history-only-finding", "s2", arm(0, 5), arm(5, 5)),
			observation("c", "history-only-finding", "s3", arm(0, 5), arm(5, 5)),
			observation("d", "history-only-finding", "s4", arm(0, 5), arm(5, 5)),
			observation("e", "history-only-finding", "s5", arm(0, 5), arm(5, 5)),
		];
		const summary = summarizeAb(corpus, OPTIONS);
		// 5 pairs favour treatment, none favour control -> 2/2^5
		expect(summary.historyRecallMcNemarP).toBeCloseTo(2 / 32, 12);
		// No visible-finding clusters, so that McNemar is the empty-set p=1
		expect(summary.visibleRecallMcNemarP).toBe(1);
	});

	it("computes visible-finding McNemar independently of history-only", () => {
		const corpus = [
			observation("v1", "visible-finding", "s1", arm(0, 5), arm(5, 5)),
			observation("v2", "visible-finding", "s2", arm(0, 5), arm(5, 5)),
			observation("v3", "visible-finding", "s3", arm(0, 5), arm(5, 5)),
			observation("v4", "visible-finding", "s4", arm(0, 5), arm(5, 5)),
			observation("v5", "visible-finding", "s5", arm(0, 5), arm(5, 5)),
		];
		const summary = summarizeAb(corpus, OPTIONS);
		expect(summary.visibleRecallMcNemarP).toBeCloseTo(2 / 32, 12);
		expect(summary.historyRecallMcNemarP).toBe(1);
	});
});

describe("evaluateGates", () => {
	it("reports insufficient-evidence when the corpus floors are not met", () => {
		const corpus = [
			...uniform("history-only-finding", 4, arm(1, 5), arm(5, 5), "h"),
			...uniform("silence", 4, arm(0, 5), arm(0, 5), "s"),
		];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const floors = report.gates.find((gate) => gate.id === "corpus-floors");
		expect(floors?.verdict).toBe("fail");
		expect(report.overall).toBe("insufficient-evidence");
	});

	it("passes every gate for a corpus that meets the bar with a wide margin", () => {
		const corpus = [
			...uniform("history-only-finding", 30, arm(0, 5), arm(5, 5), "h"),
			...uniform("render-only-finding", 10, arm(5, 5), arm(5, 5), "r"),
			...uniform("visible-finding", 10, arm(5, 5), arm(5, 5), "v"),
			// silence: zero notes in both arms keeps the FP upper bound at 0
			...uniform("silence", 30, arm(0, 5), arm(0, 5), "s"),
		];
		const summary = summarizeAb(corpus, OPTIONS);
		summary.tokensPct.control = 1_000;
		summary.tokensPct.treatment = 1_000;
		const report = evaluateGates(summary, PROPOSED_THRESHOLDS);
		expect(report.overall).toBe("pass");
		expect(report.gates.every((gate) => gate.verdict === "pass")).toBe(true);
	});

	it("fails the recall gate when the interval excludes the required gain", () => {
		const corpus = [
			...uniform("history-only-finding", 30, arm(4, 5), arm(4, 5), "h"),
			...uniform("visible-finding", 10, arm(5, 5), arm(5, 5), "v"),
			...uniform("silence", 30, arm(0, 5), arm(0, 5), "s"),
		];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const recall = report.gates.find((gate) => gate.id === "history-recall-gain");
		expect(recall?.verdict).toBe("fail");
		expect(report.overall).toBe("fail");
	});

	it("fails the false-positive gate when the interval excludes the safety limit", () => {
		const corpus = [
			...uniform("history-only-finding", 30, arm(0, 5), arm(0, 5), "h"),
			...uniform("visible-finding", 10, arm(0, 5), arm(0, 5), "v"),
			// treatment manufactures a note on every silence case: +100pp, which is
			// far outside the +5pp safety limit and excludes it from the interval
			...uniform("silence", 30, arm(0, 5), arm(5, 5), "s"),
		];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const safety = report.gates.find((gate) => gate.id === "false-positive-safety");
		expect(safety?.verdict).toBe("fail");
		expect(report.overall).toBe("fail");
	});

	it("marks an undecidable comparison as unmet, not pass", () => {
		const corpus = [
			observation("h1", "history-only-finding", "s1", arm(0, 5), arm(5, 5)),
			observation("h2", "history-only-finding", "s2", arm(5, 5), arm(0, 5)),
			observation("h3", "history-only-finding", "s3", arm(0, 5), arm(5, 5)),
			observation("h4", "history-only-finding", "s4", arm(5, 5), arm(0, 5)),
			...uniform("visible-finding", 10, arm(5, 5), arm(5, 5), "v"),
			...uniform("silence", 30, arm(0, 5), arm(0, 5), "s"),
		];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const recall = report.gates.find((gate) => gate.id === "history-recall-gain");
		expect(recall?.verdict).toBe("unmet");
		expect(report.overall).toBe("insufficient-evidence");
	});

	it("marks the visible-recall guard unmet when the corpus has no visible-finding case", () => {
		const corpus = [
			...uniform("history-only-finding", 30, arm(0, 5), arm(5, 5), "h"),
			...uniform("silence", 30, arm(0, 5), arm(0, 5), "s"),
		];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const guard = report.gates.find((gate) => gate.id === "visible-recall-guard");
		expect(guard?.verdict).toBe("unmet");
		expect(guard?.note).toMatch(/no visible-finding cases/u);
	});

	it("marks the false-positive gate unmet when the corpus has no silence case", () => {
		const corpus = [...uniform("history-only-finding", 30, arm(0, 5), arm(5, 5), "h")];
		const report = evaluateGates(summarizeAb(corpus, OPTIONS), PROPOSED_THRESHOLDS);
		const safety = report.gates.find((gate) => gate.id === "false-positive-safety");
		expect(safety?.verdict).toBe("unmet");
		expect(safety?.note).toMatch(/no silence case/u);
	});
});

describe("checkSessionSeparation", () => {
	it("returns no overlap when finding and silence cases use disjoint sessions", () => {
		const corpus = [
			...uniform("history-only-finding", 3, arm(1, 5), arm(1, 5), "f"),
			...uniform("silence", 3, arm(0, 5), arm(0, 5), "q"),
		];
		expect(checkSessionSeparation(corpus)).toEqual([]);
	});

	it("reports the shared session when a session supplies both kinds", () => {
		const corpus = [
			observation("f1", "history-only-finding", "shared", arm(1, 5), arm(1, 5)),
			observation("s1", "silence", "shared", arm(0, 5), arm(0, 5)),
			observation("s2", "silence", "other", arm(0, 5), arm(0, 5)),
		];
		expect(checkSessionSeparation(corpus)).toEqual(["shared"]);
	});
});

describe("stratum vocabulary", () => {
	it("keeps the stratum vocabulary closed", () => {
		expect([...AB_STRATA]).toEqual([
			"history-only-finding",
			"render-only-finding",
			"visible-finding",
			"silence",
		]);
	});
});
