import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_ARGUMENT_VALIDATION_FAILURE,
	ADVISOR_RETRY_DELAY_MS,
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	createPiAdvisorExtension,
	DEFAULT_ADVISOR_CONFIG,
	formatAdvisorStatus,
	type AdvisorConfig,
	type AdvisorRuntime,
	type AdvisorRuntimeHooks,
	type PersistedAdvisorRuntimeState,
} from "../../src/index.js";
import { runtimeInternals } from "../fixtures/runtime-internals.js";
import { createSessionHarness } from "../fixtures/session-harness.js";
import {
	createAdvisorProvider,
	createPrimaryProvider,
	type ScriptedProvider,
} from "../fixtures/scripted-provider.js";

function configFor(provider: ScriptedProvider): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
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
		name: "pi-advisor-retry-resilience-test",
		factory: createPiAdvisorExtension({ config, hooks }),
	};
}

function acceptedAdvice(note: string, id = "retry-advice") {
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

describe.sequential("Slice 3B retry lifecycle resilience", () => {
	it("rolls back a failed provider turn, retries after a bounded delay, and resets recovery state", async () => {
		const note = "Retry only from clean Advisor context.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "executor answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "transient provider failure" },
			acceptedAdvice(note),
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
			await harness.session.prompt("trigger a retry");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);

			expect(advisor.requests).toHaveLength(2);
			const firstRequest = advisor.requests[0];
			const retryRequest = advisor.requests[1];
			if (firstRequest === undefined || retryRequest === undefined) {
				throw new Error("Expected initial and retry requests");
			}
			expect(retryRequest.startedAt - firstRequest.startedAt).toBeGreaterThanOrEqual(
				ADVISOR_RETRY_DELAY_MS - 25,
			);
			const retryContext = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(retryContext).not.toContain("transient provider failure");
			expect(retryContext.split("trigger a retry")).toHaveLength(2);
			expect(runtime?.getStatus()).toMatchObject({
				reviewsCompleted: 1,
				failedReviews: 1,
				consecutiveFailures: 0,
				retryAttempts: 1,
				retryPending: false,
				deferredNotesPending: 1,
			});
			expect(
				runtime?.getNestedMessages().filter((message) => message.role === "user"),
			).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	it("counts suppression only from the successful resolved retry attempt", async () => {
		const firstAttempt = createBarrier();
		const resolvedAttempt = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "executor answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "failure after suppression", waitFor: firstAttempt.promise },
			{ content: [], waitFor: resolvedAttempt.promise },
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
			await harness.session.prompt("retry after a suppressed call");
			await waitFor(() => advisor.requests.length === 1 && runtime !== undefined);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const collector = runtimeInternals(activeRuntime).collector;
			collector.suppressedCalls = 1;
			firstAttempt.release();
			await waitFor(() => advisor.requests.length === 2);
			collector.suppressedCalls = 1;
			resolvedAttempt.release();
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 1);

			expect(activeRuntime.getStatus()).toMatchObject({
				reviewRequests: 2,
				reviewsCompleted: 1,
				failedReviews: 1,
				retryAttempts: 1,
				notesSuppressed: 1,
			});
		} finally {
			firstAttempt.release();
			resolvedAttempt.release();
			await harness.dispose();
		}
	});

	it("does not count suppression from an update whose attempts all fail", async () => {
		const firstAttempt = createBarrier();
		const finalAttempt = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "executor answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "first failure after suppression", waitFor: firstAttempt.promise },
			{ errorMessage: "second failure after suppression", waitFor: finalAttempt.promise },
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
			await harness.session.prompt("fail every suppressed review attempt");
			await waitFor(() => advisor.requests.length === 1 && runtime !== undefined);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const collector = runtimeInternals(activeRuntime).collector;
			collector.suppressedCalls = 1;
			firstAttempt.release();
			await waitFor(() => advisor.requests.length === 2);
			collector.suppressedCalls = 1;
			finalAttempt.release();
			await waitFor(() => activeRuntime.getStatus().failedReviews === 2);

			expect(activeRuntime.getStatus()).toMatchObject({
				reviewRequests: 2,
				reviewsCompleted: 0,
				failedReviews: 2,
				consecutiveFailures: 1,
				retryAttempts: 1,
				notesSuppressed: 0,
			});
		} finally {
			firstAttempt.release();
			finalAttempt.release();
			await harness.dispose();
		}
	});

	it("counts failed updates only after retries are exhausted and warns once with the final cause", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
			{ content: [{ type: "text", text: "ignored after pause" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "failure one" },
			{ errorMessage: "failure two" },
			{ errorMessage: "failure three" },
			{ errorMessage: "failure four" },
			{ errorMessage: "failure five" },
			{ errorMessage: "failure six Bearer super-secret-token-value" },
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
					(message) => warnings.push(message),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first repeatedly failing update");
			await waitFor(() => runtime?.getStatus().failedReviews === 2);
			expect(runtime?.getStatus()).toMatchObject({ consecutiveFailures: 1, paused: false });
			await harness.session.prompt("second repeatedly failing update");
			await waitFor(() => runtime?.getStatus().failedReviews === 4);
			expect(runtime?.getStatus()).toMatchObject({ consecutiveFailures: 2, paused: false });
			await harness.session.prompt("third repeatedly failing update reaches pause");
			await waitFor(() => runtime?.getStatus().paused === true);

			expect(runtime?.getStatus()).toMatchObject({
				paused: true,
				consecutiveFailures: 3,
				failedReviews: 6,
				retryAttempts: 3,
				warnings: 1,
				lastFailure: "failure six Bearer [REDACTED]",
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Three consecutive Advisor updates failed");
			expect(warnings[0]).toContain("failure six Bearer [REDACTED]");
			expect(warnings[0]).not.toContain("super-secret-token-value");
			await harness.session.prompt("turn after pause");
			expect(advisor.requests).toHaveLength(6);
		} finally {
			await harness.dispose();
		}
	});

	it("pauses after three malformed advise updates with actionable model recovery guidance", async () => {
		const privateArgument = "MALFORMED-PRIVATE-SENTINEL";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third answer" }] },
		]);
		const advisor = createAdvisorProvider(
			["malformed-one", "malformed-two", "malformed-three"].flatMap((id) => [
				{
					content: [
						{
							type: "toolCall" as const,
							id,
							name: "advise",
							arguments: { privateArgument },
						},
					],
					stopReason: "toolUse" as const,
				},
				{ content: [] },
			]),
		);
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
			for (const [index, prompt] of [
				"first malformed",
				"second malformed",
				"third malformed",
			].entries()) {
				await harness.session.prompt(prompt);
				await waitFor(() => runtime?.getStatus().consecutiveFailures === index + 1);
			}
			expect(runtime?.getStatus()).toMatchObject({
				paused: true,
				consecutiveFailures: 3,
				failedReviews: 3,
				retryAttempts: 0,
				lastFailure: ADVISOR_ARGUMENT_VALIDATION_FAILURE,
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Three consecutive Advisor updates failed");
			expect(warnings[0]).toContain("/advisor configure");
			expect(warnings[0]).toContain("/advisor on");
			expect(warnings[0]).not.toContain(privateArgument);
		} finally {
			await harness.dispose();
		}
	});

	it("retains a queued update when the active review pauses after terminal failure", async () => {
		const finalFailure = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "second answer" }] },
			{ content: [{ type: "text", text: "third active answer" }] },
			{ content: [{ type: "text", text: "QUEUED-WHILE-FAILING" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "failure one" },
			{ errorMessage: "failure two" },
			{ errorMessage: "failure three" },
			{ errorMessage: "failure four" },
			{ errorMessage: "failure five" },
			{ errorMessage: "failure six", waitFor: finalFailure.promise },
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
			await harness.session.prompt("first repeatedly failing update");
			await waitFor(() => runtime?.getStatus().consecutiveFailures === 1);
			await harness.session.prompt("second repeatedly failing update");
			await waitFor(() => runtime?.getStatus().consecutiveFailures === 2);
			await harness.session.prompt("third active update reaches final failure");
			await waitFor(() => advisor.requests.length === 6 && advisor.activeRequests === 1);
			// Simulate advise-started immunity so the failing final attempt is not
			// superseded by the queued evidence: Q4 supersession only aborts attempts
			// that have not started advise.
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			runtimeInternals(activeRuntime).currentRun?.adviseExecutionStartedCallIds.add(
				"test-immunity",
			);
			await harness.session.prompt("queue evidence while the active review is failing");
			await waitFor(() =>
				Boolean(
					runtimeInternals(activeRuntime).pendingUpdate?.text.includes("QUEUED-WHILE-FAILING"),
				),
			);
			finalFailure.release();
			await waitFor(
				() => activeRuntime.getStatus().paused && !runtimeInternals(activeRuntime).draining,
			);
			const internals = runtimeInternals(activeRuntime);
			expect(internals.pendingUpdate).toBeUndefined();
			expect(internals.throttledUpdate).toBeDefined();

			const latest = harness.sessionManager
				.getBranch()
				.slice()
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (latest?.type !== "custom") throw new Error("Expected persisted runtime state");
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			const state = latest.data as PersistedAdvisorRuntimeState;
			expect(state.queuedReview?.text).toContain("QUEUED-WHILE-FAILING");
			expect(state.queuedReview?.turnNumber).toBe(4);
			expect(state.lastReviewSubmittedTurn).toBe(3);
			expect(internals.lastReviewSubmittedTurn).toBe(3);

			await harness.session.prompt("/advisor on");
			await waitFor(() => advisor.requests.length === 7);
			expect(JSON.stringify(advisor.requests[6]?.context.messages)).toContain(
				"QUEUED-WHILE-FAILING",
			);
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 1);
			expect(activeRuntime.getStatus()).toMatchObject({ paused: false, backlog: false });
		} finally {
			finalFailure.release();
			await harness.dispose();
		}
	});

	it("resumes a soft-cap-stranded active claim before newer evidence", async () => {
		const resumedReview = createBarrier();
		const newerReview = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "STRANDED-ACTIVE-EVIDENCE" }] },
			{ content: [{ type: "text", text: "NEWER-EVIDENCE-AFTER-UNPAUSE" }] },
		]);
		const advisor = createAdvisorProvider([
			{
				errorMessage: "retryable failure crossing the soft cap",
				usage: { input: 5 },
			},
			{ content: [], waitFor: resumedReview.promise },
			{ content: [], waitFor: newerReview.promise },
		]);
		const config = configFor(advisor);
		config.limits.sessionTokenSoftCap = 5;
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [extensionFor(config, (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create evidence whose review crosses the soft cap");
			await waitFor(
				() =>
					runtime !== undefined &&
					runtime.getStatus().paused &&
					!runtimeInternals(runtime).draining,
			);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const internals = runtimeInternals(activeRuntime);
			const stranded = internals.activeReview;
			if (stranded === undefined) throw new Error("Expected a stranded active review");
			expect(stranded.text).toContain("STRANDED-ACTIVE-EVIDENCE");
			expect(stranded.restoredReplayCount).toBe(0);

			await harness.session.prompt("/advisor on");
			await waitFor(() => advisor.requests.length >= 2);
			expect(JSON.stringify(advisor.requests[1]?.context.messages)).toContain(
				"STRANDED-ACTIVE-EVIDENCE",
			);
			expect(internals.activeReview?.reviewId).toBe(stranded.reviewId);

			await harness.session.prompt("queue newer evidence while the claimed review resumes");
			await waitFor(
				() => internals.pendingUpdate?.text.includes("NEWER-EVIDENCE-AFTER-UNPAUSE") === true,
			);
			expect(internals.activeReview?.reviewId).toBe(stranded.reviewId);
			const whileQueued = harness.sessionManager
				.getBranch()
				.slice()
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (whileQueued?.type !== "custom") throw new Error("Expected persisted runtime state");
			// SAFETY: this test fixture deliberately supplies the asserted boundary shape.
			const queuedState = whileQueued.data as PersistedAdvisorRuntimeState;
			expect(queuedState.activeReview?.reviewId).toBe(stranded.reviewId);
			expect(queuedState.queuedReview?.text).toContain("NEWER-EVIDENCE-AFTER-UNPAUSE");

			resumedReview.release();
			await waitFor(() =>
				advisor.requests.some((request) =>
					JSON.stringify(request.context.messages).includes("NEWER-EVIDENCE-AFTER-UNPAUSE"),
				),
			);
			const newerClaim = internals.activeReview;
			expect(newerClaim?.reviewId).not.toBe(stranded.reviewId);
			newerReview.release();
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted >= 1);
			expect(activeRuntime.getStatus()).toMatchObject({ paused: false, backlog: false });
			expect(internals.activeReview).toBeUndefined();
		} finally {
			resumedReview.release();
			newerReview.release();
			await harness.dispose();
		}
	});

	it("reports retry and queued transcript backlog while catch-up remains non-blocking", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first executor answer" }] },
			{ content: [{ type: "text", text: "SECOND-EXECUTOR-ANSWER" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "retryable provider failure" },
			{ content: [] },
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
			await harness.session.prompt("first update enters retry delay");
			await waitFor(() => runtime?.getStatus().retryPending === true);
			await harness.session.prompt("queue a newer update without blocking Executor");

			const pending = runtime?.getStatus();
			if (pending === undefined) throw new Error("Expected Advisor status");
			expect(pending).toMatchObject({ backlog: true, retryPending: true });
			expect(pending.pendingTranscriptBytes).toBeGreaterThan(0);
			expect(formatAdvisorStatus(pending)).toContain("retry pending");
			expect(formatAdvisorStatus(pending)).toContain("0 consecutive failed updates");

			await waitFor(
				() => runtime?.getStatus().reviewsCompleted === 2 && !runtime.getStatus().backlog,
			);
			expect(JSON.stringify(advisor.requests.at(-1)?.context.messages)).toContain(
				"SECOND-EXECUTOR-ANSWER",
			);
			expect(runtime?.getStatus().reviewsSuperseded).toBe(0);
			expect(runtime?.getStatus()).toMatchObject({
				backlog: false,
				retryPending: false,
				pendingTranscriptBytes: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("extracts stale nested queued output on reset and invalidates retry-delay continuation", async () => {
		const providerBarrier = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "executor answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ errorMessage: "enter retry delay" },
			{ ...acceptedAdvice("Never deliver after reset."), waitFor: providerBarrier.promise },
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
			await harness.session.prompt("start reset-sensitive retry");
			await waitFor(() => runtime?.getStatus().retryPending === true);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const internals = runtimeInternals(runtime);
			const nested = internals.session;
			if (nested === undefined) throw new Error("Expected nested Advisor session");
			await nested.steer("STALE-NESTED-QUEUED-OUTPUT");
			expect(nested.pendingMessageCount).toBe(1);
			const ctx = internals.hostContext;
			if (ctx === undefined) throw new Error("Expected Advisor host context");

			runtime.handleBranchChange(ctx);
			await new Promise((resolve) => setTimeout(resolve, 350));

			expect(advisor.requests).toHaveLength(1);
			expect(nested.pendingMessageCount).toBe(0);
			expect(runtime.getStatus()).toMatchObject({
				retryPending: false,
				staleQueuedMessagesDiscarded: 1,
				notesDelivered: 0,
				deferredNotesPending: 0,
			});
		} finally {
			providerBarrier.release();
			await harness.dispose();
		}
	});
});
