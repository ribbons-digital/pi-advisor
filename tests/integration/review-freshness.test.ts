import {
	SessionManager,
	type CustomEntry,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	ADVISOR_RUNTIME_STATE_VERSION,
	ADVISOR_TRANSCRIPT_ENTRY_TYPE,
	createPiAdvisorExtension,
	cursorAtTail,
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
	onAdviseExecutionStart?: () => void | Promise<void>,
): InlineExtension {
	const hooks: AdvisorRuntimeHooks & { onRuntime(runtime: AdvisorRuntime): void } = { onRuntime };
	if (onAdviseExecutionStart !== undefined) hooks.onAdviseExecutionStart = onAdviseExecutionStart;
	return {
		name: "pi-advisor-review-freshness-test",
		factory: createPiAdvisorExtension({ config, hooks }),
	};
}

function createBarrier() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
}

function acceptedAdvice(note: string, id = "freshness-advice") {
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

function persistedState(
	manager: SessionManager,
	overrides: Partial<PersistedAdvisorRuntimeState> = {},
): PersistedAdvisorRuntimeState {
	return {
		version: ADVISOR_RUNTIME_STATE_VERSION,
		sessionId: manager.getSessionId(),
		savedAt: Date.now(),
		cursor: cursorAtTail(manager.getBranch()),
		activeDeliveries: [],
		deferredAdvice: [],
		dedupeHashes: [],
		memorySuggestions: {
			meaningfulTurnCount: 0,
			admittedCount: 0,
			deliveredCount: 0,
			sessionCapReached: false,
		},
		recentFindings: [],
		notesDelivered: 0,
		...overrides,
	};
}

function appendState(manager: SessionManager, state: PersistedAdvisorRuntimeState): void {
	manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, state);
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

function latestRuntimeState(manager: SessionManager): PersistedAdvisorRuntimeState | undefined {
	const latest = [...manager.getBranch()]
		.reverse()
		.find(
			(entry) => entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
		);
	return latest?.type === "custom" ? (latest.data as PersistedAdvisorRuntimeState) : undefined;
}

describe.sequential("Quality Slice Q4 review freshness and cost", () => {
	it("supersedes an in-flight review that has not started advise and coalesces the newer window", async () => {
		const firstReview = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "FIRST-WINDOW" }] },
			{ content: [{ type: "text", text: "NEWER-WINDOW" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [], waitFor: firstReview.promise, usage: { input: 2, output: 1 } },
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
			const firstTurn = harness.session.prompt("first review window");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("newer review window");
			await waitFor(
				() =>
					runtime !== undefined &&
					runtimeInternals(runtime).pendingUpdate?.text.includes("NEWER-WINDOW") === true,
			);
			firstReview.release();
			await firstTurn;
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(advisor.requests).toHaveLength(2);
			expect(JSON.stringify(advisor.requests[1]?.context.messages)).toContain("FIRST-WINDOW");
			expect(JSON.stringify(advisor.requests[1]?.context.messages)).toContain("NEWER-WINDOW");
			expect(runtime?.getStatus()).toMatchObject({
				reviewsSuperseded: 1,
				failedReviews: 0,
				restoredReplayCount: 0,
				poisonReviewDrops: 0,
				consecutiveFailures: 0,
				usage: { total: 3 },
			});
			const supersededStatus = runtime?.getStatus();
			if (supersededStatus === undefined) throw new Error("Expected Advisor runtime");
			expect(formatAdvisorStatus(supersededStatus)).toContain("1 superseded");
		} finally {
			firstReview.release();
			await harness.dispose();
		}
	});

	it("does not supersede an in-flight review after advise execution has started", async () => {
		const adviseStarted = createBarrier();
		const afterAdvise = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ADVISE-STARTED-WINDOW" }] },
			{ content: [{ type: "text", text: "LATER-WINDOW" }] },
		]);
		const advisor = createAdvisorProvider([
			acceptedAdvice("Keep this started advise note."),
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
			void harness.session.prompt("started advise window");
			await adviseStarted.promise;
			await harness.session.prompt("later review window");
			await waitFor(
				() =>
					runtime !== undefined &&
					runtimeInternals(runtime).pendingUpdate?.text.includes("LATER-WINDOW") === true,
			);
			afterAdvise.release();
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			expect(runtime?.getStatus()).toMatchObject({
				reviewsSuperseded: 0,
				failedReviews: 0,
			});
			expect(JSON.stringify(advisor.requests[0]?.context.messages)).toContain(
				"ADVISE-STARTED-WINDOW",
			);
			expect(JSON.stringify(advisor.requests[1]?.context.messages)).toContain("LATER-WINDOW");
		} finally {
			afterAdvise.release();
			await harness.dispose();
		}
	});

	it("holds a coalesced update when a session cap trips during supersession", async () => {
		const firstReview = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "CAP-FIRST-WINDOW" }] },
			{ content: [{ type: "text", text: "CAP-NEWER-WINDOW" }] },
			{ content: [{ type: "text", text: "AFTER-CAP-WINDOW" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [], waitFor: firstReview.promise, usage: { input: 5 } },
			{ content: [] },
		]);
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
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			const firstTurn = harness.session.prompt("first window before cap");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("newer window during in-flight review");
			await waitFor(
				() =>
					runtime !== undefined &&
					runtimeInternals(runtime).pendingUpdate?.text.includes("CAP-NEWER-WINDOW") === true,
			);
			firstReview.release();
			await firstTurn;
			await waitFor(() => runtime?.getStatus().paused === true);
			expect(runtime?.getStatus()).toMatchObject({
				pauseReason: "Advisor session token soft cap reached",
				reviewsSuperseded: 1,
				reviewsCompleted: 0,
			});
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const internals = runtimeInternals(runtime);
			expect(internals.pendingUpdate).toBeUndefined();
			expect(internals.throttledUpdate?.text).toContain("CAP-NEWER-WINDOW");
			expect(latestRuntimeState(harness.sessionManager)?.queuedReview?.text).toContain(
				"CAP-NEWER-WINDOW",
			);
			await harness.session.prompt("ignored after the cap");
			expect(advisor.requests).toHaveLength(1);
		} finally {
			firstReview.release();
			await harness.dispose();
		}
	});

	it("holds non-material turns until a later material turn joins them", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "CHAT-ONE" }] },
			{ content: [{ type: "text", text: "CHAT-TWO" }] },
			{ content: [{ type: "text", text: "MATERIAL-THREE" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.review.skipNonMaterialTurns = true;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("first conversational turn");
			await harness.session.prompt("second conversational turn");
			expect(advisor.requests).toHaveLength(0);
			expect(runtime?.getStatus().backlog).toBe(true);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const heldUpdate = runtimeInternals(runtime).throttledUpdate;
			if (heldUpdate === undefined) throw new Error("Expected a held Advisor update");
			expect(heldUpdate.heldForMaterialTurn).toBe(true);
			expect(latestRuntimeState(harness.sessionManager)?.queuedReview).toBeUndefined();

			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "pnpm run typecheck",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			await harness.session.prompt("please edit the file");
			await waitFor(
				() => runtime?.getStatus().reviewsCompleted === 1 || advisor.requests.length === 1,
			);
			const submitted = JSON.stringify(advisor.requests[0]?.context.messages);
			expect(submitted).toContain("CHAT-ONE");
			expect(submitted).toContain("CHAT-TWO");
			expect(submitted).toContain("edit");
			expect(runtime.getStatus().pendingTranscriptBytes).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("does not let the elapsed-time cadence timer submit a held-for-material-turn update", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "HELD-CHAT" }] },
			{ content: [{ type: "text", text: "STILL-HELD-CHAT" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.review.skipNonMaterialTurns = true;
						config.limits.minTurnsBetweenReviews = 1;
						config.limits.minIntervalMs = 20;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("held conversational turn");
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(advisor.requests).toHaveLength(0);
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			expect(runtimeInternals(runtime).throttledUpdate?.heldForMaterialTurn).toBe(true);
			await harness.session.prompt("still conversational");
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(advisor.requests).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});

	it("widens adaptive cadence after silent reviews and resets after an accepted note", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "SILENT-ONE" }] },
			{ content: [{ type: "text", text: "SILENT-TWO" }] },
			{ content: [{ type: "text", text: "SILENT-THREE" }] },
			{ content: [{ type: "text", text: "HELD-AFTER-BACKOFF" }] },
			{ content: [{ type: "text", text: "SUBMIT-AFTER-BACKOFF" }] },
			{ content: [{ type: "text", text: "RESET-NOTE-TURN" }] },
			{ content: [{ type: "text", text: "RESET-NOTE-JOIN" }] },
			{ content: [{ type: "text", text: "AFTER-RESET" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [] },
			{ content: [] },
			{ content: [] },
			{ content: [] },
			acceptedAdvice("Reset cadence after this accepted note."),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.review.adaptiveCadence.enabled = true;
						config.review.adaptiveCadence.silentReviewsBeforeBackOff = 3;
						config.review.adaptiveCadence.backOffTurnStep = 1;
						config.review.adaptiveCadence.maxMinTurnsBetweenReviews = 4;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("silent one");
			await waitFor(() => runtime?.getStatus().silentReviews === 1);
			await harness.session.prompt("silent two");
			await waitFor(() => runtime?.getStatus().silentReviews === 2);
			await harness.session.prompt("silent three");
			await waitFor(() => runtime?.getStatus().silentReviews === 3);
			expect(runtime?.getStatus().effectiveMinTurnsBetweenReviews).toBe(2);
			const cadenceStatus = runtime?.getStatus();
			if (cadenceStatus === undefined) throw new Error("Expected Advisor runtime");
			expect(formatAdvisorStatus(cadenceStatus)).toContain(
				"Review cadence: every 2 meaningful turns",
			);

			await harness.session.prompt("held after back-off");
			expect(advisor.requests).toHaveLength(3);
			await harness.session.prompt("submit after back-off");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);
			expect(JSON.stringify(advisor.requests[3]?.context.messages)).toContain("HELD-AFTER-BACKOFF");
			expect(JSON.stringify(advisor.requests[3]?.context.messages)).toContain(
				"SUBMIT-AFTER-BACKOFF",
			);

			await harness.session.prompt("accepted note turn");
			expect(advisor.requests).toHaveLength(4);
			await harness.session.prompt("join accepted note under current cadence");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 5);
			expect(runtime?.getStatus().effectiveMinTurnsBetweenReviews).toBe(1);

			await harness.session.prompt("immediate after reset");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 6);
			expect(JSON.stringify(advisor.requests[5]?.context.messages)).toContain("AFTER-RESET");
		} finally {
			await harness.dispose();
		}
	});

	it("keeps restored pre-Q4 queuedReview cadence behavior and does not restore a held update", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "restored queued root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("PRE-Q4-QUEUED-REVIEW"));
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				queuedReview: {
					text: "[Executor assistant]\nPRE-Q4-QUEUED-REVIEW",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 2,
					successfulMemoryTexts: [],
				},
				lastReviewSubmittedTurn: 1,
				lastReviewSubmittedAt: 0,
				memorySuggestions: {
					meaningfulTurnCount: 2,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
			}),
		);
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "NEW-AFTER-RESTORED-QUEUE" }] },
		]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.minTurnsBetweenReviews = 2;
						config.limits.minIntervalMs = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(advisor.requests).toHaveLength(0);
			expect(runtime?.getStatus().restoredQueuedReviewPending).toBe(true);
			await harness.session.prompt("advance restored queued cadence");
			await waitFor(() => advisor.requests.length === 1);
			const context = JSON.stringify(advisor.requests[0]?.context);
			expect(context).toContain("PRE-Q4-QUEUED-REVIEW");
			expect(context).toContain("NEW-AFTER-RESTORED-QUEUE");
		} finally {
			await harness.dispose();
		}
	});

	it("replays a restored active review without incrementing reviewsSuperseded", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "replay root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("RESTORED-ACTIVE-REVIEW"));
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				memorySuggestions: {
					meaningfulTurnCount: 1,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
				activeReview: {
					text: "[Executor assistant]\nRESTORED-ACTIVE-REVIEW",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 1,
					successfulMemoryTexts: [],
					reviewId: "q4-restored-review",
					restoredReplayCount: 0,
				},
				lastReviewSubmittedTurn: 1,
				lastReviewSubmittedAt: Date.now(),
			}),
		);
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await waitFor(() => advisor.requests.length === 1);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				reviewsSuperseded: 0,
				restoredReplayCount: 1,
				poisonReviewDrops: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("does not supersede an in-flight review for held turns and joins them into the next material window", async () => {
		const firstReview = createBarrier();
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "MATERIAL-ONE" }] },
			{ content: [{ type: "text", text: "CHAT-HELD-ONE" }] },
			{ content: [{ type: "text", text: "CHAT-HELD-TWO" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [], waitFor: firstReview.promise },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.review.skipNonMaterialTurns = true;
						config.persistence.transcript = true;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "pnpm run typecheck",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			void harness.session.prompt("material first window");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.prompt("chat-only window while the review is in flight");
			await waitFor(
				() =>
					runtime !== undefined &&
					runtimeInternals(runtime).throttledUpdate?.heldForMaterialTurn === true,
			);
			expect(advisor.requests).toHaveLength(1);
			expect(runtime?.getStatus().reviewsSuperseded).toBe(0);
			harness.sessionManager.appendMessage({
				role: "bashExecution",
				command: "pnpm run build",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			await harness.session.prompt("material third window joins the held chat");
			await waitFor(() => advisor.requests.length === 2);
			firstReview.release();
			await waitFor(
				() => runtime?.getStatus().reviewsCompleted === 1 && !runtime.getStatus().backlog,
			);
			expect(runtime?.getStatus().reviewsSuperseded).toBe(1);
			const submitted = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(submitted).toContain("CHAT-HELD-ONE");
			expect(submitted).toContain("CHAT-HELD-TWO");
			expect(submitted).toContain("MATERIAL-ONE");
			const records = harness.sessionManager
				.getBranch()
				.filter(
					(entry): entry is CustomEntry =>
						entry.type === "custom" && entry.customType === ADVISOR_TRANSCRIPT_ENTRY_TYPE,
				)
				.map((entry) => entry.data as { kind?: string; outcome?: string });
			expect(
				records.some(
					(record) => record.kind === "review-outcome" && record.outcome === "superseded",
				),
			).toBe(true);
		} finally {
			firstReview.release();
			await harness.dispose();
		}
	});
});
