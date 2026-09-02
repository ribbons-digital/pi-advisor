import { afterEach, describe, expect, it } from "vitest";

import { NO_REASONING_FLAG, isNoReasoningRenderEnabled } from "../../src/feature-flags.js";

describe("no-reasoning feature flag", () => {
	afterEach(() => {
		process.env[NO_REASONING_FLAG] = "";
	});

	it("is enabled only by PI_ADVISOR_NO_REASONING=1", () => {
		expect(isNoReasoningRenderEnabled()).toBe(false);
		process.env[NO_REASONING_FLAG] = "1";
		expect(isNoReasoningRenderEnabled()).toBe(true);
	});
});
