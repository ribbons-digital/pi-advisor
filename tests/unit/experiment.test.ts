import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ADVISOR_CONFIG } from "../../src/index.js";
import {
	buildTieredAdvisorSystemPrompt,
	TIERED_PROMPT_EXPERIMENT_FLAG,
	tieredPromptUpdateRelevance,
} from "../../src/experiment.js";
import { buildAdvisorSystemPrompt } from "../../src/runtime.js";

const CHRONOLOGY_MARKER = "Do not contradict observed chronology";
const MEMORY_MARKER = "Recalled memories, handoffs, summaries";

describe("Quality Slice Q6 F9 tiered prompt prototype (Q6-D3)", () => {
	afterEach(() => {
		process.env[TIERED_PROMPT_EXPERIMENT_FLAG] = "";
	});

	it("keeps the baseline prompt byte-identical when the internal flag is off", () => {
		const baseline = buildAdvisorSystemPrompt(DEFAULT_ADVISOR_CONFIG, "project focus");
		const gated = buildAdvisorSystemPrompt(DEFAULT_ADVISOR_CONFIG, "project focus", {
			updateText: "[Executor tool call edit]\nsrc/a.ts",
		});
		expect(gated).toBe(baseline);
		expect(baseline).toContain(CHRONOLOGY_MARKER);
		expect(baseline).toContain(MEMORY_MARKER);
	});

	it("includes chronology and memory blocks only when the update is relevant to them", () => {
		process.env[TIERED_PROMPT_EXPERIMENT_FLAG] = "1";
		const toolUpdate =
			"[Executor user]\nFix the retry.\n[Executor tool result edit]\nRetry helper added.";
		const tieredTool = buildTieredAdvisorSystemPrompt(
			DEFAULT_ADVISOR_CONFIG,
			toolUpdate,
			"project focus",
		);
		expect(tieredTool).toContain(CHRONOLOGY_MARKER);
		expect(tieredTool).not.toContain(MEMORY_MARKER);

		const memoryUpdate =
			"[Executor user]\nThe recalled memory says to run the changelog script.\n[Executor assistant]\nApplying the remembered workflow.";
		const tieredMemory = buildTieredAdvisorSystemPrompt(
			DEFAULT_ADVISOR_CONFIG,
			memoryUpdate,
			"project focus",
		);
		expect(tieredMemory).toContain(MEMORY_MARKER);
		expect(tieredMemory).not.toContain(CHRONOLOGY_MARKER);

		const plainUpdate = "[Executor user]\nExplain the build pipeline.\n[Executor assistant]\nDone.";
		const tieredPlain = buildTieredAdvisorSystemPrompt(
			DEFAULT_ADVISOR_CONFIG,
			plainUpdate,
			"project focus",
		);
		expect(tieredPlain).not.toContain(CHRONOLOGY_MARKER);
		expect(tieredPlain).not.toContain(MEMORY_MARKER);

		// Core rules are always present in every variant.
		for (const prompt of [tieredTool, tieredMemory, tieredPlain]) {
			expect(prompt).toContain("Silence is the normal successful outcome");
			expect(prompt).toContain("project focus");
		}
	});

	it("detects chronology and memory relevance deterministically", () => {
		expect(
			tieredPromptUpdateRelevance(
				"[Executor tool call edit]\nsrc/a.ts\n[Executor tool result edit]\nUpdated.",
			),
		).toEqual({ chronology: true, memory: false });
		expect(
			tieredPromptUpdateRelevance(
				"[Executor compaction summary]\nThe session reached the migration milestone.",
			),
		).toEqual({ chronology: false, memory: true });
		expect(tieredPromptUpdateRelevance("[Executor user]\nExplain the build pipeline.")).toEqual({
			chronology: false,
			memory: false,
		});
		expect(tieredPromptUpdateRelevance("")).toEqual({ chronology: false, memory: false });
	});

	it("routes the runtime prompt through the tiered variant when the flag is on", () => {
		process.env[TIERED_PROMPT_EXPERIMENT_FLAG] = "1";
		const toolUpdate = "[Executor tool result edit]\nUpdated the retry helper.";
		const runtimePrompt = buildAdvisorSystemPrompt(DEFAULT_ADVISOR_CONFIG, "", {
			updateText: toolUpdate,
		});
		expect(runtimePrompt).toContain(CHRONOLOGY_MARKER);
		expect(runtimePrompt).not.toContain(MEMORY_MARKER);
	});
});
