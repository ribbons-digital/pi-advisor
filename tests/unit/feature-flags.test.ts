import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_QUIESCENCE_HOLD_MAX_MS,
	HISTORY_COMPRESSION_FLAG,
	NO_REASONING_FLAG,
	isHistoryCompressionEnabled,
	isNoReasoningRenderEnabled,
	quiescenceHoldMaxMs,
} from "../../src/feature-flags.js";

describe("advisor context feature flags (default on, `0` opts out)", () => {
	afterEach(() => {
		process.env[NO_REASONING_FLAG] = "";
		process.env[HISTORY_COMPRESSION_FLAG] = "";
		delete process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS;
	});

	it("no-reasoning rendering is on unless explicitly disabled with =0", () => {
		expect(isNoReasoningRenderEnabled()).toBe(true);
		process.env[NO_REASONING_FLAG] = "";
		expect(isNoReasoningRenderEnabled()).toBe(true);
		process.env[NO_REASONING_FLAG] = "1";
		expect(isNoReasoningRenderEnabled()).toBe(true);
		process.env[NO_REASONING_FLAG] = "0";
		expect(isNoReasoningRenderEnabled()).toBe(false);
	});

	it("history compression is on unless explicitly disabled with =0", () => {
		expect(isHistoryCompressionEnabled()).toBe(true);
		process.env[HISTORY_COMPRESSION_FLAG] = "";
		expect(isHistoryCompressionEnabled()).toBe(true);
		process.env[HISTORY_COMPRESSION_FLAG] = "0";
		expect(isHistoryCompressionEnabled()).toBe(false);
	});

	it("quiescence hold cap defaults, disables on 0, and clamps junk", () => {
		// vitest.config.ts pins the cap to "0" for legacy timing tests; clear it
		// here to exercise parsing from a clean slate.
		delete process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS;
		expect(quiescenceHoldMaxMs()).toBe(DEFAULT_QUIESCENCE_HOLD_MAX_MS);
		process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS = "0";
		expect(quiescenceHoldMaxMs()).toBe(0);
		process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS = "50";
		expect(quiescenceHoldMaxMs()).toBe(50);
		process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS = "999999999";
		expect(quiescenceHoldMaxMs()).toBe(3_600_000);
		process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS = "junk";
		expect(quiescenceHoldMaxMs()).toBe(DEFAULT_QUIESCENCE_HOLD_MAX_MS);
		process.env.PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS = "-5";
		expect(quiescenceHoldMaxMs()).toBe(DEFAULT_QUIESCENCE_HOLD_MAX_MS);
	});
});
