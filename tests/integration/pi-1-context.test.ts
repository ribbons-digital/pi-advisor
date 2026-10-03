import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import {
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorRuntime,
} from "../../src/index.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import { createAdvisorProvider, createPrimaryProvider } from "../fixtures/scripted-provider.js";

function barrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

describe.sequential("Pi 1.0 current Executor evidence", () => {
	it.each([
		"replacement",
		"omission",
		"system change",
		"returned systemPrompt",
		"forceSystemPrompt option",
	] as const)(
		"invalidates an in-flight review after %s and re-primes from current context",
		async (change) => {
			const held = barrier();
			const primary = createPrimaryProvider([
				{ content: [{ type: "text", text: "FIRST-EXECUTOR-ANSWER" }] },
				{ content: [{ type: "text", text: "SECOND-EXECUTOR-ANSWER" }] },
				{ content: [{ type: "text", text: "CURRENT-EXECUTOR-ANSWER" }] },
			]);
			const advisor = createAdvisorProvider([
				{ content: [{ type: "text", text: "PRIVATE-HISTORY-BEFORE-CONTEXT-CHANGE" }] },
				{
					waitFor: held.promise,
					content: [
						{
							type: "toolCall",
							id: "outdated-advice",
							name: "advise",
							arguments: {
								note: "OUTDATED-ADVICE-MUST-NOT-DELIVER",
								intent: "review",
								severity: "concern",
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: [] },
			]);
			let runtime: AdvisorRuntime | undefined;
			let changedSystem = false;
			const configuration = structuredClone(DEFAULT_ADVISOR_CONFIG);
			configuration.defaultEnabled = true;
			configuration.model = `${advisor.model.provider}/${advisor.model.id}`;
			const system: InlineExtension = {
				name: "current-system-test",
				factory: (pi) => {
					pi.on("before_agent_start", (event) => {
						const prompt = changedSystem ? "CURRENT-EXECUTOR-SYSTEM" : "OLD-EXECUTOR-SYSTEM";
						if (change === "returned systemPrompt") return { systemPrompt: prompt };
						if (change === "forceSystemPrompt option")
							event.systemPromptOptions.forceSystemPrompt = prompt;
						else event.systemPromptOptions.appendSystemPrompt = prompt;
						return undefined;
					});
				},
			};
			const harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				extensions: [
					system,
					{
						name: "advisor-context-test",
						factory: createPiAdvisorExtension({
							config: configuration,
							hooks: {
								onRuntime: (value) => {
									runtime = value;
								},
							},
						}),
					},
				],
				tools: [],
				mode: "rpc",
			});
			try {
				await harness.session.prompt("ORIGINAL-USER-EVIDENCE");
				await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
				await harness.session.prompt("start the held review");
				await waitFor(() => advisor.activeRequests === 1 && advisor.requests.length === 2);
				const firstUser = harness.sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (firstUser === undefined) throw new Error("Expected original user entry");
				if (change !== "replacement" && change !== "omission") changedSystem = true;
				else
					harness.sessionManager.appendContextEdit(
						firstUser.id,
						change === "omission" ? null : { content: "EDITED-USER-EVIDENCE" },
					);
				await harness.session.prompt("continue from current evidence");
				await waitFor(
					() => advisor.requests.length === 3 && runtime?.getStatus().reviewsCompleted === 2,
				);
				const current = JSON.stringify(advisor.requests[2]?.context);
				expect(current).toContain("CURRENT-EXECUTOR-ANSWER");
				expect(current).not.toContain("PRIVATE-HISTORY-BEFORE-CONTEXT-CHANGE");
				expect(current).not.toContain("OUTDATED-ADVICE-MUST-NOT-DELIVER");
				if (changedSystem) {
					expect(current).toContain("CURRENT-EXECUTOR-SYSTEM");
					expect(current).not.toContain("OLD-EXECUTOR-SYSTEM");
				} else {
					expect(current).not.toContain("ORIGINAL-USER-EVIDENCE");
					if (change === "replacement") expect(current).toContain("EDITED-USER-EVIDENCE");
				}
				expect(runtime?.getStatus()).toMatchObject({
					notesDelivered: 0,
					activeNotesPending: 0,
					deferredNotesPending: 0,
					failedReviews: 0,
				});
				expect(JSON.stringify(primary.requests.at(-1)?.context)).not.toContain(
					"OUTDATED-ADVICE-MUST-NOT-DELIVER",
				);
			} finally {
				held.release();
				await harness.dispose();
			}
		},
	);

	it.each([
		"replacement",
		"omission",
		"system change",
		"returned systemPrompt",
		"forceSystemPrompt option",
	] as const)("revokes retained RPC steering before delivery after %s", async (change) => {
		const held = barrier();
		const note = "RETAINED-ADVICE-FROM-OLD-CONTEXT";
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-before-abort", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: held.promise, content: [{ type: "text", text: "abandoned continuation" }] },
			{ content: [{ type: "text", text: "current continuation" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "retained-context-advice",
						name: "advise",
						arguments: { intent: "review", severity: "concern", note },
					},
				],
				stopReason: "toolUse",
			},
			{ content: [] },
		]);
		const tool = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a review boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text", text: "boundary" }], details: {} }),
		});
		const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
		config.defaultEnabled = true;
		config.model = `${advisor.model.provider}/${advisor.model.id}`;
		let runtime: AdvisorRuntime | undefined;
		let changedSystem = false;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			customTools: [tool],
			tools: ["hold"],
			mode: "rpc",
			extensions: [
				{
					name: "retained-context-system",
					factory: (pi) => {
						pi.on("before_agent_start", (event) => {
							const prompt = changedSystem ? "CURRENT-STEERING-SYSTEM" : "OLD-STEERING-SYSTEM";
							if (change === "returned systemPrompt") return { systemPrompt: prompt };
							if (change === "forceSystemPrompt option")
								event.systemPromptOptions.forceSystemPrompt = prompt;
							else event.systemPromptOptions.appendSystemPrompt = prompt;
							return undefined;
						});
					},
				},
				{
					name: "retained-context-advisor",
					factory: createPiAdvisorExtension({
						config,
						hooks: {
							onRuntime: (value) => {
								runtime = value;
							},
						},
					}),
				},
			],
		});
		try {
			const turn = harness.session.prompt("OLD-STEERING-USER-EVIDENCE");
			await waitFor(
				() => primary.requests.length === 2 && runtime?.getStatus().activeNotesPending === 1,
			);
			await harness.session.abort();
			await turn;
			expect(runtime?.getStatus()).toMatchObject({ activeNotesPending: 1, notesDelivered: 0 });
			const firstUser = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (firstUser === undefined) throw new Error("Expected user entry");
			if (change !== "replacement" && change !== "omission") changedSystem = true;
			else
				harness.sessionManager.appendContextEdit(
					firstUser.id,
					change === "omission" ? null : { content: "EDITED-STEERING-USER-EVIDENCE" },
				);
			await harness.session.prompt("continue after the evidence changed");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(JSON.stringify(primary.requests.at(-1)?.context)).not.toContain(note);
			if (changedSystem) {
				expect(JSON.stringify(primary.requests.at(-1)?.context)).toContain(
					"CURRENT-STEERING-SYSTEM",
				);
				expect(JSON.stringify(advisor.requests.at(-1)?.context)).toContain(
					"CURRENT-STEERING-SYSTEM",
				);
			}
			expect(runtime?.getStatus()).toMatchObject({ activeNotesPending: 0, notesDelivered: 0 });
			const revoked = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.content.length === 0);
			expect(revoked).toMatchObject({
				content: [],
				display: false,
				details: { deliveryRevoked: true },
			});
		} finally {
			held.release();
			await harness.dispose();
		}
	});

	it.each(["append", "return", "force option"] as const)(
		"checks idle deferred advice against the final %s prompt, with unchanged control",
		async (kind) => {
			for (const changed of [false, true]) {
				const late = barrier();
				const note = "IDLE-DEFERRED-OLD-SYSTEM-ADVICE";
				const primary = createPrimaryProvider([
					{ content: [{ type: "text", text: "first answer" }] },
					{ content: [{ type: "text", text: "second answer" }] },
					{ content: [{ type: "text", text: "third answer" }] },
				]);
				const advisor = createAdvisorProvider([
					{
						waitFor: late.promise,
						content: [
							{
								type: "toolCall",
								id: "late-system-advice",
								name: "advise",
								arguments: { intent: "review", severity: "concern", note },
							},
						],
						stopReason: "toolUse",
					},
					{ content: [] },
					{ content: [] },
				]);
				const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
				config.defaultEnabled = true;
				config.model = `${advisor.model.provider}/${advisor.model.id}`;
				let current = false;
				let runtime: AdvisorRuntime | undefined;
				const harness = await createSessionHarness({
					provider: primary,
					advisorProvider: advisor,
					tools: [],
					mode: "rpc",
					extensions: [
						{
							name: "deferred-final-system",
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									const prompt = current ? "CURRENT-DEFERRED-SYSTEM" : "OLD-DEFERRED-SYSTEM";
									if (kind === "return") return { systemPrompt: prompt };
									if (kind === "force option") event.systemPromptOptions.forceSystemPrompt = prompt;
									else event.systemPromptOptions.appendSystemPrompt = prompt;
									return undefined;
								});
							},
						},
						{
							name: "deferred-final-advisor",
							factory: createPiAdvisorExtension({
								config,
								hooks: {
									onRuntime: (value) => {
										runtime = value;
									},
								},
							}),
						},
					],
				});
				try {
					await harness.session.prompt("complete before the late advice");
					await waitFor(() => advisor.activeRequests === 1);
					late.release();
					await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
					expect(runtime?.getStatus().notesDelivered).toBe(0);
					current = changed;
					await harness.session.prompt("check the next prompt's instructions");
					await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
					const request = JSON.stringify(primary.requests[1]?.context);
					expect(request.includes(note)).toBe(!changed);
					expect(runtime?.getStatus()).toMatchObject({
						notesDelivered: changed ? 0 : 1,
						deferredNotesPending: 0,
						branchResets: changed ? 1 : 0,
						failedReviews: 0,
					});
					expect(JSON.stringify(advisor.requests.at(-1)?.context)).toContain(
						current ? "CURRENT-DEFERRED-SYSTEM" : "OLD-DEFERRED-SYSTEM",
					);
					await harness.session.prompt("unchanged prompt must not replay or reset");
					await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
					expect(runtime?.getStatus()).toMatchObject({
						notesDelivered: changed ? 0 : 1,
						branchResets: changed ? 1 : 0,
					});
					const entries = harness.sessionManager
						.getEntries()
						.filter(
							(entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note",
						);
					expect(entries).toHaveLength(1);
					if (changed)
						expect(entries[0]).toMatchObject({
							content: [],
							display: false,
							details: { deliveryRevoked: true },
						});
				} finally {
					late.release();
					await harness.dispose();
				}
			}
		},
	);

	it("observes successful nested Memory calls through actual ctx.executeTool without duplicate suggestions", async () => {
		const proposed = "Keep API tests deterministic with scripted providers.";
		const finish = barrier();
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "outer-memory", name: "orchestrate", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: finish.promise, content: [{ type: "text", text: "memory was queued" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "duplicate-memory",
						name: "advise",
						arguments: {
							intent: "memory-suggestion",
							note: "This verified project constraint matters later.",
							memory: { text: proposed, category: "project", basis: "project-constraint" },
						},
					},
				],
				stopReason: "toolUse",
			},
			{ content: [] },
		]);
		const memory = defineTool({
			name: "memory_suggest",
			label: "memory",
			description: "Queue pending memory.",
			parameters: Type.Object({
				text: Type.String(),
				category: Type.Union([Type.Literal("project"), Type.Literal("preference")]),
				status: Type.Literal("pending"),
			}),
			execute: () => Promise.resolve({ content: [{ type: "text", text: "queued" }], details: {} }),
		});
		const orchestrate = defineTool({
			name: "orchestrate",
			label: "orchestrate",
			description: "Run a nested memory tool.",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => {
				await ctx.executeTool("memory_suggest", {
					text: proposed,
					category: "project",
					status: "pending",
				});
				return { content: [{ type: "text" as const, text: "nested call finished" }], details: {} };
			},
		});
		const configuration = structuredClone(DEFAULT_ADVISOR_CONFIG);
		configuration.defaultEnabled = true;
		configuration.model = `${advisor.model.provider}/${advisor.model.id}`;
		configuration.memorySuggestions.minIntervalMs = 0;
		configuration.memorySuggestions.minTurnsBetweenSuggestions = 0;
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			customTools: [memory, orchestrate],
			tools: ["memory_suggest", "orchestrate"],
			mode: "rpc",
			extensions: [
				{
					name: "nested-memory-advisor-test",
					factory: createPiAdvisorExtension({
						config: configuration,
						hooks: {
							onRuntime: (value) => {
								runtime = value;
							},
						},
					}),
				},
			],
		});
		try {
			const turn = harness.session.prompt("queue memory through the orchestrator");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) >= 1);
			expect(runtime?.getStatus().memorySuggestionCapability.state).toBe("available");
			finish.release();
			await turn;
			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "orchestrate",
			);
			expect(result).toMatchObject({
				nestedCalls: {
					complete: true,
					calls: [{ name: "memory_suggest", status: "ok", arguments: { text: proposed } }],
				},
			});
			expect(runtime?.getStatus().memorySuggestionsPolicySuppressed).toBe(1);
			expect(runtime?.getStatus().memorySuggestionsDelivered).toBe(0);
			expect(JSON.stringify(primary.requests)).not.toContain("<advisor-note");
		} finally {
			finish.release();
			await harness.dispose();
		}
	});
});
