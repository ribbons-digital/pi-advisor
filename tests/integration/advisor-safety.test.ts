import {
	defineTool,
	type CustomEntry,
	type CustomMessageEntry,
	type ExtensionContext,
	type InlineExtension,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISOR_ARGUMENT_VALIDATION_FAILURE,
	ADVISOR_INTERNAL_EXECUTION_FAILURE,
	ADVISOR_REVIEW_TIMEOUT_FAILURE,
	ADVISOR_LATE_ENTRY_TYPE,
	adviceDedupeKey,
	createPiAdvisorExtension,
	cursorAtTail,
	cursorMatches,
	formatAdvisorStatus,
	DEFAULT_ADVISOR_CONFIG,
	MAX_PENDING_ADVICE_BYTES,
	type AcceptedAdvice,
	type AdvisorConfig,
	type AdvisorRuntime,
	type AdvisorRuntimeHooks,
} from "../../src/index.js";
import { runtimeInternals } from "../fixtures/runtime-internals.js";
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
	mutate?.(config);
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
	onWarning?: (message: string) => void,
	onStatus?: () => void,
	onAdviseExecutionStart?: () => void | Promise<void>,
): InlineExtension {
	const hooks: AdvisorRuntimeHooks & { onRuntime(runtime: AdvisorRuntime): void } = { onRuntime };
	if (onWarning !== undefined) hooks.onWarning = onWarning;
	if (onStatus !== undefined) hooks.onStatus = onStatus;
	if (onAdviseExecutionStart !== undefined) hooks.onAdviseExecutionStart = onAdviseExecutionStart;
	return {
		name: "pi-advisor-safety-test",
		factory: createPiAdvisorExtension({ config, hooks }),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function createBarrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function assistantToolCall(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "integration-test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function acceptedAdvice(
	note: string,
	id = "advise-1",
	severity: "nit" | "concern" | "blocker" = "concern",
) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: { note, severity, intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

describe.sequential("Advisor delivery and safety behavior through Slice 2 Batch A", () => {
	it("delivers a normal accepted note once through active steer and skips the resulting Advisor-generated turn", async () => {
		const executorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{
				waitFor: executorBarrier.promise,
				content: [{ type: "text", text: "Executor continued original work" }],
			},
			{ content: [{ type: "text", text: "Executor weighed peer guidance" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Verify the migration rollback before completion."),
			{ content: [] },
		]);
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a deterministic active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("start active delivery");
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);
			executorBarrier.release();
			await activeTurn;
			await waitFor(
				() => primary.requests.length === 3 && runtime?.getStatus().notesDelivered === 1,
			);
			expect(JSON.stringify(primary.requests[2]?.context)).toContain(
				"Verify the migration rollback before completion.",
			);
			expect(advisor.requests).toHaveLength(2);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 1, reviewsCompleted: 2 });
		} finally {
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "ordinary review",
			governorOutcome: undefined,
			expectedFailedReviews: 1,
			expectedConsecutiveFailures: 1,
			expectedGovernorSkips: 0,
		},
		{
			label: "tool-governed review",
			governorOutcome: "Advisor tool-call limit reached" as const,
			expectedFailedReviews: 1,
			expectedConsecutiveFailures: 1,
			expectedGovernorSkips: 1,
		},
		{
			label: "turn-governed review",
			governorOutcome: "Advisor turn limit reached" as const,
			expectedFailedReviews: 1,
			expectedConsecutiveFailures: 1,
			expectedGovernorSkips: 1,
		},
	])(
		"processes the pending update in order after a thrown active delivery for a $label",
		async ({
			governorOutcome,
			expectedFailedReviews,
			expectedConsecutiveFailures,
			expectedGovernorSkips,
		}) => {
			const executorBarrier = createBarrier();
			const adviseStarted = createBarrier();
			const afterAdvise = createBarrier();
			const pendingAdvisorBarrier = createBarrier();
			const secondExecutorTurn = createBarrier();
			const primary = createPrimaryProvider([
				{
					content: [{ type: "toolCall", id: "hold-send-failure", name: "hold", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					waitFor: secondExecutorTurn.promise,
					content: [
						{ type: "text", text: "SECOND-PENDING-EXECUTOR-UPDATE" },
						{ type: "toolCall", id: "hold-pending-update", name: "hold", arguments: {} },
					],
					stopReason: "toolUse",
				},
				{
					waitFor: executorBarrier.promise,
					content: [{ type: "text", text: "Executor continued after delivery failure" }],
				},
			]);
			const advisor = createAdvisorProvider([
				acceptedAdvice("This delivery should throw."),
				{ content: [], waitFor: pendingAdvisorBarrier.promise },
			]);
			const hold = defineTool({
				name: "hold",
				label: "hold",
				description: "Create a deterministic active Executor boundary.",
				parameters: Type.Object({}),
				execute: () =>
					Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
			});
			let runtime: AdvisorRuntime | undefined;
			const harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				extensions: [
					extensionFor(
						configFor(advisor),
						(value) => (runtime = value),
						undefined,
						undefined,
						async () => {
							adviseStarted.release();
							await afterAdvise.promise;
						},
					),
				],
				customTools: [hold],
				tools: ["hold"],
				mode: "rpc",
			});
			try {
				if (runtime === undefined) throw new Error("Expected Advisor runtime");
				const activeRuntime = runtime;
				const extensionApi = runtimeInternals(activeRuntime).pi;
				const sendMessage = vi.spyOn(extensionApi, "sendMessage").mockImplementation(() => {
					throw new Error("scripted active delivery failure");
				});
				const activeTurn = harness.session.prompt("start throwing active delivery");
				try {
					await adviseStarted.promise;
					if (governorOutcome !== undefined) {
						const currentRun = runtimeInternals(activeRuntime).currentRun;
						if (currentRun === undefined) throw new Error("Expected current Advisor run");
						currentRun.governorFailure = governorOutcome;
					}
					secondExecutorTurn.release();
					await waitFor(() => activeRuntime.getStatus().backlog);
					afterAdvise.release();
					await waitFor(() => advisor.requests.length === 2);
					const failedDeliveryStatus = activeRuntime.getStatus();
					expect(failedDeliveryStatus).toMatchObject({
						reviewsCompleted: 0,
						failedReviews: expectedFailedReviews,
						governorSkippedReviews: expectedGovernorSkips,
						deliveryFailures: 1,
						consecutiveFailures: expectedConsecutiveFailures,
						silentReviews: 0,
						activeNotesPending: 0,
						lastDeliveryFailure: "scripted active delivery failure",
					});
					expect(failedDeliveryStatus.lastFailure).toBe("scripted active delivery failure");
					if (governorOutcome !== undefined) {
						expect(failedDeliveryStatus.lastGovernorOutcome).toBe(governorOutcome);
					}
					expect(sendMessage).toHaveBeenCalledTimes(1);
					expect(JSON.stringify(advisor.requests[0]?.context)).not.toContain(
						"SECOND-PENDING-EXECUTOR-UPDATE",
					);
					const pendingContext = JSON.stringify(advisor.requests[1]?.context);
					expect(pendingContext).toContain("SECOND-PENDING-EXECUTOR-UPDATE");
					expect(pendingContext).not.toContain("This delivery should throw.");

					pendingAdvisorBarrier.release();
					await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 1);
					expect(activeRuntime.getStatus()).toMatchObject({
						failedReviews: expectedFailedReviews,
						governorSkippedReviews: expectedGovernorSkips,
						consecutiveFailures: 0,
						backlog: false,
					});
				} finally {
					afterAdvise.release();
					pendingAdvisorBarrier.release();
					secondExecutorTurn.release();
					executorBarrier.release();
					await activeTurn;
					sendMessage.mockRestore();
				}
			} finally {
				afterAdvise.release();
				pendingAdvisorBarrier.release();
				secondExecutorTurn.release();
				executorBarrier.release();
				await harness.dispose();
			}
		},
	);

	it("preserves active advice when a TUI-style abort clears the steering queue", async () => {
		const executorBarrier = createBarrier();
		const note = "Retain this active note across interruption.";
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-abort", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: executorBarrier.promise, content: [{ type: "text", text: "interrupted" }] },
			{ content: [{ type: "text", text: "answer after interruption" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice(note)]);
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a deterministic active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "tui",
		});
		try {
			const activeTurn = harness.session.prompt("start interruptible active delivery");
			await waitFor(
				() =>
					primary.activeRequests === 1 &&
					advisor.requests.length === 1 &&
					runtime?.getStatus().activeNotesPending === 1,
			);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0 });
			harness.session.clearQueue();
			await harness.session.abort();
			await activeTurn;
			expect(runtime?.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 1,
				notesDelivered: 0,
			});

			await harness.session.prompt("resume after clearing the active queue");
			const context = JSON.stringify(primary.requests[2]?.context);
			expect(context.split(note).length - 1).toBe(1);
		} finally {
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it("acknowledges RPC active advice after abort continuation without deferring a duplicate", async () => {
		const executorBarrier = createBarrier();
		const note = "Deliver this active RPC note once.";
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-rpc-abort", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: executorBarrier.promise, content: [{ type: "text", text: "interrupted" }] },
			{ content: [{ type: "text", text: "continued with active advice" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice(note), { content: [] }]);
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a deterministic active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("start RPC active delivery");
			await waitFor(
				() =>
					primary.activeRequests === 1 &&
					advisor.requests.length === 1 &&
					runtime?.getStatus().activeNotesPending === 1,
			);
			await harness.session.abort();
			await activeTurn;

			expect(primary.requests).toHaveLength(3);
			const context = JSON.stringify(primary.requests[2]?.context);
			expect(context.split(note).length - 1).toBe(1);
			expect(runtime?.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 0,
				notesDelivered: 1,
			});
		} finally {
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it("clears active-pending advice on branch invalidation without recovering it", async () => {
		const executorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "hold-branch", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ waitFor: executorBarrier.promise, content: [{ type: "text", text: "invalidated" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Do not carry this note onto another branch."),
		]);
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a deterministic active Executor boundary.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "rpc",
		});
		try {
			const activeTurn = harness.session.prompt("start branch-local active delivery");
			await waitFor(() => runtime?.getStatus().activeNotesPending === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const hostContext = runtimeInternals(activeRuntime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");

			harness.session.clearQueue();
			activeRuntime.handleBranchChange(hostContext);
			executorBarrier.release();
			await activeTurn;

			expect(activeRuntime.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 0,
				notesDelivered: 0,
				branchResets: 1,
			});
		} finally {
			executorBarrier.release();
			await harness.dispose();
		}
	});

	it("acknowledges an active direct-append delivery from branch state at settlement", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const advice: AcceptedAdvice = {
				intent: "review",
				note: "Acknowledge this direct append.",
				severity: "concern",
				truncated: false,
				originalCharacters: 31,
				originalEstimatedTokens: 8,
				createdAt: Date.now(),
			};
			const identity = adviceDedupeKey(advice);
			const deliveryId = `direct-append:${identity}`;
			const reviewId = "direct-append-review";
			const branchWindow = cursorAtTail(harness.sessionManager.getBranch());
			const activeAdvice = runtimeInternals(activeRuntime).activeAdvice;
			expect(
				activeAdvice.enqueue(
					identity,
					{
						advice,
						stale: false,
						branchWindow,
						displayedInEntry: false,
						identity,
						deliveryId,
						reviewId,
						turnNumber: 1,
						epoch: activeRuntime.getStatus().epoch,
					},
					Buffer.byteLength(advice.note, "utf8"),
				),
			).toBe("accepted");
			activeRuntime.observeExecutorMessage({
				role: "custom",
				customType: "pi-advisor-note",
				content: "stale acknowledgement",
				display: true,
				details: { deliveryId: `old-attempt:${identity}` },
				timestamp: Date.now(),
			});
			expect(activeAdvice.length).toBe(1);
			expect(activeRuntime.getStatus().notesDelivered).toBe(0);
			harness.sessionManager.appendCustomMessageEntry("pi-advisor-note", "direct append", true, {
				deliveryId,
				reviewId,
			});
			const hostContext = runtimeInternals(activeRuntime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");

			await activeRuntime.settleActiveAdvice(hostContext);

			expect(activeAdvice.length).toBe(0);
			expect(activeRuntime.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 0,
				notesDelivered: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("queues a normal accepted note with nextTurn while idle without triggering a completion", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next user answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice("Check the final artifact checksum."), delayMs: 100 },
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
			await harness.session.prompt("finish first turn");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(1);
			await harness.session.prompt("begin next user turn");
			expect(primary.requests).toHaveLength(2);
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				"Check the final artifact checksum.",
			);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(advisor.requests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});

	it("shows late TUI advice immediately without duplicating it on next-turn delivery", async () => {
		const note = "Check the late TUI artifact before shipping.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "answer after late advice" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(note, "late-tui"), delayMs: 50 },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "tui",
		});
		try {
			await harness.session.prompt("finish before the late review");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(1);
			const lateEntries = harness.sessionManager
				.getEntries()
				.filter(
					(entry): entry is CustomEntry =>
						entry.type === "custom" && entry.customType === ADVISOR_LATE_ENTRY_TYPE,
				);
			expect(lateEntries).toHaveLength(1);
			expect(lateEntries[0]?.data).toMatchObject({
				note: { note, delivery: "deferred" },
			});
			expect(JSON.stringify(primary.requests[0]?.context)).not.toContain(note);

			await harness.session.prompt("weigh the late review");
			const nextContext = JSON.stringify(primary.requests[1]?.context);
			expect(nextContext.match(new RegExp(note.replaceAll(".", "\\."), "gu"))).toHaveLength(1);
			const delivered = harness.sessionManager
				.getEntries()
				.find(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(delivered).toMatchObject({
				display: false,
				details: { displayedInEntry: true, notes: [{ displayedInEntry: true }] },
			});
		} finally {
			await harness.dispose();
		}
	});

	it.each(["json", "print"] as const)(
		"delivers deferred advice in %s mode without invoking TUI-only entries",
		async (mode) => {
			const note = `Non-interactive ${mode} advice.`;
			const primary = createPrimaryProvider([
				{ content: [{ type: "text", text: "terminal answer" }] },
				{ content: [{ type: "text", text: "next answer" }] },
			]);
			const advisor = createAdvisorProvider([
				{ ...acceptedAdvice(note, `non-interactive-${mode}`), delayMs: 25 },
				{ content: [] },
			]);
			let runtime: AdvisorRuntime | undefined;
			const harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
				tools: [],
				mode,
			});
			try {
				await harness.session.prompt("/advisor on");
				expect(runtime?.getStatus()).toMatchObject({ active: true });
				await harness.session.prompt(`finish ${mode} turn`);
				await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
				if (runtime === undefined) throw new Error("Expected Advisor runtime");
				expect(
					harness.sessionManager
						.getEntries()
						.some(
							(entry) => entry.type === "custom" && entry.customType === ADVISOR_LATE_ENTRY_TYPE,
						),
				).toBe(false);
				expect(formatAdvisorStatus(runtime.getStatus())).toContain("Delivery failures: 0");

				await harness.session.prompt(`deliver ${mode} advice`);
				expect(JSON.stringify(primary.requests[1]?.context)).toContain(note);
			} finally {
				await harness.dispose();
			}
		},
	);

	it("counts a failed late-card append once and keeps next-turn delivery available", async () => {
		const note = "Preserve delivery after the late card fails.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(note, "late-card-failure"), delayMs: 50 },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "tui",
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const extensionApi = runtimeInternals(runtime).pi;
			const appendEntry = vi.spyOn(extensionApi, "appendEntry").mockImplementation(() => {
				throw new Error("TOKEN=late-card-secret-value");
			});
			await harness.session.prompt("finish before failed late card");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(
				appendEntry.mock.calls.filter(([customType]) => customType === ADVISOR_LATE_ENTRY_TYPE),
			).toHaveLength(1);
			expect(runtime.getStatus()).toMatchObject({
				deliveryFailures: 1,
				lastDeliveryFailure: "TOKEN=[REDACTED]",
			});

			await harness.session.prompt("deliver despite card failure");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(note);
			expect(
				appendEntry.mock.calls.filter(([customType]) => customType === ADVISOR_LATE_ENTRY_TYPE),
			).toHaveLength(1);
			appendEntry.mockRestore();
		} finally {
			await harness.dispose();
		}
	});

	it("isolates throwing warning observers from capacity rejection", async () => {
		const advisorBarrier = createBarrier();
		const capacityWarning =
			"Deferred Advisor queue reached its fixed item or byte bound; newer advice was suppressed.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice("Rejected note at queue capacity."), waitFor: advisorBarrier.promise },
		]);
		let runtime: AdvisorRuntime | undefined;
		let warningCalls = 0;
		let statusCalls = 0;
		const notify = vi.fn();
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					() => {
						warningCalls++;
						throw new Error("warning observer failed");
					},
					() => {
						statusCalls++;
					},
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("fill deferred queue");
			await waitFor(() => advisor.activeRequests === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const hostContext = runtimeInternals(activeRuntime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");
			Reflect.set(activeRuntime, "hostContext", {
				...hostContext,
				hasUI: true,
				ui: { ...hostContext.ui, notify },
			});
			const pendingAdvice = runtimeInternals(activeRuntime).pendingAdvice;
			const seededAdvice: AcceptedAdvice = {
				intent: "review",
				note: "Existing queued note.",
				severity: "concern",
				truncated: false,
				originalCharacters: 21,
				originalEstimatedTokens: 6,
				createdAt: Date.now(),
			};
			expect(
				pendingAdvice.enqueue(
					"full-queue-entry",
					{
						advice: seededAdvice,
						stale: false,
						branchWindow: { expectedIndex: 0 },
						displayedInEntry: false,
					},
					MAX_PENDING_ADVICE_BYTES,
				),
			).toBe("accepted");
			const statusCallsBeforeWarning = statusCalls;

			advisorBarrier.release();
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 1);

			expect(activeRuntime.getStatus()).toMatchObject({
				reviewsCompleted: 1,
				silentReviews: 1,
				failedReviews: 0,
				notesDelivered: 0,
				notesSuppressed: 1,
				warnings: 1,
			});
			expect(pendingAdvice.length).toBe(1);
			expect(pendingAdvice.totalBytes).toBe(MAX_PENDING_ADVICE_BYTES);
			expect(warningCalls).toBe(1);
			expect(statusCalls).toBeGreaterThan(statusCallsBeforeWarning);
			expect(notify).toHaveBeenCalledWith(capacityWarning, "warning");
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("isolates throwing status observers from deferred delivery", async () => {
		const note = "Preserve this deferred note despite observer failures.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "answer after deferred advice" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice(note), { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		let statusCalls = 0;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					undefined,
					() => {
						statusCalls++;
						throw new Error("status observer failed");
					},
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("finish reviewed turn");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("materialize deferred advice");
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context.split(note).length - 1).toBe(1);
			expect(statusCalls).toBeGreaterThan(0);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				deferredNotesPending: 0,
			});
			const notes = harness.sessionManager
				.getEntries()
				.filter(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(notes).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("acknowledges valid content-free advice neutrally and records a silent suppression", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ordinary answer" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice("Looks good")]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review for noise");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 0,
				notesSuppressed: 1,
				silentReviews: 1,
			});
			expect(JSON.stringify(runtime?.getNestedMessages())).toContain("Recorded.");
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("Looks good");
		} finally {
			await harness.dispose();
		}
	});

	it("delivers one bounded oversized note with metadata and no discarded primary content", async () => {
		const discarded = "DISCARDED-OVERSIZED-SENTINEL";
		const longNote = `${"Important verification detail. ".repeat(20)}${discarded}`;
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer before oversized advice" }] },
			{ content: [{ type: "text", text: "answer after oversized advice" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice(longNote)]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxAdviceCharacters = 120;
						config.limits.maxAdviceTokens = 30;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("produce oversized advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			if (primary.requests.length === 1) {
				await harness.session.prompt("materialize deferred oversized advice");
			}
			const notes = harness.sessionManager
				.getEntries()
				.filter(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(notes).toHaveLength(1);
			const note = notes[0];
			if (note === undefined) throw new Error("Expected one Advisory note");
			expect(note.content).toContain("[Advisory note truncated to configured limit]");
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			const details = note.details as {
				truncated?: unknown;
				originalCharacters?: unknown;
			};
			expect(details.truncated).toBe(true);
			expect(details.originalCharacters).toBe(longNote.length);
			expect(JSON.stringify(notes)).not.toContain(discarded);
			expect(JSON.stringify(primary.requests[1]?.context)).not.toContain(discarded);
		} finally {
			await harness.dispose();
		}
	});

	it("invalidates an in-flight review when the user disables Advisor", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice("This result must be invalidated."), delayMs: 150 },
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
			await harness.session.prompt("start delayed review");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("/advisor off");
			await waitFor(() => advisor.activeRequests === 0);
			expect(runtime?.getStatus()).toMatchObject({
				enabled: false,
				active: false,
				notesDelivered: 0,
			});
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(
				"This result must be invalidated.",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("counts and drops a provider failure after one bounded retry", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "scripted provider failed" },
			{ errorMessage: "scripted provider failed again" },
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
			await harness.session.prompt("trigger provider failure");
			await waitFor(() => runtime?.getStatus().failedReviews === 2);
			expect(advisor.requests).toHaveLength(2);
			expect(runtime?.getNestedMessageCount()).toBe(0);
			expect(runtime?.getStatus()).toMatchObject({
				reviewsCompleted: 0,
				silentReviews: 0,
				failedReviews: 2,
				retryAttempts: 1,
				lastFailure: "scripted provider failed again",
			});
		} finally {
			await harness.dispose();
		}
	});

	it("treats a well-formed read of a missing file as ordinary tool feedback", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "missing-read",
						name: "read",
						arguments: { path: "does-not-exist.txt" },
					},
				],
				stopReason: "toolUse",
			},
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
			await harness.session.prompt("allow ordinary read miss");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				silentReviews: 1,
				consecutiveFailures: 0,
			});
			expect(advisor.requests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});

	it("preserves the newest Executor delta and clears removed project context", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "NEWEST-EXECUTOR-CONTENT" }] },
			{ content: [{ type: "text", text: "CONTENT-AFTER-INSTRUCTIONS-REMOVED" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }, { content: [] }]);
		let projectFiles = [{ path: "AGENTS.md", content: "P".repeat(2_000) }];
		const projectContextExtension: InlineExtension = {
			name: "project-context-fixture",
			factory: (pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.contextFiles = projectFiles;
				});
			},
		};
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				projectContextExtension,
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxUpdateTokens = 100;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("newest user content");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const firstUpdate = JSON.stringify(advisor.requests[0]?.context.messages.at(-1));
			expect(firstUpdate).toContain("NEWEST-EXECUTOR-CONTENT");
			expect(firstUpdate).toContain("Project instructions truncated");

			projectFiles = [];
			await harness.session.prompt("instructions removed");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			const secondContext = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(secondContext).toContain("CONTENT-AFTER-INSTRUCTIONS-REMOVED");
			expect(secondContext).not.toContain("project-instruction");
		} finally {
			await harness.dispose();
		}
	});

	it("uses the latest project context when submitting coalesced Executor updates", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "FIRST-EXECUTOR-CONTENT" }] },
			{ content: [{ type: "text", text: "COALESCED-WHILE-INSTRUCTIONS-PRESENT" }] },
			{ content: [{ type: "text", text: "COALESCED-AFTER-INSTRUCTIONS-REMOVED" }] },
		]);
		const advisor = createAdvisorProvider([
			{ waitFor: advisorBarrier.promise, content: [] },
			{ content: [] },
		]);
		let projectFiles = [{ path: "AGENTS.md", content: "REMOVE-ME" }];
		const projectContextExtension: InlineExtension = {
			name: "coalesced-project-context-fixture",
			factory: (pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.contextFiles = projectFiles;
				});
			},
		};
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [projectContextExtension, extensionFor(configFor(advisor), () => undefined)],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("start delayed project-context review");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("coalesce with project instructions");
			projectFiles = [];
			await harness.session.prompt("coalesce after removing project instructions");
			advisorBarrier.release();
			await waitFor(() =>
				advisor.requests.some((request) =>
					JSON.stringify(request.context.messages).includes("COALESCED-AFTER-INSTRUCTIONS-REMOVED"),
				),
			);

			const firstContext = JSON.stringify(advisor.requests[0]?.context.messages);
			expect(firstContext).toContain("REMOVE-ME");
			const latestContext = JSON.stringify(advisor.requests.at(-1)?.context.messages);
			expect(latestContext).toContain("COALESCED-WHILE-INSTRUCTIONS-PRESENT");
			expect(latestContext).toContain("COALESCED-AFTER-INSTRUCTIONS-REMOVED");
			expect(latestContext).not.toContain("REMOVE-ME");
			expect(latestContext).not.toContain("project-instruction");
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("suppresses whitespace-only and punctuation-only review notes", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("   \t ", "blank-review"),
			acceptedAdvice("... !!! --", "punctuation-review"),
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
			for (const [index, prompt] of ["blank review", "punctuation review"].entries()) {
				await harness.session.prompt(prompt);
				await waitFor(() => runtime?.getStatus().reviewsCompleted === index + 1);
			}
			expect(runtime?.getStatus()).toMatchObject({
				silentReviews: 2,
				notesSuppressed: 2,
				notesDelivered: 0,
				deferredNotesPending: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("classifies malformed advise arguments without exposing generated or validator text", async () => {
		const privateArgument = "GENERATED-PRIVATE-ARGUMENT-SENTINEL";
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "malformed-advise",
						name: "advise",
						arguments: { severity: "concern", privateArgument },
					},
				],
				stopReason: "toolUse",
			},
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
			await harness.session.prompt("trigger malformed advise");
			await waitFor(() => runtime?.getStatus().failedReviews === 1);
			expect(runtime?.getStatus().lastFailure).toBe(ADVISOR_ARGUMENT_VALIDATION_FAILURE);
			expect(ADVISOR_ARGUMENT_VALIDATION_FAILURE).toContain("selected Advisor model");
			expect(ADVISOR_ARGUMENT_VALIDATION_FAILURE).toContain("/advisor configure");
			expect(ADVISOR_ARGUMENT_VALIDATION_FAILURE).toContain("/advisor on");
			expect(ADVISOR_ARGUMENT_VALIDATION_FAILURE).not.toContain(privateArgument);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(privateArgument);
			expect(runtime?.getNestedMessageCount()).toBe(0);
			expect(runtime?.getStatus().notesDelivered).toBe(0);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			expect(runtimeInternals(runtime).currentRun).toBeUndefined();
		} finally {
			await harness.dispose();
		}
	});

	it("classifies a validated advise execution failure at a zero read-only budget", async () => {
		const advisorBarrier = createBarrier();
		const rawExecutionError = "RAW-EXECUTION-PRIVATE-SENTINEL";
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{
				...acceptedAdvice("Exercise the validated execution path."),
				waitFor: advisorBarrier.promise,
			},
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxToolCallsPerUpdate = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		let originalMaximum: number | undefined;
		try {
			const turn = harness.session.prompt("trigger validated execution failure");
			await waitFor(() => advisor.activeRequests === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeConfig = runtimeInternals(runtime).config;
			originalMaximum = activeConfig.limits.maxAdviceCharacters;
			Object.defineProperty(activeConfig.limits, "maxAdviceCharacters", {
				configurable: true,
				get: () => {
					throw new Error(rawExecutionError);
				},
			});
			advisorBarrier.release();
			await turn;
			await waitFor(() => runtime?.getStatus().failedReviews === 1);
			expect(runtime.getStatus().lastFailure).toBe(ADVISOR_INTERNAL_EXECUTION_FAILURE);
			expect(ADVISOR_INTERNAL_EXECUTION_FAILURE).toContain("internal");
			expect(ADVISOR_INTERNAL_EXECUTION_FAILURE).not.toContain("selected Advisor model");
			expect(ADVISOR_INTERNAL_EXECUTION_FAILURE).not.toContain("/advisor configure");
			expect(ADVISOR_INTERNAL_EXECUTION_FAILURE).not.toContain(rawExecutionError);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(rawExecutionError);
			expect(runtimeInternals(runtime).currentRun).toBeUndefined();
		} finally {
			advisorBarrier.release();
			if (runtime !== undefined && originalMaximum !== undefined) {
				const activeConfig = runtimeInternals(runtime).config;
				Object.defineProperty(activeConfig.limits, "maxAdviceCharacters", {
					configurable: true,
					writable: true,
					value: originalMaximum,
				});
			}
			await harness.dispose();
		}
	});

	it("pauses after three consecutive review timeouts, warns once, and resumes only after a successful review", async () => {
		const timeoutBarriers: (() => void)[] = [];
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer 1" }] },
			{ content: [{ type: "text", text: "answer 2" }] },
			{ content: [{ type: "text", text: "answer 3" }] },
			{ content: [{ type: "text", text: "answer 4" }] },
			{ content: [{ type: "text", text: "answer 5" }] },
			{ content: [{ type: "text", text: "answer 6" }] },
			{ content: [{ type: "text", text: "answer 7" }] },
		]);
		const advisor = createAdvisorProvider([
			{ waitFor: barrierPromise(), content: [] },
			{ waitFor: barrierPromise(), content: [] },
			{ waitFor: barrierPromise(), content: [] },
			{ content: [] },
		]);
		function barrierPromise(): Promise<void> {
			return new Promise((resolve) => timeoutBarriers.push(resolve));
		}
		const warnings: string[] = [];
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxReviewAttemptMs = 50;
					}),
					(value) => (runtime = value),
					(warning) => warnings.push(warning),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first timeout turn");
			await waitFor(() => runtime?.getStatus().consecutiveReviewTimeouts === 1);
			await harness.session.prompt("second timeout turn");
			await waitFor(() => runtime?.getStatus().consecutiveReviewTimeouts === 2);
			expect(runtime?.getStatus()).toMatchObject({
				paused: false,
				governorSkippedReviews: 2,
				warnings: 0,
			});

			await harness.session.prompt("third timeout turn");
			await waitFor(() => runtime?.getStatus().paused === true);
			expect(runtime?.getStatus()).toMatchObject({
				consecutiveReviewTimeouts: 3,
				pauseReason:
					"Three consecutive Advisor review attempts timed out. Last timeout: Advisor review attempt timed out",
				governorSkippedReviews: 3,
				warnings: 1,
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Three consecutive Advisor review attempts timed out");
			expect(warnings[0]).toContain("Automatic Advisor review is paused");

			// The pause is a one-shot warning; subsequent eligible updates stay paused without new warnings.
			await harness.session.prompt("turn after pause");
			expect(advisor.requests).toHaveLength(3);
			expect(warnings).toHaveLength(1);
			expect(runtime?.getStatus()).toMatchObject({
				paused: true,
				consecutiveReviewTimeouts: 3,
			});

			// Re-activating with budget reset clears the timeout streak.
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const hostContext = runtimeInternals(runtime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");
			await runtime.enable(hostContext, "session-command", true);
			expect(runtime.getStatus()).toMatchObject({
				paused: false,
				consecutiveReviewTimeouts: 0,
			});
		} finally {
			for (const release of timeoutBarriers) release();
			await harness.dispose();
		}
	});

	it("resets the review-timeout streak after a successful review", async () => {
		const timeoutBarriers: (() => void)[] = [];
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer 1" }] },
			{ content: [{ type: "text", text: "answer 2" }] },
			{ content: [{ type: "text", text: "answer 3" }] },
			{ content: [{ type: "text", text: "answer 4" }] },
		]);
		const advisor = createAdvisorProvider([
			{ waitFor: barrierPromise(), content: [] },
			{ waitFor: barrierPromise(), content: [] },
			{ content: [] },
			{ waitFor: barrierPromise(), content: [] },
		]);
		function barrierPromise(): Promise<void> {
			return new Promise((resolve) => timeoutBarriers.push(resolve));
		}
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxReviewAttemptMs = 50;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("timeout one");
			await waitFor(() => runtime?.getStatus().consecutiveReviewTimeouts === 1);
			await harness.session.prompt("timeout two");
			await waitFor(() => runtime?.getStatus().consecutiveReviewTimeouts === 2);
			expect(runtime?.getStatus().paused).toBe(false);

			// A successful review resets the streak before it reaches the pause threshold.
			await harness.session.prompt("successful review turn");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) >= 1);
			expect(runtime?.getStatus()).toMatchObject({
				consecutiveReviewTimeouts: 0,
				paused: false,
				governorSkippedReviews: 2,
			});

			// A later isolated timeout restarts the streak at one and stays a handled skip, not a pause.
			await harness.session.prompt("timeout three");
			await waitFor(() => runtime?.getStatus().consecutiveReviewTimeouts === 1);
			expect(runtime?.getStatus().paused).toBe(false);
		} finally {
			for (const release of timeoutBarriers) release();
			await harness.dispose();
		}
	});

	it("pauses after three consecutive failed updates and warns once", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer 1" }] },
			{ content: [{ type: "text", text: "answer 2" }] },
			{ content: [{ type: "text", text: "answer 3" }] },
			{ content: [{ type: "text", text: "answer 4" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "failure one" },
			{ errorMessage: "failure two" },
			{ errorMessage: "failure three" },
			{ errorMessage: "failure four" },
			{ errorMessage: "failure five" },
			{ errorMessage: "failure six" },
		]);
		const warnings: string[] = [];
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					(warning) => warnings.push(warning),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first failure turn");
			await waitFor(() => runtime?.getStatus().failedReviews === 2);
			await harness.session.prompt("second failure turn");
			await waitFor(() => runtime?.getStatus().failedReviews === 4);
			await harness.session.prompt("third failure turn");
			await waitFor(() => runtime?.getStatus().failedReviews === 6);
			expect(runtime?.getStatus()).toMatchObject({
				paused: true,
				consecutiveFailures: 3,
				failedReviews: 6,
				retryAttempts: 3,
				warnings: 1,
			});
			expect(warnings).toHaveLength(1);
			await harness.session.prompt("turn after pause");
			expect(advisor.requests).toHaveLength(6);
		} finally {
			await harness.dispose();
		}
	});

	it("crossing the token soft cap pauses review and warns once", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer 1" }] },
			{ content: [{ type: "text", text: "answer 2" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [], usage: { input: 3, output: 2 } }]);
		const warnings: string[] = [];
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.sessionTokenSoftCap = 5;
					}),
					(value) => (runtime = value),
					(warning) => warnings.push(warning),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("cross token cap");
			await waitFor(() => runtime?.getStatus().paused === true);
			expect(runtime?.getStatus()).toMatchObject({
				pauseReason: "Advisor session token soft cap reached",
				warnings: 1,
			});
			expect(runtime?.getStatus().usage.total).toBe(5);
			expect(warnings).toHaveLength(1);
			await harness.session.prompt("after token cap");
			expect(advisor.requests).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("preserves an exhausted soft cap across branch invalidation and enable without reset", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ delayMs: 100, content: [], usage: { input: 3, output: 2 } },
		]);
		let runtime: AdvisorRuntime | undefined;
		let hostContext: ExtensionContext | undefined;
		const contextCapture: InlineExtension = {
			name: "capture-extension-context",
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					hostContext = ctx;
				});
			},
		};
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				contextCapture,
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.sessionTokenSoftCap = 5;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("cross cap before branch mismatch");
			await waitFor(() => advisor.activeRequests === 1);
			const firstEntry = harness.sessionManager.getBranch()[0];
			if (firstEntry === undefined) throw new Error("Expected a primary branch entry");
			harness.sessionManager.branch(firstEntry.id);
			await waitFor(
				() => runtime?.getStatus().paused === true && runtime.getStatus().branchResets === 1,
			);
			const exhausted = runtime?.getStatus();
			expect(exhausted?.pauseReason).toBe("Advisor session token soft cap reached");
			expect(exhausted?.usage.total).toBe(5);
			if (hostContext === undefined) throw new Error("Expected captured extension context");
			await runtime?.enable(hostContext, "session-command", false);
			const preserved = runtime?.getStatus();
			expect(preserved?.paused).toBe(true);
			expect(preserved?.usage.total).toBe(5);
			await harness.session.prompt("no paid review while exhausted");
			expect(advisor.requests).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("preserves advise-only delivery when the read-only tool budget is zero", async () => {
		const note = "Preserve internal advice when read-only inspection is disabled.";
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([acceptedAdvice(note, "advise-at-zero-budget")]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxToolCallsPerUpdate = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review without read-only tool calls");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				failedReviews: 0,
				consecutiveFailures: 0,
				governorSkippedReviews: 0,
				deferredNotesPending: 1,
			});
			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain(note);
		} finally {
			await harness.dispose();
		}
	});

	it("skips repeated tool-governed reviews without pausing or retrying later updates", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
			{ content: [{ type: "text", text: "later answer" }] },
		]);
		const governedRead = (id: string) => ({
			content: [{ type: "toolCall" as const, id, name: "read", arguments: { path: "README.md" } }],
			stopReason: "toolUse" as const,
		});
		const advisor = createAdvisorProvider(
			Array.from({ length: 12 }, (_, index) => governedRead(`read-over-limit-${String(index)}`)),
		);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxToolCallsPerUpdate = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			for (const [index, prompt] of [
				"first governed review",
				"second governed review",
				"third governed review",
			].entries()) {
				const requestsBeforeUpdate = advisor.requests.length;
				await harness.session.prompt(prompt);
				await waitFor(() => (runtime?.getStatus().governorSkippedReviews ?? 0) >= index + 1);
				expect(advisor.requests.length - requestsBeforeUpdate).toBeLessThanOrEqual(2);
			}

			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 0,
				consecutiveFailures: 0,
				governorSkippedReviews: 3,
				lastGovernorOutcome: "Advisor tool-call limit reached",
				retryAttempts: 0,
			});
			const requestsBeforeLaterUpdate = advisor.requests.length;
			await harness.session.prompt("review after repeated tool exhaustion");
			await waitFor(() => runtime?.getStatus().governorSkippedReviews === 4);
			expect(advisor.requests.length).toBeGreaterThan(requestsBeforeLaterUpdate);
			expect(advisor.requests.length - requestsBeforeLaterUpdate).toBeLessThanOrEqual(2);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 0,
				consecutiveFailures: 0,
				retryAttempts: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "tool-call",
			outcome: "Advisor tool-call limit reached" as const,
		},
		{
			label: "turn",
			outcome: "Advisor turn limit reached" as const,
		},
	])(
		"delivers accepted review advice once before handled $label governor exhaustion",
		async ({ label, outcome }) => {
			const note = `Verify accepted guidance survives the bounded ${label} governor.`;
			const advisorBarrier = createBarrier();
			const primary = createPrimaryProvider([
				{ content: [{ type: "text", text: "first answer" }] },
				{ content: [{ type: "text", text: "later answer" }] },
			]);
			const advisor = createAdvisorProvider([
				{
					...acceptedAdvice(note, `accepted-before-${label}-governor`),
					waitFor: advisorBarrier.promise,
				},
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
				await harness.session.prompt("accept advice before exhaustion");
				await waitFor(() => advisor.activeRequests === 1);
				if (runtime === undefined) throw new Error("Expected Advisor runtime");
				const activeRuntime = runtime;
				const currentRun = runtimeInternals(activeRuntime).currentRun;
				if (currentRun === undefined) throw new Error("Expected current Advisor run");
				currentRun.governorFailure = outcome;
				advisorBarrier.release();
				await waitFor(() => activeRuntime.getStatus().governorSkippedReviews === 1);
				expect(activeRuntime.getStatus()).toMatchObject({
					failedReviews: 0,
					consecutiveFailures: 0,
					deferredNotesPending: 1,
					lastGovernorOutcome: outcome,
				});
				expect(primary.requests).toHaveLength(1);
				await harness.session.prompt("materialize accepted advice");
				await waitFor(() => activeRuntime.getStatus().notesDelivered === 1);
				const deliveredContext = JSON.stringify(primary.requests[1]?.context);
				expect(deliveredContext).toContain(note);
				expect(deliveredContext.split(note)).toHaveLength(2);
			} finally {
				advisorBarrier.release();
				await harness.dispose();
			}
		},
	);

	it("clears an ordinary failure streak after handled tool governor exhaustion", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "ordinary provider failure one" },
			{ errorMessage: "ordinary provider failure two" },
			{
				content: [
					{
						type: "toolCall",
						id: "governed-streak-clear",
						name: "read",
						arguments: { path: "README.md" },
					},
				],
				stopReason: "toolUse",
			},
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxToolCallsPerUpdate = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("establish ordinary failure streak");
			await waitFor(() => runtime?.getStatus().failedReviews === 2);
			await waitFor(() => runtime?.getStatus().consecutiveFailures === 1);
			await harness.session.prompt("handle governor exhaustion");
			await waitFor(() => runtime?.getStatus().governorSkippedReviews === 1);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 2,
				consecutiveFailures: 0,
				retryAttempts: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("bounds coalesced pending transcript bytes", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "x".repeat(500) }] },
		]);
		const advisor = createAdvisorProvider([{ delayMs: 100, content: [] }, { content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxPendingTranscriptBytes = 80;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("start delayed review");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("coalesce a large update");
			await waitFor(
				() => runtime?.getStatus().reviewsCompleted === 1 && !runtime.getStatus().backlog,
			);
			expect(runtime?.getStatus().maxPendingTranscriptBytesObserved).toBeLessThanOrEqual(80);
			expect(JSON.stringify(advisor.requests.at(-1)?.context)).toContain("xxxxx");
		} finally {
			await harness.dispose();
		}
	});

	it("bounds coalesced successful-memory metadata and retains the newest entries", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxPendingTranscriptBytes = 100;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("initialize metadata bounds");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const internals = runtimeInternals(runtime);
			const oldMetadata = `old-${"o".repeat(20)}`;
			const sharedMetadata = `shared-${"s".repeat(17)}`;
			const newMetadata = `new-${"n".repeat(20)}`;
			const current = {
				text: "older transcript ".repeat(10),
				entryCount: 1,
				truncated: false,
				window: { expectedIndex: 1 },
				turnNumber: 1,
				successfulMemoryTexts: new Set([oldMetadata, sharedMetadata]),
			};
			const incoming = {
				text: "newest transcript ".repeat(10),
				entryCount: 1,
				truncated: false,
				window: { expectedIndex: 2 },
				turnNumber: 2,
				successfulMemoryTexts: new Set([sharedMetadata, newMetadata]),
			};
			const retained = internals.coalescePending(current, incoming);
			expect([...retained.successfulMemoryTexts]).toEqual([sharedMetadata, newMetadata]);
			internals.pendingUpdate = retained;
			internals.updateBacklogStatus();
			const retainedBytes =
				Buffer.byteLength(retained.text, "utf8") +
				[...retained.successfulMemoryTexts].reduce(
					(total, text) => total + Buffer.byteLength(text, "utf8"),
					0,
				);
			expect(runtime.getStatus()).toMatchObject({
				pendingTranscriptBytes: retainedBytes,
				maxPendingTranscriptBytesObserved: retainedBytes,
			});
			expect(retainedBytes).toBeLessThanOrEqual(100);
		} finally {
			await harness.dispose();
		}
	});

	it("skips repeated turn-governed reviews without pausing or retrying later updates", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
			{ content: [{ type: "text", text: "later answer" }] },
		]);
		const governedList = (id: string) => ({
			content: [{ type: "toolCall" as const, id, name: "ls", arguments: { path: "." } }],
			stopReason: "toolUse" as const,
		});
		const advisor = createAdvisorProvider([
			governedList("ls-at-turn-limit-1"),
			governedList("ls-at-turn-limit-2"),
			governedList("ls-at-turn-limit-3"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxAdvisorTurnsPerUpdate = 1;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			for (const [index, prompt] of [
				"first turn-governed review",
				"second turn-governed review",
				"third turn-governed review",
			].entries()) {
				await harness.session.prompt(prompt);
				await waitFor(() => (runtime?.getStatus().governorSkippedReviews ?? 0) >= index + 1);
			}

			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 0,
				consecutiveFailures: 0,
				governorSkippedReviews: 3,
				lastGovernorOutcome: "Advisor turn limit reached",
			});
			await harness.session.prompt("review after repeated turn exhaustion");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(advisor.requests).toHaveLength(4);
		} finally {
			await harness.dispose();
		}
	});

	it("drops an update without pausing when fresh private context cannot fit", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer" }] },
			{ content: [{ type: "text", text: "answer while paused" }] },
		]);
		const advisor = createAdvisorProvider([]);
		const warnings: string[] = [];
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.01;
						config.context.reserveTokens = advisor.model.contextWindow;
					}),
					(value) => (runtime = value),
					(message) => warnings.push(message),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("exhaust context policy");
			await waitFor(() => runtime?.getStatus().failedReviews === 1);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				compactionsCompleted: 0,
				compactionFailures: 1,
				contextReprimesCompleted: 1,
				contextReprimeFailures: 1,
				warnings: 1,
			});
			expect(runtime?.getStatus().lastFailure).toContain("context compaction failed");
			expect(warnings).toHaveLength(1);
			expect(advisor.requests).toHaveLength(0);

			await harness.session.prompt("continue while Advisor remains active");
			await waitFor(() => runtime?.getStatus().failedReviews === 2);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				compactionFailures: 2,
				contextReprimeFailures: 2,
				warnings: 2,
			});
			expect(warnings).toHaveLength(2);
			expect(advisor.requests).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});

	it("skips a review attempt that exceeds maxReviewAttemptMs", async () => {
		const barrier = createBarrier();
		const abortHang = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				...acceptedAdvice("This review must time out."),
				waitFor: barrier.promise,
				waitAfterAbort: abortHang.promise,
			},
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxReviewAttemptMs = 50;
						config.limits.maxLifecycleAbortMs = 50;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("start a review that will time out");
			await waitFor(() => advisor.activeRequests === 1);
			await waitFor(() => runtime?.getStatus().governorSkippedReviews === 1);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				lastGovernorOutcome: ADVISOR_REVIEW_TIMEOUT_FAILURE,
			});
			await harness.session.prompt("continue after timed-out review");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) >= 1);
		} finally {
			barrier.release();
			abortHang.release();
			await harness.dispose();
		}
	});

	it("crossing the cost soft cap pauses review when cost is reported", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([
			{ content: [], usage: { input: 1, output: 1, costUsd: 0.75 } },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.sessionCostSoftCapUsd = 0.5;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("cross cost cap");
			await waitFor(() => runtime?.getStatus().paused === true);
			expect(runtime?.getStatus()).toMatchObject({
				pauseReason: "Advisor session cost soft cap reached",
				warnings: 1,
			});
			expect(runtime?.getStatus().usage.costUsd).toBe(0.75);
		} finally {
			await harness.dispose();
		}
	});

	it("accepts at most one note from multiple valid advise calls in one update", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer" }] },
			{ content: [{ type: "text", text: "Executor response to one note" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				content: [
					{
						type: "toolCall",
						id: "first-advice",
						name: "advise",
						arguments: { note: "First material note." },
					},
					{
						type: "toolCall",
						id: "second-advice",
						name: "advise",
						arguments: { note: "Second material note." },
					},
				],
				stopReason: "toolUse",
			},
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
			await harness.session.prompt("request one note maximum");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0, notesSuppressed: 1 });
			if (primary.requests.length === 1) await harness.session.prompt("materialize one note");
			const primaryContext = JSON.stringify(primary.requests.at(-1)?.context);
			expect(primaryContext).toContain("First material note.");
			expect(primaryContext).not.toContain("Second material note.");
		} finally {
			await harness.dispose();
		}
	});

	it("treats an empty Advisor completion as successful silence without retry", async () => {
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "answer" }] }]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("allow empty silence");
			await waitFor(() => runtime?.getStatus().silentReviews === 1);
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus()).toMatchObject({ failedReviews: 0, notesDelivered: 0 });
		} finally {
			await harness.dispose();
		}
	});

	it("suppresses a normalized duplicate across Advisor updates", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first terminal answer" }] },
			{ content: [{ type: "text", text: "second terminal answer" }] },
			{ content: [{ type: "text", text: "third terminal answer" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Verify the rollback path!", "dedupe-1"),
			acceptedAdvice("  VERIFY the rollback path... ", "dedupe-2"),
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
			await harness.session.prompt("first reviewed turn");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("second reviewed turn");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				notesSuppressed: 1,
			});
			await harness.session.prompt("inspect duplicate outcome");
			const context = JSON.stringify(primary.requests.at(-1)?.context);
			expect(context.match(/Verify the rollback path/giu)).toHaveLength(1);
			expect(context).not.toContain("VERIFY the rollback path");
		} finally {
			await harness.dispose();
		}
	});

	it("suppresses the same normalized note when severity changes", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first terminal answer" }] },
			{ content: [{ type: "text", text: "second terminal answer" }] },
			{ content: [{ type: "text", text: "third terminal answer" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Verify the rollback path!", "severity-concern", "concern"),
			acceptedAdvice("VERIFY the rollback path...", "severity-blocker", "blocker"),
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
			await harness.session.prompt("first severity");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await harness.session.prompt("materialize concern and review again");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("inspect severity suppression");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				'severity=\\"concern\\" delivery=\\"deferred\\" stale=\\"false\\"',
			);
			expect(JSON.stringify(primary.requests[2]?.context)).not.toContain('severity=\\"blocker\\"');
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				notesSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("marks advice stale when materially newer Executor activity follows the reviewed window", async () => {
		const adviseStarted = createBarrier();
		const afterAdvise = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "newer answer" }] },
			{ content: [{ type: "text", text: "answer after stale advice" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Recheck the earlier assumption."),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					undefined,
					undefined,
					async () => {
						adviseStarted.release();
						await afterAdvise.promise;
					},
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			void harness.session.prompt("first turn starts review");
			await adviseStarted.promise;
			await harness.session.prompt("advance while review is running");
			expect(primary.requests).toHaveLength(2);
			afterAdvise.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "pnpm run typecheck",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			await harness.session.prompt("materialize stale advice");
			const context = JSON.stringify(primary.requests.at(-1)?.context);
			expect(context).toContain('stale=\\"true\\"');
			expect(context).toContain("Verify this still applies");
			const note = harness.sessionManager
				.getEntries()
				.find(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(note?.details).toMatchObject({ stale: true, delivery: "deferred" });
		} finally {
			afterAdvise.release();
			await harness.dispose();
		}
	});

	it("does not mark deferred advice stale when only the triggering user prompt follows", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "reviewed answer" }] },
			{ content: [{ type: "text", text: "answer after deferred advice" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Recheck this against the next user request."),
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
			await harness.session.prompt("create current deferred advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const branchBeforePrompt = harness.sessionManager.getBranch();
			const pendingAdvice = runtimeInternals(runtime).pendingAdvice;
			const queued = pendingAdvice.values()[0];
			expect(queued?.stale).toBe(false);
			expect(
				queued === undefined ? false : cursorMatches(branchBeforePrompt, queued.branchWindow),
			).toBe(true);

			await harness.session.prompt("materialize with only a user prompt");

			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain('severity=\\"concern\\" delivery=\\"deferred\\" stale=\\"false\\"');
			expect(context).not.toContain("Verify this still applies");
			const note = harness.sessionManager
				.getEntries()
				.find(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(note?.details).toMatchObject({ delivery: "deferred" });
			expect(note?.details).not.toHaveProperty("stale");
			expect(runtime.getStatus()).toMatchObject({
				notesDelivered: 1,
				deferredNotesPending: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it.each([
		{
			label: "only a user message",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "user",
					content: "buffered user shell activity",
					timestamp: Date.now(),
				}),
			stale: false,
		},
		{
			label: "a read-only grep call and result",
			append: (manager: SessionManager) => {
				manager.appendMessage(
					assistantToolCall([{ type: "toolCall", id: "grep-1", name: "grep", arguments: {} }]),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "grep-1",
					toolName: "grep",
					content: [{ type: "text", text: "no matches" }],
					isError: false,
					timestamp: Date.now(),
				});
			},
			stale: false,
		},
		{
			label: "a mutating edit call and result",
			append: (manager: SessionManager) => {
				manager.appendMessage(
					assistantToolCall([{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }]),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [{ type: "text", text: "updated" }],
					isError: false,
					timestamp: Date.now(),
				});
			},
			stale: true,
		},
		{
			label: "an unknown third-party tool call",
			append: (manager: SessionManager) =>
				manager.appendMessage(
					assistantToolCall([
						{ type: "toolCall", id: "custom-1", name: "some_tool", arguments: {} },
					]),
				),
			stale: true,
		},
		{
			label: "an included user bash execution",
			append: (manager: SessionManager) =>
				manager.appendMessage({
					role: "bashExecution",
					command: "pnpm run typecheck",
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: Date.now(),
				}),
			stale: true,
		},
	])("recomputes deferred staleness as $stale after $label", async ({ append, stale }) => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "reviewed answer" }] },
			{ content: [{ type: "text", text: "answer after buffered activity" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Recheck this after buffered branch activity."),
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
			await harness.session.prompt("create current deferred advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			append(harness.sessionManager);
			await harness.session.prompt("materialize after buffered activity");
			const context = JSON.stringify(primary.requests[1]?.context);
			expect(context).toContain(`stale=\\"${String(stale)}\\"`);
			if (stale) {
				expect(context).toContain("Verify this still applies");
			} else {
				expect(context).not.toContain("Verify this still applies");
			}
			const note = harness.sessionManager
				.getEntries()
				.find(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(note?.details).toMatchObject({ delivery: "deferred" });
			if (stale) {
				expect(note?.details).toMatchObject({ stale: true });
			} else {
				expect(note?.details).not.toHaveProperty("stale");
			}
		} finally {
			await harness.dispose();
		}
	});

	it("injects multiple deferred notes once in one bounded next-turn message", async () => {
		const adviseStarted = createBarrier();
		const afterAdvise = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "answer after deferred batch" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("First deferred issue.", "deferred-1"),
			acceptedAdvice("Second deferred issue.", "deferred-2", "nit"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					undefined,
					undefined,
					async () => {
						adviseStarted.release();
						await afterAdvise.promise;
					},
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			void harness.session.prompt("start first deferred review");
			await adviseStarted.promise;
			await harness.session.prompt("coalesce another reviewed turn");
			expect(primary.requests).toHaveLength(2);
			afterAdvise.release();
			await waitFor(() => (runtime?.getStatus().deferredNotesPending ?? 0) >= 2);
			await harness.session.prompt("materialize deferred batch");
			const context = JSON.stringify(primary.requests.at(-1)?.context);
			expect(context).toContain("First deferred issue.");
			expect(context).toContain("Second deferred issue.");
			const notes = harness.sessionManager
				.getEntries()
				.filter(
					(entry): entry is CustomMessageEntry =>
						entry.type === "custom_message" && entry.customType === "pi-advisor-note",
				);
			expect(notes).toHaveLength(1);
			expect(notes[0]?.details).toMatchObject({
				notes: [{ note: "First deferred issue." }, { note: "Second deferred issue." }],
			});
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 2,
				deferredNotesPending: 0,
			});
		} finally {
			afterAdvise.release();
			await harness.dispose();
		}
	});

	it("defers advice after any aborted Executor turn until the next user prompt", async () => {
		const advisorBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ delayMs: 10_000 },
			{ content: [{ type: "text", text: "answer after interruption" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				...acceptedAdvice("Inspect the interrupted work before continuing."),
				waitFor: advisorBarrier.promise,
			},
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
			await harness.session.prompt("start review before interruption");
			await waitFor(() => advisor.activeRequests === 1);
			const interrupted = harness.session.prompt("interrupt this Executor turn");
			await waitFor(() => primary.activeRequests === 1);
			await harness.session.abort();
			await interrupted;
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(2);
			expect(JSON.stringify(harness.sessionManager.buildSessionContext())).not.toContain(
				"Inspect the interrupted work before continuing.",
			);
			await harness.session.prompt("resume after interruption");
			const resumedContext = JSON.stringify(primary.requests[2]?.context);
			expect(resumedContext).toContain(
				'severity=\\"concern\\" delivery=\\"deferred\\" stale=\\"false\\"',
			);
			expect(resumedContext).not.toContain("Verify this still applies");
		} finally {
			advisorBarrier.release();
			await harness.dispose();
		}
	});

	it("defers advice after the abort signal before aborted turn_end handling", async () => {
		const advisorBarrier = createBarrier();
		const abortedTurnEndBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ delayMs: 10_000, waitAfterAbort: abortedTurnEndBarrier.promise },
			{ content: [{ type: "text", text: "answer after signal-first interruption" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				...acceptedAdvice("Keep this signal-first interruption advice deferred."),
				waitFor: advisorBarrier.promise,
			},
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
			await harness.session.prompt("start review before signal-first interruption");
			await waitFor(() => advisor.activeRequests === 1);
			const interrupted = harness.session.prompt("abort before turn_end can run");
			await waitFor(() => primary.activeRequests === 1);
			const aborting = harness.session.abort();
			await waitFor(() => primary.requests[1]?.options?.signal?.aborted === true);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.activeRequests).toBe(1);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0 });
			expect(JSON.stringify(harness.sessionManager.buildSessionContext())).not.toContain(
				"Keep this signal-first interruption advice deferred.",
			);
			abortedTurnEndBarrier.release();
			await Promise.all([aborting, interrupted]);
			await harness.session.prompt("resume after signal-first interruption");
			const context = JSON.stringify(primary.requests[2]?.context);
			expect(context.match(/Keep this signal-first interruption advice deferred\./gu)).toHaveLength(
				1,
			);
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				deferredNotesPending: 0,
			});
		} finally {
			advisorBarrier.release();
			abortedTurnEndBarrier.release();
			await harness.dispose();
		}
	});

	it("keeps an aborted turn's in-flight review deferred when the next turn starts first", async () => {
		const advisorBarrier = createBarrier();
		const nextTurnBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ delayMs: 10_000 },
			{
				waitFor: nextTurnBarrier.promise,
				content: [{ type: "text", text: "answer before late review" }],
			},
			{ content: [{ type: "text", text: "answer after deferred review" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				...acceptedAdvice("Preserve this interrupted review."),
				waitFor: advisorBarrier.promise,
			},
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
			await harness.session.prompt("start review before interruption");
			await waitFor(() => advisor.activeRequests === 1);
			const interrupted = harness.session.prompt("interrupt this Executor turn");
			await waitFor(() => primary.activeRequests === 1);
			await harness.session.abort();
			await interrupted;
			expect(advisor.activeRequests).toBe(1);
			const nextTurn = harness.session.prompt("start next turn before review finishes");
			await waitFor(() => primary.activeRequests === 1);
			expect(primary.requests).toHaveLength(3);
			advisorBarrier.release();
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(JSON.stringify(primary.requests[2]?.context)).not.toContain(
				"Preserve this interrupted review.",
			);
			nextTurnBarrier.release();
			await nextTurn;
			await harness.session.prompt("materialize interrupted review");
			expect(JSON.stringify(primary.requests[3]?.context)).toContain(
				"Preserve this interrupted review.",
			);
		} finally {
			advisorBarrier.release();
			nextTurnBarrier.release();
			await harness.dispose();
		}
	});

	it("clears deferred advice when the active branch changes", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "branch answer" }] },
			{ content: [{ type: "text", text: "alternate branch answer" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Advice for the abandoned branch only."),
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
			await harness.session.prompt("create advice on original branch");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			const firstEntry = harness.sessionManager.getBranch()[0];
			if (firstEntry === undefined) throw new Error("Expected original branch entry");
			await harness.session.navigateTree(firstEntry.id, { summarize: false });
			expect(runtime?.getStatus()).toMatchObject({
				branchResets: 1,
				deferredNotesPending: 0,
				notesDelivered: 0,
			});
			await harness.session.prompt("continue alternate branch");
			expect(JSON.stringify(primary.requests.at(-1)?.context)).not.toContain(
				"Advice for the abandoned branch only.",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("invalidates branch-local state when navigation returns to the observation cursor", async () => {
		const branchAdvice = "Do not leak this across explicit navigation.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "reviewed answer" }] },
			{ content: [{ type: "text", text: "answer after navigation" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice(branchAdvice, "cursor-matching-advice"),
			acceptedAdvice(branchAdvice, "advice-after-navigation"),
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
			await harness.session.prompt("create branch-local advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			const observedLeaf = harness.sessionManager.getBranch().at(-1);
			if (observedLeaf === undefined) throw new Error("Expected observed branch leaf");
			harness.sessionManager.appendMessage({
				role: "user",
				content: "temporary descendant",
				timestamp: Date.now(),
			});
			await harness.session.navigateTree(observedLeaf.id, { summarize: false });
			expect(runtime?.getStatus()).toMatchObject({
				branchResets: 1,
				deferredNotesPending: 0,
				notesDelivered: 0,
			});
			await harness.session.prompt("continue after explicit navigation");
			expect(JSON.stringify(primary.requests[1]?.context)).not.toContain(branchAdvice);
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus().notesSuppressed).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("invalidates deferred advice and dedupe on explicit forward navigation", async () => {
		const branchAdvice = "Revalidate the branch-local migration.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "original descendant answer" }] },
			{ content: [{ type: "text", text: "alternate descendant answer" }] },
			{ content: [{ type: "text", text: "continued original descendant" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [] },
			acceptedAdvice(branchAdvice, "alternate-branch-advice"),
			acceptedAdvice(branchAdvice, "original-branch-advice"),
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
			await harness.session.prompt("create original descendant");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const originalBranch = harness.sessionManager.getBranch();
			const ancestor = originalBranch[0];
			const originalLeaf = originalBranch.at(-1);
			if (ancestor === undefined || originalLeaf === undefined) {
				throw new Error("Expected original branch entries");
			}
			await harness.session.navigateTree(ancestor.id, { summarize: false });
			await harness.session.prompt("create alternate descendant advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);

			await harness.session.navigateTree(originalLeaf.id, { summarize: false });
			expect(runtime?.getStatus()).toMatchObject({
				branchResets: 2,
				deferredNotesPending: 0,
				notesDelivered: 0,
			});
			await harness.session.prompt("continue original descendant");
			expect(JSON.stringify(primary.requests[2]?.context)).not.toContain(branchAdvice);
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus().notesSuppressed).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it.each(["nit", "blocker"] as const)(
		"delivers an active %s at the same steering boundary",
		async (severity) => {
			const executorBarrier = createBarrier();
			const primary = createPrimaryProvider([
				{
					content: [{ type: "toolCall", id: `hold-${severity}`, name: "hold", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					waitFor: executorBarrier.promise,
					content: [{ type: "text", text: "Executor continued" }],
				},
				{ content: [{ type: "text", text: "Executor weighed guidance" }] },
			]);
			const advisor = createAdvisorProvider([
				acceptedAdvice(`Active ${severity} guidance.`, `active-${severity}`, severity),
				{ content: [] },
			]);
			const hold = defineTool({
				name: "hold",
				label: "hold",
				description: "Create a deterministic active Executor boundary.",
				parameters: Type.Object({}),
				execute: () =>
					Promise.resolve({ content: [{ type: "text" as const, text: "held" }], details: {} }),
			});
			let runtime: AdvisorRuntime | undefined;
			const harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
				customTools: [hold],
				tools: ["hold"],
				mode: "rpc",
			});
			try {
				const prompt = harness.session.prompt(`start active ${severity}`);
				await waitFor(
					() => primary.requests.length === 2 && runtime?.getStatus().activeNotesPending === 1,
				);
				executorBarrier.release();
				await prompt;
				expect(primary.requests).toHaveLength(3);
				expect(runtime?.getStatus()).toMatchObject({
					activeNotesPending: 0,
					notesDelivered: 1,
				});
				expect(JSON.stringify(primary.requests[2]?.context)).toContain(
					`severity=\\"${severity}\\" delivery=\\"active\\" stale=\\"false\\"`,
				);
			} finally {
				executorBarrier.release();
				await harness.dispose();
			}
		},
	);

	it("delivers a deferred blocker without triggering a completion", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next user answer" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Do not ship the invalid migration.", "late-blocker", "blocker"),
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
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("finish terminal answer");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(primary.requests).toHaveLength(1);
			await harness.session.prompt("next user-driven turn");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				'severity=\\"blocker\\" delivery=\\"deferred\\" stale=\\"false\\"',
			);
		} finally {
			await harness.dispose();
		}
	});

	it("disposes nested resources on shutdown", async () => {
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(runtime?.getNestedMessageCount()).toBe(0);
			await runtime?.shutdown();
			expect(runtime?.getStatus()).toMatchObject({ enabled: false, active: false });
			expect(runtime?.getNestedMessageCount()).toBe(0);
		} finally {
			await harness.dispose();
		}
	});
});
