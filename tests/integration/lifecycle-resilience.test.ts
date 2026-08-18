import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	ADVISOR_RUNTIME_STATE_VERSION,
	adviceDedupeKey,
	createPiAdvisorExtension,
	cursorAtTail,
	DEFAULT_ADVISOR_CONFIG,
	formatAdvisorStatus,
	MAX_PERSISTED_DEDUPE_HASHES,
	type AcceptedAdvice,
	type AdvisorConfig,
	type AdvisorRuntime,
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
		name: "pi-advisor-lifecycle-resilience-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
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

function acceptedAdvice(note: string, id = "lifecycle-advice") {
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

function memorySuggestion(text: string, id = "lifecycle-memory") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: {
					note: "This verified project constraint remains useful in future sessions.",
					intent: "memory-suggestion",
					memory: { text, category: "project", basis: "project-constraint" },
				},
			},
		],
		stopReason: "toolUse" as const,
	};
}

function compatibleMemoryTool() {
	return defineTool({
		name: "memory_suggest",
		label: "memory_suggest",
		description: "Queue a pending memory suggestion.",
		parameters: Type.Object({
			text: Type.String(),
			category: Type.Optional(StringEnum(["preference", "project"] as const)),
			status: Type.Optional(StringEnum(["pending"] as const)),
		}),
		execute: () =>
			Promise.resolve({ content: [{ type: "text" as const, text: "Queued." }], details: {} }),
	});
}

function reviewAdvice(note: string, createdAt = Date.now()): AcceptedAdvice {
	return {
		intent: "review",
		note,
		severity: "concern",
		truncated: false,
		originalCharacters: Array.from(note).length,
		originalEstimatedTokens: Math.ceil(note.length / 4),
		createdAt,
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

describe.sequential("Slice 3A branch, compaction, and persistence lifecycle", () => {
	it("invalidates old advice after an equal-length branch switch without relying on a tree hint", async () => {
		const barrier = createBarrier();
		const oldNote = "This old-branch advice must never cross onto the alternate branch.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "original branch answer" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(oldNote), waitFor: barrier.promise },
		]);
		let runtime: AdvisorRuntime | undefined;
		const manager = SessionManager.inMemory();
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create the original branch");
			await waitFor(() => advisor.activeRequests === 1);
			const claimed = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect(
				claimed?.type === "custom"
					? (claimed.data as PersistedAdvisorRuntimeState).activeReview?.reviewId
					: undefined,
			).toBeTypeOf("string");
			const originalBranch = manager.getBranch();
			const userEntry = originalBranch.find(
				(entry) => entry.type === "message" && entry.message.role === "user",
			);
			if (userEntry === undefined) throw new Error("Expected original user entry");
			manager.branch(userEntry.id);
			manager.appendMessage(scriptedAssistant("equal-length alternate branch answer"));
			while (manager.getBranch().length < originalBranch.length) {
				manager.appendCustomEntry("equal-length-alternate-padding", {});
			}
			expect(manager.getBranch()).toHaveLength(originalBranch.length);

			barrier.release();
			await waitFor(() => advisor.activeRequests === 0);
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0, deferredNotesPending: 0 });
			expect(JSON.stringify(manager.buildSessionContext())).not.toContain(oldNote);
		} finally {
			barrier.release();
			await harness.dispose();
		}
	});

	it("eager compaction reset aborts an Advisor await and keeps the next review free of old context", async () => {
		const barrier = createBarrier();
		const invalidated = "Compaction must invalidate this old transcript result.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "OLD-TRANSCRIPT-VIEW" }] },
			{ content: [{ type: "text", text: "bounded compaction summary" }] },
			{ content: [{ type: "text", text: "NEW-TRANSCRIPT-VIEW" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(invalidated), waitFor: barrier.promise },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const manager = SessionManager.inMemory();
		for (let turn = 0; turn < 24; turn++) {
			manager.appendMessage({
				role: "user",
				content: `compaction-history-${String(turn)}-${"x".repeat(5_000)}`,
				timestamp: turn * 2,
			});
			manager.appendMessage(scriptedAssistant(`history-answer-${String(turn)}`));
		}
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("create context before compaction");
			await waitFor(() => advisor.activeRequests === 1);
			await harness.session.compact("use the scripted compacted view");
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			barrier.release();
			await waitFor(() => advisor.activeRequests === 0);
			await harness.session.prompt("continue only from the compacted branch");
			await waitFor(() => advisor.requests.length === 2);
			await waitFor(() => advisor.activeRequests === 0);
			const nextAdvisorContext = JSON.stringify(advisor.requests[1]?.context.messages);
			expect(nextAdvisorContext).toContain("NEW-TRANSCRIPT-VIEW");
			expect(nextAdvisorContext).not.toContain("OLD-TRANSCRIPT-VIEW");
			expect(nextAdvisorContext).not.toContain(invalidated);
			expect(runtime?.getStatus().notesDelivered).toBe(0);
		} finally {
			barrier.release();
			await harness.dispose();
		}
	});

	it("eager tree navigation reset invalidates an Advisor await", async () => {
		const barrier = createBarrier();
		const invalidated = "Tree navigation must invalidate this result.";
		const primary = createPrimaryProvider([{ content: [{ type: "text", text: "first answer" }] }]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(invalidated), waitFor: barrier.promise },
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
			await harness.session.prompt("start a review before tree navigation");
			await waitFor(() => advisor.activeRequests === 1);
			const target = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (target === undefined) throw new Error("Expected tree target");
			await harness.session.navigateTree(target.id, { summarize: false });
			await waitFor(() => runtime?.getStatus().branchResets === 1);
			barrier.release();
			await waitFor(() => advisor.activeRequests === 0);
			expect(runtime?.getStatus()).toMatchObject({ notesDelivered: 0, deferredNotesPending: 0 });
			expect(JSON.stringify(harness.sessionManager.buildSessionContext())).not.toContain(
				invalidated,
			);
		} finally {
			barrier.release();
			await harness.dispose();
		}
	});

	it("restores compatible deferred advice with age and a stale-after-resume warning", async () => {
		const note = "Restore this deferred review after the next user prompt.";
		const createdAt = Date.now() - 2 * 60 * 60 * 1_000;
		const advice = reviewAdvice(note, createdAt);
		const manager = SessionManager.inMemory();
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				deferredAdvice: [
					{
						advice,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
					},
				],
			}),
		);
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "handled restored advice" }] },
		]);
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
			if (runtime === undefined) throw new Error("Expected restored Advisor runtime");
			expect(runtime.getStatus()).toMatchObject({
				deferredNotesPending: 1,
				restoredDeferredNotesPending: 1,
			});
			expect(runtime.getStatus().oldestDeferredAdviceAgeMs).toBeGreaterThanOrEqual(
				2 * 60 * 60 * 1_000,
			);
			expect(formatAdvisorStatus(runtime.getStatus())).toContain("oldest deferred age");

			await harness.session.prompt("resume and weigh retained advice");
			const context = JSON.stringify(primary.requests[0]?.context);
			expect(context).toContain(note);
			expect(context).toContain('restored-after-resume=\\"true\\"');
			expect(context).toContain("restored after resume and may be stale");
			const delivered = manager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note");
			expect(delivered?.type === "custom_message" ? delivered.details : undefined).toMatchObject({
				restoredAfterResume: true,
				createdAt,
				stale: true,
			});
			expect(runtime.getStatus()).toMatchObject({
				deferredNotesPending: 0,
				restoredDeferredNotesPending: 0,
				notesDelivered: 1,
			});
			const latestState = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect(
				latestState?.type === "custom"
					? (latestState.data as PersistedAdvisorRuntimeState).deferredAdvice
					: undefined,
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("refreshes deferred-advice age on every status read", async () => {
		const now = 1_800_000_000_000;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		const manager = SessionManager.inMemory();
		const window = cursorAtTail(manager.getBranch());
		const advice = reviewAdvice("Report fresh deferred-advice age.", now - 1_000);
		appendState(
			manager,
			persistedState(manager, {
				deferredAdvice: [
					{
						advice,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
					},
				],
			}),
		);
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		let harness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		try {
			harness = await createSessionHarness({
				provider: primary,
				advisorProvider: advisor,
				sessionManager: manager,
				extensions: [extensionFor(configFor(advisor), (value) => (runtime = value))],
				tools: [],
				mode: "rpc",
			});
			expect(runtime?.getStatus().oldestDeferredAdviceAgeMs).toBe(1_000);
			vi.setSystemTime(now + 4_000);
			expect(runtime?.getStatus().oldestDeferredAdviceAgeMs).toBe(5_000);
		} finally {
			await harness?.dispose();
			vi.useRealTimers();
		}
	});

	it("restores lifecycle-only state after reopening a persisted Pi session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-advisor-resume-"));
		const project = join(root, "project");
		const sessions = join(root, "sessions");
		await mkdir(project, { recursive: true });
		await mkdir(sessions, { recursive: true });
		const note = "Restore this note from the reopened Pi session JSONL.";
		let firstHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		let secondHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		try {
			const firstManager = SessionManager.create(project, sessions);
			const firstPrimary = createPrimaryProvider([
				{ content: [{ type: "text", text: "answer before exit" }] },
			]);
			const firstAdvisor = createAdvisorProvider([
				{ ...acceptedAdvice(note, "persisted-resume-note"), delayMs: 25 },
			]);
			let firstRuntime: AdvisorRuntime | undefined;
			firstHarness = await createSessionHarness({
				provider: firstPrimary,
				advisorProvider: firstAdvisor,
				sessionManager: firstManager,
				extensions: [extensionFor(configFor(firstAdvisor), (value) => (firstRuntime = value))],
				tools: [],
				mode: "rpc",
			});
			await firstHarness.session.prompt("queue advice before process exit");
			await waitFor(() => firstRuntime?.getStatus().deferredNotesPending === 1);
			if (firstRuntime === undefined) throw new Error("Expected first persisted runtime");
			await firstRuntime.shutdown();
			const sessionFile = firstManager.getSessionFile();
			if (sessionFile === undefined) throw new Error("Expected persisted Pi session file");
			await firstHarness.dispose();
			firstHarness = undefined;

			const resumedManager = SessionManager.open(sessionFile, sessions, project);
			const resumedPrimary = createPrimaryProvider([
				{ content: [{ type: "text", text: "answer after resume" }] },
			]);
			const resumedAdvisor = createAdvisorProvider([{ content: [] }]);
			let resumedRuntime: AdvisorRuntime | undefined;
			secondHarness = await createSessionHarness({
				provider: resumedPrimary,
				advisorProvider: resumedAdvisor,
				sessionManager: resumedManager,
				extensions: [extensionFor(configFor(resumedAdvisor), (value) => (resumedRuntime = value))],
				tools: [],
				mode: "rpc",
			});
			expect(resumedRuntime?.getStatus()).toMatchObject({
				deferredNotesPending: 1,
				restoredDeferredNotesPending: 1,
			});
			await secondHarness.session.prompt("materialize advice after reopening the session");
			expect(JSON.stringify(resumedPrimary.requests[0]?.context)).toContain(note);
			expect(resumedRuntime?.getStatus()).toMatchObject({
				deferredNotesPending: 0,
				notesDelivered: 1,
			});
		} finally {
			await firstHarness?.dispose();
			await secondHarness?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reviews cadence-throttled Executor evidence after reopening the same session", async () => {
		const manager = SessionManager.inMemory();
		const firstPrimary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first completed answer" }] },
			{ content: [{ type: "text", text: "DURABLE-QUEUED-EVIDENCE" }] },
		]);
		const firstAdvisor = createAdvisorProvider([{ content: [] }]);
		let firstRuntime: AdvisorRuntime | undefined;
		let firstHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		let resumedHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		try {
			const cadenceConfig = configFor(firstAdvisor, (config) => {
				config.limits.minTurnsBetweenReviews = 0;
				config.limits.minIntervalMs = 250;
			});
			firstHarness = await createSessionHarness({
				provider: firstPrimary,
				advisorProvider: firstAdvisor,
				sessionManager: manager,
				extensions: [extensionFor(cadenceConfig, (value) => (firstRuntime = value))],
				tools: [],
				mode: "rpc",
			});
			await firstHarness.session.prompt("establish the cadence anchor");
			await waitFor(() => firstAdvisor.requests.length === 1);
			await firstHarness.session.prompt("retain this evidence across restart");
			await waitFor(() => {
				const latest = [...manager.getBranch()]
					.reverse()
					.find(
						(entry) =>
							entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
					);
				// SAFETY: the entry was filtered to the Advisor runtime custom type above.
				return (
					latest?.type === "custom" &&
					(latest.data as PersistedAdvisorRuntimeState).queuedReview?.text.includes(
						"DURABLE-QUEUED-EVIDENCE",
					) === true
				);
			});
			if (firstRuntime === undefined) throw new Error("Expected first restart runtime");
			await firstRuntime.shutdown();
			await firstHarness.dispose();
			firstHarness = undefined;

			const resumedPrimary = createPrimaryProvider([]);
			const resumedAdvisor = createAdvisorProvider([{ content: [] }]);
			let resumedRuntime: AdvisorRuntime | undefined;
			resumedHarness = await createSessionHarness({
				provider: resumedPrimary,
				advisorProvider: resumedAdvisor,
				sessionManager: manager,
				extensions: [
					extensionFor(
						configFor(resumedAdvisor, (config) => {
							config.limits.minTurnsBetweenReviews = 0;
							config.limits.minIntervalMs = 250;
						}),
						(value) => (resumedRuntime = value),
					),
				],
				tools: [],
				mode: "rpc",
			});
			expect(resumedRuntime?.getStatus().restoredQueuedReviewPending).toBe(true);
			await waitFor(() => resumedAdvisor.requests.length === 1);
			expect(JSON.stringify(resumedAdvisor.requests[0]?.context)).toContain(
				"DURABLE-QUEUED-EVIDENCE",
			);
			await waitFor(() => resumedRuntime?.getStatus().reviewsCompleted === 1);
			expect(resumedRuntime?.getStatus().restoredQueuedReviewPending).toBe(false);
		} finally {
			await firstHarness?.dispose();
			await resumedHarness?.dispose();
		}
	});

	it("restores later pending evidence that arrived while an active review was in flight", async () => {
		const barrier = createBarrier();
		const manager = SessionManager.inMemory();
		const firstPrimary = createPrimaryProvider([
			{ content: [{ type: "text", text: "ACTIVE-BEFORE-RESTART-EVIDENCE" }] },
			{ content: [{ type: "text", text: "PENDING-AFTER-ACTIVE-EVIDENCE" }] },
		]);
		const firstAdvisor = createAdvisorProvider([{ content: [], waitFor: barrier.promise }]);
		let firstRuntime: AdvisorRuntime | undefined;
		let firstHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		let resumedHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		try {
			firstHarness = await createSessionHarness({
				provider: firstPrimary,
				advisorProvider: firstAdvisor,
				sessionManager: manager,
				extensions: [
					extensionFor(
						configFor(firstAdvisor, (config) => {
							config.limits.minTurnsBetweenReviews = 0;
							config.limits.minIntervalMs = 0;
						}),
						(value) => (firstRuntime = value),
					),
				],
				tools: [],
				mode: "rpc",
			});
			await firstHarness.session.prompt("start active review before restart");
			await waitFor(() => firstAdvisor.activeRequests === 1);
			await firstHarness.session.prompt("queue later evidence while active");
			await waitFor(() => {
				const latest = [...manager.getBranch()]
					.reverse()
					.find(
						(entry) =>
							entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
					);
				if (latest?.type !== "custom") return false;
				// SAFETY: the entry was filtered to the Advisor runtime custom type above.
				const state = latest.data as PersistedAdvisorRuntimeState;
				return state.activeReview !== undefined && state.queuedReview !== undefined;
			});
			if (firstRuntime === undefined) throw new Error("Expected pending restart runtime");
			const shuttingDown = firstRuntime.shutdown();
			barrier.release();
			await shuttingDown;
			await firstHarness.dispose();
			firstHarness = undefined;

			const resumedPrimary = createPrimaryProvider([]);
			const resumedAdvisor = createAdvisorProvider([{ content: [] }, { content: [] }]);
			resumedHarness = await createSessionHarness({
				provider: resumedPrimary,
				advisorProvider: resumedAdvisor,
				sessionManager: manager,
				extensions: [
					extensionFor(
						configFor(resumedAdvisor, (config) => {
							config.limits.minTurnsBetweenReviews = 0;
							config.limits.minIntervalMs = 0;
						}),
						() => undefined,
					),
				],
				tools: [],
				mode: "rpc",
			});
			await waitFor(() => resumedAdvisor.requests.length === 2);
			expect(JSON.stringify(resumedAdvisor.requests[0]?.context)).toContain(
				"ACTIVE-BEFORE-RESTART-EVIDENCE",
			);
			expect(JSON.stringify(resumedAdvisor.requests[1]?.context)).toContain(
				"PENDING-AFTER-ACTIVE-EVIDENCE",
			);
		} finally {
			barrier.release();
			await firstHarness?.dispose();
			await resumedHarness?.dispose();
		}
	});

	it("preserves restored meaningful-turn cadence until enough new evidence arrives", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "cadence root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("RESTORED-TURN-CADENCE-EVIDENCE"));
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				queuedReview: {
					text: "[Executor assistant]\nRESTORED-TURN-CADENCE-EVIDENCE",
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
			{ content: [{ type: "text", text: "NEW-TURN-CADENCE-EVIDENCE" }] },
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
			await harness.session.prompt("advance restored turn cadence");
			await waitFor(() => advisor.requests.length === 1);
			const context = JSON.stringify(advisor.requests[0]?.context);
			expect(context).toContain("RESTORED-TURN-CADENCE-EVIDENCE");
			expect(context).toContain("NEW-TURN-CADENCE-EVIDENCE");
		} finally {
			await harness.dispose();
		}
	});

	it("preserves restored elapsed-time cadence until its timer becomes eligible", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "elapsed cadence root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("RESTORED-ELAPSED-CADENCE-EVIDENCE"));
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				queuedReview: {
					text: "[Executor assistant]\nRESTORED-ELAPSED-CADENCE-EVIDENCE",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 2,
					successfulMemoryTexts: [],
				},
				lastReviewSubmittedTurn: 1,
				lastReviewSubmittedAt: Date.now(),
				memorySuggestions: {
					meaningfulTurnCount: 2,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
			}),
		);
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([{ content: [] }]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.minTurnsBetweenReviews = 0;
						config.limits.minIntervalMs = 500;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			expect(advisor.requests).toHaveLength(0);
			expect(runtime?.getStatus().restoredQueuedReviewPending).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(advisor.requests).toHaveLength(0);
			await waitFor(() => advisor.requests.length === 1);
			expect(JSON.stringify(advisor.requests[0]?.context)).toContain(
				"RESTORED-ELAPSED-CADENCE-EVIDENCE",
			);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
		} finally {
			await harness.dispose();
		}
	});

	it("replays an interrupted active review once and persists its terminal completion", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "active replay root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("DURABLE-ACTIVE-REVIEW-EVIDENCE"));
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
					text: "[Executor assistant]\nDURABLE-ACTIVE-REVIEW-EVIDENCE",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 1,
					successfulMemoryTexts: [],
					reviewId: "stable-restored-review",
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
			expect(JSON.stringify(advisor.requests[0]?.context)).toContain(
				"DURABLE-ACTIVE-REVIEW-EVIDENCE",
			);
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				restoredActiveReviewPending: false,
				restoredReplayCount: 1,
			});
			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect(
				latest?.type === "custom"
					? (latest.data as PersistedAdvisorRuntimeState).activeReview
					: "missing",
			).toBeUndefined();
		} finally {
			await harness.dispose();
		}
	});

	it("does not replay an active review already owned by restored deferred advice", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "user",
			content: "deferred ownership root",
			timestamp: Date.now(),
		});
		manager.appendMessage(scriptedAssistant("DEFERRED-OWNED-ACTIVE-REVIEW-EVIDENCE"));
		const window = cursorAtTail(manager.getBranch());
		const reviewId = "deferred-owned-restored-review";
		const deferred = reviewAdvice("Deliver this accepted deferred note exactly once.");
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				activeReview: {
					text: "[Executor assistant]\nDEFERRED-OWNED-ACTIVE-REVIEW-EVIDENCE",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 1,
					successfulMemoryTexts: [],
					reviewId,
					restoredReplayCount: 0,
				},
				deferredAdvice: [
					{
						advice: deferred,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
						reviewId,
					},
				],
				memorySuggestions: {
					meaningfulTurnCount: 1,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
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
			expect(advisor.requests).toHaveLength(0);
			expect(runtime?.getStatus()).toMatchObject({
				restoredActiveReviewPending: false,
				deferredNotesPending: 1,
			});
			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect(
				latest?.type === "custom"
					? (latest.data as PersistedAdvisorRuntimeState).activeReview
					: "missing",
			).toBeUndefined();
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect(
				latest?.type === "custom"
					? (latest.data as PersistedAdvisorRuntimeState).deferredAdvice[0]?.reviewId
					: undefined,
			).toBe(reviewId);
		} finally {
			await harness.dispose();
		}
	});

	it("restores an unacknowledged active delivery as stale deferred advice when absent", async () => {
		const manager = SessionManager.inMemory();
		const advice = reviewAdvice("Recover this accepted but unacknowledged Advisor note.");
		const identity = adviceDedupeKey(advice);
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
				activeDeliveries: [
					{
						advice,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
						identity,
						deliveryId: "restored-delivery-absent",
						reviewId: "restored-review-absent",
						turnNumber: 1,
						tag: "possible-duplicate",
					},
				],
			}),
		);
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "continued after restored delivery" }] },
		]);
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
			expect(runtime?.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 1,
				restoredDeferredNotesPending: 1,
				restoredActiveDeliveriesPending: 0,
			});
			await harness.session.prompt("materialize recovered active delivery");
			expect(JSON.stringify(primary.requests[0]?.context)).toContain(advice.note);
			expect(JSON.stringify(primary.requests[0]?.context)).toContain(
				'tag=\\"possible-duplicate\\"',
			);
			expect(runtime?.getStatus().notesDelivered).toBe(1);
		} finally {
			await harness.dispose();
		}
	});

	it("acknowledges a restored active delivery already present in branch without redisplay", async () => {
		const manager = SessionManager.inMemory();
		const advice = reviewAdvice("Acknowledge this already visible restored Advisor note.");
		const identity = adviceDedupeKey(advice);
		const window = cursorAtTail(manager.getBranch());
		manager.appendCustomMessageEntry("pi-advisor-note", advice.note, true, {
			...advice,
			delivery: "active",
			deliveryId: "restored-delivery-present",
			reviewId: "restored-review-present",
		});
		appendState(
			manager,
			persistedState(manager, {
				cursor: cursorAtTail(manager.getBranch()),
				memorySuggestions: {
					meaningfulTurnCount: 1,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
				activeDeliveries: [
					{
						advice,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
						identity,
						deliveryId: "restored-delivery-present",
						reviewId: "restored-review-present",
						turnNumber: 1,
					},
				],
			}),
		);
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
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
			expect(runtime?.getStatus()).toMatchObject({
				activeNotesPending: 0,
				deferredNotesPending: 0,
				notesDelivered: 1,
			});
			expect(
				manager
					.getBranch()
					.filter(
						(entry) => entry.type === "custom_message" && entry.customType === "pi-advisor-note",
					),
			).toHaveLength(1);
			expect(advisor.requests).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});

	it("drops a twice-interrupted restored review and continues its queued successor", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "poison replay root", timestamp: Date.now() });
		manager.appendMessage(scriptedAssistant("POISON-OLD-EVIDENCE and QUEUED-LATER-EVIDENCE"));
		const window = cursorAtTail(manager.getBranch());
		appendState(
			manager,
			persistedState(manager, {
				cursor: window,
				memorySuggestions: {
					meaningfulTurnCount: 2,
					admittedCount: 0,
					deliveredCount: 0,
					sessionCapReached: false,
				},
				activeReview: {
					text: "[Executor assistant]\nPOISON-OLD-EVIDENCE",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 1,
					successfulMemoryTexts: [],
					reviewId: "poison-restored-review",
					restoredReplayCount: 2,
				},
				queuedReview: {
					text: "[Executor assistant]\nQUEUED-LATER-EVIDENCE",
					entryCount: 1,
					truncated: false,
					window,
					turnNumber: 2,
					successfulMemoryTexts: [],
				},
				lastReviewSubmittedTurn: 1,
				lastReviewSubmittedAt: 0,
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
			const submitted = JSON.stringify(advisor.requests[0]?.context);
			expect(submitted).toContain("QUEUED-LATER-EVIDENCE");
			expect(submitted).not.toContain("POISON-OLD-EVIDENCE");
			expect(runtime?.getStatus()).toMatchObject({
				poisonReviewDrops: 1,
				restoredActiveReviewPending: false,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("preserves valid Memory accounting when oversized deferred snapshots trim their tail before resume", async () => {
		const manager = SessionManager.inMemory();
		const firstPrimary = createPrimaryProvider([]);
		const firstAdvisor = createAdvisorProvider([]);
		let firstRuntime: AdvisorRuntime | undefined;
		let firstHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		let resumedHarness: Awaited<ReturnType<typeof createSessionHarness>> | undefined;
		try {
			firstHarness = await createSessionHarness({
				provider: firstPrimary,
				advisorProvider: firstAdvisor,
				sessionManager: manager,
				extensions: [
					extensionFor(
						configFor(firstAdvisor, (config) => {
							config.memorySuggestions.sessionSuggestionCap = 1_000;
						}),
						(value) => (firstRuntime = value),
					),
				],
				tools: [],
				mode: "rpc",
			});
			if (firstRuntime === undefined) throw new Error("Expected trim fixture runtime");
			const activeRuntime = firstRuntime;
			const pendingAdvice = runtimeInternals(activeRuntime).pendingAdvice;
			const branchWindow = cursorAtTail(manager.getBranch());
			const pendingCount = 489;
			const admittedCount = pendingCount + 1;
			for (let index = 0; index < pendingCount; index++) {
				const rationale = "\u0001".repeat(1_990);
				const memoryText = `Durable trim fixture ${String(index)}`;
				const advice: AcceptedAdvice = {
					intent: "memory-suggestion",
					note: rationale,
					memory: {
						text: memoryText,
						category: "project",
						basis: "project-constraint",
					},
					truncated: false,
					originalCharacters: rationale.length,
					originalEstimatedTokens: Math.ceil(rationale.length / 4),
					createdAt: Date.now(),
				};
				expect(
					pendingAdvice.enqueue(
						adviceDedupeKey(advice),
						{
							advice,
							stale: false,
							branchWindow,
							displayedInEntry: false,
						},
						Buffer.byteLength(rationale, "utf8") + Buffer.byteLength(memoryText, "utf8"),
					),
				).toBe("accepted");
			}
			Reflect.set(activeRuntime, "meaningfulTurnCount", admittedCount);
			Reflect.set(activeRuntime, "memorySuggestionAdmissions", admittedCount);
			Reflect.set(activeRuntime, "lastMemorySuggestionTurn", admittedCount);
			Reflect.set(activeRuntime, "lastMemorySuggestionAt", Date.now());
			const status = runtimeInternals(activeRuntime).status;
			status.memorySuggestionsDelivered = 1;
			status.notesDelivered = 1;
			runtimeInternals(activeRuntime).persistState();

			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (latest?.type !== "custom") throw new Error("Expected trimmed persisted state");
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			const persisted = latest.data as PersistedAdvisorRuntimeState;
			expect(persisted.deferredAdvice.length).toBeGreaterThan(0);
			expect(persisted.deferredAdvice.length).toBeLessThan(pendingCount);
			expect(Buffer.byteLength(JSON.stringify(persisted), "utf8")).toBeLessThanOrEqual(
				4 * 1_024 * 1_024,
			);
			expect(persisted.memorySuggestions).toMatchObject({
				meaningfulTurnCount: admittedCount,
				admittedCount,
				deliveredCount: 1,
			});
			expect(persisted.memorySuggestions.deliveredCount).toBeLessThanOrEqual(
				persisted.memorySuggestions.admittedCount,
			);

			await activeRuntime.shutdown();
			await firstHarness.dispose();
			firstHarness = undefined;
			const resumedPrimary = createPrimaryProvider([]);
			const resumedAdvisor = createAdvisorProvider([]);
			let resumedRuntime: AdvisorRuntime | undefined;
			resumedHarness = await createSessionHarness({
				provider: resumedPrimary,
				advisorProvider: resumedAdvisor,
				sessionManager: manager,
				extensions: [
					extensionFor(
						configFor(resumedAdvisor, (config) => {
							config.memorySuggestions.sessionSuggestionCap = 1_000;
						}),
						(value) => (resumedRuntime = value),
					),
				],
				tools: [],
				mode: "rpc",
			});
			expect(resumedRuntime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsRemaining: 510,
				deferredNotesPending: persisted.deferredAdvice.length,
			});
		} finally {
			await firstHarness?.dispose();
			await resumedHarness?.dispose();
		}
	});

	it("compacts escape-heavy queued review content by serialized bytes and preserves its tail", async () => {
		const manager = SessionManager.inMemory();
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxPendingTranscriptBytes = 1_000_000;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected serialized compaction runtime");
			const activeRuntime = runtime;
			const escapeHeavy = `${`"\\\n\u0000`.repeat(190_000)}NEWEST-ESCAPED-EVIDENCE`;
			expect(Buffer.byteLength(escapeHeavy, "utf8")).toBeLessThanOrEqual(1_000_000);
			Reflect.set(activeRuntime, "throttledUpdate", {
				text: escapeHeavy,
				entryCount: 1,
				truncated: false,
				window: cursorAtTail(manager.getBranch()),
				turnNumber: 1,
				successfulMemoryTexts: new Set<string>(),
			});
			runtimeInternals(activeRuntime).persistState();
			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (latest?.type !== "custom") throw new Error("Expected compacted runtime state");
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			const queued = (latest.data as PersistedAdvisorRuntimeState).queuedReview;
			expect(queued).toBeDefined();
			expect(Buffer.byteLength(JSON.stringify(queued), "utf8")).toBeLessThanOrEqual(1_000_000);
			expect(queued?.text).toContain("NEWEST-ESCAPED-EVIDENCE");
			expect(queued?.truncated).toBe(true);
			expect(activeRuntime.getStatus().serializedPersistenceTruncations).toBeGreaterThan(0);
		} finally {
			await harness.dispose();
		}
	});

	it("retains active review, active delivery, queued review, and dedupe before oldest deferred advice", async () => {
		const manager = SessionManager.inMemory();
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.maxPendingTranscriptBytes = 1_000_000;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected retention-priority runtime");
			const activeRuntime = runtime;
			const window = cursorAtTail(manager.getBranch());
			Reflect.set(activeRuntime, "meaningfulTurnCount", 1);
			Reflect.set(activeRuntime, "activeReview", {
				text: `${"\u0000".repeat(700_000)}ACTIVE-REVIEW-TAIL`,
				entryCount: 1,
				truncated: false,
				window,
				turnNumber: 1,
				successfulMemoryTexts: [],
				reviewId: "priority-active-review",
				restoredReplayCount: 0,
			});
			Reflect.set(activeRuntime, "pendingUpdate", {
				text: `${"\u0000".repeat(700_000)}QUEUED-REVIEW-TAIL`,
				entryCount: 1,
				truncated: false,
				window,
				turnNumber: 1,
				successfulMemoryTexts: new Set<string>(),
			});
			const activeDeliveryAdvice = reviewAdvice("Retain accepted active delivery first.");
			const activeIdentity = adviceDedupeKey(activeDeliveryAdvice);
			const activeAdvice = runtimeInternals(activeRuntime).activeAdvice;
			expect(
				activeAdvice.enqueue(
					activeIdentity,
					{
						advice: activeDeliveryAdvice,
						stale: false,
						branchWindow: window,
						displayedInEntry: false,
						identity: activeIdentity,
						deliveryId: "priority-active-delivery",
						reviewId: "priority-delivery-review",
						turnNumber: 1,
						epoch: activeRuntime.getStatus().epoch,
					},
					Buffer.byteLength(activeDeliveryAdvice.note, "utf8"),
				),
			).toBe("accepted");
			const pendingAdvice = runtimeInternals(activeRuntime).pendingAdvice;
			for (let index = 0; index < 500; index++) {
				const note = `DEFERRED-${String(index).padStart(3, "0")}-${"\u0000".repeat(1_880)}`;
				const deferred = reviewAdvice(note);
				const identity = adviceDedupeKey(deferred);
				expect(
					pendingAdvice.enqueue(
						identity,
						{
							advice: deferred,
							stale: false,
							branchWindow: window,
							displayedInEntry: false,
						},
						Buffer.byteLength(note, "utf8"),
					),
				).toBe("accepted");
			}
			const dedupe = runtimeInternals(activeRuntime).adviceDedupe;
			for (let index = 0; index < MAX_PERSISTED_DEDUPE_HASHES; index++) {
				dedupe.add(reviewAdvice(`Persist priority dedupe ${String(index)}.`));
			}
			const recentFindings = runtimeInternals(activeRuntime).recentFindings;
			for (let index = 0; index < 128; index++) {
				recentFindings.add(
					index.toString(16).padStart(64, "0"),
					`Persist priority finding ${String(index)}.`,
				);
			}
			runtimeInternals(activeRuntime).persistState();
			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (latest?.type !== "custom") throw new Error("Expected priority runtime state");
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			const state = latest.data as PersistedAdvisorRuntimeState;
			expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(
				4 * 1_024 * 1_024,
			);
			expect(state.activeReview?.text).toContain("ACTIVE-REVIEW-TAIL");
			expect(state.activeReview?.truncated).toBe(true);
			expect(state.activeDeliveries).toHaveLength(1);
			expect(state.queuedReview?.text).toContain("QUEUED-REVIEW-TAIL");
			expect(state.queuedReview?.truncated).toBe(true);
			expect(state.dedupeHashes).toHaveLength(MAX_PERSISTED_DEDUPE_HASHES);
			// The index sits after deferred advice and dedupe hashes in the
			// snapshot-pressure drop order, so it survives while deferred advice
			// absorbs the pressure, and it compacts oldest-first when reached.
			expect(state.recentFindings).toHaveLength(128);
			expect(state.recentFindings[0]?.label).toBe("Persist priority finding 0.");
			expect(state.recentFindings.at(-1)?.label).toBe("Persist priority finding 127.");
			expect(state.deferredAdvice.length).toBeLessThan(500);
			expect(state.deferredAdvice.at(-1)?.advice.note).toContain("DEFERRED-499");
			expect(state.deferredAdvice[0]?.advice.note).not.toContain("DEFERRED-000");
		} finally {
			if (runtime !== undefined) {
				Reflect.deleteProperty(runtime, "activeReview");
				Reflect.deleteProperty(runtime, "pendingUpdate");
				runtimeInternals(runtime).activeAdvice.clear();
			}
			await harness.dispose();
		}
	});

	it("asserts that pending and throttled work cannot form a third durable review slot", async () => {
		const manager = SessionManager.inMemory();
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
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
			if (runtime === undefined) throw new Error("Expected invariant runtime");
			const activeRuntime = runtime;
			const update = {
				text: "durable invariant evidence",
				entryCount: 1,
				truncated: false,
				window: cursorAtTail(manager.getBranch()),
				turnNumber: 1,
				successfulMemoryTexts: new Set<string>(),
			};
			Reflect.set(activeRuntime, "pendingUpdate", update);
			Reflect.set(activeRuntime, "throttledUpdate", structuredClone(update));
			expect(() => runtimeInternals(activeRuntime).persistState()).toThrow(
				"Advisor invariant violated: pending and throttled updates coexist",
			);
			Reflect.deleteProperty(activeRuntime, "pendingUpdate");
			Reflect.deleteProperty(activeRuntime, "throttledUpdate");
		} finally {
			await harness.dispose();
		}
	});

	it("writes no deferred note content to lifecycle snapshots when retention is zero", async () => {
		const note = "Do not retain this note across exit when retention is zero.";
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer before zero-retention exit" }] },
		]);
		const advisor = createAdvisorProvider([
			{ ...acceptedAdvice(note, "zero-retention-note"), delayMs: 25 },
		]);
		let runtime: AdvisorRuntime | undefined;
		const manager = SessionManager.inMemory();
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.limits.deferredAdviceRetentionHours = 0;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("queue zero-retention advice");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			if (runtime === undefined) throw new Error("Expected zero-retention runtime");
			await runtime.shutdown();
			const latestState = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			const data = latestState?.type === "custom" ? latestState.data : undefined;
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			expect((data as PersistedAdvisorRuntimeState | undefined)?.deferredAdvice).toEqual([]);
			expect(JSON.stringify(data)).not.toContain(note);
		} finally {
			await harness.dispose();
		}
	});

	it("retention zero, expiry, future timestamps, and incompatible branches discard deferred notes", async () => {
		const cases = [
			{
				label: "retention zero",
				retentionHours: 0,
				createdAt: Date.now(),
				window: undefined,
			},
			{
				label: "expired",
				retentionHours: 1,
				createdAt: Date.now() - 2 * 60 * 60 * 1_000,
				window: undefined,
			},
			{
				label: "future-created",
				retentionHours: 24,
				createdAt: Date.now() + 60 * 60 * 1_000,
				window: undefined,
			},
			{
				label: "branch incompatible",
				retentionHours: 24,
				createdAt: Date.now(),
				window: { lastEntryId: "missing-entry", expectedIndex: 1 },
			},
		];
		for (const scenario of cases) {
			const note = `Discard ${scenario.label} deferred advice.`;
			const advice = reviewAdvice(note, scenario.createdAt);
			const manager = SessionManager.inMemory();
			const window = scenario.window ?? cursorAtTail(manager.getBranch());
			appendState(
				manager,
				persistedState(manager, {
					deferredAdvice: [
						{
							advice,
							stale: false,
							branchWindow: window,
							displayedInEntry: false,
						},
					],
					dedupeHashes: [{ hash: adviceDedupeKey(advice) }],
				}),
			);
			const primary = createPrimaryProvider([
				{ content: [{ type: "text", text: "continued without discarded advice" }] },
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
							config.limits.deferredAdviceRetentionHours = scenario.retentionHours;
						}),
						(value) => (runtime = value),
					),
				],
				tools: [],
				mode: "rpc",
			});
			try {
				expect(runtime?.getStatus().deferredNotesPending).toBe(0);
				await harness.session.prompt(`continue after ${scenario.label}`);
				expect(JSON.stringify(primary.requests[0]?.context)).not.toContain(note);
			} finally {
				await harness.dispose();
			}
		}
	});

	it("persists the full newest eligible dedupe bound when newer identities are transient", async () => {
		const manager = SessionManager.inMemory();
		const primary = createPrimaryProvider([]);
		const advisor = createAdvisorProvider([]);
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
			if (runtime === undefined) throw new Error("Expected persisted dedupe fixture runtime");
			const activeRuntime = runtime;
			const dedupe = runtimeInternals(activeRuntime).adviceDedupe;
			const notes = Array.from({ length: MAX_PERSISTED_DEDUPE_HASHES + 4 }, (_, index) =>
				reviewAdvice(`Persisted dedupe fixture ${String(index)}.`),
			);
			for (const note of notes) dedupe.add(note);
			const allKeys = notes.map((note) => adviceDedupeKey(note));
			const transientKeys = allKeys.slice(-4);
			const pendingAdvice = runtimeInternals(activeRuntime).pendingAdvice;
			const branchWindow = cursorAtTail(manager.getBranch());
			for (const note of notes.slice(-4)) {
				expect(
					pendingAdvice.enqueue(
						adviceDedupeKey(note),
						{ advice: note, stale: false, branchWindow, displayedInEntry: false },
						Buffer.byteLength(note.note, "utf8"),
					),
				).toBe("accepted");
			}
			runtimeInternals(activeRuntime).persistState();
			const latest = [...manager.getBranch()]
				.reverse()
				.find(
					(entry) =>
						entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
				);
			if (latest?.type !== "custom") throw new Error("Expected persisted dedupe state");
			// SAFETY: the entry was filtered to the Advisor runtime custom type above.
			const persisted = latest.data as PersistedAdvisorRuntimeState;
			expect(persisted.dedupeHashes).toHaveLength(MAX_PERSISTED_DEDUPE_HASHES);
			expect(persisted.dedupeHashes).toEqual(
				allKeys.slice(0, MAX_PERSISTED_DEDUPE_HASHES).map((hash) => ({ hash })),
			);
			for (const transient of transientKeys) {
				expect(persisted.dedupeHashes.map((entry) => entry.hash)).not.toContain(transient);
			}
		} finally {
			await harness.dispose();
		}
	});

	it("restored dedupe suppresses an immediate duplicate after revising the measured 512-hash proposal", async () => {
		const duplicate = "Do not repeat this already delivered review note.";
		const advice = reviewAdvice(duplicate);
		const manager = SessionManager.inMemory();
		const proposedHashes = Array.from({ length: 512 }, (_, index) => ({
			hash: index.toString(16).padStart(64, "0"),
		}));
		const proposedState = persistedState(manager, { dedupeHashes: proposedHashes });
		expect(Buffer.byteLength(JSON.stringify(proposedState), "utf8")).toBeGreaterThan(33 * 1_024);
		const hashes = Array.from({ length: MAX_PERSISTED_DEDUPE_HASHES }, (_, index) => ({
			hash: index === 0 ? adviceDedupeKey(advice) : index.toString(16).padStart(64, "0"),
		}));
		const state = persistedState(manager, { dedupeHashes: hashes });
		appendState(manager, state);
		expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThan(12 * 1_024);

		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer that triggers duplicate review" }] },
		]);
		const advisor = createAdvisorProvider([acceptedAdvice(duplicate)]);
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
			await harness.session.prompt("produce the same review immediately after resume");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				notesSuppressed: 1,
				deferredNotesPending: 0,
				notesDelivered: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("does not restore an old branch cursor or deferred state on another branch", async () => {
		const manager = SessionManager.inMemory();
		const rootId = manager.appendMessage({
			role: "user",
			content: "shared root",
			timestamp: Date.now(),
		});
		const oldAssistantId = manager.appendMessage(scriptedAssistant("old branch"));
		const oldAdvice = reviewAdvice("Old branch only advice.");
		appendState(
			manager,
			persistedState(manager, {
				cursor: cursorAtTail(manager.getBranch()),
				deferredAdvice: [
					{
						advice: oldAdvice,
						stale: false,
						branchWindow: cursorAtTail(manager.getBranch()),
						displayedInEntry: false,
					},
				],
			}),
		);
		manager.branch(rootId);
		manager.appendMessage(scriptedAssistant("new equal-length branch"));
		expect(manager.getBranch().some((entry) => entry.id === oldAssistantId)).toBe(false);

		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "new branch continued" }] },
		]);
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
			expect(runtime?.getStatus().deferredNotesPending).toBe(0);
			await harness.session.prompt("continue the new branch");
			expect(JSON.stringify(primary.requests[0]?.context)).not.toContain(oldAdvice.note);
			expect(runtime?.getStatus().branchResets).toBe(0);
		} finally {
			await harness.dispose();
		}
	});

	it("restores Memory cadence and cap state only for the same Pi session", async () => {
		const proposed = "Use the verified release checklist before publishing this project.";
		const manager = SessionManager.inMemory();
		appendState(
			manager,
			persistedState(manager, {
				memorySuggestions: {
					meaningfulTurnCount: 12,
					admittedCount: 1,
					deliveredCount: 1,
					lastAdmittedTurn: 12,
					lastAdmittedAt: Date.now() - 1_000,
					sessionCapReached: true,
				},
			}),
		);
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "same session answer" }] },
		]);
		const advisor = createAdvisorProvider([memorySuggestion(proposed)]);
		let runtime: AdvisorRuntime | undefined;
		const capConfig = configFor(advisor, (config) => {
			config.memorySuggestions.sessionSuggestionCap = 1;
		});
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			sessionManager: manager,
			extensions: [extensionFor(capConfig, (value) => (runtime = value))],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 1,
				memorySuggestionsRemaining: 0,
				memorySuggestionNextEligibleTurn: 12,
			});
			await harness.session.prompt("same session must retain its cap");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			expect(runtime?.getStatus()).toMatchObject({
				memorySuggestionsLimitSuppressed: 1,
				deferredNotesPending: 0,
			});
		} finally {
			await harness.dispose();
		}

		const newManager = SessionManager.inMemory();
		const copiedState = persistedState(newManager, {
			sessionId: manager.getSessionId(),
			memorySuggestions: {
				meaningfulTurnCount: 12,
				admittedCount: 1,
				deliveredCount: 1,
				lastAdmittedTurn: 12,
				lastAdmittedAt: Date.now(),
				sessionCapReached: true,
			},
		});
		appendState(newManager, copiedState);
		const newPrimary = createPrimaryProvider([
			{ content: [{ type: "text", text: "genuinely new session answer" }] },
			{ content: [{ type: "text", text: "evaluated the fresh Memory suggestion" }] },
		]);
		const newAdvisor = createAdvisorProvider([memorySuggestion(proposed, "new-session-memory")]);
		let newRuntime: AdvisorRuntime | undefined;
		const newHarness = await createSessionHarness({
			provider: newPrimary,
			advisorProvider: newAdvisor,
			sessionManager: newManager,
			extensions: [
				extensionFor(
					configFor(newAdvisor, (config) => {
						config.memorySuggestions.sessionSuggestionCap = 1;
					}),
					(value) => (newRuntime = value),
				),
			],
			customTools: [compatibleMemoryTool()],
			tools: ["memory_suggest"],
			mode: "rpc",
		});
		try {
			expect(newRuntime?.getStatus()).toMatchObject({
				memorySuggestionsDelivered: 0,
				memorySuggestionsRemaining: 1,
			});
			await newHarness.session.prompt("new session gets a fresh Memory allowance");
			await waitFor(() => newRuntime?.getStatus().memorySuggestionsDelivered === 1);
			expect(newRuntime?.getStatus()).toMatchObject({
				memorySuggestionsRemaining: 0,
				memorySuggestionsLimitSuppressed: 0,
			});
		} finally {
			await newHarness.dispose();
		}
	});
});
