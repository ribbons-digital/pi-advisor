import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-advisor-vitest-agent-"));
process.env.PI_ADVISOR_VITEST_AGENT_DIR = testAgentDir;

export default defineConfig({
	test: {
		env: {
			PI_CODING_AGENT_DIR: testAgentDir,
			// Legacy timing tests script mid-burst (toolUse) Executor turns and assert
			// immediate review starts; 0 disables quiescence holding for them. The
			// hold itself is covered by quiescence-trigger.test.ts, which overrides
			// this per test.
			PI_ADVISOR_QUIESCENCE_HOLD_MAX_MS: "0",
		},
		globalSetup: ["./tests/global-setup.ts"],
		coverage: {
			enabled: false,
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
