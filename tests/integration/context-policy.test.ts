import {
	defineTool,
	SessionManager,
	type ExtensionContext,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_TRANSCRIPT_ENTRY_TYPE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	type AdvisorConfig,
	type AdvisorRuntime,
	type AdvisorRuntimeHooks,
} from "../../src/index.js";
import { isRecordValue } from "../../src/value-guards.js";
import { runtimeInternals } from "../fixtures/runtime-internals.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	ADVISOR_SCRIPTED_API,
	createPrimaryProvider,
	ScriptedProvider,
	type ScriptedResponse,
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
): InlineExtension {
	const hooks: AdvisorRuntimeHooks & { onRuntime(runtime: AdvisorRuntime): void } = { onRuntime };
	if (onWarning !== undefined) hooks.onWarning = onWarning;
	return {
		name: "pi-advisor-context-policy-test",
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

function scriptedAssistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "pi-advisor-scripted",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function acceptedAdvice(note: string): ScriptedResponse {
	return {
		content: [
			{
				type: "toolCall",
				id: "context-policy-advice",
				name: "advise",
				arguments: { note, severity: "concern", intent: "review" },
			},
		],
		stopReason: "toolUse",
	};
}

describe.sequential("Token-aware Advisor context through Slice 4B", () => {
	it("coalesces skipped turns until the configured ordinary review turn cadence is eligible", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "EXECUTOR-ONE" }] },
			{ content: [{ type: "text", text: "EXECUTOR-TWO" }] },
			{ content: [{ type: "text", text: "EXECUTOR-THREE" }] },
			{ content: [{ type: "text", text: "EXECUTOR-FOUR" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.minTurnsBetweenReviews = 3;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("turn one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("turn two");
			await harness.session.prompt("turn three");
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus().backlog).toBe(true);

			await harness.session.prompt("turn four");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			const coalesced = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(coalesced).toContain("EXECUTOR-TWO");
			expect(coalesced).toContain("EXECUTOR-THREE");
			expect(coalesced).toContain("EXECUTOR-FOUR");
			expect(runtime?.getStatus().pendingTranscriptBytes).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("redacts and per-result bounds a large Executor tool result before Advisor submission", async () => {
		const primary = createPrimaryProvider([
			{
				content: [{ type: "toolCall", id: "large-output", name: "large_output", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Executor handled the large result." }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }, { content: [] }],
		});
		const largeOutput = defineTool({
			name: "large_output",
			label: "large output",
			description: "Return deterministic oversized output.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({
					content: [
						{
							type: "text" as const,
							text: `API_KEY=large-tool-secret\n${Array.from(
								{ length: 2_100 },
								(_, index) => `tool-line-${String(index)}-${"x".repeat(30)}`,
							).join("\n")}`,
						},
					],
					details: {},
				}),
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [largeOutput],
			tools: ["large_output"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("produce a large tool result");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) >= 1);
			const submitted = JSON.stringify(advisor.requests[0]?.context.messages);
			expect(submitted).toContain("[Tool result truncated to per-result limit]");
			expect(submitted).toContain("[REDACTED]");
			expect(submitted).not.toContain("large-tool-secret");
			expect(Buffer.byteLength(submitted, "utf8")).toBeLessThan(100_000);
		} finally {
			await harness.dispose();
		}
	});

	it("flushes the final bounded update when elapsed-time cadence becomes eligible", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "INTERVAL-ONE" }] },
			{ content: [{ type: "text", text: "INTERVAL-TWO" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.minIntervalMs = 500;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("interval one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("interval two");
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus().backlog).toBe(true);

			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			const finalReview = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(finalReview).toContain("INTERVAL-TWO");
			expect(runtime?.getStatus().pendingTranscriptBytes).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("re-evaluates a held elapsed-time update after an explicit budget reset", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "RESET-INTERVAL-ONE" }] },
			{ content: [{ type: "text", text: "RESET-INTERVAL-TWO" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }],
		});
		let runtime: AdvisorRuntime | undefined;
		let hostContext: ExtensionContext | undefined;
		const contextCapture: InlineExtension = {
			name: "capture-context-for-budget-reset",
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
						config.limits.minIntervalMs = 500;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("interval before budget reset");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("held interval before budget reset");
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus().backlog).toBe(true);
			if (runtime === undefined || hostContext === undefined) {
				throw new Error("Expected Advisor runtime and captured extension context");
			}

			await runtime.enable(hostContext, "session-command", true);
			await expect
				.poll(() => runtime?.getStatus().reviewsCompleted, { timeout: 250, interval: 10 })
				.toBe(2);
			const resetReview = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(resetReview).toContain("RESET-INTERVAL-TWO");
			expect(runtime.getStatus().pendingTranscriptBytes).toBe(0);

			await new Promise<void>((resolve) => setTimeout(resolve, 600));
			expect(advisor.requests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});

	it("retains a held elapsed-time update until inactive runtime activation completes", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "INACTIVE-INTERVAL-ONE" }] },
			{ content: [{ type: "text", text: "INACTIVE-INTERVAL-TWO" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }],
		});
		let runtime: AdvisorRuntime | undefined;
		let hostContext: ExtensionContext | undefined;
		const contextCapture: InlineExtension = {
			name: "capture-context-for-inactive-budget-reset",
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
						config.limits.minIntervalMs = 500;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("interval before inactive budget reset");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("held interval before inactive budget reset");
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus().backlog).toBe(true);
			if (runtime === undefined || hostContext === undefined) {
				throw new Error("Expected Advisor runtime and captured extension context");
			}

			const internals = runtimeInternals(runtime);
			internals.status.active = false;
			await runtime.enable(hostContext, "session-command", true);

			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			const resetReview = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(resetReview).toContain("INACTIVE-INTERVAL-TWO");
			expect(runtime.getStatus().active).toBe(true);
			expect(runtime.getStatus().pendingTranscriptBytes).toBe(0);
			expect(internals.cadenceTimer).toBeUndefined();
			expect(advisor.requests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});

	it("cancels an elapsed-time cadence flush when Advisor is disabled", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "CANCEL-INTERVAL-ONE" }] },
			{ content: [{ type: "text", text: "CANCEL-INTERVAL-TWO" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted",
			api: ADVISOR_SCRIPTED_API,
			responses: [{ content: [] }, { content: [] }],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.minIntervalMs = 500;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("interval one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("interval two");
			expect(runtime?.getStatus().backlog).toBe(true);
			await runtime?.disable();
			await new Promise<void>((resolve) => setTimeout(resolve, 600));
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus()).toMatchObject({ active: false, backlog: false });
		} finally {
			await harness.dispose();
		}
	});

	it("drops a stale update when the primary branch changes during nested compaction", async () => {
		const compactionBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ORIGINAL-BRANCH-CONTEXT" }] },
			{ content: [{ type: "text", text: "SECOND-PENDING-COMPACTION-UPDATE" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-pending-compaction",
			api: ADVISOR_SCRIPTED_API,
			contextWindow: 4_000,
			maxTokens: 512,
			responses: [
				{
					content: [{ type: "text", text: `private-before-compaction-${"x".repeat(5_000)}` }],
					usage: { input: 2_500, output: 500, costUsd: 0.03 },
				},
				{
					content: [{ type: "text", text: "bounded compaction summary" }],
					waitFor: compactionBarrier.promise,
				},
				{ content: [{ type: "text", text: "bounded suffix summary" }] },
				{ content: [] },
			],
		});
		const manager = SessionManager.inMemory();
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create original branch context");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("start update that requires compaction");
			await waitFor(() => advisor.requests.length >= 2 && advisor.activeRequests === 1);

			const originalUser = manager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (originalUser === undefined) throw new Error("Expected original user entry");
			manager.branch(originalUser.id);
			manager.appendMessage(scriptedAssistant("ALTERNATE-BRANCH-CONTEXT"));

			compactionBarrier.release();
			await waitFor(() => advisor.activeRequests === 0);
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			expect(runtime?.getStatus().reviewRequests).toBe(1);
			expect(
				advisor.requests.some((request) =>
					JSON.stringify(request.context.messages).includes("SECOND-PENDING-COMPACTION-UPDATE"),
				),
			).toBe(false);
		} finally {
			compactionBarrier.release();
			await harness.dispose();
		}
	});

	it("does not wait forever for nested compaction that exceeds maxNestedCompactionMs", async () => {
		const compactionBarrier = createBarrier();
		const abortHang = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ORIGINAL-BRANCH-CONTEXT" }] },
			{ content: [{ type: "text", text: "SECOND-PENDING-COMPACTION-UPDATE" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-compaction-timeout",
			api: ADVISOR_SCRIPTED_API,
			contextWindow: 4_000,
			maxTokens: 512,
			responses: [
				{
					content: [{ type: "text", text: `private-before-compaction-${"x".repeat(5_000)}` }],
					usage: { input: 2_500, output: 500, costUsd: 0.03 },
				},
				{
					content: [{ type: "text", text: "bounded compaction summary" }],
					waitFor: compactionBarrier.promise,
					waitAfterAbort: abortHang.promise,
				},
				{ content: [] },
			],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
						config.limits.maxNestedCompactionMs = 50;
						config.limits.maxLifecycleAbortMs = 50;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create original branch context");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const started = Date.now();
			await harness.session.prompt("start update that requires compaction");
			await waitFor(() => (runtime?.getStatus().compactionFailures ?? 0) >= 1);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
			});
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) >= 2);
		} finally {
			compactionBarrier.release();
			abortHang.release();
			await harness.dispose();
		}
	});

	it("compacts through AgentSession and preserves a planted requirement for later review", async () => {
		const violationAdvice = "The Executor violated MUST-RUN-LONG-CONTEXT-CHECK.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "Establish MUST-RUN-LONG-CONTEXT-CHECK." }] },
			{ content: [{ type: "text", text: "Continue while preserving the requirement." }] },
			{ content: [{ type: "text", text: "VIOLATION: skipped the required long-context check." }] },
			{ content: [{ type: "text", text: "Executor weighs the compacted-context finding." }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-small-context",
			api: ADVISOR_SCRIPTED_API,
			contextWindow: 4_000,
			maxTokens: 512,
			responses: [
				{ content: [{ type: "text", text: `private-one-${"a".repeat(5_000)}` }] },
				{ content: [{ type: "text", text: `private-two-${"b".repeat(5_000)}` }] },
				{
					content: [
						{
							type: "text",
							text: "## Context for Suffix\n- Preserve MUST-RUN-LONG-CONTEXT-CHECK before completion.",
						},
					],
				},
				acceptedAdvice(violationAdvice),
				{ content: [] },
			],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("establish requirement");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("continue task");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("violate requirement");
			await waitFor(
				() =>
					runtime?.getStatus().reviewsCompleted === 3 &&
					runtime.getStatus().compactionsCompleted === 1,
			);

			const reviewRequests = advisor.requests.filter((request) =>
				request.context.systemPrompt?.includes("You are Advisor"),
			);
			expect(reviewRequests).toHaveLength(3);
			const compactedReview = JSON.stringify(reviewRequests[2]?.context.messages);
			expect(compactedReview).toContain("MUST-RUN-LONG-CONTEXT-CHECK");
			expect(compactedReview).toContain("VIOLATION: skipped the required long-context check");
			expect(runtime?.getStatus()).toMatchObject({
				paused: false,
				contextEstimateSource: "estimate-only",
				contextUsageTokens: 0,
				compactionsCompleted: 1,
				compactionFailures: 0,
			});
			expect(runtime?.getStatus().contextEstimateTokens).toBeLessThanOrEqual(
				runtime?.getStatus().contextLimitTokens ?? 0,
			);

			await harness.session.prompt("weigh finding");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);
			const primaryAfterAdvice = JSON.stringify(primary.requests[3]?.context.messages);
			expect(primaryAfterAdvice).toContain(violationAdvice);
			expect(primaryAfterAdvice).not.toContain("private-one-");
			expect(primaryAfterAdvice).not.toContain("private-two-");
			expect(primaryAfterAdvice).not.toContain("## Constraints & Preferences");
		} finally {
			await harness.dispose();
		}
	});

	it("clears private context after compaction failure without replaying the primary branch", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "REPRIME-REQUIREMENT must survive." }] },
			{ content: [{ type: "text", text: "SECOND-LONG-SESSION-UPDATE" }] },
			{ content: [{ type: "text", text: "THIRD-LONG-SESSION-UPDATE" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-reprime",
			api: ADVISOR_SCRIPTED_API,
			contextWindow: 4_000,
			maxTokens: 512,
			responses: [
				{
					content: [{ type: "text", text: `private-before-reprime-${"x".repeat(4_000)}` }],
					usage: { input: 2_500, output: 500, costUsd: 0.03 },
				},
				{ content: [], usage: { input: 2_500, output: 500, costUsd: 0.03 } },
				{ content: [], usage: { input: 100, output: 20, costUsd: 0.01 } },
			],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
						config.limits.maxReprimeTokens = 512;
						config.persistence.transcript = true;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("establish reprime requirement");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("continue long session");
			await waitFor(() => runtime?.getStatus().contextReprimesCompleted === 1);
			await harness.session.prompt("continue after first reprime");
			await waitFor(
				() =>
					runtime?.getStatus().contextReprimesCompleted === 2 &&
					runtime.getStatus().reviewsCompleted === 3,
			);

			expect(advisor.requests).toHaveLength(3);
			const recoveredReviews = [advisor.requests[1], advisor.requests[2]];
			expect(JSON.stringify(recoveredReviews[0]?.context.messages)).not.toContain(
				"REPRIME-REQUIREMENT",
			);
			expect(JSON.stringify(recoveredReviews[0]?.context.messages)).toContain(
				"SECOND-LONG-SESSION-UPDATE",
			);
			expect(JSON.stringify(recoveredReviews[1]?.context.messages)).not.toContain(
				"REPRIME-REQUIREMENT",
			);
			expect(JSON.stringify(recoveredReviews[1]?.context.messages)).toContain(
				"THIRD-LONG-SESSION-UPDATE",
			);
			expect(runtime?.getStatus()).toMatchObject({
				paused: false,
				compactionFailures: 2,
				compactionUsageUnavailable: 2,
				contextReprimesCompleted: 2,
				contextReprimeFailures: 0,
				reviewRequests: 3,
				reviewsCompleted: 3,
				failedReviews: 0,
				retryAttempts: 0,
			});
			expect(runtime?.getStatus().lastFailure).toBeUndefined();
			const failureRecords = harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE &&
						isRecordValue<{ kind?: unknown }>(entry.data) &&
						"kind" in entry.data &&
						entry.data.kind === "failure",
				);
			expect(failureRecords).toHaveLength(0);
			expect(runtime?.getStatus().usage).toMatchObject({
				input: 5_100,
				output: 1_020,
				total: 6_120,
			});
			expect(runtime?.getStatus().usage.costUsd).toBeCloseTo(0.07);
		} finally {
			await harness.dispose();
		}
	});

	it("retries one provider overflow against only the same fresh bounded update, then continues", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "FIRST-PRIVATE-CONTEXT" }] },
			{ content: [{ type: "text", text: "SECOND-OVERFLOW-UPDATE" }] },
			{ content: [{ type: "text", text: "THIRD-SMALLER-UPDATE" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-overflow-recovery",
			api: ADVISOR_SCRIPTED_API,
			responses: [
				{ content: [] },
				{ errorMessage: "context_length_exceeded: scripted accumulated overflow" },
				{ errorMessage: "context_length_exceeded: scripted fresh overflow" },
				{ content: [] },
			],
		});
		const warnings: string[] = [];
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor),
					(value) => (runtime = value),
					(message) => warnings.push(message),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("establish private context");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("overflow accumulated context");
			await waitFor(() => runtime?.getStatus().failedReviews === 1);

			expect(advisor.requests).toHaveLength(3);
			const accumulatedAttempt = JSON.stringify(advisor.requests[1]?.context.messages);
			const freshAttempt = JSON.stringify(advisor.requests[2]?.context.messages);
			expect(accumulatedAttempt).toContain("FIRST-PRIVATE-CONTEXT");
			expect(accumulatedAttempt).toContain("SECOND-OVERFLOW-UPDATE");
			expect(freshAttempt).not.toContain("FIRST-PRIVATE-CONTEXT");
			expect(freshAttempt).toContain("SECOND-OVERFLOW-UPDATE");
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 1,
				retryAttempts: 1,
				warnings: 1,
			});
			expect(warnings).toHaveLength(1);

			await harness.session.prompt("continue with smaller update");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(JSON.stringify(advisor.requests[3]?.context.messages)).toContain(
				"THIRD-SMALLER-UPDATE",
			);
			expect(runtime?.getStatus()).toMatchObject({ active: true, paused: false });
		} finally {
			await harness.dispose();
		}
	});

	it("keeps default-off caps active above legacy totals while dropping only an unfit update", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "CACHE-HEAVY-SEED" }] },
			{ content: [{ type: "text", text: `OVERSIZED-${"x".repeat(30_000)}` }] },
			{ content: [{ type: "text", text: "SMALL-AFTER-OVERSIZED" }] },
		]);
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-caps-off",
			api: ADVISOR_SCRIPTED_API,
			contextWindow: 4_000,
			maxTokens: 512,
			responses: [
				{
					content: [],
					usage: { input: 100, output: 20, cacheRead: 1_000_001, cacheWrite: 10, costUsd: 11 },
				},
				{ content: [{ type: "text", text: "bounded compaction summary" }] },
				{ content: [{ type: "text", text: "bounded suffix summary" }] },
				{ content: [] },
			],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("seed cache-heavy usage");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				sessionTokenSoftCap: "off",
				sessionCostSoftCapUsd: "off",
				usage: { costUsd: 11 },
			});
			expect(runtime?.getStatus().usage.total).toBeGreaterThan(1_000_000);

			await harness.session.prompt("submit oversized update");
			await waitFor(() => runtime?.getStatus().failedReviews === 1);
			expect(runtime?.getStatus()).toMatchObject({ active: true, paused: false, warnings: 1 });

			await harness.session.prompt("submit smaller update");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({ active: true, paused: false });
			expect(
				advisor.requests.some((request) =>
					JSON.stringify(request.context.messages).includes("SMALL-AFTER-OVERSIZED"),
				),
			).toBe(true);
		} finally {
			await harness.dispose();
		}
	});

	it("slims older thinking-bearing history instead of full-clearing on provider overflow", async () => {
		// Build advisor-side accumulated history with large thinking blocks from
		// multiple prior silent reviews. Each thinking reply reports a SMALL usage
		// input so the usage anchor makes the local estimate say "fits" while the
		// actual (scripted) provider overflows — the estimate-drift scenario that
		// the slim-before-clear retry branch exists for.
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "SEED-ONE" }] },
			{ content: [{ type: "text", text: "SEED-TWO" }] },
			{ content: [{ type: "text", text: "SEED-THREE" }] },
			{ content: [{ type: "text", text: "SEED-FOUR" }] },
			{ content: [{ type: "text", text: "SEED-FIVE" }] },
			{ content: [{ type: "text", text: "OVERFLOW-TURN" }] },
		]);
		const bigThinking = "reasoning-block ".repeat(400); // ~6KB thinking per turn
		const advisor = new ScriptedProvider({
			providerId: "pi-advisor-fixture-advisor",
			modelId: "advisor-scripted-slim-overflow",
			api: ADVISOR_SCRIPTED_API,
			responses: [
				// five silent reviews, each with a large thinking block and a small
				// usage anchor (the anchor is what keeps the local estimate low)
				...Array.from(
					{ length: 5 },
					() =>
						// SAFETY: scripted-provider fixture responses deliberately carry
						// a thinking+text assistant reply with a small usage anchor to
						// reproduce the estimate-drift scenario under test.
						({
							content: [
								{ type: "thinking", thinking: bigThinking },
								{ type: "text", text: "ok" },
							],
							usage: { input: 80, output: 20, costUsd: 0 },
						}) as ScriptedResponse,
				),
				// overflow on the accumulated (slimmable) history
				{
					errorMessage: "context_length_exceeded: scripted accumulated overflow",
				},
				// the retry succeeds after the history was slimmed (thinking stripped)
				{ content: [], usage: { input: 60, output: 10, costUsd: 0 } },
			],
		});
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.context.maxFraction = 0.65;
						config.context.reserveTokens = 300;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("seed turn 1");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 1);
			await harness.session.prompt("seed turn 2");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 2);
			await harness.session.prompt("seed turn 3");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 3);
			await harness.session.prompt("seed turn 4");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 4);
			await harness.session.prompt("seed turn 5");
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 5);

			await harness.session.prompt("overflow turn");
			// Overflow triggers the slim-retry (not a full clear). The review
			// completes after the retry, so failedReviews stays 0 and the
			// lossy-slim counter advances.
			await waitFor(() => (runtime?.getStatus().reviewsCompleted ?? 0) === 6);

			expect(runtime?.getStatus()).toMatchObject({
				active: true,
				paused: false,
				failedReviews: 0,
				retryAttempts: 1,
			});
			expect(runtime?.getStatus().nestedLossyCompressions ?? 0).toBeGreaterThanOrEqual(1);
			// The retried request (last one) kept ALL the older seed frames verbatim —
			// the decisive difference from a full clear, which would have left only
			// the OVERFLOW-TURN frame behind.
			const last = advisor.requests.at(-1);
			const retried = JSON.stringify(last?.context.messages ?? []);
			expect(retried).toContain("OVERFLOW-TURN");
			expect(retried).toContain("SEED-ONE");
			expect(retried).toContain("SEED-FIVE");
			// The history is a full slim, not a clear: thinking blocks are stripped
			// from the OLDEST seed assistants (beyond the keep-recent window of 4)
			// while the newest messages keep them verbatim. Walk the assistant
			// messages: the first one must be thinking-free, a later one carries
			// thinking (proving only the old portion was degraded).
			const parsed = last?.context.messages ?? [];
			const assistantWithThinking = parsed.findIndex(
				(message) =>
					message.role === "assistant" &&
					JSON.stringify(message.content).includes("reasoning-block"),
			);
			// at least one old assistant message lies BEFORE the first thinking-
			// carrying one, and that early assistant must be thinking-free
			expect(assistantWithThinking).toBeGreaterThan(0);
			const earlyAssistant = parsed
				.slice(0, assistantWithThinking)
				.find((message) => message.role === "assistant" && message.content.length > 0);
			expect(JSON.stringify(earlyAssistant?.content ?? [])).not.toContain("reasoning-block");
		} finally {
			await harness.dispose();
		}
	});
});
