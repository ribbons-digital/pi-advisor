import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG } from "../../src/index.js";
import { buildAdvisorSystemPrompt } from "../../src/runtime.js";

// Adopted from the F9 accuracy experiment: `posind` measured as
// `frozen base + SCOPED_PROMPT_ADDENDUM + POSIND_PROMPT_ADDENDUM`
// (promptHash f2733c699d2dc52f) and adopted verbatim into the production prompt.
const SCOPE_MARKER = "Scope discipline (what makes a finding material)";
const COVERAGE_MARKER = "Coverage: this update may retain entries far above the newest actions";

describe("adopted review-scope prompt rules", () => {
	it("keeps both adopted rules in the production prompt exactly once", () => {
		const prompt = buildAdvisorSystemPrompt(DEFAULT_ADVISOR_CONFIG, "");
		expect(prompt).toContain(SCOPE_MARKER);
		expect(prompt).toContain(COVERAGE_MARKER);
		// Exactly once: a second copy would mean the experiment addenda were
		// re-applied on top of the adopted base, which is no longer the measured
		// artifact.
		expect(prompt.split(SCOPE_MARKER)).toHaveLength(2);
		expect(prompt.split(COVERAGE_MARKER)).toHaveLength(2);
	});

	it("keeps the adopted rules after the tagged project-instructions block", () => {
		const prompt = buildAdvisorSystemPrompt(DEFAULT_ADVISOR_CONFIG, "PROJECT-RULE-MARKER");
		const projectAt = prompt.indexOf("PROJECT-RULE-MARKER");
		expect(projectAt).toBeGreaterThan(-1);
		// The measured artifact appends the rules after the project block; the F9
		// frozen base reproduces that same layout, so the order is load-bearing.
		const scopeAt = prompt.indexOf(SCOPE_MARKER);
		const coverageAt = prompt.indexOf(COVERAGE_MARKER);
		expect(scopeAt).toBeGreaterThan(projectAt);
		expect(coverageAt).toBeGreaterThan(scopeAt);
	});
});
