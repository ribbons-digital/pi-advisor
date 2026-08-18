import { StringEnum, type ToolCall } from "@earendil-works/pi-ai";
import {
	defineTool,
	type InlineExtension,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { probeConstrainedSamplingSupport } from "../../src/compatibility/constrained-sampling.js";
import {
	ADVISOR_ARGUMENT_VALIDATION_FAILURE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorConfig,
	type AdvisorRuntime,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

function configFor(provider: ScriptedProvider, mutate?: (config: AdvisorConfig) => void) {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	config.memorySuggestions.minTurnsBetweenSuggestions = 0;
	config.memorySuggestions.minIntervalMs = 0;
	mutate?.(config);
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-strict-scripted-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

function strictCompatibleModel<T>(model: T): T {
	// SAFETY: Pi 0.81 types omit supportsStrictTools, but supported newer runtimes consume it.
	return {
		...model,
		api: "anthropic-messages",
		compat: { supportsStrictTools: true },
	} as T;
}

function enableStrictAdvise(modelRuntime: ModelRuntime, advisor: ScriptedProvider): void {
	const registration = modelRuntime.getRegisteredProviderConfig(advisor.model.provider);
	if (registration?.models === undefined) throw new Error("Expected registered Advisor models");
	modelRuntime.registerProvider(advisor.model.provider, {
		...registration,
		api: "anthropic-messages",
		models: registration.models.map((model) =>
			model.id === advisor.model.id ? strictCompatibleModel(model) : model,
		),
	});
}

function compatibleMemoryTool(execute = vi.fn()): ToolDefinition {
	return defineTool({
		name: "memory_suggest",
		label: "memory_suggest",
		description: "Queue a pending memory suggestion.",
		parameters: Type.Object({
			text: Type.String(),
			category: Type.Optional(StringEnum(["preference", "project"] as const)),
			status: Type.Optional(StringEnum(["pending"] as const)),
		}),
		execute: (_id, params) => {
			execute(params);
			return Promise.resolve({
				content: [{ type: "text" as const, text: "Queued." }],
				details: {},
			});
		},
	});
}

function toolCall(id: string, arguments_: ToolCall["arguments"]) {
	return {
		content: [{ type: "toolCall" as const, id, name: "advise", arguments: arguments_ }],
		stopReason: "toolUse" as const,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

const nullMemory = { text: null, category: null, basis: null };
const rationale = "This durable project rule should be available in future sessions.";
const proposed = "Use sfw-prefixed pnpm commands when installing project packages.";

const runtimeSupportsConstrainedSampling = await probeConstrainedSamplingSupport();

describe.sequential("strict advise with a scripted provider", () => {
	it("accepts an explicit null-bearing review with default severity and normal delivery", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const note = "Verify the rollback artifact before publishing the release.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "handled review" }] },
		]);
		const advisor = createAdvisorProvider([
			toolCall("strict-null-review", {
				note,
				intent: "review",
				severity: null,
				findingKey: null,
				memory: null,
			}),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus().adviseSchemaMode).toBe("strict");
			await harness.session.prompt("review explicit nulls");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("deliver strict review");
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain(note);
			expect(context).toContain('severity=\\"concern\\"');
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				notesDelivered: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("accepts a complete Memory suggestion through the existing Memory policy", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer" }] },
			{ content: [{ type: "text", text: "evaluated suggestion" }] },
		]);
		const advisor = createAdvisorProvider([
			toolCall("strict-memory", {
				note: rationale,
				intent: "memory-suggestion",
				severity: null,
				findingKey: null,
				rootUnknown: "MEMORY-ROOT-PRIVATE-SENTINEL",
				memory: {
					text: proposed,
					category: "project",
					basis: "project-constraint",
					nestedUnknown: "MEMORY-NESTED-PRIVATE-SENTINEL",
				},
			}),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("find durable guidance");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			const entries = JSON.stringify(harness.sessionManager.getEntries());
			expect(entries).toContain(proposed);
			expect(entries).toContain('"category":"project"');
			expect(entries).not.toContain("MEMORY-ROOT-PRIVATE-SENTINEL");
			expect(entries).not.toContain("MEMORY-NESTED-PRIVATE-SENTINEL");
			expect(runtime?.getStatus()).toMatchObject({
				adviseSchemaMode: "strict",
				failedReviews: 0,
				memorySuggestionsPolicySuppressed: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("null-fills omitted fields and discards unknown root and nested fallback keys", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const note = "The fallback migration can overwrite the existing index.";
		const rootSentinel = "STRICT-ROOT-PRIVATE-SENTINEL";
		const nestedSentinel = "STRICT-NESTED-PRIVATE-SENTINEL";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer" }] },
			{ content: [{ type: "text", text: "handled normalized review" }] },
		]);
		const advisor = createAdvisorProvider([
			toolCall("strict-fallback-normalized", {
				note,
				rootUnknown: rootSentinel,
				memory: { nestedUnknown: nestedSentinel },
			}),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("normalize fallback arguments");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("deliver normalized fallback review");
			const delivered = JSON.stringify(primary.requests[1]?.context);
			const persisted = JSON.stringify(harness.sessionManager.getEntries());
			expect(delivered).toContain(note);
			expect(delivered).toContain('severity=\\"concern\\"');
			for (const output of [delivered, persisted]) {
				expect(output).not.toContain(rootSentinel);
				expect(output).not.toContain(nestedSentinel);
			}
			expect(runtime?.getStatus()).toMatchObject({ failedReviews: 0, notesDelivered: 1 });
		} finally {
			await harness.dispose();
		}
	});

	it("retains invalid-arguments failure and pause policy for wrong known values", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "answer two" }] },
			{ content: [{ type: "text", text: "answer three" }] },
		]);
		const advisor = createAdvisorProvider([
			toolCall("wrong-note", {
				note: 42,
				intent: null,
				severity: null,
				findingKey: null,
				memory: nullMemory,
			}),
			{ content: [] },
			toolCall("wrong-severity", {
				note: "Known enum is invalid.",
				intent: "review",
				severity: "urgent",
				findingKey: null,
				memory: nullMemory,
			}),
			{ content: [] },
			toolCall("wrong-memory-type", {
				note: rationale,
				intent: "memory-suggestion",
				severity: null,
				findingKey: null,
				memory: { text: 42, category: "project", basis: "project-constraint" },
			}),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			tools: [],
			mode: "rpc",
		});
		try {
			for (const [index, prompt] of ["wrong type", "wrong enum", "wrong nested type"].entries()) {
				await harness.session.prompt(prompt);
				await waitFor(() => runtime?.getStatus().consecutiveFailures === index + 1);
			}
			expect(runtime?.getStatus()).toMatchObject({
				paused: true,
				failedReviews: 3,
				consecutiveFailures: 3,
				retryAttempts: 0,
				lastFailure: ADVISOR_ARGUMENT_VALIDATION_FAILURE,
				notesDelivered: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("suppresses incomplete Memory calls without advancing the failure streak", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "answer two" }] },
		]);
		const advisor = createAdvisorProvider([
			toolCall("missing-memory", { note: rationale, intent: "memory-suggestion" }),
			toolCall("partial-memory", {
				note: rationale,
				intent: "memory-suggestion",
				memory: { text: proposed, category: "project" },
			}),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("missing memory");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("partial memory");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				memorySuggestionsPolicySuppressed: 2,
				memorySuggestionsDelivered: 0,
				deferredNotesPending: 0,
			});
			expect(submit).not.toHaveBeenCalled();
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(proposed);
		} finally {
			await harness.dispose();
		}
	});

	it("preserves one-note limits, terminate behavior, delivery, and dedupe", async () => {
		if (!runtimeSupportsConstrainedSampling) return;
		const first = "Verify the strict rollback path!";
		const second = "A second strict finding must not replace the first.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
		]);
		const fullReview = (note: string) => ({
			note,
			intent: "review",
			severity: "blocker",
			findingKey: null,
			memory: null,
		});
		const advisor = createAdvisorProvider([
			{
				content: [
					{ type: "toolCall", id: "strict-first", name: "advise", arguments: fullReview(first) },
					{
						type: "toolCall",
						id: "strict-second",
						name: "advise",
						arguments: fullReview(second),
					},
				],
				stopReason: "toolUse",
			},
			toolCall("strict-duplicate", fullReview("  VERIFY the strict rollback path... ")),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.delivery.activeIdleSeverities = [];
					}),
					(value) => (runtime = value),
				),
			],
			beforeBind: (modelRuntime) => enableStrictAdvise(modelRuntime, advisor),
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("strict one-note limit");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus()).toMatchObject({ notesSuppressed: 1, notesDelivered: 0 });
			await harness.session.prompt("strict duplicate update");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 1, notesSuppressed: 2 });
			await harness.session.prompt("inspect strict delivery");
			const context = JSON.stringify(primary.requests.at(-1)?.context);
			expect(context).toContain(first);
			expect(context).toContain('severity=\\"blocker\\"');
			expect(context).not.toContain(second);
			expect(context).not.toContain("VERIFY the strict rollback path");
			expect(advisor.requests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});
});
