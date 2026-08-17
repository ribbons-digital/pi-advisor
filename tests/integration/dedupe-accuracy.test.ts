import { createHash } from "node:crypto";

import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
	ADVISOR_RUNTIME_STATE_VERSION,
	adviceDedupeKey,
	createPiAdvisorExtension,
	cursorAtTail,
	DEFAULT_ADVISOR_CONFIG,
	noteSignature,
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

const ROLLBACK_KEY = "defect-rollback-path";
const EMAIL_KEY = "defect-onboarding-email";
const ROLLBACK_NOTE = "The rollback path drops the pending migration state on failure.";
const ROLLBACK_PARAPHRASE = "The rollback path loses the pending migration state when it fails.";
const DISTINCT_NOTE =
	"Feature flags are read after the configuration file is closed, so values always come back empty.";
const EMAIL_NOTE =
	"Onboarding emails reference a removed environment variable and cannot render in production.";

function configFor(
	provider: ScriptedProvider,
	mutate?: (config: AdvisorConfig) => void,
): AdvisorConfig {
	const config = structuredClone(DEFAULT_ADVISOR_CONFIG);
	config.defaultEnabled = true;
	config.model = `${provider.model.provider}/${provider.model.id}`;
	// Keep every note deferred so each delivery lands in the next primary request
	// instead of triggering idle follow-up turns that change review pacing.
	config.delivery.activeIdleSeverities = [];
	mutate?.(config);
	return config;
}

function extensionFor(
	config: AdvisorConfig,
	onRuntime: (runtime: AdvisorRuntime) => void,
): InlineExtension {
	return {
		name: "pi-advisor-dedupe-accuracy-test",
		factory: createPiAdvisorExtension({
			config,
			hooks: { onRuntime },
		}),
	};
}

function reviewAdvice(
	note: string,
	findingKey: string,
	severity: "nit" | "concern" | "blocker" = "concern",
	id = "q5-advice",
) {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "advise",
				arguments: { note, findingKey, severity, intent: "review" },
			},
		],
		stopReason: "toolUse" as const,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await expect.poll(predicate, { timeout: 5_000, interval: 10 }).toBe(true);
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

function latestRuntimeState(manager: SessionManager): PersistedAdvisorRuntimeState | undefined {
	const latest = [...manager.getBranch()]
		.reverse()
		.find(
			(entry) => entry.type === "custom" && entry.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
		);
	return latest?.type === "custom" ? (latest.data as PersistedAdvisorRuntimeState) : undefined;
}

describe.sequential("Quality Slice Q5 dedupe accuracy", () => {
	it("suppresses paraphrase key reuse, tags a dissimilar reuse, and keeps distinct keys plain", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first" }] },
			{ content: [{ type: "text", text: "second" }] },
			{ content: [{ type: "text", text: "third" }] },
			{ content: [{ type: "text", text: "fourth" }] },
			{ content: [{ type: "text", text: "fifth" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY),
			reviewAdvice(ROLLBACK_PARAPHRASE, ROLLBACK_KEY),
			reviewAdvice(DISTINCT_NOTE, ROLLBACK_KEY),
			reviewAdvice(EMAIL_NOTE, EMAIL_KEY),
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
			await harness.session.prompt("review first window");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review second window");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review third window");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await harness.session.prompt("review fourth window");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);
			await harness.session.prompt("review fifth window");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 5);

			const afterParaphrase = JSON.stringify(primary.requests[2]?.context);
			expect(afterParaphrase).toContain(ROLLBACK_NOTE);
			expect(afterParaphrase).not.toContain(ROLLBACK_PARAPHRASE);

			const afterDistinct = JSON.stringify(primary.requests[3]?.context);
			expect(afterDistinct).toContain(DISTINCT_NOTE);
			expect(afterDistinct).toContain('tag=\\"possible-duplicate\\"');
			expect(afterDistinct).not.toContain(ROLLBACK_PARAPHRASE);

			const afterEmail = JSON.stringify(primary.requests[4]?.context);
			expect(afterEmail).toContain(EMAIL_NOTE);
			expect(afterEmail.match(/tag=\\"possible-duplicate\\"/g)).toHaveLength(1);
			expect(afterEmail).not.toContain('tag=\\"re-raised\\"');
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 3,
				notesSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("re-raises a persisting finding only after reRaiseMinTurns and strictly higher severity", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
			{ content: [] },
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "blocker"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 2;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await harness.session.prompt("review four");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);

			const afterRaise = JSON.stringify(primary.requests[3]?.context);
			expect(afterRaise).toContain(ROLLBACK_NOTE);
			expect(afterRaise).toContain('tag=\\"re-raised\\"');
			expect(afterRaise).toContain('severity=\\"blocker\\"');
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 2,
				notesSuppressed: 0,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("does not re-raise before the configured turn distance", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "blocker"),
			{ content: [] },
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 2;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);

			const delivered = JSON.stringify(primary.requests[2]?.context);
			expect(delivered).toContain(ROLLBACK_NOTE);
			expect(delivered).not.toContain('tag=\\"re-raised\\"');
			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				notesSuppressed: 1,
			});
		} finally {
			await harness.dispose();
		}
	});

	it("never re-raises on equal or lower severity regardless of turn distance", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
			{ content: [] },
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "nit"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 2;
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			await harness.session.prompt("review one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("review three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);
			await harness.session.prompt("review four");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 4);

			expect(runtime?.getStatus()).toMatchObject({
				notesDelivered: 1,
				notesSuppressed: 2,
			});
			expect(JSON.stringify(primary.requests[3]?.context)).not.toContain('tag=\\"re-raised\\"');
		} finally {
			await harness.dispose();
		}
	});

	it("restores prior dedupe metadata when a tagged delivery fails", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "one" }] },
			{ content: [{ type: "text", text: "two" }] },
			{ content: [{ type: "text", text: "three" }] },
			{ content: [{ type: "text", text: "four" }] },
		]);
		const advisor = createAdvisorProvider([
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
			{ content: [] },
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "blocker"),
			reviewAdvice(ROLLBACK_NOTE, ROLLBACK_KEY, "concern"),
		]);
		let runtime: AdvisorRuntime | undefined;
		const harness = await createSessionHarness({
			provider: primary,
			advisorProvider: advisor,
			extensions: [
				extensionFor(
					configFor(advisor, (config) => {
						config.dedupe.reRaiseMinTurns = 2;
						config.delivery.activeIdleSeverities = ["blocker"];
					}),
					(value) => (runtime = value),
				),
			],
			tools: [],
			mode: "rpc",
		});
		try {
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			await harness.session.prompt("review one");
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 1);
			await harness.session.prompt("review two");
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 2);

			const extensionApi = runtimeInternals(activeRuntime).pi;
			const sendMessage = vi.spyOn(extensionApi, "sendMessage").mockImplementation(() => {
				throw new Error("scripted tagged delivery failure");
			});
			await harness.session.prompt("review three");
			await waitFor(() => activeRuntime.getStatus().deliveryFailures === 1);
			expect(activeRuntime.getStatus()).toMatchObject({
				reviewsCompleted: 2,
				failedReviews: 1,
				consecutiveFailures: 1,
			});

			const dedupe = runtimeInternals(activeRuntime).adviceDedupe;
			const findingHash = createHash("sha256")
				.update(`review-finding:${ROLLBACK_KEY}`)
				.digest("hex");
			const key = adviceDedupeKey({
				note: ROLLBACK_NOTE,
				severity: "concern",
				intent: "review",
				findingKeyHash: findingHash,
			});
			expect(dedupe.exportNewestEntries(8).find((entry) => entry.hash === key)?.metadata).toEqual({
				severity: "concern",
				signature: noteSignature(ROLLBACK_NOTE).toString(16).padStart(16, "0"),
				lastDeliveryTurn: 1,
			});

			sendMessage.mockRestore();

			await harness.session.prompt("review four");
			await waitFor(() => activeRuntime.getStatus().reviewsCompleted === 3);
			expect(activeRuntime.getStatus()).toMatchObject({
				notesDelivered: 1,
				notesSuppressed: 1,
			});
			expect(JSON.stringify(primary.requests[3]?.context)).not.toContain('tag=\\"re-raised\\"');
		} finally {
			await harness.dispose();
		}
	});

	it("gives a finding key delivered after resume the full Q5 metadata", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const findingHash = createHash("sha256").update(`review-finding:${ROLLBACK_KEY}`).digest("hex");
		const restoredAdvice = {
			intent: "review" as const,
			note: ROLLBACK_NOTE,
			severity: "concern" as const,
			findingKeyHash: findingHash,
			truncated: false,
			originalCharacters: ROLLBACK_NOTE.length,
			originalEstimatedTokens: Math.ceil(ROLLBACK_NOTE.length / 4),
			createdAt: Date.now(),
		};
		appendState(
			manager,
			persistedState(manager, {
				// The key is intentionally absent from dedupeHashes: transient identities
				// are excluded from snapshots, exactly like a pre-restart pending note.
				dedupeHashes: [],
				deferredAdvice: [
					{
						advice: restoredAdvice,
						stale: true,
						branchWindow: cursorAtTail(manager.getBranch()),
						displayedInEntry: false,
						tag: "possible-duplicate",
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
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "first" }] },
			{ content: [{ type: "text", text: "second" }] },
			{ content: [{ type: "text", text: "third" }] },
		]);
		const advisor = createAdvisorProvider([
			{ content: [] },
			reviewAdvice(DISTINCT_NOTE, ROLLBACK_KEY),
			{ content: [] },
		]);
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
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			expect(runtime.getStatus().deferredNotesPending).toBe(1);
			await harness.session.prompt("resume one");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 1);
			const resumedContext = JSON.stringify(primary.requests[0]?.context);
			expect(resumedContext).toContain(ROLLBACK_NOTE);
			expect(resumedContext).toContain('tag=\\"possible-duplicate\\"');
			await harness.session.prompt("resume two");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 2);
			await harness.session.prompt("resume three");
			await waitFor(() => runtime?.getStatus().reviewsCompleted === 3);

			const afterResume = JSON.stringify(primary.requests[2]?.context);
			expect(afterResume).toContain(DISTINCT_NOTE);
			expect(afterResume).toContain('tag=\\"possible-duplicate\\"');
			expect(runtime.getStatus()).toMatchObject({
				notesDelivered: 2,
				notesSuppressed: 0,
			});
		} finally {
			await harness.dispose();
		}
	});
});

describe("Quality Slice Q5 dedupe snapshot tag guard", () => {
	it("persists the dedupe tag of an active delivery through a live persistState write", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "activate for live persist" }] },
		]);
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
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const extensionApi = runtimeInternals(activeRuntime).pi;
			const sendMessage = vi.spyOn(extensionApi, "sendMessage").mockImplementation(() => undefined);
			await harness.session.prompt("activate for live persist");

			const hostContext = runtimeInternals(activeRuntime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");
			const ctx = {
				...hostContext,
				mode: "rpc" as const,
				isIdle: () => false,
			};
			const internals = runtimeInternals(activeRuntime);

			const fillNote = "Persist note " + "y".repeat(300);
			const seededSignature = (~noteSignature(fillNote) & 0xffffffffffffffffn)
				.toString(16)
				.padStart(16, "0");
			const dedupe = runtimeInternals(activeRuntime).adviceDedupe;
			dedupe.restoreEntries([
				{
					hash: adviceDedupeKey({
						note: fillNote,
						severity: "concern" as const,
						intent: "review" as const,
						findingKeyHash: "a".repeat(64),
					}),
					metadata: {
						severity: "concern" as const,
						signature: seededSignature,
						lastDeliveryTurn: 1,
					},
				},
			]);
			const advice = {
				intent: "review" as const,
				note: fillNote,
				severity: "concern" as const,
				findingKeyHash: "a".repeat(64),
				truncated: false,
				originalCharacters: fillNote.length,
				originalEstimatedTokens: Math.ceil(fillNote.length / 4),
				createdAt: Date.now(),
			};
			const result = internals.deliver(advice, ctx, false, false, false, 1, "persist-guard");
			expect(result).toBe("active");

			runtimeInternals(activeRuntime).persistState();
			const persisted = latestRuntimeState(harness.sessionManager);
			const persistedDelivery = persisted?.activeDeliveries.find(
				(delivery) => delivery.identity === adviceDedupeKey(advice),
			);
			expect(persistedDelivery?.tag).toBe("possible-duplicate");
			sendMessage.mockRestore();
		} finally {
			await harness.dispose();
		}
	});
});

describe("Quality Slice Q5 dedupe active-delivery byte bound", () => {
	it("suppresses tagged deliveries at the byte bound instead of failing the review", async () => {
		const primary = createPrimaryProvider([
			{ content: [{ type: "text", text: "fill the active queue" }] },
		]);
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
			if (runtime === undefined) throw new Error("Expected Advisor runtime");
			const activeRuntime = runtime;
			const extensionApi = runtimeInternals(activeRuntime).pi;
			const sendMessage = vi.spyOn(extensionApi, "sendMessage").mockImplementation(() => undefined);
			await harness.session.prompt("fill active delivery queue");

			// Seed prior metadata for many finding keys so every fill delivery is a
			// possible-duplicate re-delivery carrying the tag. The seeded signature is
			// the bitwise complement of the fill note signature, so similarity is
			// always 0 and every admission is tagged.
			const fillNote = "Fill note " + "x".repeat(1_500);
			const seededSignature = (~noteSignature(fillNote) & 0xffffffffffffffffn)
				.toString(16)
				.padStart(16, "0");
			const dedupe = runtimeInternals(activeRuntime).adviceDedupe;
			const seededKeys = Array.from({ length: 700 }, (_, index) => ({
				hash: adviceDedupeKey({
					note: fillNote,
					severity: "concern" as const,
					intent: "review" as const,
					findingKeyHash: index.toString(16).padStart(64, "0"),
				}),
				metadata: {
					severity: "concern" as const,
					signature: seededSignature,
					lastDeliveryTurn: 1,
				},
			}));
			dedupe.restoreEntries(seededKeys);

			// A fabricated non-idle context keeps every fill on the active steering path
			// so the serialized active-delivery byte bound is exercised.
			const hostContext = runtimeInternals(activeRuntime).hostContext;
			if (hostContext === undefined) throw new Error("Expected Advisor host context");
			const ctx = {
				...hostContext,
				mode: "rpc" as const,
				isIdle: () => false,
			};
			const internals = runtimeInternals(activeRuntime);
			let suppressed = false;
			let threw: unknown;
			for (
				let index = 0;
				index < seededKeys.length && !suppressed && threw === undefined;
				index++
			) {
				const advice = {
					intent: "review" as const,
					note: fillNote,
					severity: "concern" as const,
					findingKeyHash: index.toString(16).padStart(64, "0"),
					truncated: false,
					originalCharacters: fillNote.length,
					originalEstimatedTokens: Math.ceil(fillNote.length / 4),
					createdAt: Date.now(),
				};
				try {
					const result = internals.deliver(advice, ctx, false, false, false, 1, "byte-bound-fill");
					if (result === undefined) suppressed = true;
				} catch (error) {
					threw = error;
				}
			}
			expect(threw).toBeUndefined();
			expect(suppressed).toBe(true);
			expect(activeRuntime.getStatus().deliveryFailures).toBe(0);
			expect(() => runtimeInternals(activeRuntime).persistState()).not.toThrow();
			sendMessage.mockRestore();
		} finally {
			await harness.dispose();
		}
	});
});
