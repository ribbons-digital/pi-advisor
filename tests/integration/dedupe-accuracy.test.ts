import { createHash } from "node:crypto";

import {
	SessionManager,
	type ExtensionAPI,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
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
	type BoundedAdviceDedupe,
	type PersistedAdvisorRuntimeState,
} from "../../src/index.js";
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
		notesDelivered: 0,
		...overrides,
	};
}

function appendState(manager: SessionManager, state: PersistedAdvisorRuntimeState): void {
	manager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, state);
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

			const extensionApi = Reflect.get(activeRuntime, "pi") as ExtensionAPI;
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

			const dedupe = Reflect.get(activeRuntime, "adviceDedupe") as BoundedAdviceDedupe;
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
			expect(JSON.stringify(primary.requests[0]?.context)).toContain(ROLLBACK_NOTE);
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
