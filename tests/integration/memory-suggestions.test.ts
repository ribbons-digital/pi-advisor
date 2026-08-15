import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type InlineExtension,
	type SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AcceptedAdvice,
	type BoundedKeyedByteFifo,
	type AdvisorConfig,
	type AdvisorRuntime,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

function configFor(
	provider: ScriptedProvider,
	mutate?: (config: AdvisorConfig) => void,
): AdvisorConfig {
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
		name: "pi-advisor-memory-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

const memoryRationale = "This verified project constraint will matter in future sessions.";

function memorySuggestion(
	text: string,
	id = "memory-advice",
	overrides: Record<string, unknown> = {},
) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: {
					note: memoryRationale,
					intent: "memory-suggestion",
					memory: {
						text,
						category: "project",
						basis: "project-constraint",
					},
					...overrides,
				},
			},
		],
		stopReason: "toolUse" as const,
	};
}

function ordinaryAdvice(note: string, id = "ordinary-advice") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: { note, severity: "concern", intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
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

function failingMemoryTool(execute = vi.fn()): ToolDefinition {
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
			return Promise.reject(new Error("Pending suggestion queue failed"));
		},
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

const proposed = "Use sfw-prefixed pnpm commands for package installation in this project.";

describe.sequential("Slice 2 Batch C Memory suggestions", () => {
	it("keeps ordinary review active and silent about missing Memory Lane", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "answer after ordinary advice" }] },
		]);
		const advisor = createAdvisorProvider([
			ordinaryAdvice("Verify the release artifact before completion."),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review without Memory Lane");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus().memorySuggestionCapability.state).toBe("absent");
			expect(runtime?.getStatus().warnings).toBe(0);
			await harness.session.prompt("deliver ordinary advice");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				"Verify the release artifact before completion.",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("keeps incompatible capability inspection non-fatal and suppresses Memory intent", async () => {
		const incompatible = defineTool({
			name: "memory_suggest",
			label: "memory_suggest",
			description: "An incompatible approved-only tool.",
			parameters: Type.Object({
				text: Type.String(),
				category: StringEnum(["preference", "project"] as const),
				status: StringEnum(["approved"] as const),
			}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "Saved." }], details: {} }),
		});
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([memorySuggestion(proposed)]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [incompatible],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("inspect incompatible capability");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionCapability: { state: "incompatible" },
				memorySuggestionsEnabled: false,
				memorySuggestionsPolicySuppressed: 1,
				deferredNotesPending: 0,
				warnings: 0,
			});
			expect(JSON.stringify(advisor.requests[0]?.context)).not.toContain(
				"memory-suggestion-policy",
			);
		} finally {
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "unsupported category",
			arguments: {
				note: "Do not infer personal memories.",
				intent: "memory-suggestion",
				memory: { text: proposed, category: "personal", basis: "durable-preference" },
			},
		},
		{
			label: "wrong text type",
			arguments: {
				note: "Memory text must remain a string.",
				intent: "memory-suggestion",
				memory: { text: 42, category: "project", basis: "project-constraint" },
			},
		},
	])("rejects $label through the internal advise schema", async ({ arguments: input }) => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{ type: "toolCall", id: "invalid-memory-intent", name: "advise", arguments: input },
				],
				stopReason: "toolUse",
			},
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("reject invalid structured intent");
			await waitFor(() => runtime?.getStatus().failedReviews === 1);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				deferredNotesPending: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("suppresses missing, partial, and empty Memory payloads without advancing failure state", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "answer two" }] },
			{ content: [{ type: "text", text: "answer three" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "missing-memory",
						name: "advise",
						arguments: { note: memoryRationale, intent: "memory-suggestion" },
					},
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{
						type: "toolCall",
						id: "partial-memory",
						name: "advise",
						arguments: {
							note: memoryRationale,
							intent: "memory-suggestion",
							memory: { text: proposed, category: "project" },
						},
					},
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{
						type: "toolCall",
						id: "empty-memory",
						name: "advise",
						arguments: {
							note: memoryRationale,
							intent: "memory-suggestion",
							memory: { text: "   ", category: "project", basis: "project-constraint" },
						},
					},
				],
				stopReason: "toolUse",
			},
		]);
		const submit = vi.fn();
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			for (const [index, prompt] of [
				"missing payload",
				"partial payload",
				"empty payload",
			].entries()) {
				await harness.session.prompt(prompt);
				await waitFor(() => runtime?.getStatus().reviewsCompleted === index + 1);
			}
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				memorySuggestionsPolicySuppressed: 3,
				memorySuggestionsDelivered: 0,
				deferredNotesPending: 0,
			});
			expect(submit).not.toHaveBeenCalled();
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(
				'memory-suggestion"',
			);
		} finally {
			await harness.dispose();
		}
	});

	it("accepts complete Memory input while discarding unknown and review-only fields", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer" }] },
			{ content: [{ type: "text", text: "verified the automatic suggestion" }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed, "portable-complete-memory", {
				severity: "blocker",
				findingKey: "ignored-review-key",
				rootUnknown: "ROOT-PRIVATE-SENTINEL",
				memory: {
					text: proposed,
					category: "project",
					basis: "project-constraint",
					nestedUnknown: "NESTED-PRIVATE-SENTINEL",
				},
			}),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("admit portable complete payload");
			await waitFor(
				() => primary.requests.length === 2 && runtime?.getStatus().notesDelivered === 1,
			);
			const entries = JSON.stringify(harness.sessionManager.getEntries());
			expect(entries).toContain(proposed);
			expect(entries).not.toContain("ROOT-PRIVATE-SENTINEL");
			expect(entries).not.toContain("NESTED-PRIVATE-SENTINEL");
			expect(entries).not.toContain("ignored-review-key");
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				memorySuggestionsDelivered: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "content-free proposed text",
			text: "looks good",
			mutate: () => undefined,
		},
		{
			label: "redaction-altered proposed text",
			text: "API_KEY=memory-secret-value",
			mutate: () => undefined,
		},
		{
			label: "oversized proposed text",
			text: "This proposal exceeds its configured bound.",
			mutate: (config: AdvisorConfig) => {
				config.memorySuggestions.maxProposedMemoryCharacters = 10;
			},
		},
	])("suppresses $label without exposing it", async ({ text, mutate }) => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([memorySuggestion(text)]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor, mutate), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("suppress unsafe proposal");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				memorySuggestionsPolicySuppressed: 1,
				deferredNotesPending: 0,
			});
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(text);
		} finally {
			await harness.dispose();
		}
	});

	it("accepts a compatible capability and delivers a distinct pending-submission wrapper", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "I will verify the proposed memory." }] },
		]);
		const advisor = createAdvisorProvider([memorySuggestion(proposed), { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("identify durable project guidance");
			await waitFor(
				() => primary.requests.length === 2 && runtime?.getStatus().notesDelivered === 1,
			);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionCapability: { state: "available" },
				memorySuggestionsEnabled: true,
				memorySuggestionsDelivered: 1,
				memorySuggestionsRemaining: 4,
			});
			expect(JSON.stringify(advisor.requests[0]?.context)).toContain("memory-suggestion-policy");

			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain('intent=\\"memory-suggestion\\"');
			expect(context).toContain("<proposed-memory>");
			expect(context).toContain(proposed);
			expect(context).toContain('status \\"pending\\"');
			expect(context).not.toContain("memory_save");
			expect(context).toContain("without asking for another confirmation");
			const entry = harness.sessionManager
				.getEntries()
				.find(
					(candidate) =>
						candidate.type === "custom_message" && candidate.customType === "pi-advisor-note",
				);
			if (entry?.type !== "custom_message") throw new Error("Expected Memory suggestion entry");
			expect(entry.details).toMatchObject({
				intent: "memory-suggestion",
				delivery: "active",
				memory: { text: proposed, category: "project", basis: "project-constraint" },
			});
			expect(runtime?.getStatus().memorySuggestionsDelivered).toBe(1);
		} finally {
			await harness.dispose();
		}
	});

	it("delivers an accepted Memory suggestion through the active steering boundary", async () => {
		const executorBarrier = createBarrier();
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create an active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-active-memory", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: executorBarrier.promise,
				content: [{ type: "text", text: "continued original work" }],
			},
			{ content: [{ type: "text", text: "verified active Memory suggestion" }] },
		]);
		const advisor = createAdvisorProvider([memorySuggestion(proposed), { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold, compatibleMemoryTool()],
			tools: ["hold", "memory_suggest"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("start active Memory delivery");
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeQueue = Reflect.get(runtime, "activeAdvice") as BoundedKeyedByteFifo<{
				advice: AcceptedAdvice;
			}>;
			expect(activeQueue.totalBytes).toBe(
				Buffer.byteLength(memoryRationale, "utf8") + Buffer.byteLength(proposed, "utf8"),
			);
			executorBarrier.release();
			await activeTurn;
			await waitFor(
				() => primary.requests.length === 3 && runtime?.getStatus().notesDelivered === 1,
			);
			const context = JSON.stringify(primary.requests[2]?.context);
			expect(context).toContain(proposed);
			expect(context).toContain('delivery=\\"active\\"');
			expect(runtime.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				activeNotesPending: 0,
			});
		} finally {
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it("does not suppress terminal review after a stale active Memory steer", async () => {
		const executorBarrier = createBarrier();
		const continuationBarrier = createBarrier();
		const advisorBarrier = createBarrier();
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create an active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-stale-memory", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: executorBarrier.promise,
				content: [{ type: "text", text: "terminal result after the stale Memory steer" }],
			},
			{
				waitFor: continuationBarrier.promise,
				content: [{ type: "text", text: "processed the active Memory suggestion" }],
			},
		]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
			{ content: [] },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold, compatibleMemoryTool()],
			tools: ["hold", "memory_suggest"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("review a stale active Memory steer");
			await waitFor(
				() =>
					advisor.activeRequests === 1 &&
					primary.requests.length === 2 &&
					primary.activeRequests === 1,
			);
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "late-active-result",
				toolName: "hold",
				content: [{ type: "text", text: "newer active Executor evidence" }],
				isError: false,
				timestamp: Date.now(),
			});
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);

			executorBarrier.release();
			await waitFor(() => primary.requests.length === 3 && primary.activeRequests === 1);
			await waitFor(() => advisor.requests.length === 2);
			expect(JSON.stringify(advisor.requests[1]?.context)).toContain(
				"terminal result after the stale Memory steer",
			);
			expect(
				harness.sessionManager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "pi-advisor-note" &&
							(entry.details as Record<string, unknown> | undefined)?.stale === true,
					),
			).toBe(true);

			continuationBarrier.release();
			await activeTurn;
		} finally {
			advisorBarrier.release();
			executorBarrier.release();
			continuationBarrier.release();
			await harness.dispose();
		}
	});

	it("rechecks capability loss before active steering and removes call guidance", async () => {
		const executorBarrier = createBarrier();
		const advisorBarrier = createBarrier();
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create an active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-active-loss", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: executorBarrier.promise,
				content: [{ type: "text", text: "continued original work" }],
			},
			{ content: [{ type: "text", text: "reported active capability loss" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold, compatibleMemoryTool()],
			tools: ["hold", "memory_suggest"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("start active capability-loss delivery");
			await waitFor(() => advisor.activeRequests === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const extensionApi = Reflect.get(runtime, "pi") as ExtensionAPI;
			extensionApi.setActiveTools(["hold"]);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);
			executorBarrier.release();
			await activeTurn;
			await waitFor(() => primary.requests.length === 3);
			const context = JSON.stringify(primary.requests[2]?.context);
			expect(context).toContain('queue-state=\\"could-not-queue\\"');
			expect(context).toContain("Do not attempt this tool call");
			expect(context).not.toContain("then call memory_suggest with the chosen text");
		} finally {
			advisorBarrier.release();
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it("discards a provisional Memory suggestion when its update is governed", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("govern the Memory suggestion update");
			await waitFor(() => advisor.activeRequests === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const currentRun = Reflect.get(runtime, "currentRun") as {
				governorFailure?: string;
			};
			currentRun.governorFailure = "Advisor tool-call limit reached";
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().governorSkippedReviews === 1);
			expect(runtime.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				lastGovernorOutcome: "Advisor tool-call limit reached",
				notesDelivered: 0,
				memorySuggestionsDelivered: 0,
				memorySuggestionsRemaining: 5,
				activeNotesPending: 0,
				deferredNotesPending: 0,
			});
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(proposed);
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("lets the Executor revise a proposal and submit it explicitly as pending", async () => {
		const submit = vi.fn();
		const revised = "Install project packages only with sfw-prefixed pnpm commands.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{
				content: [
					{
						type: "toolCall",
						id: "submit-revised-memory",
						name: "memory_suggest",
						arguments: { text: revised, category: "project", status: "pending" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Queued the revised durable wording." }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed),
			{ content: [] },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("prepare a Memory suggestion");
			await waitFor(
				() =>
					submit.mock.calls.length === 1 &&
					runtime?.getStatus().memorySuggestionsDelivered === 1 &&
					!runtime.getStatus().backlog,
			);
			expect(submit).toHaveBeenCalledWith({
				text: revised,
				category: "project",
				status: "pending",
			});
			expect(primary.requests).toHaveLength(3);
			expect(runtime?.getStatus().memorySuggestionsDelivered).toBe(1);
		} finally {
			await harness.dispose();
		}
	});

	it("supports an explained decline without calling memory_suggest", async () => {
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{
				content: [
					{
						type: "text",
						text: "I declined this proposal because it is not durable enough for future sessions.",
					},
				],
			},
		]);
		const advisor = createAdvisorProvider([memorySuggestion(proposed), { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("prepare a proposal to decline");
			await waitFor(() => primary.requests.length === 2 && runtime?.getStatus().backlog === false);
			expect(submit).not.toHaveBeenCalled();
			expect(advisor.requests).toHaveLength(1);
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				"briefly explain why to the user",
			);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		} finally {
			await harness.dispose();
		}
	});

	it("surfaces a failed pending submission without an automatic retry", async () => {
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{
				content: [
					{
						type: "toolCall",
						id: "failed-memory-submission",
						name: "memory_suggest",
						arguments: { text: proposed, category: "project", status: "pending" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "The pending suggestion could not be queued." }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed),
			{ content: [] },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [failingMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("prepare a proposal whose queue call fails");
			await waitFor(
				() =>
					primary.requests.length === 3 &&
					runtime?.getStatus().reviewing === false &&
					!runtime.getStatus().backlog,
			);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(primary.requests).toHaveLength(3);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "The pending suggestion could not be queued." }],
			});
		} finally {
			await harness.dispose();
		}
	});

	it("replaces a provisional Memory suggestion with ordinary material advice", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next answer" }] },
		]);
		const ordinary = "The migration can delete production rows before backup.";
		const memory = memorySuggestion(proposed);
		const advisor = createAdvisorProvider([
			{
				content: [...memory.content, ...ordinaryAdvice(ordinary).content],
				stopReason: "toolUse",
			},
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review priority");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("materialize priority result");
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain(ordinary);
			expect(context).not.toContain(proposed);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				memorySuggestionsPolicySuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("suppresses a duplicate proposal after a successful current-update memory outcome", async () => {
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "existing-memory-call",
						name: "memory_suggest",
						arguments: { text: proposed, category: "project", status: "pending" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Queued the requested memory." }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [] },
			memorySuggestion(proposed, "duplicate-current-update"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("already queue this durable fact");
			await waitFor(
				() => runtime?.getStatus().reviewsCompleted === 1 && !runtime.getStatus().backlog,
			);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				memorySuggestionsPolicySuppressed: 1,
				deferredNotesPending: 0,
			});
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(
				'memory-suggestion"',
			);
		} finally {
			await harness.dispose();
		}
	});

	it("floors a fractional per-session cap before admission", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "evaluated first suggestion" }] },
			{ content: [{ type: "text", text: "answer two" }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed, "fractional-cap-one"),
			memorySuggestion("A second distinct durable project fact.", "fractional-cap-two"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.memorySuggestions.sessionSuggestionCap = 1.5;
					}),
					(value) => (runtime = value),
				),
			],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first fractional-cap suggestion");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			await harness.session.prompt("second fractional-cap suggestion");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsRemaining: 0,
				memorySuggestionsLimitSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("bounds duplicates and the per-session cap under noisy suggestions", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "answer two" }] },
			{ content: [{ type: "text", text: "answer three" }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed, "cap-one"),
			memorySuggestion("A second distinct durable project fact.", "cap-two"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.memorySuggestions.sessionSuggestionCap = 1;
					}),
					(value) => (runtime = value),
				),
			],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first suggestion");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			await harness.session.prompt("second suggestion");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsRemaining: 0,
				memorySuggestionsLimitSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("enforces turn cadence before admitting another distinct suggestion", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "evaluated first suggestion" }] },
			{ content: [{ type: "text", text: "answer two" }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed, "cadence-one"),
			memorySuggestion("A second durable project constraint.", "cadence-two"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.memorySuggestions.minTurnsBetweenSuggestions = 2;
					}),
					(value) => (runtime = value),
				),
			],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first cadence turn");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			await harness.session.prompt("too-soon cadence turn");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsLimitSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("enforces elapsed-time cadence before admitting another distinct suggestion", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "evaluated first suggestion" }] },
			{ content: [{ type: "text", text: "answer two" }] },
		]);
		const advisor = createAdvisorProvider([
			memorySuggestion(proposed, "interval-one"),
			memorySuggestion("A second durable project procedure.", "interval-two"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.memorySuggestions.minIntervalMs = 60_000;
					}),
					(value) => (runtime = value),
				),
			],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first interval suggestion");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			await harness.session.prompt("too-soon interval suggestion");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsLimitSuppressed: 1,
			});
			expect(runtime?.getStatus().memorySuggestionNextEligibleAt).toBeGreaterThan(Date.now());
		} finally {
			await harness.dispose();
		}
	});

	it("deduplicates repeated proposed memory independently of rationale wording", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer one" }] },
			{ content: [{ type: "text", text: "evaluated first suggestion" }] },
			{ content: [{ type: "text", text: "answer two" }] },
		]);
		const second = memorySuggestion(`  ${proposed.toLocaleUpperCase("en-US")}  `, "dedupe-two");
		if (second.content[0] !== undefined) {
			second.content[0].arguments.note = "A completely different rationale for the same proposal.";
		}
		const advisor = createAdvisorProvider([memorySuggestion(proposed, "dedupe-one"), second]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first duplicate turn");
			await waitFor(() => runtime?.getStatus().memorySuggestionsDelivered === 1);
			await harness.session.prompt("second duplicate turn");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				notesSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("orders near-idle user input before one late Memory suggestion delivery", async () => {
		const advisorBarrier = createBarrier();
		const executorBarrier = createBarrier();
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "initial terminal answer" }] },
			{
				waitFor: executorBarrier.promise,
				content: [{ type: "text", text: "answered the near-idle user input" }],
			},
			{
				content: [
					{
						type: "toolCall",
						id: "near-idle-memory-submission",
						name: "memory_suggest",
						arguments: { text: proposed, category: "project", status: "pending" },
					},
				],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "queued after the nearby user prompt" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
			{ content: [] },
			{ content: [] },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("produce a late Memory suggestion");
			await waitFor(() => advisor.activeRequests === 1);

			const nearbyTurn = harness.session.prompt("near-idle user input");
			await waitFor(() => primary.requests.length === 2 && primary.activeRequests === 1);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);
			executorBarrier.release();
			await nearbyTurn;
			await waitFor(() => submit.mock.calls.length === 1 && primary.requests.length === 4);

			const branch = harness.sessionManager.getBranch();
			const indexContaining = (text: string): number =>
				branch.findIndex((entry) => JSON.stringify(entry).includes(text));
			const nearbyUserIndex = indexContaining("near-idle user input");
			const nearbyAnswerIndex = indexContaining("answered the near-idle user input");
			const suggestionIndex = branch.findIndex(
				(entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note",
			);
			const submissionIndex = indexContaining("near-idle-memory-submission");
			expect(nearbyUserIndex).toBeGreaterThan(-1);
			expect(nearbyAnswerIndex).toBeGreaterThan(nearbyUserIndex);
			expect(suggestionIndex).toBeGreaterThan(nearbyAnswerIndex);
			expect(submissionIndex).toBeGreaterThan(suggestionIndex);
			expect(
				branch.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				),
			).toHaveLength(1);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(submit).toHaveBeenCalledWith({
				text: proposed,
				category: "project",
				status: "pending",
			});
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				activeNotesPending: 0,
				deferredNotesPending: 0,
			});
		} finally {
			advisorBarrier.release();
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "newer user input",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "user",
					content: "newer instruction from the user",
					timestamp: Date.now(),
				}),
		},
		{
			label: "normal bash execution",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "bashExecution",
					command: "touch normal-side-effect",
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: Date.now(),
				}),
		},
		{
			label: "context-excluded bash execution",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "bashExecution",
					command: "touch hidden-side-effect",
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: Date.now(),
				}),
		},
		{
			label: "foreign custom message",
			append: (manager: SessionManager) =>
				manager.appendCustomMessageEntry(
					"foreign-extension",
					"Follow these newer extension instructions.",
					false,
				),
		},
		{
			label: "custom-role instruction message",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "custom",
					customType: "foreign-instruction",
					content: "Apply this newer instruction.",
					display: false,
					timestamp: Date.now(),
				}),
		},
	])("keeps a late Memory suggestion deferred after $label", async ({ append }) => {
		const advisorBarrier = createBarrier();
		const submit = vi.fn();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "reviewed terminal answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool(submit)],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("start a late Memory review");
			await waitFor(() => advisor.activeRequests === 1);
			append(harness.sessionManager);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(1);
			expect(advisor.requests).toHaveLength(1);
			expect(submit).not.toHaveBeenCalled();
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				activeNotesPending: 0,
				deferredNotesPending: 1,
			});
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("rechecks capability before idle dispatch and emits could-not-queue guidance", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "reported unavailable capability" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...memorySuggestion(proposed), waitFor: advisorBarrier.promise },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("queue before capability loss");
			await waitFor(() => advisor.activeRequests === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const extensionApi = Reflect.get(runtime, "pi") as ExtensionAPI;
			extensionApi.setActiveTools([]);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(1);
			await harness.session.prompt("deliver after capability loss");
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain('queue-state=\\"could-not-queue\\"');
			expect(context).toContain("Do not attempt this tool call");
			expect(context).not.toContain("then call memory_suggest with the chosen text");
			expect(runtime.getStatus().memorySuggestionCapability.state).toBe("inactive");
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});
});
