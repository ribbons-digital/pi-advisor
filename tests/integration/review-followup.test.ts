import { defineTool, type InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	ADVISOR_RUNTIME_STATE_VERSION,
	createPiAdvisorExtension,
	cursorAtTail,
	DEFAULT_ADVISOR_CONFIG,
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
		name: "pi-advisor-review-followup-test",
		factory: createPiAdvisorExtension({ config, hooks: { onRuntime } }),
	};
}

function blockerAdvice(note: string, id = "review-advice") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: { note, severity: "blocker", intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

function concernAdvice(note: string, id = "concern-advice") {
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

async function waitForStable(predicate: () => boolean, stableMs = 300): Promise<void> {
	await expect
		.poll(
			async () => {
				if (!predicate()) return false;
				await new Promise((resolve) => setTimeout(resolve, stableMs));
				return predicate();
			},
			{ timeout: 5_000, interval: 50 },
		)
		.toBe(true);
}

describe.sequential("Q3 severity-aware idle review dispatch", () => {
	it("triggers exactly one automatic continuation per eligible idle blocker and never chains", async () => {
		let settledCount = 0;
		const settleProbe: InlineExtension = {
			name: "q3-settle-probe",
			factory: (pi) => {
				pi.on("agent_end", () => {
					settledCount++;
				});
			},
		};
		const inspect = defineTool({
			name: "inspect",
			label: "inspect",
			description: "Produce material Executor evidence in the follow-up continuation.",
			parameters: Type.Object({}),
			execute: () =>
				Promise.resolve({
					content: [{ type: "text" as const, text: "inspected" }],
					details: {},
				}),
		});
		// The follow-up continuations make a non-read-only tool call so the turn is
		// meaningful; only the no-chain guard can keep it from being reviewed.
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{
				content: [{ type: "toolCall", id: "inspect-c1", name: "inspect", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "follow-up continuation answer" }] },
			{ content: [{ type: "text", text: "second prompt answer" }] },
			{
				content: [{ type: "toolCall", id: "inspect-c2", name: "inspect", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "second follow-up continuation answer" }] },
		]);
		const advisor = createAdvisorProvider([
			blockerAdvice("Do not ship the invalid migration."),
			blockerAdvice("Recheck the second change."),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [settleProbe, extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [inspect],
			tools: ["inspect"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("finish the first turn");
			// The follow-up dispatch settles before the continuation run starts.
			await waitFor(() => runtime?.getStatus().reviewFollowUpsTriggered === 1);
			await waitFor(() => settledCount === 2);
			expect(JSON.stringify(primary.requests[1]?.context)).toContain('delivery=\\"active\\"');
			expect(JSON.stringify(primary.requests[1]?.context)).toContain('severity=\\"blocker\\"');
			// Stability gate: the continuation made a material non-read-only tool call,
			// so with a broken no-chain guard its review would dispatch its own
			// follow-up within milliseconds; a counter and advisor count that stay put
			// prove the continuation was not reviewed.
			await waitForStable(
				() =>
					runtime?.getStatus().reviewFollowUpsTriggered === 1 &&
					runtime.getStatus().notesDelivered === 1 &&
					advisor.requests.length === 1,
			);

			await harness.session.prompt("second user turn");
			await waitFor(() => settledCount === 4);
			await waitForStable(
				() =>
					runtime?.getStatus().reviewFollowUpsTriggered === 2 &&
					runtime.getStatus().notesDelivered === 2 &&
					advisor.requests.length === 2,
			);
		} finally {
			await harness.dispose();
		}
	});

	it("defers an idle concern when the release default only admits blocker", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next user answer" }] },
		]);
		const advisor = createAdvisorProvider([
			concernAdvice("Weigh this ordinary concern."),
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
			await harness.session.prompt("finish the first turn");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus()).toMatchObject({
				reviewFollowUpsTriggered: 0,
				notesDelivered: 0,
			});
			expect(primary.requests).toHaveLength(1);
			await harness.session.prompt("materialize the deferred concern");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				'severity=\\"concern\\" delivery=\\"deferred\\" stale=\\"false\\"',
			);
		} finally {
			await harness.dispose();
		}
	});

	it("falls back to deferred delivery after the fixed session cap of five follow-ups", async () => {
		let settledCount = 0;
		const settleProbe: InlineExtension = {
			name: "q3-settle-probe",
			factory: (pi) => {
				pi.on("agent_end", () => {
					settledCount++;
				});
			},
		};
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "answer 1" }] },
			{ content: [{ type: "text", text: "continuation 1" }] },
			{ content: [{ type: "text", text: "answer 2" }] },
			{ content: [{ type: "text", text: "continuation 2" }] },
			{ content: [{ type: "text", text: "answer 3" }] },
			{ content: [{ type: "text", text: "continuation 3" }] },
			{ content: [{ type: "text", text: "answer 4" }] },
			{ content: [{ type: "text", text: "continuation 4" }] },
			{ content: [{ type: "text", text: "answer 5" }] },
			{ content: [{ type: "text", text: "continuation 5" }] },
			{ content: [{ type: "text", text: "answer 6" }] },
		]);
		const advisor = createAdvisorProvider([
			blockerAdvice("Block one.", "blocker-1"),
			blockerAdvice("Block two.", "blocker-2"),
			blockerAdvice("Block three.", "blocker-3"),
			blockerAdvice("Block four.", "blocker-4"),
			blockerAdvice("Block five.", "blocker-5"),
			blockerAdvice("Block six.", "blocker-6"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [settleProbe, extensionFor(configFor(advisor), (value) => (runtime = value))],
			tools: [],
			mode: "rpc",
		});
		try {
			for (let turn = 1; turn <= 5; turn++) {
				await harness.session.prompt(`user turn ${String(turn)}`);
				await waitFor(() => settledCount === turn * 2);
				expect(primary.requests).toHaveLength(turn * 2);
				// Stability gate: the follow-up counter and advisor request count stay
				// put only when no chain review of the continuation ran.
				await waitForStable(
					() =>
						runtime?.getStatus().reviewFollowUpsTriggered === turn &&
						advisor.requests.length === turn,
				);
			}
			expect(runtime?.getStatus()).toMatchObject({
				reviewFollowUpsTriggered: 5,
				notesDelivered: 5,
				deferredNotesPending: 0,
			});
			await harness.session.prompt("user turn 6");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			await waitFor(() => advisor.requests.length === 6);
			expect(runtime?.getStatus()).toMatchObject({
				reviewFollowUpsTriggered: 5,
				notesDelivered: 5,
				deferredNotesPending: 1,
			});
			expect(primary.requests).toHaveLength(11);
		} finally {
			await harness.dispose();
		}
	});

	it("keeps the fixed session cap across a compatible resume", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const state: PersistedAdvisorRuntimeState = {
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
			reviewFollowUpsTriggered: 5,
			recentFindings: [],
			notesDelivered: 5,
		};
		manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, state);
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{ content: [{ type: "text", text: "next user answer" }] },
		]);
		const advisor = createAdvisorProvider([blockerAdvice("Cap survived resume."), { content: [] }]);
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
			await harness.session.prompt("first turn after resume");
			await waitFor(() => runtime?.getStatus().deferredNotesPending === 1);
			expect(runtime?.getStatus()).toMatchObject({
				reviewFollowUpsTriggered: 5,
				notesDelivered: 5,
				deferredNotesPending: 1,
			});
			expect(primary.requests).toHaveLength(1);
			await harness.session.prompt("materialize the deferred blocker");
			expect(JSON.stringify(primary.requests[1]?.context)).toContain(
				'severity=\\"blocker\\" delivery=\\"deferred\\" stale=\\"false\\"',
			);
		} finally {
			await harness.dispose();
		}
	});

	it("invalidates a pending review follow-up on epoch change like the Memory guard", async () => {
		const holdBarrier = createBarrier();
		const hold = defineTool({
			name: "hold",
			label: "hold",
			description: "Create a deterministic in-flight continuation boundary.",
			parameters: Type.Object({}),
			execute: async () => {
				await holdBarrier.promise;
				return Promise.resolve({
					content: [{ type: "text" as const, text: "held" }],
					details: {},
				});
			},
		});
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "terminal answer" }] },
			{
				content: [{ type: "toolCall", id: "hold-continuation", name: "hold", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "answer after epoch change" }] },
		]);
		const advisor = createAdvisorProvider([
			blockerAdvice("Act on this blocker now."),
			{ content: [] },
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		let hostContext: Parameters<AdvisorRuntime["applyConfiguration"]>[1] | undefined;
		const probe: InlineExtension = {
			name: "q3-epoch-context-probe",
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					hostContext = ctx;
				});
			},
		};
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [probe, extensionFor(configFor(advisor), (value) => (runtime = value))],
			customTools: [hold],
			tools: ["hold"],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("finish the first turn");
			// The follow-up continuation is an in-flight toolUse turn, so the review
			// follow-up delivery id is still pending when the epoch changes.
			await waitFor(() => {
				if (runtime === undefined || primary.requests.length < 2) return false;
				return typeof runtimeInternals(runtime).automaticReviewFollowUpDeliveryId === "string";
			});
			expect(runtime?.getStatus()).toMatchObject({ reviewFollowUpsTriggered: 1 });

			const before = runtime?.getStatus().epoch;
			if (runtime === undefined || hostContext === undefined || before === undefined) {
				throw new Error("Expected initialized Advisor runtime and host context");
			}
			const next = configFor(advisor);
			next.instructions = "Apply after epoch change.";
			const applying = runtime.applyConfiguration(next, hostContext);
			expect(runtime.getStatus().active).toBe(false);
			await applying;
			expect(runtime.getStatus().epoch).toBeGreaterThan(before);
			expect(runtimeInternals(runtime).automaticReviewFollowUpDeliveryId).toBeUndefined();

			holdBarrier.release();
			await waitFor(() => primary.requests.length === 3);
			// After the epoch clear the continuation is reviewed again instead of
			// being skipped by the pending follow-up guard.
			await waitFor(() => advisor.requests.length >= 3);
			expect(advisor.requests.length).toBeGreaterThanOrEqual(3);
			expect(runtime.getStatus()).toMatchObject({
				reviewFollowUpsTriggered: 1,
				notesDelivered: 1,
			});
		} finally {
			holdBarrier.release();
			await harness.dispose();
		}
	});
});
